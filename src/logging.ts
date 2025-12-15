/**
 * Structured logging for MCP Sequential Thinking Tools
 * Provides JSON-formatted logs with contextual information
 */

export enum LogLevel {
	DEBUG = 'debug',
	INFO = 'info',
	WARN = 'warn',
	ERROR = 'error',
}

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	operation?: string;
	thoughtNumber?: number;
	branchId?: string;
	duration?: number;
	metadata?: Record<string, unknown>;
}

export interface LoggerConfig {
	minLevel: LogLevel;
	enableConsole: boolean;
	enableStructured: boolean;
	outputFormats: Array<'json' | 'pretty'>;
	sinks?: LogSink[];
}

export interface LogSink {
	write(entry: LogEntry, formatted: string): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	[LogLevel.DEBUG]: 0,
	[LogLevel.INFO]: 1,
	[LogLevel.WARN]: 2,
	[LogLevel.ERROR]: 3,
};

const isValidLogFormat = (format: string): format is 'json' | 'pretty' =>
	format === 'json' || format === 'pretty';

class Logger {
	private config: LoggerConfig;
	private metrics: Map<string, { count: number; totalDuration: number }> = new Map();
	private logCounts: Record<LogLevel, number> = {
		[LogLevel.DEBUG]: 0,
		[LogLevel.INFO]: 0,
		[LogLevel.WARN]: 0,
		[LogLevel.ERROR]: 0,
	};
	private sinks: LogSink[] = [];

	constructor(config: Partial<LoggerConfig> = {}) {
		this.config = {
			minLevel: LogLevel.INFO,
			enableConsole: true,
			enableStructured: true,
			outputFormats: config.outputFormats ?? (config.enableStructured === false ? ['pretty'] : ['json']),
			...config,
		};

		this.sinks = [...(config.sinks || [])];

		if (this.config.enableConsole) {
			this.sinks.push({
				write: (_entry, formatted) => {
					console.error(formatted);
				},
			});
		}
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.minLevel];
	}

	private formatEntry(entry: LogEntry, format: 'json' | 'pretty'): string {
		if (format === 'json') {
			return JSON.stringify(entry);
		}

		const parts = [
			entry.timestamp,
			`[${entry.level.toUpperCase()}]`,
			entry.operation ? `[${entry.operation}]` : '',
			entry.message,
		].filter(Boolean);

		return parts.join(' ');
	}

	private log(entry: LogEntry): void {
		if (!this.shouldLog(entry.level)) {
			return;
		}

		this.logCounts[entry.level]++;

		const formattedEntries = this.config.outputFormats.map(format => this.formatEntry(entry, format));
		const payload = formattedEntries.length === 1
			? formattedEntries[0]
			: formattedEntries.join('\n');

		for (const sink of this.sinks) {
			sink.write(entry, payload);
		}
	}

	debug(message: string, metadata?: Record<string, unknown>): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: LogLevel.DEBUG,
			message,
			metadata,
		});
	}

	info(message: string, metadata?: Record<string, unknown>): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: LogLevel.INFO,
			message,
			metadata,
		});
	}

	warn(message: string, metadata?: Record<string, unknown>): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: LogLevel.WARN,
			message,
			metadata,
		});
	}

	error(message: string, error?: unknown, metadata?: Record<string, unknown>): void {
		const errorInfo = error instanceof Error 
			? { error: error.message, stack: error.stack }
			: { error: String(error) };
		
		this.log({
			timestamp: new Date().toISOString(),
			level: LogLevel.ERROR,
			message,
			metadata: { ...metadata, ...errorInfo },
		});
	}

	/**
	 * Log an operation with duration tracking
	 */
	operation(
		operation: string,
		message: string,
		metadata?: Record<string, unknown>
	): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: LogLevel.INFO,
			message,
			operation,
			metadata,
		});
	}

	/**
	 * Track operation metrics
	 */
	trackMetric(operation: string, duration: number): void {
		const existing = this.metrics.get(operation) || { count: 0, totalDuration: 0 };
		this.metrics.set(operation, {
			count: existing.count + 1,
			totalDuration: existing.totalDuration + duration,
		});
	}

	/**
	 * Get performance metrics
	 */
	getMetrics(): Record<string, { count: number; avgDuration: number }> {
		const result: Record<string, { count: number; avgDuration: number }> = {};
		
		for (const [operation, data] of this.metrics.entries()) {
			result[operation] = {
				count: data.count,
				avgDuration: data.totalDuration / data.count,
			};
		}
		
		return result;
	}

	getLogCounts(): Record<LogLevel, number> {
		return { ...this.logCounts };
	}

	/**
	 * Log metrics summary
	 */
	logMetrics(): void {
		const metrics = this.getMetrics();
		this.info('Performance metrics', { metrics, logs: this.getLogCounts() });
	}
}

const getOutputFormatsFromEnv = (): Array<'json' | 'pretty'> => {
	const fromEnv = process.env.LOG_FORMATS
		?.split(',')
		.map(format => format.trim().toLowerCase())
		.filter(isValidLogFormat);

	if (fromEnv && fromEnv.length > 0) {
		return Array.from(new Set(fromEnv));
	}

	return process.env.STRUCTURED_LOGS === 'false' ? ['pretty'] : ['json'];
};

// Create a default logger instance
export const logger = new Logger({
	minLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
	enableConsole: true,
	enableStructured: process.env.STRUCTURED_LOGS !== 'false',
	outputFormats: getOutputFormatsFromEnv(),
});

/**
 * Measure execution time of an operation
 */
export async function measureTime<T>(
	operation: string,
	fn: () => Promise<T>
): Promise<T> {
	const startTime = performance.now();
	
	try {
		const result = await fn();
		const duration = performance.now() - startTime;
		logger.trackMetric(operation, duration);
		logger.debug(`Operation completed: ${operation}`, { duration });
		return result;
	} catch (error) {
		const duration = performance.now() - startTime;
		logger.trackMetric(operation, duration);
		logger.error(`Operation failed: ${operation}`, error, { duration });
		throw error;
	}
}
