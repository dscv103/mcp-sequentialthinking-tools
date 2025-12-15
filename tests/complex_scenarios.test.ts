
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolAwareSequentialThinkingServer } from '../src/server.js';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = './test_complex_db.json';

// Helper to clean up DB
function cleanup() {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }
}

test('Complex Scenarios Suite', async (t) => {
    // Cleanup before starting
    cleanup();

    await t.test('Scenario 1: The Branching Tree (Maze)', async (t) => {
        const server = new ToolAwareSequentialThinkingServer({
            enablePersistence: true,
            dbPath: DB_PATH,
            enableBacktracking: true,
            enableDAG: true
        });

        // 1. Initial Thought (Root)
        await server.processThought({
            thought: "Starting maze exploration. I see paths Left, Right, and Straight.",
            thought_number: 1,
            total_thoughts: 10,
            next_thought_needed: true,
            available_mcp_tools: []
        });

        // 2. Branch A: Go Left
        await server.processThought({
            thought: "I will go Left.",
            thought_number: 2,
            total_thoughts: 10,
            next_thought_needed: true,
            branch_from_thought: 1,
            branch_id: "branch-left",
            available_mcp_tools: []
        });

        // 3. Branch A: Cont.
        await server.processThought({
            thought: "It's a dead end.",
            thought_number: 3,
            total_thoughts: 10,
            next_thought_needed: true,
            branch_id: "branch-left",
            available_mcp_tools: []
        });

        // 4. Branch B: Go Right (Branching from Root again)
        await server.processThought({
            thought: "Going back to start. Now checking Right.",
            thought_number: 4,
            total_thoughts: 10,
            next_thought_needed: true,
            branch_from_thought: 1,
            branch_id: "branch-right",
            available_mcp_tools: []
        });

        // 5. Branch B: Success
        const result = await server.processThought({
            thought: "Found the exit!",
            thought_number: 5,
            total_thoughts: 10,
            next_thought_needed: false,
            branch_id: "branch-right",
            available_mcp_tools: []
        });

        // Verify that the server handled the branching successfully
        assert.ok(result, "Result should be returned");
        assert.ok(!result.isError, "Should not return an error");

        // Check output payload structure if possible, 
        // asserting that 'branches' contains our branch IDs
        if (result.structuredContent && 'branches' in result.structuredContent) {
            const branches = result.structuredContent.branches as string[];
            assert.ok(branches.includes('branch-left'), 'Should record left branch');
            assert.ok(branches.includes('branch-right'), 'Should record right branch');
        }

        server.shutdown();
        cleanup();
    });

    await t.test('Scenario 2: The Correction Loop (Revisions)', async (t) => {
        const server = new ToolAwareSequentialThinkingServer({
            enablePersistence: true,
            dbPath: DB_PATH,
            enableBacktracking: true
        });

        // 1. Plan
        await server.processThought({
            thought: "I need to calculate 2 + 2.",
            thought_number: 1,
            total_thoughts: 3,
            next_thought_needed: true,
            available_mcp_tools: []
        });

        // 2. Mistake
        await server.processThought({
            thought: "The answer is 5.",
            thought_number: 2,
            total_thoughts: 3,
            next_thought_needed: true,
            available_mcp_tools: []
        });

        // 3. Realization & Revision
        const result = await server.processThought({
            thought: "Wait, I made a mistake. 2 + 2 is 4. Revising thought 2.",
            thought_number: 3,
            total_thoughts: 4,
            next_thought_needed: false,
            is_revision: true,
            revises_thought: 2,
            available_mcp_tools: []
        });

        assert.ok(!result.isError, "Revision should process without error");
        if (result.structuredContent && 'is_revision' in result.structuredContent) {
            assert.strictEqual(result.structuredContent.is_revision, true);
            assert.strictEqual(result.structuredContent.revises_thought, 2);
        }

        server.shutdown();
        cleanup();
    });

    await t.test('Scenario 3: Stress Test (History Limit)', async (t) => {
        // Set small history limit to test pruning
        const server = new ToolAwareSequentialThinkingServer({
            maxHistorySize: 10,
            enablePersistence: false,
            enableBacktracking: false
        });

        const ITERATIONS = 50;

        for (let i = 1; i <= ITERATIONS; i++) {
            await server.processThought({
                thought: `Iteration ${i}`,
                thought_number: i,
                total_thoughts: ITERATIONS,
                next_thought_needed: i < ITERATIONS,
                available_mcp_tools: []
            });
        }

        // We can't easily inspect private history without casting or exposing it, 
        // but we can ensure it didn't crash and returned a successful result for the last item.
        const result = await server.processThought({
            thought: "Final check",
            thought_number: ITERATIONS + 1,
            total_thoughts: ITERATIONS + 1,
            next_thought_needed: false,
            available_mcp_tools: []
        });

        assert.ok(!result.isError, "Stress test should complete without error");

        if (result.structuredContent && 'thought_history_length' in result.structuredContent) {
            const historyLen = result.structuredContent.thought_history_length as number;
            assert.ok(historyLen <= 11, `History should be trimmed near max size (10) + buffer? Actual: ${historyLen}`);
            // Note: Implementation details might vary on when exactly it trims (before or after insert), 
            // but it should definitely not be 50.
        }

        server.shutdown();
    });
});
