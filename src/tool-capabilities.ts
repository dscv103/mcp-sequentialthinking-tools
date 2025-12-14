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
