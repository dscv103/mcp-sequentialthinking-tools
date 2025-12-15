# Merged Source (src/)

Complete in-repo snapshot of the TypeScript implementation for review.

## src/index.ts

```typescript
#!/usr/bin/env node

// adapted from https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/index.ts
// for use with mcp tools

import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { StdioTransport } from '@tmcp/transport-stdio';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SequentialThinkingSchema, SEQUENTIAL_THINKING_TOOL } from './schema.js';
import { ThoughtData, Tool } from './types.js';
import { logger, measureTime } from './logging.js';
import { CircuitBreaker, createErrorContext } from './error-handling.js';
import { PersistenceLayer } from './persistence.js';
import { ToolCapabilityMatcher, enrichToolsWithCapabilities } from './tool-capabilities.js';
import { BacktrackingManager } from './backtracking.js';
import { ThoughtDAG } from './dag.js';
import { ToolChainLibrary } from './tool-chains.js';
import { ConfigurationManager, RuntimeConfig } from './config-manager.js';
import { ScoringConfigShape } from './config-constants.js';
import { ThoughtProcessor } from './thought-processor.js';

const DEFAULT_MAX_HISTORY = 1000;
const METRICS_INTERVAL_MS = 5 * 60 * 1000;

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const package_json = JSON.parse(
    readFileSync(join(__dirname, '../package.json'), 'utf-8'),
);
const { name, version } = package_json;

// Create MCP server with tmcp
const adapter = new ValibotJsonSchemaAdapter();
const server = new McpServer(
    {
        name,
        version,
        description: 'MCP server for Sequential Thinking Tools',
    },
    {
        adapter,
        capabilities: {
            tools: { listChanged: true },
        },
    },
);

interface ServerOptions {
    available_tools?: Tool[];
    availableTools?: Tool[];
    maxHistorySize?: number;
    enablePersistence?: boolean;
    dbPath?: string;
    sessionId?: string;
    enableBacktracking?: boolean;
    minConfidence?: number;
    enableDAG?: boolean;
    enableToolChains?: boolean;
    configManager?: ConfigurationManager;
    scoringConfig?: ScoringConfigShape;
}

class ToolAwareSequentialThinkingServer {
    private availableTools: Map<string, Tool> = new Map();
    private maxHistorySize: number;
    private persistence: PersistenceLayer;
    private sessionId: string;
    private toolMatcher: ToolCapabilityMatcher;
    private backtrackingManager: BacktrackingManager;
    private thoughtDAG: ThoughtDAG;
    private toolChainLibrary: ToolChainLibrary;
    private enableDAG: boolean;
    private enableToolChains: boolean;
    private sessionLocks: Map<string, Promise<unknown>> = new Map();
    private scoringConfig: ScoringConfigShape;
    private processor: ThoughtProcessor;
    private persistenceBreaker: CircuitBreaker;
    private dagBreaker: CircuitBreaker;

    public getAvailableTools(): Tool[] {
        return Array.from(this.availableTools.values());
    }

    private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
        const run = previous.then(fn);
        const trackedRun = run.catch((error) => {
            logger.error('Session lock task failed', error, { sessionId });
            throw error;
        });
        const tracker = trackedRun.finally(() => {
            if (this.sessionLocks.get(sessionId) === tracker) {
                this.sessionLocks.delete(sessionId);
            }
        });
        this.sessionLocks.set(sessionId, tracker);
        return trackedRun;
    }

    constructor(options: ServerOptions = {}) {
        const configManager = options.configManager ?? new ConfigurationManager();
        const loadedRuntime = configManager.getRuntimeConfig();

        const runtimeConfig: RuntimeConfig = {
            ...loadedRuntime,
            maxHistorySize: options.maxHistorySize ?? loadedRuntime.maxHistorySize ?? DEFAULT_MAX_HISTORY,
            enablePersistence: options.enablePersistence ?? loadedRuntime.enablePersistence,
            dbPath: options.dbPath ?? loadedRuntime.dbPath,
            enableBacktracking: options.enableBacktracking ?? loadedRuntime.enableBacktracking,
            minConfidence: options.minConfidence ?? loadedRuntime.minConfidence,
            enableDAG: options.enableDAG ?? loadedRuntime.enableDAG,
            enableToolChains: options.enableToolChains ?? loadedRuntime.enableToolChains,
            logLevel: loadedRuntime.logLevel,
        };

        this.scoringConfig = options.scoringConfig ?? configManager.getScoringConfig();
        this.maxHistorySize = runtimeConfig.maxHistorySize;
        this.sessionId = options.sessionId || `session-${Date.now()}`;
        this.enableDAG = runtimeConfig.enableDAG;
        this.enableToolChains = runtimeConfig.enableToolChains;
        this.persistenceBreaker = new CircuitBreaker({
            failureThreshold: 3,
            resetTimeoutMs: 5000,
            halfOpenSuccessThreshold: 1,
            name: 'persistence',
        });
        this.dagBreaker = new CircuitBreaker({
            failureThreshold: 3,
            resetTimeoutMs: 2000,
            halfOpenSuccessThreshold: 1,
            name: 'dag',
        });
        
        // Initialize persistence layer
        this.persistence = new PersistenceLayer({
            enablePersistence: runtimeConfig.enablePersistence,
            dbPath: runtimeConfig.dbPath,
        });
        
        // Initialize backtracking manager
        this.backtrackingManager = new BacktrackingManager({
            ...this.scoringConfig.backtracking,
            enableAutoBacktrack: runtimeConfig.enableBacktracking,
            minConfidence: runtimeConfig.minConfidence,
            maxBacktrackDepth: this.scoringConfig.backtracking.maxBacktrackDepth,
            baseConfidence: this.scoringConfig.backtracking.baseConfidence,
            toolConfidenceWeight: this.scoringConfig.backtracking.toolConfidenceWeight,
            revisionPenalty: this.scoringConfig.backtracking.revisionPenalty,
            branchBonus: this.scoringConfig.backtracking.branchBonus,
            progressBonus: this.scoringConfig.backtracking.progressBonus,
            progressThreshold: this.scoringConfig.backtracking.progressThreshold,
            decliningConfidenceThreshold: this.scoringConfig.backtracking.decliningConfidenceThreshold,
        });
        
        // Initialize DAG for parallel execution
        this.thoughtDAG = new ThoughtDAG();
        
        // Initialize tool chain library
        this.toolChainLibrary = new ToolChainLibrary(this.scoringConfig.toolChains);

        this.processor = new ThoughtProcessor({
            backtrackingManager: this.backtrackingManager,
            persistence: this.persistence,
            thoughtDAG: this.thoughtDAG,
            toolChainLibrary: this.toolChainLibrary,
            enableDAG: this.enableDAG,
            enableToolChains: this.enableToolChains,
            maxHistorySize: this.maxHistorySize,
            sessionId: this.sessionId,
            scoringConfig: this.scoringConfig,
            persistenceBreaker: this.persistenceBreaker,
            dagBreaker: this.dagBreaker,
        });
        
        logger.info('Server initialized', { 
            maxHistorySize: this.maxHistorySize,
            sessionId: this.sessionId,
            persistenceEnabled: runtimeConfig.enablePersistence,
            backtrackingEnabled: runtimeConfig.enableBacktracking,
            dagEnabled: this.enableDAG,
            toolChainsEnabled: this.enableToolChains,
        });
        
        // Always include the sequential thinking tool
        if (options.available_tools && !options.availableTools) {
            logger.warn('The "available_tools" option is deprecated. Use "availableTools" instead.');
        }
        const providedTools = options.availableTools ?? options.available_tools ?? [];
        const tools = [
            SEQUENTIAL_THINKING_TOOL,
            ...providedTools,
        ];

        // Initialize with provided tools
        tools.forEach((tool) => {
            if (this.availableTools.has(tool.name)) {
                logger.warn('Duplicate tool name detected', { 
                    toolName: tool.name,
                    message: 'Using first occurrence'
                });
                return;
            }
            this.availableTools.set(tool.name, tool);
        });

        // Enrich tools with capability metadata
        enrichToolsWithCapabilities(this.availableTools);
        
        // Initialize tool matcher
        this.toolMatcher = new ToolCapabilityMatcher(this.availableTools);

        logger.info('Tools initialized', { 
            toolCount: this.availableTools.size,
            tools: Array.from(this.availableTools.keys()),
            categories: this.toolMatcher.getCategories(),
            tags: this.toolMatcher.getTags(),
        });
    }

    public clearHistory(): void {
        this.processor.clear();
        this.persistence.clearHistory(this.sessionId);
        logger.info('History cleared', { sessionId: this.sessionId });
    }

    public addTool(tool: Tool): void {
        if (this.availableTools.has(tool.name)) {
            logger.warn('Tool already exists', { toolName: tool.name });
            return;
        }
        this.availableTools.set(tool.name, tool);
        
        // Enrich with capabilities if not present
        enrichToolsWithCapabilities(this.availableTools);
        
        // Recreate matcher with updated tools
        this.toolMatcher = new ToolCapabilityMatcher(this.availableTools);
        
        logger.info('Tool added', { toolName: tool.name });
    }

    public discoverTools(): void {
        // In a real implementation, this would scan the environment
        // for available MCP tools and add them to availableTools
        logger.warn('Tool discovery not implemented - manually add tools via addTool()');
    }

    public shutdown(): void {
        // Close database connection
        this.persistence.close();
        logger.info('Server shutdown complete');
    }

    public async processThought(input: v.InferInput<typeof SequentialThinkingSchema>) {
        return measureTime('processThought', async () => {
            return this.withSessionLock(this.sessionId, async () => {
                try {
                    const validatedInput = input as ThoughtData;

                    logger.debug('Processing thought', {
                        thoughtNumber: validatedInput.thought_number,
                        totalThoughts: validatedInput.total_thoughts,
                        isRevision: validatedInput.is_revision,
                        branchId: validatedInput.branch_id,
                    });

                    return await this.processor.processThought(validatedInput);
                } catch (error) {
                    const errorContext = createErrorContext('processThought', error, {
                        thoughtNumber: input.thought_number,
                        branchId: input.branch_id,
                    });

                    const errorPayload = {
                        error: errorContext.error,
                        errorType: errorContext.errorType,
                        errorCategory: errorContext.category,
                        status: 'failed' as const,
                        context: errorContext,
                    };

                    logger.error('Failed to process thought', error, { 
                        operation: errorContext.operation,
                        timestamp: errorContext.timestamp,
                        errorType: errorContext.errorType,
                        thoughtNumber: errorContext.thoughtNumber,
                        branchId: errorContext.branchId,
                    });
                    
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify(errorPayload, null, 2),
                            },
                        ],
                        structuredContent: errorPayload,
                        isError: true,
                    };
                }
            });
        });
    }

    // Tool execution removed - the MCP client handles tool execution
    // This server only provides tool recommendations
}

// Read configuration from environment variables or command line args
const configurationManager = new ConfigurationManager();
const scoringConfig = configurationManager.getScoringConfig();
const runtimeConfig = configurationManager.getRuntimeConfig();

logger.info('Starting MCP Sequential Thinking Tools server', {
    maxHistorySize: runtimeConfig.maxHistorySize,
    enablePersistence: runtimeConfig.enablePersistence,
    dbPath: runtimeConfig.enablePersistence ? runtimeConfig.dbPath : 'disabled',
    enableBacktracking: runtimeConfig.enableBacktracking,
    minConfidence: runtimeConfig.minConfidence,
    enableDAG: runtimeConfig.enableDAG,
    enableToolChains: runtimeConfig.enableToolChains,
});

const thinkingServer = new ToolAwareSequentialThinkingServer({
    availableTools: [], // TODO: Add tool discovery mechanism
    maxHistorySize: runtimeConfig.maxHistorySize,
    enablePersistence: runtimeConfig.enablePersistence,
    dbPath: runtimeConfig.dbPath,
    enableBacktracking: runtimeConfig.enableBacktracking,
    minConfidence: runtimeConfig.minConfidence,
    enableDAG: runtimeConfig.enableDAG,
    enableToolChains: runtimeConfig.enableToolChains,
    configManager: configurationManager,
    scoringConfig,
});

// Register the sequential thinking tool
server.tool(
    {
        name: 'sequentialthinking_tools',
        description: SEQUENTIAL_THINKING_TOOL.description,
        schema: SequentialThinkingSchema,
    },
    async (input) => {
        return thinkingServer.processThought(input);
    },
);

async function main() {
    const transport = new StdioTransport(server);
    transport.listen();
    logger.info('Sequential Thinking MCP Server running on stdio');
    
    // Log metrics periodically (every 5 minutes)
    const metricsInterval = setInterval(() => {
        logger.logMetrics();
    }, METRICS_INTERVAL_MS);

    // Clean up resources on shutdown
    const cleanup = () => {
        logger.info('Shutting down server...');
        clearInterval(metricsInterval);
        thinkingServer.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('beforeExit', cleanup);
}

main().catch((error) => {
    logger.error('Fatal error running server', error);
    process.exit(1);
});
```

## src/schema.ts

```typescript
import * as v from 'valibot';
import { Tool } from './types.js';

const TOOL_DESCRIPTION = `A detailed tool for dynamic and reflective problem-solving through thoughts.
This tool helps analyze problems through a flexible thinking process that can adapt and evolve.
Each thought can build on, question, or revise previous insights as understanding deepens.

IMPORTANT: This server facilitates sequential thinking with MCP tool coordination. The LLM analyzes available tools and their descriptions to make intelligent recommendations, which are then tracked and organized by this server.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Problems that require a multi-step solution
- Tasks that need to maintain context over multiple steps
- Situations where irrelevant information needs to be filtered out
- When you need guidance on which tools to use and in what order

Key features:
- You can adjust total_thoughts up or down as you progress
- You can question or revise previous thoughts
- You can add more thoughts even after reaching what seemed like the end
- You can express uncertainty and explore alternative approaches
- Not every thought needs to build linearly - you can branch or backtrack
- Generates a solution hypothesis
- Verifies the hypothesis based on the Chain of Thought steps
- Recommends appropriate tools for each step
- Provides rationale for tool recommendations
- Suggests tool execution order and parameters
- Tracks previous recommendations and remaining steps
- Confidence scoring helps identify low-quality reasoning paths
- Automatic backtracking suggestions when confidence is low

Parameters explained:
- available_mcp_tools: Array of MCP tool names that are available for use (e.g., ["mcp-omnisearch", "mcp-turso-cloud"])
- thought: Your current thinking step, which can include:
* Regular analytical steps
* Revisions of previous thoughts
* Questions about previous decisions
* Realizations about needing more analysis
* Changes in approach
* Hypothesis generation
* Hypothesis verification
* Tool recommendations and rationale
- next_thought_needed: True if you need more thinking, even if at what seemed like the end
- thought_number: Current number in sequence (can go beyond initial total if needed)
- total_thoughts: Current estimate of thoughts needed (can be adjusted up/down)
- is_revision: A boolean indicating if this thought revises previous thinking
- revises_thought: If is_revision is true, which thought number is being reconsidered
- branch_from_thought: If branching, which thought number is the branching point
- branch_id: Identifier for the current branch (if any)
- needs_more_thoughts: If reaching end but realizing more thoughts needed
- confidence: Optional confidence score (0-1) for current thought path quality
- current_step: Current step recommendation, including:
* step_description: What needs to be done
* recommended_tools: Tools recommended for this step
* expected_outcome: What to expect from this step
* next_step_conditions: Conditions to consider for the next step
- previous_steps: Steps already recommended
- remaining_steps: High-level descriptions of upcoming steps

You should:
1. Start with an initial estimate of needed thoughts, but be ready to adjust
2. Feel free to question or revise previous thoughts
3. Don't hesitate to add more thoughts if needed, even at the "end"
4. Express uncertainty when present
5. Mark thoughts that revise previous thinking or branch into new paths
6. Ignore information that is irrelevant to the current step
7. Generate a solution hypothesis when appropriate
8. Verify the hypothesis based on the Chain of Thought steps
9. Consider available tools that could help with the current step
10. Provide clear rationale for tool recommendations
11. Suggest specific tool parameters when appropriate
12. Consider alternative tools for each step
13. Track progress through the recommended steps
14. Optionally provide confidence scores to enable quality monitoring
15. Pay attention to backtracking suggestions if confidence is low
16. Provide a single, ideally correct answer as the final output
17. Only set next_thought_needed to false when truly done and a satisfactory answer is reached`;

export const ToolRecommendationSchema = v.object({
    tool_name: v.pipe(
        v.string(),
        v.description('Name of the tool being recommended')
    ),
    confidence: v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(1),
        v.description('0-1 indicating confidence in recommendation')
    ),
    rationale: v.pipe(
        v.string(),
        v.description('Why this tool is recommended')
    ),
    priority: v.pipe(
        v.number(),
        v.description('Order in the recommendation sequence')
    ),
    suggested_inputs: v.optional(v.pipe(
        v.record(v.string(), v.unknown()),
        v.description('Optional suggested parameters')
    )),
    alternatives: v.optional(v.pipe(
        v.array(v.string()),
        v.description('Alternative tools that could be used')
    ))
});

export const StepRecommendationSchema = v.object({
    step_description: v.pipe(
        v.string(),
        v.description('What needs to be done')
    ),
    recommended_tools: v.pipe(
        v.array(ToolRecommendationSchema),
        v.description('Tools recommended for this step')
    ),
    expected_outcome: v.pipe(
        v.string(),
        v.description('What to expect from this step')
    ),
    next_step_conditions: v.optional(v.pipe(
        v.array(v.string()),
        v.description('Conditions to consider for the next step')
    ))
});

export const SequentialThinkingSchema = v.object({
    available_mcp_tools: v.pipe(
        v.array(v.string()),
        v.description('Array of MCP tool names available for use (e.g., ["mcp-omnisearch", "mcp-turso-cloud"])')
    ),
    thought: v.pipe(
        v.string(),
        v.description('Your current thinking step')
    ),
    next_thought_needed: v.pipe(
        v.boolean(),
        v.description('Whether another thought step is needed')
    ),
    thought_number: v.pipe(
        v.number(),
        v.minValue(1),
        v.description('Current thought number')
    ),
    total_thoughts: v.pipe(
        v.number(),
        v.minValue(1),
        v.description('Estimated total thoughts needed')
    ),
    is_revision: v.optional(v.pipe(
        v.boolean(),
        v.description('Whether this revises previous thinking')
    )),
    revises_thought: v.optional(v.pipe(
        v.number(),
        v.minValue(1),
        v.description('Which thought is being reconsidered')
    )),
    branch_from_thought: v.optional(v.pipe(
        v.number(),
        v.minValue(1),
        v.description('Branching point thought number')
    )),
    branch_id: v.optional(v.pipe(
        v.string(),
        v.description('Branch identifier')
    )),
    needs_more_thoughts: v.optional(v.pipe(
        v.boolean(),
        v.description('If more thoughts are needed')
    )),
    current_step: v.optional(v.pipe(
        StepRecommendationSchema,
        v.description('Current step recommendation')
    )),
    previous_steps: v.optional(v.pipe(
        v.array(StepRecommendationSchema),
        v.description('Steps already recommended')
    )),
    remaining_steps: v.optional(v.pipe(
        v.array(v.string()),
        v.description('High-level descriptions of upcoming steps')
    )),
    confidence: v.optional(v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(1),
        v.description('Confidence score (0-1) for current thought path')
    ))
});

export const SEQUENTIAL_THINKING_TOOL: Tool = {
    name: 'sequentialthinking_tools',
    description: TOOL_DESCRIPTION,
    inputSchema: {} // This will be handled by tmcp with the schema above
};
```

## src/thought-processor.ts

```typescript
import { BacktrackingManager } from './backtracking.js';
import { CircuitBreaker, CircuitBreakerOpenError } from './error-handling.js';
import { logger } from './logging.js';
import { PersistenceLayer } from './persistence.js';
import { ThoughtDAG } from './dag.js';
import { ToolChainLibrary } from './tool-chains.js';
import { StepRecommendation, ThoughtData } from './types.js';
import { ScoringConfigShape } from './config-constants.js';

export interface ThoughtProcessorDeps {
    backtrackingManager: BacktrackingManager;
    persistence: PersistenceLayer;
    thoughtDAG: ThoughtDAG;
    toolChainLibrary: ToolChainLibrary;
    enableDAG: boolean;
    enableToolChains: boolean;
    maxHistorySize: number;
    sessionId: string;
    scoringConfig: ScoringConfigShape;
    persistenceBreaker: CircuitBreaker;
    dagBreaker: CircuitBreaker;
}

export class ThoughtProcessor {
    private thoughtHistory: ThoughtData[] = [];
    private branches: Record<string, ThoughtData[]> = {};
    private branchOrder: string[] = [];
    private formatCache: Map<string, string> = new Map();
    private static readonly FORMAT_CACHE_LIMIT = 200;

    constructor(private readonly deps: ThoughtProcessorDeps) {}

    clear(): void {
        this.thoughtHistory = [];
        this.branches = {};
        this.branchOrder = [];
        this.formatCache.clear();
        this.deps.backtrackingManager.clear();
        this.deps.thoughtDAG.clear();
        this.deps.toolChainLibrary.clear();
        logger.info('Processor state cleared', { sessionId: this.deps.sessionId });
    }

    private formatRecommendation(step: StepRecommendation): string {
        const tools = step.recommended_tools
            .map((tool) => {
                const alternatives = tool.alternatives?.length 
                    ? ` (alternatives: ${tool.alternatives.join(', ')})`
                    : '';
                const inputs = tool.suggested_inputs 
                    ? `\n    Suggested inputs: ${JSON.stringify(tool.suggested_inputs)}`
                    : '';
                return [
                    `  - ${tool.tool_name} (priority: ${tool.priority})${alternatives}`,
                    `    Rationale: ${tool.rationale}${inputs}`,
                ].join('\n');
            })
            .join('\n');

        return `Step: ${step.step_description}
Recommended Tools:
${tools}
Expected Outcome: ${step.expected_outcome}${
            step.next_step_conditions
                ? `\nConditions for next step:\n  - ${step.next_step_conditions.join('\n  - ')}`
                : ''
        }`;
    }

    private formatThought(thoughtData: ThoughtData): string {
        const {
            thought_number,
            total_thoughts,
            thought,
            is_revision,
            revises_thought,
            branch_from_thought,
            branch_id,
            current_step,
        } = thoughtData;

        let prefix = '';
        let context = '';

        if (is_revision) {
            prefix = '🔄 Revision';
            context = ` (revising thought ${revises_thought})`;
        } else if (branch_from_thought) {
            prefix = '🌿 Branch';
            context = ` (from thought ${branch_from_thought}, ID: ${branch_id})`;
        } else {
            prefix = '💭 Thought';
            context = '';
        }

        const cacheKey = [
            thought_number,
            total_thoughts,
            thought,
            current_step?.step_description ?? '',
            current_step?.expected_outcome ?? '',
            is_revision ? 'rev' : 'no-rev',
            revises_thought ?? '',
            branch_from_thought ?? '',
            branch_id ?? '',
        ].join('|');

        const cached = this.formatCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const header = `${prefix} ${thought_number}/${total_thoughts}${context}`;
        const content = current_step
            ? `${thought}\n\nRecommendation:\n${this.formatRecommendation(current_step)}`
            : thought;

        const lines = [header, ...content.split('\n')];
        const innerWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);
        const border = '─'.repeat(innerWidth + 2);
        const formatLine = (line: string) => `│ ${line.padEnd(innerWidth)} │`;

        const formattedContent = content
            .split('\n')
            .map(formatLine)
            .join('\n');

        const formatted = `
┌${border}┐
${formatLine(header)}
├${border}┤
${formattedContent}
└${border}┘`;

        this.formatCache.set(cacheKey, formatted);
        if (this.formatCache.size > ThoughtProcessor.FORMAT_CACHE_LIMIT) {
            const oldestKey = this.formatCache.keys().next().value as string | undefined;
            if (oldestKey) {
                this.formatCache.delete(oldestKey);
            }
        }
        return formatted;
    }

    private prepareThought(input: ThoughtData): ThoughtData {
        const thought = { ...input };

        if (thought.thought_number > thought.total_thoughts) {
            thought.total_thoughts = thought.thought_number;
        }

        if (thought.confidence === undefined) {
            thought.confidence = this.deps.backtrackingManager.calculateConfidence(thought);
        }

        return thought;
    }

    private evaluateBacktracking(thought: ThoughtData) {
        const backtrackDecision = this.deps.backtrackingManager.shouldBacktrack(thought);
        if (backtrackDecision.shouldBacktrack) {
            logger.warn('Backtracking triggered', {
                thoughtNumber: thought.thought_number,
                reason: backtrackDecision.reason,
                backtrackTo: backtrackDecision.backtrackTo,
            });

            const backtrackPayload = {
                thought_number: thought.thought_number,
                total_thoughts: thought.total_thoughts,
                confidence: thought.confidence,
                backtracking_suggested: true,
                backtrack_reason: backtrackDecision.reason,
                backtrack_to_thought: backtrackDecision.backtrackTo,
                message:
                    'Low confidence detected. Consider revising approach from earlier thought.',
            };
            
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(backtrackPayload, null, 2),
                    },
                ],
                structuredContent: backtrackPayload,
            };
        }

        return null;
    }

    private recordStep(thought: ThoughtData): void {
        if (!thought.current_step) return;

        if (!thought.previous_steps) {
            thought.previous_steps = [];
        }
        thought.previous_steps.push(thought.current_step);

        if (this.deps.enableToolChains) {
            for (const toolRec of thought.current_step.recommended_tools) {
                this.deps.toolChainLibrary.recordToolUse(
                    toolRec.tool_name,
                    thought.current_step.step_description
                );
            }
        }
    }

    private updateBranches(thought: ThoughtData): void {
        if (thought.branch_from_thought && thought.branch_id) {
            if (!this.branches[thought.branch_id]) {
                this.branches[thought.branch_id] = [];
                this.branchOrder.push(thought.branch_id);
            }
            this.branches[thought.branch_id].push(thought);
            logger.debug('Branch updated', { 
                branchId: thought.branch_id,
                branchSize: this.branches[thought.branch_id].length
            });

            if (this.branchOrder.length > this.deps.maxHistorySize) {
                const oldestBranch = this.branchOrder.shift();
                if (oldestBranch) {
                    delete this.branches[oldestBranch];
                    logger.debug('Branch trimmed', { branchId: oldestBranch });
                }
            }
        }
    }

    private async persistThought(thought: ThoughtData): Promise<void> {
        try {
            await this.deps.persistenceBreaker.execute(() =>
                this.deps.persistence.saveThought(thought, this.deps.sessionId),
            );
        } catch (error) {
            if (error instanceof CircuitBreakerOpenError) {
                logger.warn('Persistence circuit breaker open, skipping persistence', {
                    thoughtNumber: thought.thought_number,
                });
                return;
            }
            logger.error('Failed to persist thought', error, { thoughtNumber: thought.thought_number });
        }
    }

    private async updateDAG(thought: ThoughtData): Promise<(ReturnType<ThoughtDAG['getStats']> & { parallelGroupCount?: number }) | undefined> {
        if (!this.deps.enableDAG) return undefined;
        
        try {
            return await this.deps.dagBreaker.execute(async () => {
                this.deps.thoughtDAG.addThought(thought);
                
                this.deps.thoughtDAG.markExecuting(thought.thought_number);
                this.deps.thoughtDAG.markCompleted(thought.thought_number, {
                    confidence: thought.confidence,
                    thoughtNumber: thought.thought_number,
                });
                
                const stats = this.deps.thoughtDAG.getStats();
                const parallelGroups = this.deps.thoughtDAG.getParallelGroups();
                const dagStats = { ...stats, parallelGroupCount: parallelGroups.length };
                logger.debug('DAG updated', dagStats);
                return dagStats;
            });
        } catch (dagError) {
            if (dagError instanceof CircuitBreakerOpenError) {
                logger.warn('DAG circuit breaker open, skipping DAG update', {
                    thoughtNumber: thought.thought_number,
                });
                return undefined;
            }

            logger.error('Failed to update DAG', dagError, {
                thoughtNumber: thought.thought_number,
            });
            return undefined;
        }
    }

    private enforceHistoryLimit(): void {
        if (this.thoughtHistory.length > this.deps.maxHistorySize) {
            const excess = this.thoughtHistory.length - this.deps.maxHistorySize;
            this.thoughtHistory.splice(0, excess);
            logger.warn('History trimmed', { maxSize: this.deps.maxHistorySize });
        }
    }

    private suggestNextTools(
        thought: ThoughtData,
    ): ReturnType<ToolChainLibrary['suggestNextTool']> | undefined {
        if (!this.deps.enableToolChains || !thought.previous_steps) return undefined;

        const previousTools = thought.previous_steps
            .flatMap(step => step.recommended_tools.map(t => t.tool_name));
        const nextToolSuggestions = this.deps.toolChainLibrary.suggestNextTool(previousTools);
        
        if (nextToolSuggestions.length > 0) {
            const toolChainSuggestions = nextToolSuggestions.slice(0, 3);
            logger.debug('Tool chain suggestions generated', {
                suggestionCount: toolChainSuggestions.length,
            });
            return toolChainSuggestions;
        }

        return undefined;
    }

    private finalizeToolChain(thought: ThoughtData): void {
        if (!this.deps.enableToolChains || thought.next_thought_needed) return;

        const success = (thought.confidence || 0.5) >= 0.5;
        this.deps.toolChainLibrary.finalizeCurrentChain(
            success,
            thought.confidence,
            thought.thought
        );
        logger.debug('Tool chain finalized', { 
            success, 
            confidence: thought.confidence 
        });
    }

    async processThought(input: ThoughtData) {
        const validatedInput = this.prepareThought(input);

        const backtrackResponse = this.evaluateBacktracking(validatedInput);
        if (backtrackResponse) {
            return backtrackResponse;
        }

        this.recordStep(validatedInput);

        const dagStats = await this.updateDAG(validatedInput);

        this.thoughtHistory.push(validatedInput);
        this.enforceHistoryLimit();

        this.updateBranches(validatedInput);

        await this.persistThought(validatedInput);

        const formattedThought = this.formatThought(validatedInput);
        logger.info(formattedThought);

        logger.info('Thought processed successfully', {
            thoughtNumber: validatedInput.thought_number,
            historyLength: this.thoughtHistory.length,
            confidence: validatedInput.confidence,
        });

        const confidenceStats = this.deps.backtrackingManager.getConfidenceStats();
        const toolChainSuggestions = this.suggestNextTools(validatedInput);
        this.finalizeToolChain(validatedInput);

        const payload = {
            thought_number: validatedInput.thought_number,
            total_thoughts: validatedInput.total_thoughts,
            next_thought_needed: validatedInput.next_thought_needed,
            confidence: validatedInput.confidence,
            confidence_stats: confidenceStats,
            branches: Object.keys(this.branches),
            thought_history_length: this.thoughtHistory.length,
            available_mcp_tools: validatedInput.available_mcp_tools,
            current_step: validatedInput.current_step,
            previous_steps: validatedInput.previous_steps,
            remaining_steps: validatedInput.remaining_steps,
            tool_chain_suggestions: toolChainSuggestions,
            dag_stats: dagStats,
        };

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(payload, null, 2),
                },
            ],
            structuredContent: payload,
        };
    }
}
```

## src/backtracking.ts

```typescript
/**
 * Backtracking support with confidence scoring
 * Enables pruning of low-quality reasoning paths
 */

import { ThoughtData } from './types.js';
import { logger } from './logging.js';
import { DEFAULT_SCORING_CONFIG } from './config-constants.js';

export interface BacktrackingConfig {
    minConfidence: number;  // Minimum confidence threshold (0-1)
    enableAutoBacktrack: boolean;  // Automatically backtrack on low confidence
    maxBacktrackDepth: number;  // Maximum number of thoughts to backtrack
    baseConfidence: number;  // Starting confidence baseline
    toolConfidenceWeight: number;  // Weight for tool recommendation confidence
    revisionPenalty: number;  // Penalty applied for revisions
    branchBonus: number;  // Bonus applied for branching
    progressBonus: number;  // Bonus for late-stage confidence
    progressThreshold: number;  // Threshold to apply progress bonus
    decliningConfidenceThreshold: number;  // Threshold for declining confidence trend
}

export interface BacktrackPoint {
    thoughtNumber: number;
    confidence: number;
    reason: string;
}

const DEFAULT_CONFIG: BacktrackingConfig = DEFAULT_SCORING_CONFIG.backtracking;

export class BacktrackingManager {
    private config: BacktrackingConfig;
    private backtrackHistory: BacktrackPoint[] = [];
    private thoughtConfidenceMap: Map<number, number> = new Map();

    constructor(config: Partial<BacktrackingConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        logger.info('Backtracking manager initialized', { 
            minConfidence: this.config.minConfidence,
            enableAutoBacktrack: this.config.enableAutoBacktrack,
            maxBacktrackDepth: this.config.maxBacktrackDepth,
        });
    }

    /**
     * Evaluate if a thought should trigger backtracking
     */
    shouldBacktrack(thought: ThoughtData): {
        shouldBacktrack: boolean;
        reason?: string;
        backtrackTo?: number;
    } {
        // Check if confidence scoring is being used
        if (thought.confidence === undefined) {
            return { shouldBacktrack: false };
        }

        // Store confidence for this thought
        this.thoughtConfidenceMap.set(thought.thought_number, thought.confidence);

        // Check if confidence is below threshold
        if (thought.confidence < this.config.minConfidence) {
            const backtrackPoint = this.findBacktrackPoint(thought.thought_number);
            
            logger.warn('Low confidence detected', {
                thoughtNumber: thought.thought_number,
                confidence: thought.confidence,
                threshold: this.config.minConfidence,
                backtrackTo: backtrackPoint,
            });

            if (this.config.enableAutoBacktrack && backtrackPoint !== null) {
                const reason = `Confidence ${thought.confidence.toFixed(2)} below threshold ${this.config.minConfidence}`;
                
                this.backtrackHistory.push({
                    thoughtNumber: thought.thought_number,
                    confidence: thought.confidence,
                    reason,
                });

                return {
                    shouldBacktrack: true,
                    reason,
                    backtrackTo: backtrackPoint,
                };
            }

            return {
                shouldBacktrack: false,
                reason: `Low confidence detected but auto-backtrack disabled`,
            };
        }

        return { shouldBacktrack: false };
    }

    /**
     * Find the best point to backtrack to
     */
    private findBacktrackPoint(currentThought: number): number | null {
        // Look backward to find a thought with acceptable confidence
        const startThought = Math.max(1, currentThought - this.config.maxBacktrackDepth);
        
        for (let i = currentThought - 1; i >= startThought; i--) {
            const confidence = this.thoughtConfidenceMap.get(i);
            if (confidence !== undefined && confidence >= this.config.minConfidence) {
                logger.debug('Found backtrack point', {
                    thoughtNumber: i,
                    confidence,
                });
                return i;
            }
        }

        // If no good backtrack point found, return the start of search range
        return startThought;
    }

    /**
     * Calculate confidence score for a thought
     * Uses multiple factors to determine confidence
     */
    calculateConfidence(thought: ThoughtData): number {
        let confidence = this.config.baseConfidence;

        // Factor 1: Tool recommendations confidence
        if (thought.current_step?.recommended_tools) {
            const toolConfidences = thought.current_step.recommended_tools.map(t => t.confidence);
            if (toolConfidences.length > 0) {
                const avgToolConfidence = toolConfidences.reduce((a, b) => a + b, 0) / toolConfidences.length;
                confidence += avgToolConfidence * this.config.toolConfidenceWeight;
            }
        }

        // Factor 2: Revision indicates uncertainty
        if (thought.is_revision) {
            confidence -= this.config.revisionPenalty;
        }

        // Factor 3: Branching indicates exploration (neutral to slightly positive)
        if (thought.branch_from_thought) {
            confidence += this.config.branchBonus;
        }

        // Factor 4: Progress toward goal
        if (thought.thought_number && thought.total_thoughts) {
            const progress = thought.thought_number / thought.total_thoughts;
            // Later thoughts with clear next steps are more confident
            if (!thought.next_thought_needed && progress > this.config.progressThreshold) {
                confidence += this.config.progressBonus;
            }
        }

        // Normalize to 0-1 range
        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Get confidence statistics for current session
     */
    getConfidenceStats(): {
        averageConfidence: number;
        minConfidence: number;
        maxConfidence: number;
        backtrackCount: number;
    } {
        const confidences = Array.from(this.thoughtConfidenceMap.values());
        
        if (confidences.length === 0) {
            return {
                averageConfidence: 0,
                minConfidence: 0,
                maxConfidence: 0,
                backtrackCount: this.backtrackHistory.length,
            };
        }

        return {
            averageConfidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
            minConfidence: Math.min(...confidences),
            maxConfidence: Math.max(...confidences),
            backtrackCount: this.backtrackHistory.length,
        };
    }

    /**
     * Get backtrack history
     */
    getBacktrackHistory(): BacktrackPoint[] {
        return [...this.backtrackHistory];
    }

    /**
     * Clear backtracking state
     */
    clear(): void {
        this.backtrackHistory = [];
        this.thoughtConfidenceMap.clear();
        logger.info('Backtracking state cleared');
    }

    /**
     * Suggest whether to continue on current path
     */
    suggestContinuation(recentThoughts: ThoughtData[]): {
        shouldContinue: boolean;
        reason: string;
        averageConfidence: number;
    } {
        if (recentThoughts.length === 0) {
            return {
                shouldContinue: true,
                reason: 'No thoughts to evaluate',
                averageConfidence: 1.0,
            };
        }

        const confidences = recentThoughts
            .map(t => t.confidence)
            .filter((c): c is number => c !== undefined);

        if (confidences.length === 0) {
            return {
                shouldContinue: true,
                reason: 'No confidence scores available',
                averageConfidence: 1.0,
            };
        }

        const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

        if (avgConfidence < this.config.minConfidence) {
            return {
                shouldContinue: false,
                reason: `Recent average confidence (${avgConfidence.toFixed(2)}) below threshold`,
                averageConfidence: avgConfidence,
            };
        }

        // Check for declining confidence trend
        if (confidences.length >= 3) {
            const recentThree = confidences.slice(-3);
            const isDecreasing = recentThree.every((val, idx) => 
                idx === 0 || val < recentThree[idx - 1]
            );

            if (isDecreasing && recentThree[recentThree.length - 1] < this.config.decliningConfidenceThreshold) {
                return {
                    shouldContinue: false,
                    reason: 'Declining confidence trend detected',
                    averageConfidence: avgConfidence,
                };
            }
        }

        return {
            shouldContinue: true,
            reason: 'Confidence levels acceptable',
            averageConfidence: avgConfidence,
        };
    }
}
```

## src/dag.ts

```typescript
/**
 * DAG-based task execution for parallel thought processing
 * Enables parallel execution of independent reasoning paths
 */

import { ThoughtData } from './types.js';
import { logger } from './logging.js';

export interface DAGNode {
    thoughtNumber: number;
    thought: ThoughtData;
    dependencies: number[]; // Thought numbers this depends on
    children: number[]; // Thought numbers that depend on this
    level?: number;
    status: 'pending' | 'ready' | 'executing' | 'completed' | 'failed';
    result?: unknown;
    error?: string;
}

export interface DAGExecutionResult {
    completedNodes: number[];
    failedNodes: number[];
    totalDuration: number;
}

export class DagCycleError extends Error {
    constructor(thoughtNumber: number) {
        super(`Cycle detected in DAG at thought ${thoughtNumber}`);
        this.name = 'DagCycleError';
    }
}

export class ThoughtDAG {
    private nodes: Map<number, DAGNode> = new Map();
    private executionOrder: number[] = [];
    private levelCache: Map<number, number> = new Map();
    private parallelGroupsCache: number[][] | null = null;
    private cacheDirty = false;

    private invalidateCache(): void {
        this.cacheDirty = true;
        this.parallelGroupsCache = null;
    }

    /**
     * Add a thought to the DAG
     */
    addThought(thought: ThoughtData): void {
        const dependencies: number[] = [];

        // Determine dependencies based on thought metadata
        if (thought.revises_thought) {
            // Depends on the thought being revised
            dependencies.push(thought.revises_thought);
        } else if (thought.branch_from_thought) {
            // Depends on the branching point
            dependencies.push(thought.branch_from_thought);
        } else if (thought.thought_number > 1) {
            // By default, depends on previous thought
            dependencies.push(thought.thought_number - 1);
        }

        const parentLevels = dependencies.map(dep => this.nodes.get(dep)?.level ?? 0);
        const maxParentLevel = parentLevels.reduce((max, current) => Math.max(max, current), 0);
        const level = parentLevels.length > 0 ? maxParentLevel + 1 : 0;

        const node: DAGNode = {
            thoughtNumber: thought.thought_number,
            thought,
            dependencies,
            children: [],
            level,
            status: dependencies.length === 0 ? 'ready' : 'pending',
        };

        this.nodes.set(thought.thought_number, node);
        this.levelCache.set(thought.thought_number, level);
        this.invalidateCache();

        // Update parent nodes to reference this as a child
        for (const depNum of dependencies) {
            const parentNode = this.nodes.get(depNum);
            if (parentNode) {
                parentNode.children.push(thought.thought_number);
            }
        }

        logger.debug('Thought added to DAG', {
            thoughtNumber: thought.thought_number,
            dependencies,
            level,
            status: node.status,
        });
    }

    /**
     * Get thoughts that are ready to execute (all dependencies completed)
     */
    getReadyThoughts(): DAGNode[] {
        const ready: DAGNode[] = [];

        for (const node of this.nodes.values()) {
            if (node.status === 'pending') {
                // Check if all dependencies are completed
                const allDependenciesCompleted = node.dependencies.every(depNum => {
                    const depNode = this.nodes.get(depNum);
                    return depNode?.status === 'completed';
                });

                if (allDependenciesCompleted) {
                    node.status = 'ready';
                    ready.push(node);
                }
            } else if (node.status === 'ready') {
                ready.push(node);
            }
        }

        return ready;
    }

    /**
     * Mark a thought as executing
     */
    markExecuting(thoughtNumber: number): void {
        const node = this.nodes.get(thoughtNumber);
        if (node) {
            node.status = 'executing';
            logger.debug('Thought marked as executing', { thoughtNumber });
            this.invalidateCache();
        }
    }

    /**
     * Mark a thought as completed
     */
    markCompleted(thoughtNumber: number, result?: unknown): void {
        const node = this.nodes.get(thoughtNumber);
        if (node) {
            node.status = 'completed';
            node.result = result;
            logger.debug('Thought marked as completed', { thoughtNumber });
            this.invalidateCache();

            // Update children that may now be ready
            for (const childNum of node.children) {
                const childNode = this.nodes.get(childNum);
                if (childNode && childNode.status === 'pending') {
                    const allDepsCompleted = childNode.dependencies.every(depNum => {
                        const depNode = this.nodes.get(depNum);
                        return depNode?.status === 'completed';
                    });

                    if (allDepsCompleted) {
                        childNode.status = 'ready';
                    }
                }
            }
        }
    }

    /**
     * Mark a thought as failed
     */
    markFailed(thoughtNumber: number, error: string): void {
        const node = this.nodes.get(thoughtNumber);
        if (node) {
            node.status = 'failed';
            node.error = error;
            logger.error('Thought failed', new Error(error), { thoughtNumber });
            this.invalidateCache();

            // Optionally mark children as failed too
            this.propagateFailure(thoughtNumber);
        }
    }

    /**
     * Propagate failure to dependent thoughts
     */
    private propagateFailure(thoughtNumber: number): void {
        const node = this.nodes.get(thoughtNumber);
        if (!node) return;

        for (const childNum of node.children) {
            const childNode = this.nodes.get(childNum);
            if (childNode && childNode.status !== 'completed') {
                childNode.status = 'failed';
                childNode.error = `Dependency thought ${thoughtNumber} failed`;
                logger.debug('Propagated failure to child', { 
                    childNum, 
                    parentNum: thoughtNumber 
                });
                // Recursively propagate
                this.propagateFailure(childNum);
            }
        }
    }

    /**
     * Perform topological sort to get execution order
     */
    topologicalSort(): number[] {
        const sorted: number[] = [];
        const visited = new Set<number>();
        const visiting = new Set<number>();

        const visit = (thoughtNum: number): boolean => {
            if (visited.has(thoughtNum)) return true;
            if (visiting.has(thoughtNum)) {
                // Cycle detected
                logger.warn('Cycle detected in thought DAG', { thoughtNum });
                return false;
            }

            visiting.add(thoughtNum);

            const node = this.nodes.get(thoughtNum);
            if (node) {
                // Visit dependencies first
                for (const depNum of node.dependencies) {
                    if (!visit(depNum)) return false;
                }
            }

            visiting.delete(thoughtNum);
            visited.add(thoughtNum);
            sorted.push(thoughtNum);
            return true;
        };

        // Visit all nodes
        for (const thoughtNum of this.nodes.keys()) {
            if (!visited.has(thoughtNum)) {
                if (!visit(thoughtNum)) {
                    logger.error('Failed to perform topological sort due to cycles');
                    return [];
                }
            }
        }

        this.executionOrder = sorted;
        logger.info('Topological sort completed', { 
            nodeCount: sorted.length,
            order: sorted,
        });
        this.invalidateCache();

        return sorted;
    }

    /**
     * Get execution statistics
     */
    getStats(): {
        total: number;
        pending: number;
        ready: number;
        executing: number;
        completed: number;
        failed: number;
    } {
        const stats = {
            total: this.nodes.size,
            pending: 0,
            ready: 0,
            executing: 0,
            completed: 0,
            failed: 0,
        };

        for (const node of this.nodes.values()) {
            switch (node.status) {
                case 'pending':
                    stats.pending++;
                    break;
                case 'ready':
                    stats.ready++;
                    break;
                case 'executing':
                    stats.executing++;
                    break;
                case 'completed':
                    stats.completed++;
                    break;
                case 'failed':
                    stats.failed++;
                    break;
            }
        }

        return stats;
    }

    /**
     * Check if all thoughts are completed
     */
    isComplete(): boolean {
        for (const node of this.nodes.values()) {
            if (node.status !== 'completed' && node.status !== 'failed') {
                return false;
            }
        }
        return true;
    }

    /**
     * Get parallel execution groups
     * Returns thoughts grouped by execution level (can run in parallel)
     */
    getParallelGroups(): number[][] {
        if (!this.cacheDirty && this.parallelGroupsCache) {
            return this.parallelGroupsCache;
        }

        const levels: Map<number, number> = new Map();
        const visiting = new Set<number>();

        const resolveLevel = (thoughtNum: number): number => {
            if (levels.has(thoughtNum)) {
                return levels.get(thoughtNum)!;
            }

            if (visiting.has(thoughtNum)) {
                logger.warn('Cycle detected while computing parallel groups', { thoughtNum });
                throw new DagCycleError(thoughtNum);
            }

            visiting.add(thoughtNum);
            const node = this.nodes.get(thoughtNum);
            if (!node) {
                levels.set(thoughtNum, 0);
                visiting.delete(thoughtNum);
                return 0;
            }

            let maxParentLevel = -1;
            for (const dep of node.dependencies) {
                const parentLevel = resolveLevel(dep);
                maxParentLevel = Math.max(maxParentLevel, parentLevel);
            }

            const level = maxParentLevel + 1;
            levels.set(thoughtNum, level);
            this.levelCache.set(thoughtNum, level);
            visiting.delete(thoughtNum);
            return level;
        };

        for (const thoughtNum of this.nodes.keys()) {
            resolveLevel(thoughtNum);
        }

        const groups: Map<number, number[]> = new Map();
        for (const [thoughtNum, level] of levels.entries()) {
            if (!groups.has(level)) {
                groups.set(level, []);
            }
            groups.get(level)!.push(thoughtNum);
        }

        const result: number[][] = [];
        const sortedLevels = Array.from(groups.keys()).sort((a, b) => a - b);
        for (const level of sortedLevels) {
            result.push(groups.get(level)!);
        }

        logger.info('Parallel execution groups calculated', {
            groupCount: result.length,
            groups: result,
        });

        const frozenGroups = result.map(group => Object.freeze([...group]));
        this.parallelGroupsCache = Object.freeze(frozenGroups) as unknown as number[][];
        this.cacheDirty = false;

        return this.parallelGroupsCache;
    }

    /**
     * Clear the DAG
     */
    clear(): void {
        this.nodes.clear();
        this.executionOrder = [];
        this.levelCache.clear();
        this.parallelGroupsCache = null;
        this.cacheDirty = false;
        logger.info('DAG cleared');
    }
}
```

## src/tool-chains.ts

```typescript
/**
 * Tool chaining pattern library
 * Tracks successful tool sequences and provides recommendations
 */

import { logger } from './logging.js';
import { loadScoringConfig, ScoringConfig } from './config.js';

export interface ToolChain {
    id: string;
    sequence: string[]; // Ordered tool names
    context: string; // Description of when this chain is useful
    successCount: number;
    totalUses: number;
    averageConfidence: number;
    lastUsed: string;
}

export interface ChainMatch {
    chain: ToolChain;
    matchScore: number;
    reason: string;
}

export class ToolChainLibrary {
    private chains: Map<string, ToolChain> = new Map();
    private currentChain: string[] = [];
    private chainIdCounter = 0;
    private scoring: typeof ScoringConfig.toolChains;

    constructor(scoring: typeof ScoringConfig.toolChains = loadScoringConfig().toolChains) {
        this.scoring = scoring;
        logger.info('Tool chain library initialized');
    }

    /**
     * Record a tool being used in sequence
     */
    recordToolUse(toolName: string, context?: string): void {
        this.currentChain.push(toolName);
        logger.debug('Tool use recorded', { 
            toolName, 
            chainLength: this.currentChain.length 
        });
    }

    /**
     * Mark current chain as successful and save it
     */
    completeChain(success: boolean, confidence?: number, context?: string): void {
        if (this.currentChain.length < 2) {
            // Only save chains of 2+ tools
            this.currentChain = [];
            return;
        }

        const chainKey = this.getChainKey(this.currentChain);
        let chain = this.chains.get(chainKey);

        if (!chain) {
            // Create new chain
            chain = {
                id: `chain-${++this.chainIdCounter}`,
                sequence: [...this.currentChain],
                context: context || '',
                successCount: success ? 1 : 0,
                totalUses: 1,
                averageConfidence: confidence || 0.5,
                lastUsed: new Date().toISOString(),
            };
            this.chains.set(chainKey, chain);
            logger.info('New tool chain recorded', {
                chainId: chain.id,
                sequence: chain.sequence,
                success,
            });
        } else {
            // Update existing chain
            chain.totalUses++;
            if (success) {
                chain.successCount++;
            }
            if (confidence !== undefined) {
                // Update rolling average
                chain.averageConfidence = 
                    chain.averageConfidence * (1 - this.scoring.confidenceWeight) + 
                    confidence * this.scoring.confidenceWeight;
            }
            chain.lastUsed = new Date().toISOString();
            
            if (context && !chain.context.includes(context)) {
                chain.context = chain.context ? `${chain.context}; ${context}` : context;
            }

            logger.debug('Tool chain updated', {
                chainId: chain.id,
                totalUses: chain.totalUses,
                successRate: (chain.successCount / chain.totalUses).toFixed(2),
            });
        }

        // Reset current chain
        this.currentChain = [];
    }

    /**
     * Finalize and record the current tool chain.
     * Should be called when a reasoning process or thought sequence is completed.
     * @param success Whether the chain led to a successful outcome
     * @param confidence Confidence score for the chain (optional)
     * @param context Additional context for the chain (optional)
     */
    public finalizeCurrentChain(success: boolean, confidence?: number, context?: string): void {
        this.completeChain(success, confidence, context);
    }

    /**
     * Get a unique key for a tool sequence
     */
    private getChainKey(sequence: string[]): string {
        return sequence.join('->');
    }

    /**
     * Find chains that match or partially match the current context
     */
    findMatchingChains(
        previousTools: string[],
        keywords?: string[],
        minSuccessRate: number = 0.5
    ): ChainMatch[] {
        const matches: ChainMatch[] = [];

        for (const chain of this.chains.values()) {
            const successRate = chain.successCount / chain.totalUses;
            
            // Filter by success rate
            if (successRate < minSuccessRate) {
                continue;
            }

            let matchScore = 0;
            const reasons: string[] = [];

            // Score based on matching prefix
            if (previousTools.length > 0) {
                const matchLength = this.getMatchingPrefixLength(
                    previousTools,
                    chain.sequence
                );
                
                if (matchLength > 0) {
                    matchScore += matchLength * this.scoring.prefixMatchWeight;
                    reasons.push(`Matches ${matchLength} previous tools`);
                }
            }

            // Score based on keyword matching in context
            if (keywords && keywords.length > 0) {
                const contextLower = chain.context.toLowerCase();
                const matchingKeywords = keywords.filter(kw => 
                    contextLower.includes(kw.toLowerCase())
                );
                
                if (matchingKeywords.length > 0) {
                    matchScore += matchingKeywords.length * this.scoring.keywordMatchWeight;
                    reasons.push(`Context matches: ${matchingKeywords.join(', ')}`);
                }
            }

            // Bonus for high success rate
            if (successRate > this.scoring.highSuccessRateThreshold) {
                matchScore += this.scoring.highSuccessBonus;
                reasons.push('High success rate');
            }

            // Bonus for recent use
            const daysSinceUse = (Date.now() - new Date(chain.lastUsed).getTime()) 
                / (1000 * 60 * 60 * 24);
            if (daysSinceUse < this.scoring.recentUseDaysThreshold) {
                matchScore += this.scoring.recentUseBonus;
                reasons.push('Recently used');
            }

            if (matchScore > 0) {
                matches.push({
                    chain,
                    matchScore,
                    reason: reasons.join('; '),
                });
            }
        }

        // Sort by match score descending
        matches.sort((a, b) => b.matchScore - a.matchScore);

        logger.debug('Found matching chains', {
            matchCount: matches.length,
            topMatch: matches[0]?.chain.id,
        });

        return matches;
    }

    /**
     * Get length of matching prefix between two sequences
     */
    private getMatchingPrefixLength(seq1: string[], seq2: string[]): number {
        let length = 0;
        const minLength = Math.min(seq1.length, seq2.length);
        
        for (let i = 0; i < minLength; i++) {
            if (seq1[i] === seq2[i]) {
                length++;
            } else {
                break;
            }
        }
        
        return length;
    }

    /**
     * Suggest next tool based on previous tools
     */
    suggestNextTool(previousTools: string[]): { 
        toolName: string; 
        confidence: number; 
        reason: string;
    }[] {
        const suggestions: Map<string, { 
            confidence: number; 
            reasons: string[];
            chainCount: number;
        }> = new Map();

        // Find chains that match the prefix
        for (const chain of this.chains.values()) {
            const matchLength = this.getMatchingPrefixLength(
                previousTools,
                chain.sequence
            );

            if (matchLength === previousTools.length && 
                matchLength < chain.sequence.length) {
                // This chain has our exact sequence as prefix
                const nextTool = chain.sequence[matchLength];
                const successRate = chain.successCount / chain.totalUses;

                const existing = suggestions.get(nextTool) || {
                    confidence: 0,
                    reasons: [],
                    chainCount: 0,
                };

                existing.confidence = Math.max(
                    existing.confidence,
                    successRate * chain.averageConfidence
                );
                existing.reasons.push(
                    `Found in ${chain.id} (success rate: ${(successRate * 100).toFixed(0)}%)`
                );
                existing.chainCount++;

                suggestions.set(nextTool, existing);
            }
        }

        // Convert to array and sort by confidence
        const result = Array.from(suggestions.entries()).map(([toolName, data]) => ({
            toolName,
            confidence: data.confidence,
            reason: data.reasons.join('; '),
        }));

        result.sort((a, b) => b.confidence - a.confidence);

        logger.debug('Next tool suggestions', {
            suggestionCount: result.length,
            topSuggestion: result[0]?.toolName,
        });

        return result;
    }

    /**
     * Get all chains sorted by success rate
     */
    getTopChains(limit: number = 10): ToolChain[] {
        const chains = Array.from(this.chains.values());
        
        chains.sort((a, b) => {
            const rateA = a.successCount / a.totalUses;
            const rateB = b.successCount / b.totalUses;
            return rateB - rateA;
        });

        return chains.slice(0, limit);
    }

    /**
     * Get library statistics
     */
    getStats(): {
        totalChains: number;
        averageChainLength: number;
        totalUses: number;
        overallSuccessRate: number;
    } {
        const chains = Array.from(this.chains.values());
        
        if (chains.length === 0) {
            return {
                totalChains: 0,
                averageChainLength: 0,
                totalUses: 0,
                overallSuccessRate: 0,
            };
        }

        const totalLength = chains.reduce((sum, c) => sum + c.sequence.length, 0);
        const totalUses = chains.reduce((sum, c) => sum + c.totalUses, 0);
        const totalSuccesses = chains.reduce((sum, c) => sum + c.successCount, 0);

        return {
            totalChains: chains.length,
            averageChainLength: totalLength / chains.length,
            totalUses,
            overallSuccessRate: totalSuccesses / totalUses,
        };
    }

    /**
     * Clear all chains
     */
    clear(): void {
        this.chains.clear();
        this.currentChain = [];
        logger.info('Tool chain library cleared');
    }
}
```

## src/tool-capabilities.ts

```typescript
/**
 * Tool capability metadata system for intelligent tool matching
 * Improves recommendation accuracy through structured capability tags
 */

import { Tool, ToolCapability } from './types.js';
import { logger } from './logging.js';

export interface ToolMatchScore {
    toolName: string;
    score: number;
    reasons: string[];
}

export class ToolCapabilityMatcher {
    private tools: Map<string, Tool>;

    constructor(tools: Map<string, Tool>) {
        this.tools = tools;
    }

    /**
     * Match tools based on capability requirements
     */
    matchTools(requirements: {
        categories?: string[];
        tags?: string[];
        complexity?: 'low' | 'medium' | 'high';
        keywords?: string[];
    }): ToolMatchScore[] {
        const scores: ToolMatchScore[] = [];

        for (const [name, tool] of this.tools.entries()) {
            const matchResult = this.scoreToolMatch(tool, requirements);
            if (matchResult.score > 0) {
                scores.push({
                    toolName: name,
                    score: matchResult.score,
                    reasons: matchResult.reasons,
                });
            }
        }

        // Sort by score descending
        return scores.sort((a, b) => b.score - a.score);
    }

    /**
     * Score a single tool against requirements
     */
    private scoreToolMatch(
        tool: Tool,
        requirements: {
            categories?: string[];
            tags?: string[];
            complexity?: 'low' | 'medium' | 'high';
            keywords?: string[];
        }
    ): { score: number; reasons: string[] } {
        let score = 0;
        const reasons: string[] = [];

        // If no capabilities metadata, fall back to keyword matching
        if (!tool.capabilities) {
            if (requirements.keywords) {
                const keywordScore = this.matchKeywords(tool, requirements.keywords);
                score += keywordScore.score;
                reasons.push(...keywordScore.reasons);
            }
            return { score, reasons };
        }

        const cap = tool.capabilities;

        // Category matching (high weight)
        if (requirements.categories && cap.category) {
            if (requirements.categories.includes(cap.category)) {
                score += 10;
                reasons.push(`Matches category: ${cap.category}`);
            }
        }

        // Tag matching (medium weight)
        if (requirements.tags && cap.tags) {
            const matchingTags = requirements.tags.filter(tag => 
                cap.tags.includes(tag)
            );
            if (matchingTags.length > 0) {
                score += matchingTags.length * 5;
                reasons.push(`Matches tags: ${matchingTags.join(', ')}`);
            }
        }

        // Complexity matching (bonus for exact match)
        if (requirements.complexity && cap.complexity === requirements.complexity) {
            score += 2;
            reasons.push(`Matches complexity level: ${requirements.complexity}`);
        }

        // Keyword matching in description (lower weight)
        if (requirements.keywords) {
            const keywordScore = this.matchKeywords(tool, requirements.keywords);
            score += keywordScore.score * 0.5;
            reasons.push(...keywordScore.reasons);
        }

        return { score, reasons };
    }

    /**
     * Match keywords in tool name and description
     */
    private matchKeywords(
        tool: Tool,
        keywords: string[]
    ): { score: number; reasons: string[] } {
        let score = 0;
        const reasons: string[] = [];
        const searchText = `${tool.name} ${tool.description}`.toLowerCase();

        for (const keyword of keywords) {
            if (searchText.includes(keyword.toLowerCase())) {
                score += 2;
                reasons.push(`Matches keyword: ${keyword}`);
            }
        }

        return { score, reasons };
    }

    /**
     * Get tools by category
     */
    getToolsByCategory(category: string): Tool[] {
        const tools: Tool[] = [];
        for (const tool of this.tools.values()) {
            if (tool.capabilities?.category === category) {
                tools.push(tool);
            }
        }
        return tools;
    }

    /**
     * Get all unique categories
     */
    getCategories(): string[] {
        const categories = new Set<string>();
        for (const tool of this.tools.values()) {
            if (tool.capabilities?.category) {
                categories.add(tool.capabilities.category);
            }
        }
        return Array.from(categories);
    }

    /**
     * Get all unique tags
     */
    getTags(): string[] {
        const tags = new Set<string>();
        for (const tool of this.tools.values()) {
            if (tool.capabilities?.tags) {
                tool.capabilities.tags.forEach(tag => tags.add(tag));
            }
        }
        return Array.from(tags);
    }

    /**
     * Find similar tools based on capabilities
     */
    findSimilarTools(toolName: string, limit: number = 3): string[] {
        const tool = this.tools.get(toolName);
        if (!tool || !tool.capabilities) {
            return [];
        }

        const scores = this.matchTools({
            categories: tool.capabilities.category ? [tool.capabilities.category] : undefined,
            tags: tool.capabilities.tags,
            complexity: tool.capabilities.complexity,
        });

        // Filter out the tool itself and limit results
        return scores
            .filter(s => s.toolName !== toolName)
            .slice(0, limit)
            .map(s => s.toolName);
    }
}

/**
 * Infer capabilities from tool name and description
 * Used for tools without explicit capability metadata
 */
export function inferCapabilities(tool: Tool): ToolCapability {
    const text = `${tool.name} ${tool.description}`.toLowerCase();
    
    // Infer category
    let category = 'general';
    if (text.includes('search') || text.includes('find') || text.includes('query')) {
        category = 'search';
    } else if (text.includes('data') || text.includes('database') || text.includes('storage')) {
        category = 'data';
    } else if (text.includes('analysis') || text.includes('analyze') || text.includes('evaluate')) {
        category = 'analysis';
    } else if (text.includes('create') || text.includes('generate') || text.includes('build')) {
        category = 'generation';
    } else if (text.includes('transform') || text.includes('convert') || text.includes('format')) {
        category = 'transformation';
    } else if (text.includes('communicate') || text.includes('send') || text.includes('notify')) {
        category = 'communication';
    }

    // Infer tags
    const tags: string[] = [];
    if (text.includes('read') || text.includes('get') || text.includes('fetch')) {
        tags.push('read');
    }
    if (text.includes('write') || text.includes('create') || text.includes('update')) {
        tags.push('write');
    }
    if (text.includes('delete') || text.includes('remove')) {
        tags.push('delete');
    }
    if (text.includes('list') || text.includes('browse')) {
        tags.push('list');
    }
    if (text.includes('transform') || text.includes('convert')) {
        tags.push('transform');
    }

    // Infer complexity based on description length and technical terms
    let complexity: 'low' | 'medium' | 'high' = 'medium';
    const technicalTerms = ['api', 'advanced', 'complex', 'sophisticated', 'ml', 'ai'];
    if (technicalTerms.some(term => text.includes(term))) {
        complexity = 'high';
    } else if (tool.description.length < 100) {
        complexity = 'low';
    }

    return {
        category,
        tags,
        complexity,
    };
}

/**
 * Auto-enrich tools with inferred capabilities if not present
 */
export function enrichToolsWithCapabilities(tools: Map<string, Tool>): void {
    let enrichedCount = 0;
    
    for (const [name, tool] of tools.entries()) {
        if (!tool.capabilities) {
            tool.capabilities = inferCapabilities(tool);
            enrichedCount++;
            logger.debug('Enriched tool with inferred capabilities', {
                toolName: name,
                category: tool.capabilities.category,
                tags: tool.capabilities.tags,
            });
        }
    }

    if (enrichedCount > 0) {
        logger.info('Tools enriched with capabilities', {
            enrichedCount,
            totalTools: tools.size,
        });
    }
}
```

## src/persistence.ts

```typescript
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
        } catch (error) {
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
```

## src/config-manager.ts

```typescript
import { DEFAULT_SCORING_CONFIG, ScoringConfigShape } from './config-constants.js';
import { loadScoringConfig } from './config.js';
import { logger, LogLevel } from './logging.js';

export interface RuntimeConfig {
    maxHistorySize: number;
    enablePersistence: boolean;
    dbPath: string;
    enableBacktracking: boolean;
    minConfidence: number;
    enableDAG: boolean;
    enableToolChains: boolean;
    logLevel: LogLevel;
}

const parseIntegerWithFallback = (value: string | undefined, fallback: number): number => {
    const parsed = value !== undefined ? parseInt(value, 10) : NaN;
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(1, parsed);
};

export class ConfigurationManager {
    private scoringConfig: ScoringConfigShape;
    private runtimeConfig: RuntimeConfig;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.scoringConfig = loadScoringConfig(env);
        this.runtimeConfig = this.loadRuntimeConfig(env);
    }

    refresh(env: NodeJS.ProcessEnv = process.env): void {
        this.scoringConfig = loadScoringConfig(env);
        this.runtimeConfig = this.loadRuntimeConfig(env);
        logger.info('Configuration refreshed from environment', {
            maxHistorySize: this.runtimeConfig.maxHistorySize,
            enablePersistence: this.runtimeConfig.enablePersistence,
            enableBacktracking: this.runtimeConfig.enableBacktracking,
            enableDAG: this.runtimeConfig.enableDAG,
            enableToolChains: this.runtimeConfig.enableToolChains,
            logLevel: this.runtimeConfig.logLevel,
        });
    }

    getScoringConfig(): ScoringConfigShape {
        return {
            backtracking: { ...this.scoringConfig.backtracking },
            toolChains: { ...this.scoringConfig.toolChains },
            logging: { ...this.scoringConfig.logging },
        };
    }

    getRuntimeConfig(): RuntimeConfig {
        return { ...this.runtimeConfig };
    }

    private loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
        const scoring = this.scoringConfig ?? DEFAULT_SCORING_CONFIG;
        const maxHistorySize = parseIntegerWithFallback(env.MAX_HISTORY_SIZE, 1000);
        const enablePersistence = env.ENABLE_PERSISTENCE !== 'false';
        const dbPath = env.DB_PATH || './mcp-thinking.db';
        const enableBacktrackingEnv = env.ENABLE_BACKTRACKING;
        const enableBacktracking = enableBacktrackingEnv !== undefined
            ? enableBacktrackingEnv === 'true'
            : scoring.backtracking.enableAutoBacktrack;

        const enableDAG = env.ENABLE_DAG === 'true';
        const enableToolChains = env.ENABLE_TOOL_CHAINS !== 'false';
        const logLevel = (env.LOG_LEVEL as LogLevel) || scoring.logging.level;

        return {
            maxHistorySize,
            enablePersistence,
            dbPath,
            enableBacktracking,
            minConfidence: scoring.backtracking.minConfidence,
            enableDAG,
            enableToolChains,
            logLevel,
        };
    }
}
```

## src/config-constants.ts

```typescript
import { LogLevel } from './logging.js';

export interface BacktrackingScoringConfig {
    minConfidence: number;
    enableAutoBacktrack: boolean;
    maxBacktrackDepth: number;
    baseConfidence: number;
    toolConfidenceWeight: number;
    revisionPenalty: number;
    branchBonus: number;
    progressBonus: number;
    progressThreshold: number;
    decliningConfidenceThreshold: number;
}

export interface ToolChainScoringConfig {
    prefixMatchWeight: number;
    keywordMatchWeight: number;
    highSuccessBonus: number;
    recentUseBonus: number;
    recentUseDaysThreshold: number;
    highSuccessRateThreshold: number;
    confidenceWeight: number;
}

export interface ScoringConfigShape {
    backtracking: BacktrackingScoringConfig;
    toolChains: ToolChainScoringConfig;
    logging: {
        level: LogLevel;
    };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfigShape = {
    backtracking: {
        minConfidence: 0.3,
        enableAutoBacktrack: false,
        maxBacktrackDepth: 5,
        baseConfidence: 0.5,
        toolConfidenceWeight: 0.3,
        revisionPenalty: 0.1,
        branchBonus: 0.05,
        progressBonus: 0.2,
        progressThreshold: 0.8,
        decliningConfidenceThreshold: 0.5,
    },
    toolChains: {
        prefixMatchWeight: 10,
        keywordMatchWeight: 5,
        highSuccessBonus: 5,
        recentUseBonus: 3,
        recentUseDaysThreshold: 7,
        highSuccessRateThreshold: 0.8,
        confidenceWeight: 0.3,
    },
    logging: {
        level: LogLevel.INFO,
    },
};
```

## src/error-handling.ts

```typescript
/**
 * Error handling utilities for MCP Sequential Thinking Tools
 * Provides structured error context and retry logic
 */

import { logger } from './logging.js';
import { DagCycleError } from './dag.js';

export type ErrorCategory =
    | 'ValidationError'
    | 'PersistenceError'
    | 'DAGError'
    | 'ConfigurationError'
    | 'CircuitBreakerOpen'
    | 'ExternalServiceError'
    | 'UnknownError';

export interface ErrorContext {
    operation: string;
    timestamp: string;
    error: string;
    errorType: string;
    category: ErrorCategory;
    retryCount?: number;
    thoughtNumber?: number;
    branchId?: string;
    stackTrace?: string;
}

export interface RetryConfig {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
};

export class CircuitBreakerOpenError extends Error {
    constructor(message = 'Circuit breaker is open') {
        super(message);
        this.name = 'CircuitBreakerOpenError';
    }
}

export interface CircuitBreakerConfig {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenSuccessThreshold: number;
    name?: string;
}

export class CircuitBreaker {
    private state: 'closed' | 'open' | 'half-open' = 'closed';
    private failureCount = 0;
    private successCount = 0;
    private nextAttempt = Date.now();

    constructor(private readonly config: CircuitBreakerConfig) {}

    private transitionToOpen(): void {
        this.state = 'open';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now() + this.config.resetTimeoutMs;
        logger.warn(`Circuit breaker "${this.config.name || 'default'}" opened`);
    }

    private transitionToHalfOpen(): void {
        this.state = 'half-open';
        this.successCount = 0;
        logger.info(`Circuit breaker "${this.config.name || 'default'}" half-open`);
    }

    private transitionToClosed(): void {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        logger.info(`Circuit breaker "${this.config.name || 'default'}" closed`);
    }

    async execute<T>(operation: () => Promise<T>): Promise<T> {
        if (this.state === 'open' && Date.now() < this.nextAttempt) {
            throw new CircuitBreakerOpenError(
                `Circuit breaker "${this.config.name || 'default'}" is open`,
            );
        }

        if (this.state === 'open') {
            this.transitionToHalfOpen();
        }

        try {
            const result = await operation();
            this.successCount++;
            if (this.state === 'closed') {
                this.failureCount = 0;
            }

            if (this.state === 'half-open' && this.successCount >= this.config.halfOpenSuccessThreshold) {
                this.transitionToClosed();
            }

            return result;
        } catch (error) {
            this.failureCount++;
            if (this.failureCount >= this.config.failureThreshold) {
                this.transitionToOpen();
            }
            throw error;
        }
    }
}

/**
 * Wrap an error with structured context
 */
export function createErrorContext(
    operation: string,
    error: unknown,
    additionalContext?: Partial<ErrorContext>
): ErrorContext {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    
    return {
        operation,
        timestamp: new Date().toISOString(),
        error: errorObj.message,
        errorType: errorObj.name || 'UnknownError',
        category: categorizeError(errorObj),
        stackTrace: errorObj.stack,
        ...additionalContext,
    };
}

export function categorizeError(error: unknown): ErrorCategory {
    if (error instanceof CircuitBreakerOpenError) {
        return 'CircuitBreakerOpen';
    }
    if (error instanceof DagCycleError || (error instanceof Error && error.name === 'DagCycleError')) {
        return 'DAGError';
    }

    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('validation')) return 'ValidationError';
        if (message.includes('dag')) return 'DAGError';
        if (message.includes('config') || message.includes('configuration')) return 'ConfigurationError';
        if (message.includes('sqlite') || message.includes('database') || message.includes('db')) {
            return 'PersistenceError';
        }
        if (message.includes('network') || message.includes('timeout') || message.includes('external')) {
            return 'ExternalServiceError';
        }
    }

    return 'UnknownError';
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        // Network errors, timeouts, rate limits are retryable
        return (
            message.includes('timeout') ||
            message.includes('network') ||
            message.includes('econnrefused') ||
            message.includes('rate limit') ||
            message.includes('429') ||
            message.includes('503') ||
            message.includes('temporary')
        );
    }
    return false;
}

/**
 * Calculate exponential backoff delay
 */
function calculateDelay(
    retryCount: number,
    config: RetryConfig
): number {
    const delay = Math.min(
        config.initialDelayMs * Math.pow(config.backoffMultiplier, retryCount),
        config.maxDelayMs
    );
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 100;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with retry logic
 */
export async function withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    config: Partial<RetryConfig> = {}
): Promise<T> {
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
    let lastError: unknown;
    
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            
            // Don't retry if it's not a retryable error
            if (!isRetryableError(error)) {
                throw error;
            }
            
            // Don't retry if we've exhausted attempts
            if (attempt >= retryConfig.maxRetries) {
                break;
            }
            
            const delay = calculateDelay(attempt, retryConfig);
            logger.warn(
                `Operation "${operationName}" failed (attempt ${attempt + 1}/${retryConfig.maxRetries + 1}), ` +
                `retrying in ${Math.round(delay)}ms...`,
                { error: error instanceof Error ? error.message : String(error) }
            );
            
            await sleep(delay);
        }
    }
    
    // If we get here, all retries failed
    const errorContext = createErrorContext(operationName, lastError, {
        retryCount: retryConfig.maxRetries,
    });
    
    throw new Error(
        `Operation "${operationName}" failed after ${retryConfig.maxRetries + 1} attempts. ` +
        `Last error: ${errorContext.error}`
    );
}

/**
 * Safe wrapper that catches errors and returns structured error context
 */
export async function safeExecute<T>(
    operation: () => Promise<T>,
    operationName: string,
    fallback?: T
): Promise<{ success: true; data: T } | { success: false; error: ErrorContext; data?: T }> {
    try {
        const data = await operation();
        return { success: true, data };
    } catch (error) {
        const errorContext = createErrorContext(operationName, error);
        logger.error(`Operation "${operationName}" failed`, error, {
            operation: errorContext.operation,
            timestamp: errorContext.timestamp,
        });
        
        if (fallback !== undefined) {
            return { success: false, error: errorContext, data: fallback };
        }
        
        return { success: false, error: errorContext };
    }
}
```

## src/logging.ts

```typescript
/**
 * Structured logging for MCP Sequential Thinking Tools
 * Provides JSON-formatted logs with contextual information
 */

export enum LogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    operation?: string;
    thoughtNumber?: number;
    branchId?: string;
    duration?: number;
    metadata?: Record<string, unknown>;
}

export interface LoggerConfig {
    minLevel: LogLevel;
    enableConsole: boolean;
    enableStructured: boolean;
    outputFormats: Array<'json' | 'pretty'>;
    sinks?: LogSink[];
}

export interface LogSink {
    write(entry: LogEntry, formatted: string): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    [LogLevel.DEBUG]: 0,
    [LogLevel.INFO]: 1,
    [LogLevel.WARN]: 2,
    [LogLevel.ERROR]: 3,
};

const isValidLogFormat = (format: string): format is 'json' | 'pretty' =>
    format === 'json' || format === 'pretty';

class Logger {
    private config: LoggerConfig;
    private metrics: Map<string, { count: number; totalDuration: number }> = new Map();
    private logCounts: Record<LogLevel, number> = {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0,
    };
    private sinks: LogSink[] = [];

    constructor(config: Partial<LoggerConfig> = {}) {
        this.config = {
            minLevel: LogLevel.INFO,
            enableConsole: true,
            enableStructured: true,
            outputFormats: config.outputFormats ?? (config.enableStructured === false ? ['pretty'] : ['json']),
            ...config,
        };

        this.sinks = [...(config.sinks || [])];

        if (this.config.enableConsole) {
            this.sinks.push({
                write: (_entry, formatted) => {
                    console.error(formatted);
                },
            });
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.minLevel];
    }

    private formatEntry(entry: LogEntry, format: 'json' | 'pretty'): string {
        if (format === 'json') {
            return JSON.stringify(entry);
        }

        const parts = [
            entry.timestamp,
            `[${entry.level.toUpperCase()}]`,
            entry.operation ? `[${entry.operation}]` : '',
            entry.message,
        ].filter(Boolean);

        return parts.join(' ');
    }

    private log(entry: LogEntry): void {
        if (!this.shouldLog(entry.level)) {
            return;
        }

        this.logCounts[entry.level]++;

        const formattedEntries = this.config.outputFormats.map(format => this.formatEntry(entry, format));
        const payload = formattedEntries.length === 1
            ? formattedEntries[0]
            : formattedEntries.join('\n');

        for (const sink of this.sinks) {
            sink.write(entry, payload);
        }
    }

    debug(message: string, metadata?: Record<string, unknown>): void {
        this.log({
            timestamp: new Date().toISOString(),
            level: LogLevel.DEBUG,
            message,
            metadata,
        });
    }

    info(message: string, metadata?: Record<string, unknown>): void {
        this.log({
            timestamp: new Date().toISOString(),
            level: LogLevel.INFO,
            message,
            metadata,
        });
    }

    warn(message: string, metadata?: Record<string, unknown>): void {
        this.log({
            timestamp: new Date().toISOString(),
            level: LogLevel.WARN,
            message,
            metadata,
        });
    }

    error(message: string, error?: unknown, metadata?: Record<string, unknown>): void {
        const errorInfo = error instanceof Error 
            ? { error: error.message, stack: error.stack }
            : { error: String(error) };
        
        this.log({
            timestamp: new Date().toISOString(),
            level: LogLevel.ERROR,
            message,
            metadata: { ...metadata, ...errorInfo },
        });
    }

    /**
     * Log an operation with duration tracking
     */
    operation(
        operation: string,
        message: string,
        metadata?: Record<string, unknown>
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            level: LogLevel.INFO,
            message,
            operation,
            metadata,
        });
    }

    /**
     * Track operation metrics
     */
    trackMetric(operation: string, duration: number): void {
        const existing = this.metrics.get(operation) || { count: 0, totalDuration: 0 };
        this.metrics.set(operation, {
            count: existing.count + 1,
            totalDuration: existing.totalDuration + duration,
        });
    }

    /**
     * Get performance metrics
     */
    getMetrics(): Record<string, { count: number; avgDuration: number }> {
        const result: Record<string, { count: number; avgDuration: number }> = {};
        
        for (const [operation, data] of this.metrics.entries()) {
            result[operation] = {
                count: data.count,
                avgDuration: data.totalDuration / data.count,
            };
        }
        
        return result;
    }

    getLogCounts(): Record<LogLevel, number> {
        return { ...this.logCounts };
    }

    /**
     * Log metrics summary
     */
    logMetrics(): void {
        const metrics = this.getMetrics();
        this.info('Performance metrics', { metrics, logs: this.getLogCounts() });
    }
}

const getOutputFormatsFromEnv = (): Array<'json' | 'pretty'> => {
    const fromEnv = process.env.LOG_FORMATS
        ?.split(',')
        .map(format => format.trim().toLowerCase())
        .filter(isValidLogFormat);

    if (fromEnv && fromEnv.length > 0) {
        return Array.from(new Set(fromEnv));
    }

    return process.env.STRUCTURED_LOGS === 'false' ? ['pretty'] : ['json'];
};

// Create a default logger instance
export const logger = new Logger({
    minLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
    enableConsole: true,
    enableStructured: process.env.STRUCTURED_LOGS !== 'false',
    outputFormats: getOutputFormatsFromEnv(),
});

/**
 * Measure execution time of an operation
 */
export async function measureTime<T>(
    operation: string,
    fn: () => Promise<T>
): Promise<T> {
    const startTime = performance.now();
    
    try {
        const result = await fn();
        const duration = performance.now() - startTime;
        logger.trackMetric(operation, duration);
        logger.debug(`Operation completed: ${operation}`, { duration });
        return result;
    } catch (error) {
        const duration = performance.now() - startTime;
        logger.trackMetric(operation, duration);
        logger.error(`Operation failed: ${operation}`, error, { duration });
        throw error;
    }
}
```

## src/types.ts

```typescript

export interface ToolRecommendation {
    tool_name: string;
    confidence: number;  // 0-1 indicating how confident we are this tool is appropriate
    rationale: string;  // Why this tool is recommended
    priority: number;   // Order in the recommendation sequence
    suggested_inputs?: Record<string, unknown>;  // Optional suggested parameters
    alternatives?: string[];  // Alternative tools that could be used
}

export interface StepRecommendation {
    step_description: string;  // What needs to be done
    recommended_tools: ToolRecommendation[];  // Tools recommended for this step
    expected_outcome: string;  // What to expect from this step
    next_step_conditions?: string[];  // Conditions to consider for the next step
}

export interface ThoughtData {
    available_mcp_tools: string[];  // Array of MCP tool names available for use
    thought: string;
    thought_number: number;
    total_thoughts: number;
    is_revision?: boolean;
    revises_thought?: number;
    branch_from_thought?: number;
    branch_id?: string;
    needs_more_thoughts?: boolean;
    next_thought_needed: boolean;
    
    // Recommendation-related fields
    current_step?: StepRecommendation;  // Current step being considered
    previous_steps?: StepRecommendation[];  // Steps already recommended
    remaining_steps?: string[];  // High-level descriptions of upcoming steps
    
    // Confidence scoring for backtracking support
    confidence?: number;  // 0-1 confidence in current thought path
}

export interface ToolCapability {
    category: string;  // e.g., "data", "search", "analysis", "communication"
    tags: string[];  // Capability tags like "read", "write", "transform", "query"
    inputTypes?: string[];  // Types of input the tool accepts
    outputTypes?: string[];  // Types of output the tool produces
    complexity?: 'low' | 'medium' | 'high';  // Complexity level
    costLevel?: 'free' | 'low' | 'medium' | 'high';  // Cost/resource level
}

export interface Tool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    capabilities?: ToolCapability;  // Extended capability metadata
}

export interface ServerConfig {
    available_tools: Map<string, Tool>;
}
```

## src/config.ts

```typescript
import * as v from 'valibot';
import {
    BacktrackingScoringConfig,
    DEFAULT_SCORING_CONFIG,
    ScoringConfigShape,
    ToolChainScoringConfig,
} from './config-constants.js';
import { LogLevel, logger } from './logging.js';

type NumberParser = (value: string | undefined, fallback: number) => number;

const parseNumber: NumberParser = (value, fallback) => {
    const parsed = value !== undefined ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseInteger: NumberParser = (value, fallback) => {
    const parsed = value !== undefined ? parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampValue = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

const backtrackingSchema = v.object({
    minConfidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    enableAutoBacktrack: v.boolean(),
    maxBacktrackDepth: v.pipe(v.number(), v.minValue(1)),
    baseConfidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    toolConfidenceWeight: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    revisionPenalty: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    branchBonus: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    progressBonus: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    progressThreshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    decliningConfidenceThreshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

const toolChainSchema = v.object({
    prefixMatchWeight: v.pipe(v.number(), v.minValue(0)),
    keywordMatchWeight: v.pipe(v.number(), v.minValue(0)),
    highSuccessBonus: v.pipe(v.number(), v.minValue(0)),
    recentUseBonus: v.pipe(v.number(), v.minValue(0)),
    recentUseDaysThreshold: v.pipe(v.number(), v.minValue(1)),
    highSuccessRateThreshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    confidenceWeight: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

const scoringSchema = v.object({
    backtracking: backtrackingSchema,
    toolChains: toolChainSchema,
    logging: v.object({
        level: v.picklist([LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]),
    }),
});

const sanitizeBacktracking = (config: BacktrackingScoringConfig): BacktrackingScoringConfig => ({
    ...config,
    minConfidence: clampValue(config.minConfidence, 0, 1),
    baseConfidence: clampValue(config.baseConfidence, 0, 1),
    toolConfidenceWeight: clampValue(config.toolConfidenceWeight, 0, 1),
    revisionPenalty: clampValue(config.revisionPenalty, 0, 1),
    branchBonus: clampValue(config.branchBonus, 0, 1),
    progressBonus: clampValue(config.progressBonus, 0, 1),
    progressThreshold: clampValue(config.progressThreshold, 0, 1),
    decliningConfidenceThreshold: clampValue(config.decliningConfidenceThreshold, 0, 1),
    maxBacktrackDepth: Math.max(1, Math.floor(config.maxBacktrackDepth)),
});

const sanitizeToolChain = (config: ToolChainScoringConfig): ToolChainScoringConfig => ({
    ...config,
    prefixMatchWeight: Math.max(0, config.prefixMatchWeight),
    keywordMatchWeight: Math.max(0, config.keywordMatchWeight),
    highSuccessBonus: Math.max(0, config.highSuccessBonus),
    recentUseBonus: Math.max(0, config.recentUseBonus),
    recentUseDaysThreshold: Math.max(1, Math.floor(config.recentUseDaysThreshold)),
    highSuccessRateThreshold: clampValue(config.highSuccessRateThreshold, 0, 1),
    confidenceWeight: clampValue(config.confidenceWeight, 0, 1),
});

const validateScoringConfig = (config: ScoringConfigShape): ScoringConfigShape => {
    const result = v.safeParse(scoringSchema, config);
    if (result.success) {
        return {
            backtracking: sanitizeBacktracking(result.output.backtracking),
            toolChains: sanitizeToolChain(result.output.toolChains),
            logging: result.output.logging,
        };
    }

    logger.warn('Scoring configuration validation failed, applying sanitized defaults', {
        issues: result.issues?.map(issue => issue.message) ?? ['unknown validation error'],
    });

    // Fall back to sanitized defaults while preserving valid overrides
    return {
        backtracking: sanitizeBacktracking({
            ...DEFAULT_SCORING_CONFIG.backtracking,
            ...config.backtracking,
        }),
        toolChains: sanitizeToolChain({
            ...DEFAULT_SCORING_CONFIG.toolChains,
            ...config.toolChains,
        }),
        logging: {
            level: config.logging.level ?? DEFAULT_SCORING_CONFIG.logging.level,
        },
    };
};

export const ScoringConfig: ScoringConfigShape = DEFAULT_SCORING_CONFIG;

export const loadScoringConfig = (env: NodeJS.ProcessEnv = process.env): ScoringConfigShape => {
    const merged: ScoringConfigShape = {
        backtracking: {
            minConfidence: parseNumber(env.MIN_CONFIDENCE, DEFAULT_SCORING_CONFIG.backtracking.minConfidence),
            enableAutoBacktrack:
                env.ENABLE_BACKTRACKING === 'true'
                    ? true
                    : env.ENABLE_BACKTRACKING === 'false'
                        ? false
                        : DEFAULT_SCORING_CONFIG.backtracking.enableAutoBacktrack,
            maxBacktrackDepth: parseInteger(
                env.MAX_BACKTRACK_DEPTH,
                DEFAULT_SCORING_CONFIG.backtracking.maxBacktrackDepth,
            ),
            baseConfidence: parseNumber(
                env.BASE_CONFIDENCE,
                DEFAULT_SCORING_CONFIG.backtracking.baseConfidence,
            ),
            toolConfidenceWeight: parseNumber(
                env.TOOL_CONFIDENCE_WEIGHT,
                DEFAULT_SCORING_CONFIG.backtracking.toolConfidenceWeight,
            ),
            revisionPenalty: parseNumber(
                env.REVISION_PENALTY,
                DEFAULT_SCORING_CONFIG.backtracking.revisionPenalty,
            ),
            branchBonus: parseNumber(
                env.BRANCH_BONUS,
                DEFAULT_SCORING_CONFIG.backtracking.branchBonus,
            ),
            progressBonus: parseNumber(
                env.PROGRESS_BONUS,
                DEFAULT_SCORING_CONFIG.backtracking.progressBonus,
            ),
            progressThreshold: parseNumber(
                env.PROGRESS_THRESHOLD,
                DEFAULT_SCORING_CONFIG.backtracking.progressThreshold,
            ),
            decliningConfidenceThreshold: parseNumber(
                env.DECLINING_CONFIDENCE_THRESHOLD,
                DEFAULT_SCORING_CONFIG.backtracking.decliningConfidenceThreshold,
            ),
        },
        toolChains: {
            prefixMatchWeight: parseNumber(
                env.TOOL_CHAIN_PREFIX_MATCH_WEIGHT,
                DEFAULT_SCORING_CONFIG.toolChains.prefixMatchWeight,
            ),
            keywordMatchWeight: parseNumber(
                env.TOOL_CHAIN_KEYWORD_MATCH_WEIGHT,
                DEFAULT_SCORING_CONFIG.toolChains.keywordMatchWeight,
            ),
            highSuccessBonus: parseNumber(
                env.TOOL_CHAIN_HIGH_SUCCESS_BONUS,
                DEFAULT_SCORING_CONFIG.toolChains.highSuccessBonus,
            ),
            recentUseBonus: parseNumber(
                env.TOOL_CHAIN_RECENT_USE_BONUS,
                DEFAULT_SCORING_CONFIG.toolChains.recentUseBonus,
            ),
            recentUseDaysThreshold: parseNumber(
                env.TOOL_CHAIN_RECENT_USE_DAYS_THRESHOLD,
                DEFAULT_SCORING_CONFIG.toolChains.recentUseDaysThreshold,
            ),
            highSuccessRateThreshold: parseNumber(
                env.TOOL_CHAIN_HIGH_SUCCESS_RATE_THRESHOLD,
                DEFAULT_SCORING_CONFIG.toolChains.highSuccessRateThreshold,
            ),
            confidenceWeight: parseNumber(
                env.TOOL_CHAIN_CONFIDENCE_WEIGHT,
                DEFAULT_SCORING_CONFIG.toolChains.confidenceWeight,
            ),
        },
        logging: {
            level: (env.LOG_LEVEL as LogLevel) || DEFAULT_SCORING_CONFIG.logging.level,
        },
    };

    return validateScoringConfig(merged);
};
```
