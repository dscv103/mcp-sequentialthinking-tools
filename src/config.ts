import { LogLevel } from './logging.js';

type NumberParser = (value: string | undefined, fallback: number) => number;

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

const parseNumber: NumberParser = (value, fallback) => {
	const parsed = value !== undefined ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

const parseInteger: NumberParser = (value, fallback) => {
	const parsed = value !== undefined ? parseInt(value, 10) : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

export const ScoringConfig: ScoringConfigShape = {
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

export const loadScoringConfig = (): ScoringConfigShape => ({
	backtracking: {
		minConfidence: parseNumber(process.env.MIN_CONFIDENCE, ScoringConfig.backtracking.minConfidence),
		enableAutoBacktrack:
			process.env.ENABLE_BACKTRACKING === 'true'
				? true
				: process.env.ENABLE_BACKTRACKING === 'false'
					? false
					: ScoringConfig.backtracking.enableAutoBacktrack,
		maxBacktrackDepth: parseInteger(
			process.env.MAX_BACKTRACK_DEPTH,
			ScoringConfig.backtracking.maxBacktrackDepth,
		),
		baseConfidence: parseNumber(
			process.env.BASE_CONFIDENCE,
			ScoringConfig.backtracking.baseConfidence,
		),
		toolConfidenceWeight: parseNumber(
			process.env.TOOL_CONFIDENCE_WEIGHT,
			ScoringConfig.backtracking.toolConfidenceWeight,
		),
		revisionPenalty: parseNumber(
			process.env.REVISION_PENALTY,
			ScoringConfig.backtracking.revisionPenalty,
		),
		branchBonus: parseNumber(
			process.env.BRANCH_BONUS,
			ScoringConfig.backtracking.branchBonus,
		),
		progressBonus: parseNumber(
			process.env.PROGRESS_BONUS,
			ScoringConfig.backtracking.progressBonus,
		),
		progressThreshold: parseNumber(
			process.env.PROGRESS_THRESHOLD,
			ScoringConfig.backtracking.progressThreshold,
		),
		decliningConfidenceThreshold: parseNumber(
			process.env.DECLINING_CONFIDENCE_THRESHOLD,
			ScoringConfig.backtracking.decliningConfidenceThreshold,
		),
	},
	toolChains: {
		prefixMatchWeight: parseNumber(
			process.env.TOOL_CHAIN_PREFIX_MATCH_WEIGHT,
			ScoringConfig.toolChains.prefixMatchWeight,
		),
		keywordMatchWeight: parseNumber(
			process.env.TOOL_CHAIN_KEYWORD_MATCH_WEIGHT,
			ScoringConfig.toolChains.keywordMatchWeight,
		),
		highSuccessBonus: parseNumber(
			process.env.TOOL_CHAIN_HIGH_SUCCESS_BONUS,
			ScoringConfig.toolChains.highSuccessBonus,
		),
		recentUseBonus: parseNumber(
			process.env.TOOL_CHAIN_RECENT_USE_BONUS,
			ScoringConfig.toolChains.recentUseBonus,
		),
		recentUseDaysThreshold: parseNumber(
			process.env.TOOL_CHAIN_RECENT_USE_DAYS_THRESHOLD,
			ScoringConfig.toolChains.recentUseDaysThreshold,
		),
		highSuccessRateThreshold: parseNumber(
			process.env.TOOL_CHAIN_HIGH_SUCCESS_RATE_THRESHOLD,
			ScoringConfig.toolChains.highSuccessRateThreshold,
		),
		confidenceWeight: parseNumber(
			process.env.TOOL_CHAIN_CONFIDENCE_WEIGHT,
			ScoringConfig.toolChains.confidenceWeight,
		),
	},
	logging: {
		level: (process.env.LOG_LEVEL as LogLevel) || ScoringConfig.logging.level,
	},
});
