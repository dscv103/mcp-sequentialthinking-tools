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

export class ThoughtDAG {
	private nodes: Map<number, DAGNode> = new Map();
	private executionOrder: number[] = [];

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
		const levels: Map<number, number> = new Map(); // thoughtNum -> level
		const missingLevels: number[] = [];

		for (const [thoughtNum, node] of this.nodes.entries()) {
			if (node.level === undefined) {
				missingLevels.push(thoughtNum);
			}
			levels.set(thoughtNum, node.level ?? 0);
		}

		if (missingLevels.length > 0) {
			logger.debug('Missing cached DAG levels detected', { 
				missingLevelCount: missingLevels.length,
				nodes: missingLevels,
			});
		}

		// Group by level
		const groups: Map<number, number[]> = new Map();
		for (const [thoughtNum, level] of levels.entries()) {
			if (!groups.has(level)) {
				groups.set(level, []);
			}
			groups.get(level)!.push(thoughtNum);
		}

		// Convert to array of arrays, sorted by level
		const result: number[][] = [];
		const sortedLevels = Array.from(groups.keys()).sort((a, b) => a - b);
		for (const level of sortedLevels) {
			result.push(groups.get(level)!);
		}

		logger.info('Parallel execution groups calculated', {
			groupCount: result.length,
			groups: result,
		});

		return result;
	}

	/**
	 * Clear the DAG
	 */
	clear(): void {
		this.nodes.clear();
		this.executionOrder = [];
		logger.info('DAG cleared');
	}
}
