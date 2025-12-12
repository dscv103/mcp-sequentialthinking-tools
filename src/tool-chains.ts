/**
 * Tool chaining pattern library
 * Tracks successful tool sequences and provides recommendations
 */

import { StepRecommendation, ToolRecommendation } from './types.js';
import { logger } from './logging.js';
import { PersistenceLayer } from './persistence.js';

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

	constructor() {
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
				const weight = 0.3; // Weight for new value
				chain.averageConfidence = 
					chain.averageConfidence * (1 - weight) + confidence * weight;
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
					matchScore += matchLength * 10;
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
					matchScore += matchingKeywords.length * 5;
					reasons.push(`Context matches: ${matchingKeywords.join(', ')}`);
				}
			}

			// Bonus for high success rate
			if (successRate > 0.8) {
				matchScore += 5;
				reasons.push('High success rate');
			}

			// Bonus for recent use
			const daysSinceUse = (Date.now() - new Date(chain.lastUsed).getTime()) 
				/ (1000 * 60 * 60 * 24);
			if (daysSinceUse < 7) {
				matchScore += 3;
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
