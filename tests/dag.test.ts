import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ThoughtDAG } from '../src/dag.js';
import { ThoughtData } from '../src/types.js';

const baseThought = (overrides: Partial<ThoughtData>): ThoughtData => ({
	available_mcp_tools: [],
	thought: 'test',
	thought_number: 1,
	total_thoughts: 1,
	next_thought_needed: false,
	...overrides,
});

describe('ThoughtDAG', () => {
	it('groups branched thoughts by execution level', () => {
		const dag = new ThoughtDAG();

		const thought1 = baseThought({ thought_number: 1 });
		const thought2 = baseThought({ thought_number: 2, total_thoughts: 2 });
		const thought3 = baseThought({
			thought_number: 3,
			branch_from_thought: 1,
			branch_id: 'b1',
			total_thoughts: 3,
		});
		const thought4 = baseThought({
			thought_number: 4,
			revises_thought: 2,
			total_thoughts: 4,
		});

		dag.addThought(thought1);
		dag.addThought(thought2);
		dag.addThought(thought3);
		dag.addThought(thought4);

		const groups = dag.getParallelGroups();

		assert.deepStrictEqual(groups, [
			[1],
			[2, 3],
			[4],
		]);
	});

	it('caches parallel groups for large DAGs without sharing references', () => {
		const dag = new ThoughtDAG();

		for (let i = 1; i <= 200; i++) {
			dag.addThought(
				baseThought({
					thought_number: i,
					total_thoughts: 200,
					revises_thought: i > 1 ? i - 1 : undefined,
					next_thought_needed: i < 200,
				}),
			);
		}

		const first = dag.getParallelGroups();
		const second = dag.getParallelGroups();

		assert.notStrictEqual(first, second);
		assert.deepStrictEqual(first, second);

		// Mutating the first result should not affect cached value
		first[0].push(9999);
		const third = dag.getParallelGroups();
		assert.strictEqual(third[0].includes(9999), false);
	});
});
