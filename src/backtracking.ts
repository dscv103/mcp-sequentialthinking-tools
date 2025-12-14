/**
 * Backtracking support with confidence scoring
 * Enables pruning of low-quality reasoning paths
 */

import { ThoughtData } from './types.js';
import { logger } from './logging.js';

export interface BacktrackingConfig {
	minConfidence: number;  // Minimum confidence threshold (0-1)
	enableAutoBacktrack: boolean;  // Automatically backtrack on low confidence
	maxBacktrackDepth: number;  // Maximum number of thoughts to backtrack
}

export interface BacktrackPoint {
	thoughtNumber: number;
	confidence: number;
	reason: string;
}

const DEFAULT_CONFIG: BacktrackingConfig = {
	minConfidence: 0.3,
	enableAutoBacktrack: false,
	maxBacktrackDepth: 5,
};

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
		let confidence = 0.5; // Start with neutral confidence
		let factors = 0;

		// Factor 1: Tool recommendations confidence
		if (thought.current_step?.recommended_tools) {
			const toolConfidences = thought.current_step.recommended_tools.map(t => t.confidence);
			if (toolConfidences.length > 0) {
				const avgToolConfidence = toolConfidences.reduce((a, b) => a + b, 0) / toolConfidences.length;
				confidence += avgToolConfidence * 0.3;
				factors++;
			}
		}

		// Factor 2: Revision indicates uncertainty
		if (thought.is_revision) {
			confidence -= 0.1;
			factors++;
		}

		// Factor 3: Branching indicates exploration (neutral to slightly positive)
		if (thought.branch_from_thought) {
			confidence += 0.05;
			factors++;
		}

		// Factor 4: Progress toward goal
		if (thought.thought_number && thought.total_thoughts) {
			const progress = thought.thought_number / thought.total_thoughts;
			// Later thoughts with clear next steps are more confident
			if (!thought.next_thought_needed && progress > 0.8) {
				confidence += 0.2;
				factors++;
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

			if (isDecreasing && recentThree[recentThree.length - 1] < 0.5) {
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
