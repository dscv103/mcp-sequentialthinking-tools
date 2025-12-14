#!/usr/bin/env node

// adapted from https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/index.ts
// for use with mcp tools

import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { StdioTransport } from '@tmcp/transport-stdio';
import * as v from 'valibot';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SequentialThinkingSchema, SEQUENTIAL_THINKING_TOOL } from './schema.js';
import { ThoughtData, ToolRecommendation, StepRecommendation, Tool } from './types.js';
import { logger, measureTime } from './logging.js';
import { createErrorContext } from './error-handling.js';
import { PersistenceLayer } from './persistence.js';
import { ToolCapabilityMatcher, enrichToolsWithCapabilities } from './tool-capabilities.js';
import { BacktrackingManager } from './backtracking.js';
import { ThoughtDAG } from './dag.js';
import { ToolChainLibrary } from './tool-chains.js';
import { loadScoringConfig, ScoringConfig } from './config.js';

const DEFAULT_MAX_HISTORY = 1000;
const DEFAULT_MIN_CONFIDENCE = ScoringConfig.backtracking.minConfidence;
const METRICS_INTERVAL_MS = 5 * 60 * 1000;

const parseIntegerWithFallback = (value: string | undefined, fallback: number): number => {
	const parsed = value !== undefined ? parseInt(value, 10) : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

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
}

class ToolAwareSequentialThinkingServer {
	private thoughtHistory: ThoughtData[] = [];
	private branches: Record<string, ThoughtData[]> = {};
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
	private sessionLocks: Map<string, Promise<void>> = new Map();
	private scoringConfig = loadScoringConfig();

	public getAvailableTools(): Tool[] {
		return Array.from(this.availableTools.values());
	}

	private _evaluateBacktracking(thought: ThoughtData) {
		const backtrackDecision = this.backtrackingManager.shouldBacktrack(thought);
		if (backtrackDecision.shouldBacktrack) {
			logger.warn('Backtracking triggered', {
				thoughtNumber: thought.thought_number,
				reason: backtrackDecision.reason,
				backtrackTo: backtrackDecision.backtrackTo,
			});
			
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								thought_number: thought.thought_number,
								total_thoughts: thought.total_thoughts,
								confidence: thought.confidence,
								backtracking_suggested: true,
								backtrack_reason: backtrackDecision.reason,
								backtrack_to_thought: backtrackDecision.backtrackTo,
								message: 'Low confidence detected. Consider revising approach from earlier thought.',
							},
							null,
							2,
						),
					},
				],
			};
		}

		return null;
	}

	private _updateDAG(thought: ThoughtData): (ReturnType<ThoughtDAG['getStats']> & { parallelGroupCount?: number }) | undefined {
		if (!this.enableDAG) return undefined;
		
		try {
			this.thoughtDAG.addThought(thought);
			
			// Mark this thought as executing and then completed
			this.thoughtDAG.markExecuting(thought.thought_number);
			this.thoughtDAG.markCompleted(thought.thought_number, {
				confidence: thought.confidence,
				thoughtNumber: thought.thought_number,
			});
			
			// Get DAG statistics
			const stats = this.thoughtDAG.getStats();
			const parallelGroups = this.thoughtDAG.getParallelGroups();
			const dagStats = { ...stats, parallelGroupCount: parallelGroups.length };
			logger.debug('DAG updated', dagStats);
			return dagStats;
		} catch (dagError) {
			logger.error('Failed to update DAG', dagError, {
				thoughtNumber: thought.thought_number,
			});
			return undefined;
		}
	}

	private async _persistThought(thought: ThoughtData): Promise<void> {
		await this.persistence.saveThought(thought, this.sessionId);
	}

	private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
		const run = previous.then(fn);
		const completion = run.catch(() => {}).then(() => {});
		let tracker: Promise<void>;
		tracker = completion.finally(() => {
			if (this.sessionLocks.get(sessionId) === tracker) {
				this.sessionLocks.delete(sessionId);
			}
		});
		this.sessionLocks.set(sessionId, tracker);
		return run;
	}

	constructor(options: ServerOptions = {}) {
		this.maxHistorySize = options.maxHistorySize ?? DEFAULT_MAX_HISTORY;
		this.sessionId = options.sessionId || `session-${Date.now()}`;
		this.enableDAG = options.enableDAG ?? false;
		this.enableToolChains = options.enableToolChains ?? true;
		
		// Initialize persistence layer
		this.persistence = new PersistenceLayer({
			enablePersistence: options.enablePersistence ?? true,
			dbPath: options.dbPath,
		});
		
		// Initialize backtracking manager
		this.backtrackingManager = new BacktrackingManager({
			enableAutoBacktrack: options.enableBacktracking ?? this.scoringConfig.backtracking.enableAutoBacktrack,
			minConfidence: options.minConfidence ?? this.scoringConfig.backtracking.minConfidence,
			maxBacktrackDepth: this.scoringConfig.backtracking.maxBacktrackDepth,
			baseConfidence: this.scoringConfig.backtracking.baseConfidence,
			toolConfidenceWeight: this.scoringConfig.backtracking.toolConfidenceWeight,
			revisionPenalty: this.scoringConfig.backtracking.revisionPenalty,
			branchBonus: this.scoringConfig.backtracking.branchBonus,
			progressBonus: this.scoringConfig.backtracking.progressBonus,
		});
		
		// Initialize DAG for parallel execution
		this.thoughtDAG = new ThoughtDAG();
		
		// Initialize tool chain library
		this.toolChainLibrary = new ToolChainLibrary();
		
		logger.info('Server initialized', { 
			maxHistorySize: this.maxHistorySize,
			sessionId: this.sessionId,
			persistenceEnabled: options.enablePersistence ?? true,
			backtrackingEnabled: options.enableBacktracking ?? false,
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
		this.thoughtHistory = [];
		this.branches = {};
		this.persistence.clearHistory(this.sessionId);
		this.backtrackingManager.clear();
		this.thoughtDAG.clear();
		this.toolChainLibrary.clear();
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

	private formatRecommendation(step: StepRecommendation): string {
		const tools = step.recommended_tools
			.map((tool) => {
				const alternatives = tool.alternatives?.length 
					? ` (alternatives: ${tool.alternatives.join(', ')})`
					: '';
				const inputs = tool.suggested_inputs 
					? `\n    Suggested inputs: ${JSON.stringify(tool.suggested_inputs)}`
					: '';
				return `  - ${tool.tool_name} (priority: ${tool.priority})${alternatives}
    Rationale: ${tool.rationale}${inputs}`;
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
			prefix = chalk.yellow('🔄 Revision');
			context = ` (revising thought ${revises_thought})`;
		} else if (branch_from_thought) {
			prefix = chalk.green('🌿 Branch');
			context = ` (from thought ${branch_from_thought}, ID: ${branch_id})`;
		} else {
			prefix = chalk.blue('💭 Thought');
			context = '';
		}

		const header = `${prefix} ${thought_number}/${total_thoughts}${context}`;
		let content = thought;

		// Add recommendation information if present
		if (current_step) {
			content = `${thought}\n\nRecommendation:\n${this.formatRecommendation(current_step)}`;
		}

		const border = '─'.repeat(
			Math.max(header.length, content.length) + 4,
		);

		return `
┌${border}┐
│ ${header} │
├${border}┤
│ ${content.padEnd(border.length - 2)} │
└${border}┘`;
	}

	public async processThought(input: v.InferInput<typeof SequentialThinkingSchema>) {
		return measureTime('processThought', async () => {
			return this.withSessionLock(this.sessionId, async () => {
				try {
					// Input is already validated by tmcp with Valibot
					const validatedInput = input as ThoughtData;
	
					logger.debug('Processing thought', {
						thoughtNumber: validatedInput.thought_number,
						totalThoughts: validatedInput.total_thoughts,
						isRevision: validatedInput.is_revision,
						branchId: validatedInput.branch_id,
					});
	
					if (
						validatedInput.thought_number > validatedInput.total_thoughts
					) {
						validatedInput.total_thoughts = validatedInput.thought_number;
						logger.debug('Adjusted total thoughts', {
							newTotal: validatedInput.total_thoughts
						});
					}
	
					// Calculate confidence if not provided
					if (validatedInput.confidence === undefined) {
						validatedInput.confidence = this.backtrackingManager.calculateConfidence(validatedInput);
						logger.debug('Calculated confidence', {
							thoughtNumber: validatedInput.thought_number,
							confidence: validatedInput.confidence,
						});
					}
	
					const backtrackResponse = this._evaluateBacktracking(validatedInput);
					if (backtrackResponse) {
						return backtrackResponse;
					}
	
					// Store the current step in thought history
					if (validatedInput.current_step) {
						if (!validatedInput.previous_steps) {
							validatedInput.previous_steps = [];
						}
						validatedInput.previous_steps.push(validatedInput.current_step);
						
						// Track tool usage in chain library
						if (this.enableToolChains) {
							for (const toolRec of validatedInput.current_step.recommended_tools) {
								this.toolChainLibrary.recordToolUse(
									toolRec.tool_name,
									validatedInput.current_step.step_description
								);
							}
						}
					}
	
					const dagStats = this._updateDAG(validatedInput);
	
					// Add to in-memory history
					this.thoughtHistory.push(validatedInput);
				
					// Prevent memory leaks by limiting history size
					if (this.thoughtHistory.length > this.maxHistorySize) {
						const excess = this.thoughtHistory.length - this.maxHistorySize;
						this.thoughtHistory.splice(0, excess);
						logger.warn('History trimmed', { maxSize: this.maxHistorySize });
					}
	
					// Save to persistent storage
					await this._persistThought(validatedInput);
	
					if (
						validatedInput.branch_from_thought &&
						validatedInput.branch_id
					) {
						if (!this.branches[validatedInput.branch_id]) {
							this.branches[validatedInput.branch_id] = [];
						}
						this.branches[validatedInput.branch_id].push(validatedInput);
						logger.debug('Branch updated', { 
							branchId: validatedInput.branch_id,
							branchSize: this.branches[validatedInput.branch_id].length
						});
					}
	
					const formattedThought = this.formatThought(validatedInput);
					logger.info(formattedThought);
	
					logger.info('Thought processed successfully', {
						thoughtNumber: validatedInput.thought_number,
						historyLength: this.thoughtHistory.length,
						confidence: validatedInput.confidence,
					});
	
					// Get confidence statistics
					const confidenceStats = this.backtrackingManager.getConfidenceStats();
					
					// Get tool chain suggestions if enabled
					let toolChainSuggestions;
					if (this.enableToolChains && validatedInput.previous_steps) {
						const previousTools = validatedInput.previous_steps
							.flatMap(step => step.recommended_tools.map(t => t.tool_name));
						const nextToolSuggestions = this.toolChainLibrary.suggestNextTool(previousTools);
						
						if (nextToolSuggestions.length > 0) {
							toolChainSuggestions = nextToolSuggestions.slice(0, 3);
							logger.debug('Tool chain suggestions generated', {
								suggestionCount: toolChainSuggestions.length,
							});
						}
					}
					
					// Finalize tool chain if this is the last thought
					if (this.enableToolChains && !validatedInput.next_thought_needed) {
						const success = (validatedInput.confidence || 0.5) >= 0.5;
						this.toolChainLibrary.finalizeCurrentChain(
							success,
							validatedInput.confidence,
							validatedInput.thought
						);
						logger.debug('Tool chain finalized', { 
							success, 
							confidence: validatedInput.confidence 
						});
					}
	
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify(
									{
										thought_number: validatedInput.thought_number,
										total_thoughts: validatedInput.total_thoughts,
										next_thought_needed:
											validatedInput.next_thought_needed,
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
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					const errorContext = createErrorContext('processThought', error, {
						thoughtNumber: input.thought_number,
						branchId: input.branch_id,
					});
					
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
								text: JSON.stringify(
									{
										error: errorContext.error,
										errorType: errorContext.errorType,
										status: 'failed',
										context: errorContext,
									},
									null,
									2,
								),
							},
						],
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
const scoringConfig = loadScoringConfig();
const maxHistorySize = parseIntegerWithFallback(process.env.MAX_HISTORY_SIZE, DEFAULT_MAX_HISTORY);
const enablePersistence = process.env.ENABLE_PERSISTENCE !== 'false';
const dbPath = process.env.DB_PATH || './mcp-thinking.db';
const enableBacktracking = process.env.ENABLE_BACKTRACKING === 'true' || scoringConfig.backtracking.enableAutoBacktrack;
const minConfidence = scoringConfig.backtracking.minConfidence;
const enableDAG = process.env.ENABLE_DAG === 'true';
const enableToolChains = process.env.ENABLE_TOOL_CHAINS !== 'false';

logger.info('Starting MCP Sequential Thinking Tools server', {
	maxHistorySize,
	enablePersistence,
	dbPath: enablePersistence ? dbPath : 'disabled',
	enableBacktracking,
	minConfidence,
	enableDAG,
	enableToolChains,
});

const thinkingServer = new ToolAwareSequentialThinkingServer({
	availableTools: [], // TODO: Add tool discovery mechanism
	maxHistorySize,
	enablePersistence,
	dbPath,
	enableBacktracking,
	minConfidence,
	enableDAG,
	enableToolChains,
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
