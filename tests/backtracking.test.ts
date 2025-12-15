import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BacktrackingManager, BacktrackingConfig } from '../src/backtracking.js';
import { ThoughtData } from '../src/types.js';

const baseConfig: BacktrackingConfig = {
	minConfidence: 0.4,
	enableAutoBacktrack: true,
	maxBacktrackDepth: 3,
	baseConfidence: 0.5,
	toolConfidenceWeight: 0.4,
	revisionPenalty: 0.1,
	branchBonus: 0.05,
	progressBonus: 0.1,
	progressThreshold: 0.6,
	decliningConfidenceThreshold: 0.4,
};

const buildThought = (overrides: Partial<ThoughtData>): ThoughtData => ({
	thought: overrides.thought ?? 'content',
	thought_number: overrides.thought_number ?? 1,
	total_thoughts: overrides.total_thoughts ?? 1,
	available_mcp_tools: overrides.available_mcp_tools ?? ['a'],
	next_thought_needed: overrides.next_thought_needed ?? false,
	is_revision: overrides.is_revision,
	revises_thought: overrides.revises_thought,
	branch_from_thought: overrides.branch_from_thought,
	branch_id: overrides.branch_id,
	current_step: overrides.current_step,
	previous_steps: overrides.previous_steps,
	remaining_steps: overrides.remaining_steps,
	confidence: overrides.confidence,
});

describe('BacktrackingManager', () => {
	it('calculates confidence using tool weights and bonuses', () => {
		const manager = new BacktrackingManager(baseConfig);
		const thought = buildThought({
			thought_number: 2,
			total_thoughts: 3,
			branch_from_thought: 1,
			current_step: {
				step_description: 'do work',
				recommended_tools: [
					{ tool_name: 'alpha', confidence: 0.8, rationale: 'fast', priority: 1 },
					{ tool_name: 'beta', confidence: 0.6, rationale: 'precise', priority: 2 },
				],
				expected_outcome: 'complete',
			},
		});

		const score = manager.calculateConfidence(thought);

		assert.ok(score > baseConfig.baseConfidence, 'confidence should increase with tool weights and branch bonus');
	});

	it('triggers backtracking when confidence falls below threshold', () => {
		const manager = new BacktrackingManager(baseConfig);
		const thought = buildThought({
			thought_number: 3,
			total_thoughts: 3,
			confidence: 0.1,
		});

		const decision = manager.shouldBacktrack(thought);

		assert.equal(decision.shouldBacktrack, true);
		assert.ok(decision.backtrackTo !== undefined, 'backtrack target should be defined');
	});

	it('detects declining confidence trend in recent thoughts', () => {
		const manager = new BacktrackingManager(baseConfig);
		const thoughts: ThoughtData[] = [
			buildThought({ confidence: 0.6, thought_number: 1 }),
			buildThought({ confidence: 0.4, thought_number: 2 }),
			buildThought({ confidence: 0.3, thought_number: 3 }),
		];

		const suggestion = manager.suggestContinuation(thoughts);
		assert.equal(suggestion.shouldContinue, false);
		assert.ok(suggestion.reason.includes('Declining'));
	});
});
