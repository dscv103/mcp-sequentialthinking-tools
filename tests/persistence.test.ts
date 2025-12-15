import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { PersistenceLayer } from '../src/persistence.js';
import { ThoughtData } from '../src/types.js';

const setupPersistence = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-persistence-'));
	const dbPath = path.join(dir, 'test.db');
	const persistence = new PersistenceLayer({ dbPath });
	let closed = false;

	const close = () => {
		if (!closed) {
			persistence.close();
			closed = true;
		}
	};

	const cleanup = () => {
		close();
		fs.rmSync(dir, { recursive: true, force: true });
	};

	return { persistence, dbPath, cleanup, close };
};

const baseThought = (overrides: Partial<ThoughtData>): ThoughtData => ({
	available_mcp_tools: [],
	thought: 'test thought',
	thought_number: 1,
	total_thoughts: 1,
	next_thought_needed: false,
	...overrides,
});

describe('PersistenceLayer.getThoughtHistory', () => {
	it('returns an empty array when sessionId is not provided', async () => {
		const { persistence, cleanup } = setupPersistence();

		const result = await persistence.getThoughtHistory();
		assert.deepStrictEqual(result, []);

		cleanup();
	});

	it('returns an empty array when session has no thoughts', async () => {
		const { persistence, cleanup } = setupPersistence();

		const result = await persistence.getThoughtHistory('unknown-session');
		assert.deepStrictEqual(result, []);

		cleanup();
	});

	it('rehydrates full thought history with steps and tools in ascending order', async () => {
		const { persistence, cleanup } = setupPersistence();
		const sessionId = 'session-1';

		const thought1: ThoughtData = baseThought({
			thought: 'first',
			thought_number: 1,
			total_thoughts: 2,
			available_mcp_tools: ['tool-a', 'tool-b'],
			current_step: {
				step_description: 'analyze',
				expected_outcome: 'understanding',
				next_step_conditions: ['cond-a'],
				recommended_tools: [
					{
						tool_name: 'search',
						confidence: 0.9,
						rationale: 'gather data',
						priority: 1,
						suggested_inputs: { query: 'info' },
						alternatives: ['alt-search'],
					},
				],
			},
			previous_steps: [
				{
					step_description: 'prep',
					expected_outcome: 'ready',
					next_step_conditions: ['cond-b'],
					recommended_tools: [
						{
							tool_name: 'notes',
							confidence: 0.7,
							rationale: 'record',
							priority: 1,
						},
					],
				},
			],
			confidence: 0.8,
		});

		const thought2: ThoughtData = baseThought({
			thought: 'second',
			thought_number: 2,
			total_thoughts: 2,
			available_mcp_tools: ['tool-c'],
			next_thought_needed: true,
			needs_more_thoughts: true,
			current_step: {
				step_description: 'execute',
				expected_outcome: 'result',
				recommended_tools: [
					{
						tool_name: 'runner',
						confidence: 0.6,
						rationale: 'perform task',
						priority: 1,
						alternatives: ['fallback'],
					},
				],
			},
			previous_steps: [
				{
					step_description: 'draft',
					expected_outcome: 'drafted',
					recommended_tools: [
						{
							tool_name: 'editor',
							confidence: 0.5,
							rationale: 'prepare',
							priority: 1,
						},
					],
				},
			],
		});

		await persistence.saveThought(thought1, sessionId);
		await persistence.saveThought(thought2, sessionId);

		const history = await persistence.getThoughtHistory(sessionId);

		assert.strictEqual(history.length, 2);
		assert.deepStrictEqual(
			history.map(thought => thought.thought_number),
			[1, 2],
		);

		const [rehydratedFirst, rehydratedSecond] = history;

		assert.deepStrictEqual(rehydratedFirst.available_mcp_tools, thought1.available_mcp_tools);
		assert.strictEqual(rehydratedFirst.current_step?.step_description, thought1.current_step?.step_description);
		assert.deepStrictEqual(
			rehydratedFirst.current_step?.recommended_tools[0].suggested_inputs,
			thought1.current_step?.recommended_tools[0].suggested_inputs,
		);
		assert.strictEqual(
			rehydratedFirst.previous_steps?.[0].recommended_tools[0].tool_name,
			thought1.previous_steps?.[0].recommended_tools[0].tool_name,
		);

		assert.strictEqual(rehydratedSecond.thought, thought2.thought);
		assert.strictEqual(rehydratedSecond.current_step?.step_description, thought2.current_step?.step_description);
		assert.deepStrictEqual(
			rehydratedSecond.current_step?.recommended_tools[0].alternatives,
			thought2.current_step?.recommended_tools[0].alternatives,
		);

		cleanup();
	});

	it('handles malformed JSON gracefully and defaults values', async () => {
		const { persistence, dbPath, cleanup, close } = setupPersistence();
		const sessionId = 'session-json';

		const thought: ThoughtData = baseThought({
			thought: 'bad-json',
			thought_number: 1,
			total_thoughts: 1,
			available_mcp_tools: ['tool-a'],
		});

		await persistence.saveThought(thought, sessionId);
		close();

		const db = new Database(dbPath);
		db.prepare('UPDATE thoughts SET available_mcp_tools = ? WHERE session_id = ?').run('not-json', sessionId);
		db.close();

		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(' '));
		};

		const reader = new PersistenceLayer({ dbPath });
		const history = await reader.getThoughtHistory(sessionId);
		reader.close();
		console.error = originalError;
		cleanup();

		assert.strictEqual(history.length, 1);
		assert.deepStrictEqual(history[0].available_mcp_tools, []);
		assert.ok(errors.some(msg => msg.includes('Failed to parse JSON field during rehydration')));
	});
});

describe('PersistenceLayer.clearHistory', () => {
	it('removes thoughts, steps, and tools for a session', async () => {
		const { persistence, dbPath, cleanup, close } = setupPersistence();
		const sessionA = 'session-a';
		const sessionB = 'session-b';

		const thought: ThoughtData = baseThought({
			current_step: {
				step_description: 'step',
				expected_outcome: 'outcome',
				recommended_tools: [
					{
						tool_name: 'tool-x',
						confidence: 1,
						rationale: 'reason',
						priority: 1,
					},
				],
			},
		});

		await persistence.saveThought(thought, sessionA);
		await persistence.saveThought({ ...thought, thought_number: 2 }, sessionB);

		await persistence.clearHistory(sessionA);
		close();

		const db = new Database(dbPath);

		const thoughtCountA = db.prepare('SELECT COUNT(*) as count FROM thoughts WHERE session_id = ?').get(sessionA).count as number;
		const thoughtCountB = db.prepare('SELECT COUNT(*) as count FROM thoughts WHERE session_id = ?').get(sessionB).count as number;

		const stepCountA = db.prepare(`
			SELECT COUNT(*) as count FROM step_recommendations 
			WHERE thought_id IN (SELECT id FROM thoughts WHERE session_id = ?)
		`).get(sessionA).count as number;
		const stepCountB = db.prepare(`
			SELECT COUNT(*) as count FROM step_recommendations 
			WHERE thought_id IN (SELECT id FROM thoughts WHERE session_id = ?)
		`).get(sessionB).count as number;

		const toolCountA = db.prepare(`
			SELECT COUNT(*) as count FROM tool_recommendations 
			WHERE step_id IN (
				SELECT id FROM step_recommendations 
				WHERE thought_id IN (SELECT id FROM thoughts WHERE session_id = ?)
			)
		`).get(sessionA).count as number;
		const toolCountB = db.prepare(`
			SELECT COUNT(*) as count FROM tool_recommendations 
			WHERE step_id IN (
				SELECT id FROM step_recommendations 
				WHERE thought_id IN (SELECT id FROM thoughts WHERE session_id = ?)
			)
		`).get(sessionB).count as number;

		db.close();
		cleanup();

		assert.strictEqual(thoughtCountA, 0);
		assert.strictEqual(stepCountA, 0);
		assert.strictEqual(toolCountA, 0);

		assert.strictEqual(thoughtCountB, 1);
		assert.strictEqual(stepCountB, 1);
		assert.strictEqual(toolCountB, 1);
	});

	it('clears all history when called without a session', async () => {
		const { persistence, dbPath, cleanup, close } = setupPersistence();

		const thought: ThoughtData = baseThought({
			current_step: {
				step_description: 'step',
				expected_outcome: 'outcome',
				recommended_tools: [
					{
						tool_name: 'tool-x',
						confidence: 1,
						rationale: 'reason',
						priority: 1,
					},
				],
			},
		});

		await persistence.saveThought(thought, 'session-a');
		await persistence.saveThought({ ...thought, thought_number: 2 }, 'session-b');

		await persistence.clearHistory();
		close();

		const db = new Database(dbPath);
		const thoughts = db.prepare('SELECT COUNT(*) as count FROM thoughts').get().count as number;
		const steps = db.prepare('SELECT COUNT(*) as count FROM step_recommendations').get().count as number;
		const tools = db.prepare('SELECT COUNT(*) as count FROM tool_recommendations').get().count as number;
		db.close();
		cleanup();

		assert.strictEqual(thoughts, 0);
		assert.strictEqual(steps, 0);
		assert.strictEqual(tools, 0);
	});
});
