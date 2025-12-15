#!/usr/bin/env node

// adapted from https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/index.ts
// for use with mcp tools

import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { StdioTransport } from '@tmcp/transport-stdio';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SequentialThinkingSchema, SEQUENTIAL_THINKING_TOOL } from './schema.js';
import { logger } from './logging.js';
import { ConfigurationManager } from './config-manager.js';
import { ToolAwareSequentialThinkingServer } from './server.js';

const METRICS_INTERVAL_MS = 5 * 60 * 1000;

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const package_json = JSON.parse(
	readFileSync(join(__dirname, '../package.json'), 'utf-8'),
);
const { name, version } = package_json;

// Create MCP server with tmcp
const adapter = new ValibotJsonSchemaAdapter();
const server = new McpServer(
	{
		name,
		version,
		description: 'MCP server for Sequential Thinking Tools',
	},
	{
		adapter,
		capabilities: {
			tools: { listChanged: true },
		},
	},
);

// Read configuration from environment variables or command line args
const configurationManager = new ConfigurationManager();
const scoringConfig = configurationManager.getScoringConfig();
const runtimeConfig = configurationManager.getRuntimeConfig();

logger.info('Starting MCP Sequential Thinking Tools server', {
	maxHistorySize: runtimeConfig.maxHistorySize,
	enablePersistence: runtimeConfig.enablePersistence,
	dbPath: runtimeConfig.enablePersistence ? runtimeConfig.dbPath : 'disabled',
	enableBacktracking: runtimeConfig.enableBacktracking,
	minConfidence: runtimeConfig.minConfidence,
	enableDAG: runtimeConfig.enableDAG,
	enableToolChains: runtimeConfig.enableToolChains,
});

const thinkingServer = new ToolAwareSequentialThinkingServer({
	availableTools: [], // TODO: Add tool discovery mechanism
	maxHistorySize: runtimeConfig.maxHistorySize,
	enablePersistence: runtimeConfig.enablePersistence,
	dbPath: runtimeConfig.dbPath,
	enableBacktracking: runtimeConfig.enableBacktracking,
	minConfidence: runtimeConfig.minConfidence,
	enableDAG: runtimeConfig.enableDAG,
	enableToolChains: runtimeConfig.enableToolChains,
	configManager: configurationManager,
	scoringConfig,
});

// Register the sequential thinking tool
server.tool(
	{
		name: 'sequentialthinking_tools',
		title: 'Sequential Thinking Tool Recommender',
		description: SEQUENTIAL_THINKING_TOOL.description,
		schema: SequentialThinkingSchema,
		outputSchema: v.looseObject({}),
	},
	async (input: v.InferInput<typeof SequentialThinkingSchema>) => {
		return thinkingServer.processThought(input);
	},
);

async function main() {
	// Initialize server state (hydration)
	await thinkingServer.initialize();

	const transport = new StdioTransport(server);
	transport.listen();
	logger.info('Sequential Thinking MCP Server running on stdio');

	// Log metrics periodically (every 5 minutes)
	const metricsInterval = setInterval(() => {
		logger.logMetrics();
	}, METRICS_INTERVAL_MS);

	// Clean up resources on shutdown
	const cleanup = () => {
		logger.info('Shutting down server...');
		clearInterval(metricsInterval);
		thinkingServer.shutdown();
		process.exit(0);
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
	process.on('beforeExit', cleanup);
}

main().catch((error) => {
	logger.error('Fatal error running server', error);
	process.exit(1);
});
