import { LogLevel } from './logging.js';

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

export const DEFAULT_SCORING_CONFIG: ScoringConfigShape = {
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
