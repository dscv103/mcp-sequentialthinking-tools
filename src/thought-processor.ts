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
