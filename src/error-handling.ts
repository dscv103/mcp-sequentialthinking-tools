/**
 * Error handling utilities for MCP Sequential Thinking Tools
 * Provides structured error context and retry logic
 */

export interface ErrorContext {
	operation: string;
	timestamp: string;
	error: string;
	errorType: string;
	retryCount?: number;
	thoughtNumber?: number;
	branchId?: string;
	stackTrace?: string;
}

export interface RetryConfig {
	maxRetries: number;
	initialDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	initialDelayMs: 100,
	maxDelayMs: 5000,
	backoffMultiplier: 2,
};

/**
 * Wrap an error with structured context
 */
export function createErrorContext(
	operation: string,
	error: unknown,
	additionalContext?: Partial<ErrorContext>
): ErrorContext {
	const errorObj = error instanceof Error ? error : new Error(String(error));
	
	return {
		operation,
		timestamp: new Date().toISOString(),
		error: errorObj.message,
		errorType: errorObj.name || 'UnknownError',
		stackTrace: errorObj.stack,
		...additionalContext,
	};
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		// Network errors, timeouts, rate limits are retryable
		return (
			message.includes('timeout') ||
			message.includes('network') ||
			message.includes('econnrefused') ||
			message.includes('rate limit') ||
			message.includes('429') ||
			message.includes('503') ||
			message.includes('temporary')
		);
	}
	return false;
}

/**
 * Calculate exponential backoff delay
 */
function calculateDelay(
	retryCount: number,
	config: RetryConfig
): number {
	const delay = Math.min(
		config.initialDelayMs * Math.pow(config.backoffMultiplier, retryCount),
		config.maxDelayMs
	);
	// Add jitter to prevent thundering herd
	return delay + Math.random() * 100;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with retry logic
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	operationName: string,
	config: Partial<RetryConfig> = {}
): Promise<T> {
	const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
	let lastError: unknown;
	
	for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			
			// Don't retry if it's not a retryable error
			if (!isRetryableError(error)) {
				throw error;
			}
			
			// Don't retry if we've exhausted attempts
			if (attempt >= retryConfig.maxRetries) {
				break;
			}
			
			const delay = calculateDelay(attempt, retryConfig);
			console.error(
				`Operation "${operationName}" failed (attempt ${attempt + 1}/${retryConfig.maxRetries + 1}), ` +
				`retrying in ${Math.round(delay)}ms...`,
				error instanceof Error ? error.message : String(error)
			);
			
			await sleep(delay);
		}
	}
	
	// If we get here, all retries failed
	const errorContext = createErrorContext(operationName, lastError, {
		retryCount: retryConfig.maxRetries,
	});
	
	throw new Error(
		`Operation "${operationName}" failed after ${retryConfig.maxRetries + 1} attempts. ` +
		`Last error: ${errorContext.error}`
	);
}

/**
 * Safe wrapper that catches errors and returns structured error context
 */
export async function safeExecute<T>(
	operation: () => Promise<T>,
	operationName: string,
	fallback?: T
): Promise<{ success: true; data: T } | { success: false; error: ErrorContext; data?: T }> {
	try {
		const data = await operation();
		return { success: true, data };
	} catch (error) {
		const errorContext = createErrorContext(operationName, error);
		console.error(`Operation "${operationName}" failed:`, errorContext);
		
		if (fallback !== undefined) {
			return { success: false, error: errorContext, data: fallback };
		}
		
		return { success: false, error: errorContext };
	}
}
