
const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.join(__dirname, 'dist', 'index.js');

const SCENARIOS = [
    {
        name: "1. Basic Initialization",
        input: {
            "thought": "I need to explain the thread-safe singleton pattern in C++11. I will start by discussing the 'Magic Statics' feature (Meyers' Singleton) which guarantees thread safety for static local variable initialization.",
            "thought_number": 1,
            "total_thoughts": 3,
            "next_thought_needed": true,
            "available_mcp_tools": []
        },
        verify: (res) => res.thought_number === 1 && res.total_thoughts >= 1
    },
    {
        name: "2. Step-by-Step Progression",
        input: {
            "thought": "Now I will provide the code example for the header file, specifically the class declaration with the deleted copy constructor and assignment operator to ensure uniqueness.",
            "thought_number": 2,
            "total_thoughts": 3,
            "next_thought_needed": true,
            "available_mcp_tools": []
        },
        verify: (res) => res.thought_number === 2
    },
    {
        name: "3. Dynamic Tool Recommendation",
        input: {
            "thought": "I need to verify the current requirements for 'use client' in React Server Components. I should use a search tool to find the official documentation.",
            "thought_number": 1,
            "total_thoughts": 3,
            "next_thought_needed": true,
            "available_mcp_tools": ["mcp-omnisearch", "mcp-browser"],
            "current_step": {
                "step_description": "Search for React Server Components 'use client' documentation",
                "recommended_tools": [
                    {
                        "tool_name": "mcp-omnisearch",
                        "rationale": "To find the latest official React documentation pages.",
                        "confidence": 0.9,
                        "priority": 1,
                        "suggested_inputs": {
                            "query": "React Server Components use client directive documentation"
                        }
                    }
                ],
                "expected_outcome": "URL or summary of the official docs regarding client components."
            }
        },
        verify: (res) => res.current_step && res.current_step.recommended_tools.some(t => t.tool_name === 'mcp-omnisearch')
    },
    {
        name: "4. Revision",
        input: {
            "thought": "The user pointed out that the previous syntax was outdated. I need to revise Thought 2 to use the `delete` keyword for the copy constructor instead of making it private without implementation.",
            "thought_number": 3,
            "total_thoughts": 4,
            "next_thought_needed": true,
            "is_revision": true,
            "revises_thought": 2,
            "available_mcp_tools": []
        },
        verify: (res) => res.thought_number === 3 && res.is_revision === true
    },
    {
        name: "5. Branching",
        input: {
            "thought": "The user wants to explore `std::call_once`. I should branch from the initial concept discussion to explain this alternative implementation.",
            "thought_number": 4,
            "total_thoughts": 5,
            "next_thought_needed": true,
            "branch_from_thought": 1,
            "branch_id": "call-once-alternative",
            "available_mcp_tools": []
        },
        verify: (res) => res.branch_from_thought === 1
    },
    {
        name: "6. Changing Total Thoughts",
        input: {
            "thought": "The user requested just the code. I will provide the implementation immediately and finish the thought process.",
            "thought_number": 2,
            "total_thoughts": 2,
            "next_thought_needed": false,
            "available_mcp_tools": []
        },
        verify: (res) => res.total_thoughts === 2 && res.next_thought_needed === false
    },
    {
        name: "7. Confidence Scoring",
        input: {
            "thought": "I am not entirely sure about the configuration for this specific environment. I will try to infer it from the standard node setup.",
            "thought_number": 2,
            "total_thoughts": 4,
            "next_thought_needed": true,
            "confidence": 0.4,
            "available_mcp_tools": []
        },
        verify: (res) => res.confidence === 0.4
    }
];

async function runTests() {
    console.log("# Test Results: MCP Sequential Thinking Prompts\n");
    console.log("| Scenario | Status | Details |");
    console.log("|---|---|---|");

    const fs = require('fs');
    const logFile = path.join(__dirname, 'test_debug.log');
    // Clear log file at start
    fs.writeFileSync(logFile, '');
    const log = (msg) => fs.appendFileSync(logFile, msg + '\n');
    log("Starting test runner...");

    const server = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'] // Pipe stderr too
    });

    server.stderr.on('data', (data) => {
        log(`[SERVER STDERR] ${data}`);
    });

    let messageId = 0;
    const pendingRequests = new Map();

    server.stdout.on('data', (data) => {
        log(`[SERVER STDOUT RAW] ${data}`);
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && pendingRequests.has(msg.id)) {
                    log(`[RPC RES] ${msg.id}`);
                    const { resolve, reject } = pendingRequests.get(msg.id);
                    pendingRequests.delete(msg.id);
                    if (msg.error) reject(msg.error);
                    else resolve(msg.result);
                }
            } catch (e) {
                log(`[PARSE ERR] ${e.message} for line: ${line}`);
            }
        }
    });

    const send = (method, params) => {
        return new Promise((resolve, reject) => {
            messageId++;
            const req = { jsonrpc: "2.0", id: messageId, method, params };
            log(`[RPC REQ] ${JSON.stringify(req)}`);
            pendingRequests.set(messageId, { resolve, reject });
            server.stdin.write(JSON.stringify(req) + "\n");
        });
    };

    try {
        log("Sending initialize...");
        // Initialize
        await send("initialize", {
            protocolVersion: "2024-11-05", // Spec says 2024-11-05
            clientInfo: { name: "test-runner", version: "1.0.0" },
            capabilities: {}
        });
        log("Initialized received.");

        await new Promise(r => setTimeout(r, 500));

        server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        log("Sent notifications/initialized.");

        for (const scenario of SCENARIOS) {
            log(`Running scenario: ${scenario.name}`);
            try {
                const result = await send("tools/call", {
                    name: "sequentialthinking_tools",
                    arguments: scenario.input
                });

                log(`Got result for ${scenario.name}`);

                const contentItem = result.content.find(c => c.type === 'text');
                let parsedContent = null;

                if (contentItem) {
                    try {
                        const jsonBlock = contentItem.text;
                        log(`Content text: ${jsonBlock.substring(0, 100)}...`);
                        parsedContent = JSON.parse(jsonBlock);
                        if (parsedContent.structuredContent) {
                            parsedContent = parsedContent.structuredContent;
                        }
                    } catch (e) {
                        log(`JSON Parse error on content: ${e.message}`);
                    }
                }

                if (!parsedContent) {
                    console.log(`| ${scenario.name} | ❌ Failed | Invalid output format |`);
                    log(`Invalid output format for ${scenario.name}. Result: ${JSON.stringify(result)}`);
                    continue;
                }

                if (scenario.verify(parsedContent)) {
                    console.log(`| ${scenario.name} | ✅ Passed | |`);
                } else {
                    console.log(`| ${scenario.name} | ❌ Failed | Verification failed |`);
                    log(`Verification Failed Payload: ${JSON.stringify(parsedContent)}`);
                }

            } catch (err) {
                console.log(`| ${scenario.name} | ❌ Error | ${err.message || JSON.stringify(err)} |`);
                log(`Error in scenario: ${err.message}`);
            }
        }

    } catch (e) {
        console.error("Runner failed:", e);
        log(`Runner crashed: ${e.message}`);
    } finally {
        server.kill();
        log("Server killed.");
    }
}

runTests();
