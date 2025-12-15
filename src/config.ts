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
		return result.output;
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
		backtracking: sanitizeBacktracking({
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
		}),
		toolChains: sanitizeToolChain({
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
		}),
		logging: {
			level: (env.LOG_LEVEL as LogLevel) || DEFAULT_SCORING_CONFIG.logging.level,
		},
	};

	return validateScoringConfig(merged);
};
