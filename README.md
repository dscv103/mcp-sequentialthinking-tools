# MCP Sequential Thinking Tools

A Model Context Protocol (MCP) server that recommends tools for step-by-step reasoning. It tracks thoughts, scores confidence, suggests backtracking when quality drops, and learns tool-chain patterns. The server never executes tools itself; it only recommends them with structured output so your MCP client can run the tools.

<a href="https://glama.ai/mcp/servers/zl990kfusy">
 <img width="380" height="200" src="https://glama.ai/mcp/servers/zl990kfusy/badge" />
</a>

## What It Does

- Produces ranked MCP tool recommendations with rationale and suggested inputs
- Tracks branches, revisions, and progress with confidence scoring
- Suggests backtracking when confidence falls below thresholds
- Builds a DAG of thoughts to reason about ordering/parallelism
- Learns successful tool sequences and suggests the next likely tool
- Persists thoughts to SQLite (optional) and trims in-memory history
- Guards persistence/DAG with circuit breakers and structured error contexts

## Why It Works (Algorithms)

- **Confidence scoring**: combines tool confidence, revisions, branching, and progress to rate each thought.
- **Backtracking**: proposes a prior thought to revisit when confidence dips below `MIN_CONFIDENCE`.
- **DAG reasoning**: auto-adds dependencies (previous thought, branch source, or revision target) to enable parallel-ready planning.
- **Tool-chain learning**: records successful sequences, scores by success rate and recency, and suggests next tools.
- **Capability matching**: infers categories/tags from tool descriptions to improve ranking.
- **Persistence + breakers**: SQLite storage with circuit breakers so transient DB/DAG faults do not crash sessions.

## Quick Start (runtime)

1) Install Node.js 20+.
2) Run directly:

```bash
npx -y mcp-sequentialthinking-tools
```

3) Configure your MCP client (examples below) to point at the binary and set env vars.

For development from source:

```bash
pnpm install
pnpm build
pnpm start
```

## MCP Client Configuration Examples

### Cline

```json
{
 "mcpServers": {
  "mcp-sequentialthinking-tools": {
   "command": "npx",
   "args": ["-y", "mcp-sequentialthinking-tools"],
   "env": {
    "MAX_HISTORY_SIZE": "1000"
   }
  }
 }
}
```

### Claude Desktop (WSL)

```json
{
 "mcpServers": {
  "mcp-sequentialthinking-tools": {
   "command": "wsl.exe",
   "args": [
    "bash",
    "-c",
    "MAX_HISTORY_SIZE=1000 source ~/.nvm/nvm.sh && /home/username/.nvm/versions/node/v20.12.1/bin/npx mcp-sequentialthinking-tools"
   ]
  }
 }
}
```

### Google Antigravity

```json
{
 "mcpServers": {
  "mcp-sequentialthinking-tools": {
   "command": "node",
   "args": ["/home/dscv/Repositories/mcp-sequentialthinking-tools/dist/index.js"],
   "env": {
    "MAX_HISTORY_SIZE": "1000"
   }
  }
 }
}
```

## Tool Contract: `sequentialthinking_tools`

Single MCP tool that returns recommendations only. Minimal request:

```json
{
 "available_mcp_tools": ["mcp-omnisearch", "mcp-turso-cloud"],
 "thought": "Understand Svelte 5 universal reactivity",
 "thought_number": 1,
 "total_thoughts": 5,
 "next_thought_needed": true
}
```

Response always includes `content` and `structuredContent`. Example (truncated):

```json
{
 "structuredContent": {
  "thought_number": 1,
  "confidence": 0.78,
  "current_step": {
   "step_description": "Gather initial docs",
   "recommended_tools": [
    {"tool_name": "search_docs", "priority": 1, "confidence": 0.9},
    {"tool_name": "tavily_search", "priority": 2, "confidence": 0.8}
   ]
  },
  "dag_stats": {"total": 1, "completed": 1}
 }
}
```

## MCP Patterns Mapped to Sequential Thinking

- **Backtracking**: confidence-aware `shouldBacktrack` gate with suggested `backtrack_to_thought` in responses.
- **DAG/parallelism**: thoughts become nodes; revisions/branches add edges; stats include parallel group counts.
- **Tool-chain suggestions**: learned sequences surface `tool_chain_suggestions` for the next tool candidates.
- **Capability matching**: inferred categories/tags enrich ranking and provide alternates.
- **Structured outputs**: every response returns JSON in both `content` and `structuredContent` for clients.
- **Execution contract**: server recommends only—clients execute tools.

## Components (map to source)

- Server wiring and MCP registration: [src/index.ts](src/index.ts)
- Schemas and types: [src/schema.ts](src/schema.ts), [src/types.ts](src/types.ts)
- Thought processing pipeline: [src/thought-processor.ts](src/thought-processor.ts)
- Backtracking/confidence: [src/backtracking.ts](src/backtracking.ts)
- DAG management: [src/dag.ts](src/dag.ts)
- Tool-chain learning: [src/tool-chains.ts](src/tool-chains.ts)
- Capability enrichment/matching: [src/tool-capabilities.ts](src/tool-capabilities.ts)
- Persistence (SQLite) with circuit breaker guards: [src/persistence.ts](src/persistence.ts)
- Config loading/validation and defaults: [src/config-manager.ts](src/config-manager.ts), [src/config-constants.ts](src/config-constants.ts), [src/config.ts](src/config.ts)
- Logging/metrics and error handling: [src/logging.ts](src/logging.ts), [src/error-handling.ts](src/error-handling.ts)

## Configuration (env vars)

- History: `MAX_HISTORY_SIZE` (default 1000)
- Persistence: `ENABLE_PERSISTENCE` (true), `DB_PATH` (./mcp-thinking.db)
- Backtracking: `ENABLE_BACKTRACKING` (false), `MIN_CONFIDENCE` (0.3)
- DAG: `ENABLE_DAG` (false)
- Tool chains: `ENABLE_TOOL_CHAINS` (true)
- Logging: `LOG_LEVEL` (info), `STRUCTURED_LOGS` (false), `LOG_FORMATS` (json,pretty)

## Performance and Reliability Notes

- Persistence is optional; when disabled, the circuit breaker prevents DB calls.
- DAG updates are breaker-guarded to avoid cascading failures.
- History trimming keeps memory bounded; persistence retains full history per session.
- Capability inference runs once per tool; formatting uses a small cache (bounded to avoid memory bloat).
- SQLite tables are indexed for thought/step lookups.

## Development

- Install deps: `pnpm install`
- Build: `pnpm build`
- Run with inspector: `pnpm dev` (uses @modelcontextprotocol/inspector against built output)
- Start built server: `pnpm start`
- Tests (focused suite): `pnpm test`

## License

MIT License. See [LICENSE](LICENSE).
The server implements a single MCP tool with configurable parameters:
