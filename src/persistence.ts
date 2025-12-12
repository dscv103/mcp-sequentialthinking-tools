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
		if (!this.db || !this.config.enablePersistence) return null;

		const result = await safeExecute(async () => {
			const stmt = this.db!.prepare(`
				INSERT INTO thoughts (
					thought_number, total_thoughts, thought, is_revision, revises_thought,
					branch_from_thought, branch_id, needs_more_thoughts, next_thought_needed,
					available_mcp_tools, created_at, session_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				new Date().toISOString(),
				sessionId || null
			);

			const thoughtId = Number(info.lastInsertRowid);

			// Save current step if present
			if (thought.current_step) {
				await this.saveStepRecommendation(thoughtId, thought.current_step, true);
			}

			// Save previous steps
			if (thought.previous_steps) {
				for (const step of thought.previous_steps) {
					await this.saveStepRecommendation(thoughtId, step, false);
				}
			}

			logger.debug('Thought saved to database', { 
				thoughtId, 
				thoughtNumber: thought.thought_number 
			});

			return thoughtId;
		}, 'saveThought');

		return result.success ? result.data! : null;
	}

	private async saveStepRecommendation(
		thoughtId: number, 
		step: StepRecommendation, 
		isCurrent: boolean
	): Promise<void> {
		if (!this.db) return;

		const stmt = this.db.prepare(`
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
			const toolStmt = this.db.prepare(`
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
	}

	async getThoughtHistory(sessionId?: string, limit: number = 100): Promise<ThoughtData[]> {
		if (!this.db || !this.config.enablePersistence) return [];

		const result = await safeExecute(async () => {
			const query = sessionId
				? 'SELECT * FROM thoughts WHERE session_id = ? ORDER BY thought_number DESC LIMIT ?'
				: 'SELECT * FROM thoughts ORDER BY thought_number DESC LIMIT ?';
			
			const params = sessionId ? [sessionId, limit] : [limit];
			const rows = this.db!.prepare(query).all(...params) as any[];

			const thoughts: ThoughtData[] = [];
			for (const row of rows) {
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
					available_mcp_tools: JSON.parse(row.available_mcp_tools),
				};

				thoughts.push(thought);
			}

			return thoughts;
		}, 'getThoughtHistory', []);

		return result.data || [];
	}

	async clearHistory(sessionId?: string): Promise<void> {
		if (!this.db || !this.config.enablePersistence) return;

		await safeExecute(async () => {
			if (sessionId) {
				this.db!.prepare('DELETE FROM thoughts WHERE session_id = ?').run(sessionId);
				logger.info('Session history cleared', { sessionId });
			} else {
				this.db!.exec('DELETE FROM thoughts');
				this.db!.exec('DELETE FROM step_recommendations');
				this.db!.exec('DELETE FROM tool_recommendations');
				logger.info('All history cleared');
			}
		}, 'clearHistory');
	}

	close(): void {
		if (this.db) {
			this.db.close();
			logger.info('Database connection closed');
		}
	}
}
