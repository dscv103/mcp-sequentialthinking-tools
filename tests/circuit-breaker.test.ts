import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitBreakerOpenError } from '../src/error-handling.js';

test('CircuitBreaker opens after repeated failures', async () => {
	const breaker = new CircuitBreaker({
		failureThreshold: 1,
		resetTimeoutMs: 1000,
		halfOpenSuccessThreshold: 1,
		name: 'test-breaker',
	});

await assert.rejects(
	() => breaker.execute(async () => {
		throw new Error('fail');
	}),
	Error,
);

	await assert.rejects(
		() => breaker.execute(async () => 'ok'),
		CircuitBreakerOpenError,
	);
});
