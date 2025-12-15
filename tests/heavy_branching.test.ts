
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolAwareSequentialThinkingServer } from '../src/server.js';
import * as fs from 'fs';

const DB_PATH = './test_heavy_db.json';

function cleanup() {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }
}

test('Heavy Branching & Revision Suite', async (t) => {
    cleanup();

    await t.test('Scenario 4: Heavy Branching & Revision (Max History 1000)', async (t) => {
        const MAX_HISTORY = 1000;
        const server = new ToolAwareSequentialThinkingServer({
            enablePersistence: true,
            dbPath: DB_PATH,
            enableBacktracking: true,
            enableDAG: true,
            maxHistorySize: MAX_HISTORY
        });

        const thoughts: any[] = [];
        let thoughtCounter = 0;

        // Helper to generate thought
        const addThought = async (text: string, options: any = {}) => {
            thoughtCounter++;
            const input = {
                thought: text,
                thought_number: thoughtCounter,
                total_thoughts: 1000,
                next_thought_needed: true,
                available_mcp_tools: [],
                ...options
            };

            // Adjust total_thoughts dynamically if we exceed it, just to be safe in logic
            if (thoughtCounter > input.total_thoughts) {
                input.total_thoughts = thoughtCounter + 100;
            }

            const result = await server.processThought(input);
            if (result.isError) {
                console.error(`Error at thought ${thoughtCounter}:`, result);
            }
            assert.ok(!result.isError, `Thought ${thoughtCounter} should not error`);
            thoughts.push({ id: thoughtCounter, ...input });
            return result;
        };

        // 1. Root
        await addThought("Root Thought: Starting massive branching test.");

        // 2. 10 Primary Branches
        const primaryBranches: number[] = [];
        for (let i = 1; i <= 10; i++) {
            const branchId = `primary-${i}`;
            const result = await addThought(`Starting Primary Branch ${i}`, {
                branch_from_thought: 1,
                branch_id: branchId
            });
            // We capture the thought number of this new branch head
            // Since addThought increments thoughtCounter, the current thought number is thoughtCounter
            primaryBranches.push(thoughtCounter);
        }

        // 3. 5 Sub-branches for each Primary Branch
        // nesting depth: Root -> Primary -> Sub
        for (let i = 0; i < primaryBranches.length; i++) {
            const parentThoughtNum = primaryBranches[i];
            const primaryId = i + 1;

            for (let j = 1; j <= 5; j++) {
                const subBranchId = `sub-${primaryId}-${j}`;
                await addThought(`Sub-branch ${j} of Primary ${primaryId}`, {
                    branch_from_thought: parentThoughtNum,
                    branch_id: subBranchId
                });
            }
        }

        // Current thought count should be: 1 (root) + 10 (primary) + 50 (sub) = 61 thoughts.
        assert.ok(thoughtCounter >= 61, "Should have created at least 61 thoughts");

        // 4. Random Revisions
        // We will pick 20 random thoughts from the past to revise
        const thoughtsToRevise = 20;
        for (let k = 0; k < thoughtsToRevise; k++) {
            // Pick a random thought ID between 1 and current thoughtCounter
            const targetId = Math.floor(Math.random() * (thoughtCounter - 1)) + 1;

            await addThought(`Revising thought ${targetId} with new info`, {
                is_revision: true,
                revises_thought: targetId
            });
        }

        // 5. Finalize
        const finalResult = await addThought("Finalizing test run.", {
            next_thought_needed: false
        });

        // Verification
        if (finalResult.structuredContent) {
            const historyLen = (finalResult.structuredContent as any).thought_history_length;
            // We simply verify we haven't lost thoughts unexpectedly (should be strictly increasing until limit)
            // We have not hit the 1000 limit yet, so history length should roughly equal thoughtCounter
            // (minus any that might be replaced individually if we were using replace, but we append revs).
            // Actually, `thoughtHistory` array grows with revisions too, unless we're talking about a purely linear model. 
            // In this server, revisions are added as NEW thoughts that link back.

            assert.strictEqual(historyLen, thoughtCounter, "History length should match total thoughts created since we are below limit");
        }

        // Cleanup
        server.shutdown();
        cleanup();
    });
});
