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
import { withRetry, safeExecute, createErrorContext } from './error-handling.js';
import { PersistenceLayer } from './persistence.js';
import { ToolCapabilityMatcher, enrichToolsWithCapabilities } from './tool-capabilities.js';
import { BacktrackingManager } from './backtracking.js';

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
	maxHistorySize?: number;
	enablePersistence?: boolean;
	dbPath?: string;
	sessionId?: string;
	enableBacktracking?: boolean;
	minConfidence?: number;
}

class ToolAwareSequentialThinkingServer {
	private thought_history: ThoughtData[] = [];
	private branches: Record<string, ThoughtData[]> = {};
	private available_tools: Map<string, Tool> = new Map();
	private maxHistorySize: number;
	private persistence: PersistenceLayer;
	private sessionId: string;
	private toolMatcher: ToolCapabilityMatcher;
	private backtrackingManager: BacktrackingManager;

	public getAvailableTools(): Tool[] {
		return Array.from(this.available_tools.values());
	}

	constructor(options: ServerOptions = {}) {
		this.maxHistorySize = options.maxHistorySize || 1000;
		this.sessionId = options.sessionId || `session-${Date.now()}`;
		
		// Initialize persistence layer
		this.persistence = new PersistenceLayer({
			enablePersistence: options.enablePersistence ?? true,
			dbPath: options.dbPath,
		});
		
		// Initialize backtracking manager
		this.backtrackingManager = new BacktrackingManager({
			enableAutoBacktrack: options.enableBacktracking ?? false,
			minConfidence: options.minConfidence ?? 0.3,
		});
		
		logger.info('Server initialized', { 
			maxHistorySize: this.maxHistorySize,
			sessionId: this.sessionId,
			persistenceEnabled: options.enablePersistence ?? true,
			backtrackingEnabled: options.enableBacktracking ?? false,
		});
		
		// Always include the sequential thinking tool
		const tools = [
			SEQUENTIAL_THINKING_TOOL,
			...(options.available_tools || []),
		];

		// Initialize with provided tools
		tools.forEach((tool) => {
			if (this.available_tools.has(tool.name)) {
				logger.warn('Duplicate tool name detected', { 
					toolName: tool.name,
					message: 'Using first occurrence'
				});
				return;
			}
			this.available_tools.set(tool.name, tool);
		});

		// Enrich tools with capability metadata
		enrichToolsWithCapabilities(this.available_tools);
		
		// Initialize tool matcher
		this.toolMatcher = new ToolCapabilityMatcher(this.available_tools);

		logger.info('Tools initialized', { 
			toolCount: this.available_tools.size,
			tools: Array.from(this.available_tools.keys()),
			categories: this.toolMatcher.getCategories(),
			tags: this.toolMatcher.getTags(),
		});
	}

	public clearHistory(): void {
		this.thought_history = [];
		this.branches = {};
		this.persistence.clearHistory(this.sessionId);
		this.backtrackingManager.clear();
		logger.info('History cleared', { sessionId: this.sessionId });
	}

	public addTool(tool: Tool): void {
		if (this.available_tools.has(tool.name)) {
			logger.warn('Tool already exists', { toolName: tool.name });
			return;
		}
		this.available_tools.set(tool.name, tool);
		
		// Enrich with capabilities if not present
		enrichToolsWithCapabilities(this.available_tools);
		
		// Recreate matcher with updated tools
		this.toolMatcher = new ToolCapabilityMatcher(this.available_tools);
		
		logger.info('Tool added', { toolName: tool.name });
	}

	public discoverTools(): void {
		// In a real implementation, this would scan the environment
		// for available MCP tools and add them to available_tools
		logger.warn('Tool discovery not implemented - manually add tools via addTool()');
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

				// Check if backtracking is needed
				const backtrackDecision = this.backtrackingManager.shouldBacktrack(validatedInput);
				if (backtrackDecision.shouldBacktrack) {
					logger.warn('Backtracking triggered', {
						thoughtNumber: validatedInput.thought_number,
						reason: backtrackDecision.reason,
						backtrackTo: backtrackDecision.backtrackTo,
					});
					
					// Include backtracking suggestion in response
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify(
									{
										thought_number: validatedInput.thought_number,
										total_thoughts: validatedInput.total_thoughts,
										confidence: validatedInput.confidence,
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

				// Store the current step in thought history
				if (validatedInput.current_step) {
					if (!validatedInput.previous_steps) {
						validatedInput.previous_steps = [];
					}
					validatedInput.previous_steps.push(validatedInput.current_step);
				}

				// Add to in-memory history
				this.thought_history.push(validatedInput);
			
				// Prevent memory leaks by limiting history size
				if (this.thought_history.length > this.maxHistorySize) {
					this.thought_history = this.thought_history.slice(-this.maxHistorySize);
					logger.warn('History trimmed', { maxSize: this.maxHistorySize });
				}

				// Save to persistent storage
				await this.persistence.saveThought(validatedInput, this.sessionId);

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
				console.error(formattedThought);

				logger.info('Thought processed successfully', {
					thoughtNumber: validatedInput.thought_number,
					historyLength: this.thought_history.length,
					confidence: validatedInput.confidence,
				});

				// Get confidence statistics
				const confidenceStats = this.backtrackingManager.getConfidenceStats();

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
									thought_history_length: this.thought_history.length,
									available_mcp_tools: validatedInput.available_mcp_tools,
									current_step: validatedInput.current_step,
									previous_steps: validatedInput.previous_steps,
									remaining_steps: validatedInput.remaining_steps,
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
	}

	// Tool execution removed - the MCP client handles tool execution
	// This server only provides tool recommendations
}

// Read configuration from environment variables or command line args
const maxHistorySize = parseInt(process.env.MAX_HISTORY_SIZE || '1000');
const enablePersistence = process.env.ENABLE_PERSISTENCE !== 'false';
const dbPath = process.env.DB_PATH || './mcp-thinking.db';
const enableBacktracking = process.env.ENABLE_BACKTRACKING === 'true';
const minConfidence = parseFloat(process.env.MIN_CONFIDENCE || '0.3');

logger.info('Starting MCP Sequential Thinking Tools server', {
	maxHistorySize,
	enablePersistence,
	dbPath: enablePersistence ? dbPath : 'disabled',
	enableBacktracking,
	minConfidence,
});

const thinkingServer = new ToolAwareSequentialThinkingServer({
	available_tools: [], // TODO: Add tool discovery mechanism
	maxHistorySize,
	enablePersistence,
	dbPath,
	enableBacktracking,
	minConfidence,
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
	setInterval(() => {
		logger.logMetrics();
	}, 5 * 60 * 1000);
}

main().catch((error) => {
	logger.error('Fatal error running server', error);
	process.exit(1);
});