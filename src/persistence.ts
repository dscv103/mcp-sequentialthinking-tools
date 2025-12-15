/**
 * State persistence using SQLite for MCP Sequential Thinking Tools
 * Enables long-running tasks to survive restarts
 */

import Database from 'better-sqlite3';
import { ThoughtData, StepRecommendation } from './types.js';
import { logger } from './logging.js';
import { safeExecute } from './error-handling.js';

export interface PersistenceConfig {
	dbPath: string;
	enablePersistence: boolean;
}

const DEFAULT_DB_PATH = './mcp-thinking.db';

export class PersistenceLayer {
	private db: Database.Database | null = null;
	private config: PersistenceConfig;

	constructor(config: Partial<PersistenceConfig> = {}) {
		this.config = {
			dbPath: config.dbPath || DEFAULT_DB_PATH,
			enablePersistence: config.enablePersistence ?? true,
		};

		if (this.config.enablePersistence) {
			this.initialize();
		}
	}

	private initialize(): void {
		try {
			this.db = new Database(this.config.dbPath);
			this.createTables();
			logger.info('Persistence layer initialized', { dbPath: this.config.dbPath });
		} catch (error) {
			logger.error('Failed to initialize persistence layer', error);
			this.db = null;
		}
	}

	private createTables(): void {
		if (!this.db) return;

		// Thoughts table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS thoughts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thought_number INTEGER NOT NULL,
				total_thoughts INTEGER NOT NULL,
				thought TEXT NOT NULL,
				is_revision BOOLEAN DEFAULT 0,
				revises_thought INTEGER,
				branch_from_thought INTEGER,
				branch_id TEXT,
				needs_more_thoughts BOOLEAN DEFAULT 0,
				next_thought_needed BOOLEAN NOT NULL,
				available_mcp_tools TEXT NOT NULL,
				confidence REAL,
				created_at TEXT NOT NULL,
				session_id TEXT
			)
		`);

		// Step recommendations table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS step_recommendations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thought_id INTEGER NOT NULL,
				step_description TEXT NOT NULL,
				expected_outcome TEXT NOT NULL,
				next_step_conditions TEXT,
				is_current BOOLEAN DEFAULT 0,
				created_at TEXT NOT NULL,
				FOREIGN KEY (thought_id) REFERENCES thoughts(id)
			)
		`);

		// Tool recommendations table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tool_recommendations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				step_id INTEGER NOT NULL,
				tool_name TEXT NOT NULL,
				confidence REAL NOT NULL,
				rationale TEXT NOT NULL,
				priority INTEGER NOT NULL,
				suggested_inputs TEXT,
				alternatives TEXT,
				created_at TEXT NOT NULL,
				FOREIGN KEY (step_id) REFERENCES step_recommendations(id)
			)
		`);

		// Create indexes for faster queries
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_thoughts_number ON thoughts(thought_number);
			CREATE INDEX IF NOT EXISTS idx_thoughts_branch ON thoughts(branch_id);
			CREATE INDEX IF NOT EXISTS idx_thoughts_session ON thoughts(session_id);
			CREATE INDEX IF NOT EXISTS idx_steps_thought ON step_recommendations(thought_id);
			CREATE INDEX IF NOT EXISTS idx_tools_step ON tool_recommendations(step_id);
		`);

		logger.debug('Database tables created/verified');
	}

	async saveThought(thought: ThoughtData, sessionId?: string): Promise<number | null> {
		const db = this.db;
		if (!db || !this.config.enablePersistence) return null;

		const result = await safeExecute(async () => {
			// Use transaction for atomicity
			db.exec('BEGIN TRANSACTION');
			
			try {
				const stmt = db.prepare(`
					INSERT INTO thoughts (
						thought_number, total_thoughts, thought, is_revision, revises_thought,
						branch_from_thought, branch_id, needs_more_thoughts, next_thought_needed,
						available_mcp_tools, confidence, created_at, session_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`);

				const info = stmt.run(
					thought.thought_number,
					thought.total_thoughts,
					thought.thought,
					thought.is_revision ? 1 : 0,
					thought.revises_thought || null,
					thought.branch_from_thought || null,
					thought.branch_id || null,
					thought.needs_more_thoughts ? 1 : 0,
					thought.next_thought_needed ? 1 : 0,
					JSON.stringify(thought.available_mcp_tools),
					thought.confidence || null,
					new Date().toISOString(),
					sessionId || null
				);

				const thoughtId = Number(info.lastInsertRowid);

				// Save current step if present
				if (thought.current_step) {
					this.saveStepRecommendation(db, thoughtId, thought.current_step, true);
				}

				// Save previous steps
				if (thought.previous_steps) {
					for (const step of thought.previous_steps) {
						this.saveStepRecommendation(db, thoughtId, step, false);
					}
				}

				db.exec('COMMIT');

				logger.debug('Thought saved to database', { 
					thoughtId, 
					thoughtNumber: thought.thought_number 
				});

				return thoughtId;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		}, 'saveThought');

		return result.success ? result.data! : null;
	}

	private saveStepRecommendation(
		db: Database.Database,
		thoughtId: number, 
		step: StepRecommendation, 
		isCurrent: boolean
	): void {
		if (!db) return;

		try {
			const stmt = db.prepare(`
				INSERT INTO step_recommendations (
					thought_id, step_description, expected_outcome, next_step_conditions,
					is_current, created_at
				) VALUES (?, ?, ?, ?, ?, ?)
			`);

			const info = stmt.run(
				thoughtId,
				step.step_description,
				step.expected_outcome,
				step.next_step_conditions ? JSON.stringify(step.next_step_conditions) : null,
				isCurrent ? 1 : 0,
				new Date().toISOString()
			);

			const stepId = Number(info.lastInsertRowid);

			// Save tool recommendations
			for (const tool of step.recommended_tools) {
				const toolStmt = db.prepare(`
					INSERT INTO tool_recommendations (
						step_id, tool_name, confidence, rationale, priority,
						suggested_inputs, alternatives, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`);

				toolStmt.run(
					stepId,
					tool.tool_name,
					tool.confidence,
					tool.rationale,
					tool.priority,
					tool.suggested_inputs ? JSON.stringify(tool.suggested_inputs) : null,
					tool.alternatives ? JSON.stringify(tool.alternatives) : null,
					new Date().toISOString()
				);
			}
		} catch (error) {
			logger.error('Failed to save step recommendation', error, {
				thoughtId,
				stepDescription: step.step_description,
				isCurrent,
			});
			throw error;
		}
	}

	private parseJson<T>(
		value: unknown,
		defaultValue: T,
		context: Record<string, unknown>,
		validator?: (parsed: unknown) => boolean
	): T {
		if (value === null || value === undefined) return defaultValue;
		try {
			const parsed = JSON.parse(String(value));
			if (validator && !validator(parsed)) {
				logger.warn('Parsed JSON failed validation during rehydration', context);
				return defaultValue;
			}
			return (parsed ?? defaultValue) as T;
		} catch (_error) {
			logger.warn('Failed to parse JSON field during rehydration', context);
			return defaultValue;
		}
	}

	private extractValidIds(values: Iterable<unknown>): number[] {
		return Array.from(values)
			.map(value => Number(value))
			.filter(value => Number.isFinite(value));
	}

	/**
	 * Returns all persisted thoughts for the specified session.
	 * Returns an empty array (with a warning) when no sessionId is provided.
	 */
	async getThoughtHistory(sessionId?: string): Promise<ThoughtData[]> {
		const db = this.db;
		if (!db || !this.config.enablePersistence) return [];

		if (!sessionId) {
			logger.warn('getThoughtHistory called without sessionId');
			return [];
		}

		const result = await safeExecute(async () => {
			const thoughtRows = db.prepare(`
				SELECT * FROM thoughts 
				WHERE session_id = ? 
				ORDER BY thought_number ASC
			`).all(sessionId) as any[];

			if (thoughtRows.length === 0) return [];

			const thoughts: ThoughtData[] = [];
			const thoughtMap = new Map<number, ThoughtData>();

			for (const row of thoughtRows) {
				const thought: ThoughtData = {
					thought_number: row.thought_number,
					total_thoughts: row.total_thoughts,
					thought: row.thought,
					is_revision: Boolean(row.is_revision),
					revises_thought: row.revises_thought || undefined,
					branch_from_thought: row.branch_from_thought || undefined,
					branch_id: row.branch_id || undefined,
					needs_more_thoughts: Boolean(row.needs_more_thoughts),
					next_thought_needed: Boolean(row.next_thought_needed),
					available_mcp_tools: this.parseJson<string[]>(
						row.available_mcp_tools,
						[],
						{
							thoughtId: row.id,
							field: 'available_mcp_tools',
						},
						Array.isArray
					),
					confidence: row.confidence ?? undefined,
				};

				thoughts.push(thought);
				thoughtMap.set(row.id, thought);
			}

			const thoughtIds = this.extractValidIds(thoughtRows.map(row => row.id));
			const thoughtPlaceholders = thoughtIds.map(() => '?').join(',');

			const stepRows = thoughtPlaceholders
				? (db.prepare(`
					SELECT * FROM step_recommendations
					WHERE thought_id IN (${thoughtPlaceholders})
					ORDER BY thought_id ASC, is_current DESC, id ASC
				`).all(...thoughtIds) as any[])
				: [];

			const stepMap = new Map<number, StepRecommendation>();
			const stepIds: number[] = [];

			for (const row of stepRows) {
				const step: StepRecommendation = {
					step_description: row.step_description,
					expected_outcome: row.expected_outcome,
					recommended_tools: [],
				};

				const parsedConditions = this.parseJson<string[] | undefined>(
					row.next_step_conditions,
					undefined,
					{ stepId: row.id, field: 'next_step_conditions' },
					value => value === undefined || Array.isArray(value)
				);
				if (parsedConditions !== undefined) {
					step.next_step_conditions = parsedConditions;
				}

				const thought = thoughtMap.get(row.thought_id);
				if (thought) {
					if (row.is_current) {
						if (!thought.current_step) {
							thought.current_step = step;
						} else {
							throw new Error(
								`Multiple current steps found during rehydration for thoughtId=${row.thought_id}. Duplicate stepId=${row.id}.`
							);
						}
					} else {
						thought.previous_steps = [...(thought.previous_steps || []), step];
					}
				}

				stepMap.set(row.id, step);
				const stepIdNum = Number(row.id);
				if (Number.isFinite(stepIdNum)) {
					stepIds.push(stepIdNum);
				}
			}

			// Step IDs are validated numeric values prior to placeholder interpolation
			const stepPlaceholders = stepIds.map(() => '?').join(',');
			const toolRows = stepPlaceholders
				? (db.prepare(`
					SELECT * FROM tool_recommendations
					WHERE step_id IN (${stepPlaceholders})
					ORDER BY step_id ASC, priority ASC, id ASC
				`).all(...stepIds) as any[])
				: [];

			for (const row of toolRows) {
				const step = stepMap.get(row.step_id);
				if (!step) continue;

				const suggestedInputs = this.parseJson<Record<string, unknown> | undefined>(
					row.suggested_inputs,
					undefined,
					{ toolId: row.id, field: 'suggested_inputs' },
					value => value === undefined || (typeof value === 'object' && !Array.isArray(value))
				);
				const alternatives = this.parseJson<string[] | undefined>(
					row.alternatives,
					undefined,
					{ toolId: row.id, field: 'alternatives' },
					value => value === undefined || Array.isArray(value)
				);

				step.recommended_tools.push({
					tool_name: row.tool_name,
					confidence: row.confidence,
					rationale: row.rationale,
					priority: row.priority,
					...(suggestedInputs !== undefined ? { suggested_inputs: suggestedInputs } : {}),
					...(alternatives !== undefined ? { alternatives } : {}),
				});
			}

			return thoughts;
		}, 'getThoughtHistory', []);

		return result.data || [];
	}

	async clearHistory(sessionId?: string): Promise<void> {
		const db = this.db;
		if (!db || !this.config.enablePersistence) return;

		await safeExecute(async () => {
			const transactional = db.transaction((session?: string) => {
				if (session) {
					db.prepare(`
						DELETE FROM tool_recommendations 
						WHERE step_id IN (
							SELECT id FROM step_recommendations 
							WHERE thought_id IN (
								SELECT id FROM thoughts WHERE session_id = ?
							)
						)
					`).run(session);

					db.prepare(`
						DELETE FROM step_recommendations 
						WHERE thought_id IN (SELECT id FROM thoughts WHERE session_id = ?)
					`).run(session);

					db.prepare('DELETE FROM thoughts WHERE session_id = ?').run(session);
					logger.info('Session history cleared', { sessionId: session });
				} else {
					db.exec('DELETE FROM tool_recommendations');
					db.exec('DELETE FROM step_recommendations');
					db.exec('DELETE FROM thoughts');
					logger.info('All history cleared');
				}
			});

			transactional(sessionId);
		}, 'clearHistory');
	}

	close(): void {
		if (this.db) {
			this.db.close();
			logger.info('Database connection closed');
		}
	}
}
