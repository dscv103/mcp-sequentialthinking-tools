import { DEFAULT_SCORING_CONFIG, ScoringConfigShape } from './config-constants.js';
import { loadScoringConfig } from './config.js';
import { logger, LogLevel } from './logging.js';

export interface RuntimeConfig {
	maxHistorySize: number;
	enablePersistence: boolean;
	dbPath: string;
	enableBacktracking: boolean;
	minConfidence: number;
	enableDAG: boolean;
	enableToolChains: boolean;
	logLevel: LogLevel;
}

const parseIntegerWithFallback = (value: string | undefined, fallback: number): number => {
	const parsed = value !== undefined ? parseInt(value, 10) : NaN;
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(1, parsed);
};

export class ConfigurationManager {
	private scoringConfig: ScoringConfigShape;
	private runtimeConfig: RuntimeConfig;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.scoringConfig = loadScoringConfig(env);
		this.runtimeConfig = this.loadRuntimeConfig(env);
	}

	refresh(env: NodeJS.ProcessEnv = process.env): void {
		this.scoringConfig = loadScoringConfig(env);
		this.runtimeConfig = this.loadRuntimeConfig(env);
		logger.info('Configuration refreshed from environment', {
			maxHistorySize: this.runtimeConfig.maxHistorySize,
			enablePersistence: this.runtimeConfig.enablePersistence,
			enableBacktracking: this.runtimeConfig.enableBacktracking,
			enableDAG: this.runtimeConfig.enableDAG,
			enableToolChains: this.runtimeConfig.enableToolChains,
			logLevel: this.runtimeConfig.logLevel,
		});
	}

	getScoringConfig(): ScoringConfigShape {
		return {
			backtracking: { ...this.scoringConfig.backtracking },
			toolChains: { ...this.scoringConfig.toolChains },
			logging: { ...this.scoringConfig.logging },
		};
	}

	getRuntimeConfig(): RuntimeConfig {
		return { ...this.runtimeConfig };
	}

	private loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
		const scoring = this.scoringConfig ?? DEFAULT_SCORING_CONFIG;
		const maxHistorySize = parseIntegerWithFallback(env.MAX_HISTORY_SIZE, 1000);
		const enablePersistence = env.ENABLE_PERSISTENCE !== 'false';
		const dbPath = env.DB_PATH || './mcp-thinking.db';
		const enableBacktrackingEnv = env.ENABLE_BACKTRACKING;
		const enableBacktracking = enableBacktrackingEnv !== undefined
			? enableBacktrackingEnv === 'true'
			: scoring.backtracking.enableAutoBacktrack;

		const enableDAG = env.ENABLE_DAG === 'true';
		const enableToolChains = env.ENABLE_TOOL_CHAINS !== 'false';
		const logLevel = (env.LOG_LEVEL as LogLevel) || scoring.logging.level;

		return {
			maxHistorySize,
			enablePersistence,
			dbPath,
			enableBacktracking,
			minConfidence: scoring.backtracking.minConfidence,
			enableDAG,
			enableToolChains,
			logLevel,
		};
	}
}
