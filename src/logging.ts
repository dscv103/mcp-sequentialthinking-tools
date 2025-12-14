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
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	[LogLevel.DEBUG]: 0,
	[LogLevel.INFO]: 1,
	[LogLevel.WARN]: 2,
	[LogLevel.ERROR]: 3,
};

class Logger {
	private config: LoggerConfig;
	private metrics: Map<string, { count: number; totalDuration: number }> = new Map();

	constructor(config: Partial<LoggerConfig> = {}) {
		this.config = {
			minLevel: LogLevel.INFO,
			enableConsole: true,
			enableStructured: true,
			...config,
		};
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.minLevel];
	}

	private formatEntry(entry: LogEntry): string {
		if (this.config.enableStructured) {
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

		const formatted = this.formatEntry(entry);
		
		if (this.config.enableConsole) {
			// Use console.error for all logs since MCP uses stdio for communication
			console.error(formatted);
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

	/**
	 * Log metrics summary
	 */
	logMetrics(): void {
		const metrics = this.getMetrics();
		this.info('Performance metrics', { metrics });
	}
}

// Create a default logger instance
export const logger = new Logger({
	minLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
	enableConsole: true,
	enableStructured: process.env.STRUCTURED_LOGS === 'true',
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
