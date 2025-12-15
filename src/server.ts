
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

const DEFAULT_MAX_HISTORY = 1000;

export interface ServerOptions {
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

export class ToolAwareSequentialThinkingServer {
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

    public async initialize(): Promise<void> {
        if (this.persistence) {
            try {
                const history = await this.persistence.getThoughtHistory(this.sessionId);
                if (history.length > 0) {
                    logger.info('Found existing history, hydrating...', {
                        sessionId: this.sessionId,
                        thoughtCount: history.length
                    });
                    await this.processor.hydrate(history);
                }
            } catch (error) {
                logger.error('Failed to hydrate history', error, { sessionId: this.sessionId });
                // We don't throw here to allow the server to start even if rehydration fails
                // although this might mean loss of context.
            }
        }
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
}
