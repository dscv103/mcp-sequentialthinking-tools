
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolAwareSequentialThinkingServer } from '../src/server.js';
import { ThoughtData } from '../src/types.js';

const setupServer = async (sessionId: string, dbPath: string) => {
    const server = new ToolAwareSequentialThinkingServer({
        dbPath,
        sessionId,
        enablePersistence: true,
        enableDAG: true,
        enableToolChains: true,
        maxHistorySize: 100,
    });
    await server.initialize();
    return server;
};

describe('Server State Rehydration', () => {
    it('restores thought history and DAG state after restart', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rehydration-'));
        const dbPath = path.join(dir, 'test.db');
        const sessionId = 'test-session-rehydration';

        // 1. Start Server A
        const serverA = await setupServer(sessionId, dbPath);

        // 2. Process some thoughts with branching
        // T1
        await serverA.processThought({
            thought: 'Thought 1',
            thought_number: 1,
            total_thoughts: 3,
            next_thought_needed: true
        } as ThoughtData);

        // T2 (depends on T1)
        await serverA.processThought({
            thought: 'Thought 2',
            thought_number: 2,
            total_thoughts: 3,
            next_thought_needed: true
        } as ThoughtData);

        // T3 (Branch from T1)
        await serverA.processThought({
            thought: 'Branch Thought',
            thought_number: 3,
            total_thoughts: 3,
            branch_from_thought: 1,
            branch_id: 'branch-1',
            next_thought_needed: false
        } as ThoughtData);

        // Shutdown Server A
        serverA.shutdown();

        // 3. Start Server B (Simulate new process)
        const serverB = await setupServer(sessionId, dbPath);

        // 4. Verify History
        // Access private processor state via `any` casting or just rely on public behavior?
        // Since we want to verify internal state restoration, inspecting internals is acceptable for this white-box test.
        // However, let's see if we can use public methods. `processThought` returns context.
        // But valid rehydration is best checked by inspecting the processor.

        const processorB = (serverB as any).processor;
        const historyB = processorB.thoughtHistory as ThoughtData[];
        const branchesB = processorB.branches;
        const dagB = (serverB as any).thoughtDAG;

        assert.equal(historyB.length, 3, 'History length should be 3');
        assert.equal(historyB[0].thought, 'Thought 1');
        assert.equal(historyB[1].thought, 'Thought 2');
        assert.equal(historyB[2].thought, 'Branch Thought');

        // Verify Branching
        assert.ok(branchesB['branch-1'], 'Branch should exist');
        assert.equal(branchesB['branch-1'].length, 1);
        assert.equal(branchesB['branch-1'][0].thought_number, 3);

        // Verify DAG Status
        // T1: Completed
        // T2: Completed (depends on T1)
        // T3: Completed (depends on T1)
        const nodes = dagB.nodes; // specific to DAG implementation

        const node1 = nodes.get(1);
        const node2 = nodes.get(2);
        const node3 = nodes.get(3);

        assert.ok(node1, 'Node 1 should exist in DAG');
        assert.equal(node1.status, 'completed', 'Node 1 should be completed');

        assert.ok(node2, 'Node 2 should exist in DAG');
        assert.equal(node2.status, 'completed', 'Node 2 should be completed');
        // T2 depends on T1
        assert.ok(node2.dependencies.includes(1), 'Node 2 should depend on 1');

        assert.ok(node3, 'Node 3 should exist in DAG');
        assert.equal(node3.status, 'completed', 'Node 3 should be completed');
        // T3 depends on T1 (branch from 1)
        assert.ok(node3.dependencies.includes(1), 'Node 3 should depend on 1');

        // Cleanup
        serverB.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('handles empty history gracefully', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rehydration-empty-'));
        const dbPath = path.join(dir, 'test.db');
        const sessionId = 'test-session-empty';

        const server = await setupServer(sessionId, dbPath);

        const processor = (server as any).processor;
        assert.equal(processor.thoughtHistory.length, 0);

        server.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
