## Purpose
- Guide AI coding agents to work productively in this MCP server by documenting the architecture, workflows, configuration, and project-specific patterns grounded in this repo.

## Big Picture
- This is a TypeScript Model Context Protocol (MCP) server that recommends tools for sequential thinking. It does not execute tools; MCP clients do.
- Core runtime composes distinct modules:
  - **Server Entrypoint**: [src/index.ts](src/index.ts) wires MCP server, registers `sequentialthinking_tools`, and manages lifecycle.
  - **Schemas & Types**: [src/schema.ts](src/schema.ts) defines `SequentialThinkingSchema`; [src/types.ts](src/types.ts) holds `Tool`, `ThoughtData`, etc.
  - **Processing**: [src/thought-processor.ts](src/thought-processor.ts) coordinates backtracking, persistence, DAG, tool chains, and scoring.
  - **Reasoning Systems**: [src/backtracking.ts](src/backtracking.ts), [src/dag.ts](src/dag.ts), [src/tool-chains.ts](src/tool-chains.ts).
  - **Capabilities**: [src/tool-capabilities.ts](src/tool-capabilities.ts) enriches tools and matches by category/tags.
  - **Persistence**: [src/persistence.ts](src/persistence.ts) uses SQLite (better-sqlite3) with circuit breaker guards.
  - **Config**: [src/config-manager.ts](src/config-manager.ts) + [src/config-constants.ts](src/config-constants.ts) load/validate env and scoring presets.
  - **Reliability**: [src/error-handling.ts](src/error-handling.ts) provides circuit breakers and categorized error contexts.
  - **Logging**: [src/logging.ts](src/logging.ts) structured logs, metrics, and timing helpers.

## Key Behavior
- The MCP tool name is `sequentialthinking_tools` and expects input shaped by `SequentialThinkingSchema`.
- Entrypoint enriches `availableTools`, builds managers (persistence, DAG, backtracking), and delegates to `ThoughtProcessor.processThought()`.
- Tool execution is deliberately removed; this server only recommends tools (see comment block in [src/index.ts](src/index.ts#L164-L170)).

## Developer Workflows
- Build: `pnpm build` (emits to `dist`, sets executable bit on `dist/index.js`).
- Dev run with MCP Inspector: `pnpm dev` (runs `@modelcontextprotocol/inspector` on `dist/index.js`).
- Start node directly: `pnpm start` after build.
- Tests: `pnpm test` runs focused suite: DAG, backtracking, circuit breaker, persistence.
- Publish: `pnpm changeset`, `pnpm version`, `pnpm release` (see [README.md](README.md)).

## Configuration Conventions
- Runtime config comes from env vars via `ConfigurationManager`:
  - History/persistence/backtracking/DAG/tool-chains toggles and thresholds are read and validated.
  - See examples in [README.md](README.md#L232-L290) and defaults in [src/config-constants.ts](src/config-constants.ts).
- Common envs: `MAX_HISTORY_SIZE`, `ENABLE_PERSISTENCE`, `DB_PATH`, `ENABLE_BACKTRACKING`, `MIN_CONFIDENCE`, `ENABLE_DAG`, `ENABLE_TOOL_CHAINS`, `LOG_LEVEL`, `STRUCTURED_LOGS`.
- Structured logs and periodic metrics are controlled via logging envs; metrics log every 5 minutes.

## Error Handling & Reliability
- Circuit breakers protect persistence and DAG operations (constructed in [src/index.ts](src/index.ts#L73-L120), implemented in [src/error-handling.ts](src/error-handling.ts)).
- Errors returned from tool handler include categorized context with `isError: true` payload.

## Data Flow
- Input (MCP tool call) → validation (`valibot` via `SequentialThinkingSchema`) → `ThoughtProcessor.processThought()`.
- `ThoughtProcessor` consults backtracking policy, persistence (SQLite), DAG graph, and tool chain library to produce recommendations.
- Tool metadata is enriched and matched via `ToolCapabilityMatcher` to suggest alternatives and priorities.

## Project-Specific Patterns
- Use `valibot` for schema validation; keep schema changes centralized in [src/schema.ts](src/schema.ts).
- Persist long-running sessions via `PersistenceLayer`; guard DB operations with circuit breakers and keep session-scoped history limits.
- Logging: prefer `logger.info/debug/warn/error` and `measureTime()` around expensive operations.
- Avoid executing tools here; AI agents should maintain the contract: recommend tools only.
- When adding tools, call `addTool()`; capabilities are auto-enriched and matcher rebuilt.

## Integration Points
- MCP transport: `@tmcp/transport-stdio` with `McpServer` from `tmcp`.
- JSON schema adaptation: `@tmcp/adapter-valibot`.
- SQLite: `better-sqlite3` via `PersistenceLayer` in [src/persistence.ts](src/persistence.ts).

## Examples for Agents
- Invoke the tool: provide `available_mcp_tools` plus a thought record matching [src/schema.ts](src/schema.ts) fields; expect a response with recommended tools, rationale, confidence, and sequencing.
- Toggle features during dev quickly: `ENABLE_DAG=true ENABLE_BACKTRACKING=true STRUCTURED_LOGS=true pnpm dev`.
- Clear session history programmatically via `ToolAwareSequentialThinkingServer.clearHistory()` if wiring custom runners.

### Minimal Example Input
Use this payload when calling `sequentialthinking_tools`:

```json
{
  "available_mcp_tools": ["mcp-omnisearch", "mcp-turso-cloud"],
  "thought": "Identify the best docs tool to start research",
  "next_thought_needed": true,
  "thought_number": 1,
  "total_thoughts": 3,
  "current_step": {
    "step_description": "Search official docs for starting points",
    "expected_outcome": "List of authoritative doc pages",
    "recommended_tools": []
  }
}
```

## Testing Focus
- Test targets emphasize reasoning infrastructure (DAG, backtracking, persistence, circuit breaker). Keep changes aligned with these contracts to satisfy `pnpm test` suite.

### Quick Run & Test

```bash
# install deps
pnpm install

# build and run with inspector
pnpm build
pnpm dev

# or start directly
pnpm start

# run focused tests
pnpm test
```

## Quick Links
- Entrypoint: [src/index.ts](src/index.ts)
- Processor: [src/thought-processor.ts](src/thought-processor.ts)
- Schema: [src/schema.ts](src/schema.ts)
- Config: [src/config-manager.ts](src/config-manager.ts), [src/config-constants.ts](src/config-constants.ts)
- Persistence: [src/persistence.ts](src/persistence.ts)
- Reliability: [src/error-handling.ts](src/error-handling.ts)
- Capabilities: [src/tool-capabilities.ts](src/tool-capabilities.ts)

## Gotchas
- **Tool execution**: This server only recommends tools; MCP clients execute them. Don’t add execution here—keep recommendations via `sequentialthinking_tools`.
- **Schema changes**: Update `SequentialThinkingSchema` only in [src/schema.ts](src/schema.ts) and ensure the inspector/dev run still validates inputs.
- **Persistence toggles**: When `ENABLE_PERSISTENCE=false`, DB calls are disabled but code paths still exist—guard logic already uses circuit breakers.
- **Circuit breakers**: Failures in persistence/DAG trip breakers; repeated rapid calls can keep them open. Prefer staggered retries and check logs.
- **Session locks**: `processThought()` is serialized per `sessionId`. Long-running steps block subsequent ones; avoid synchronous heavy work inside processing.
- **Capabilities enrichment**: Adding tools requires `addTool()`; capability tags auto-enrich, but duplicate tool names are ignored (first occurrence wins).
- **Logging format**: If `STRUCTURED_LOGS=true`, logs are JSON; avoid relying on pretty logs in production analysis.
- **DAG/backtracking defaults**: `ENABLE_DAG` and `ENABLE_BACKTRACKING` are off by default; tests assume focused coverage rather than end-to-end parallelism.

## Code Review
- **Execution contract**: Confirm no tool execution is added; only recommendations via `sequentialthinking_tools` in [src/index.ts](src/index.ts).
- **Schema boundaries**: Ensure inputs conform to `SequentialThinkingSchema` in [src/schema.ts](src/schema.ts); avoid spreading validation across files.
- **Minimal, focused changes**: Keep edits scoped; don’t reformat unrelated code or alter public APIs beyond the task.
- **Circuit breaker safety**: Validate new persistence/DAG interactions use `CircuitBreaker` from [src/error-handling.ts](src/error-handling.ts); check sensible thresholds.
- **Persistence guards**: Respect `ENABLE_PERSISTENCE`; avoid unconditional DB calls in [src/persistence.ts](src/persistence.ts).
- **Logging consistency**: Use `logger` + `measureTime()` from [src/logging.ts](src/logging.ts); keep messages structured and meaningful.
- **Config validation**: Route env/knob changes through `ConfigurationManager` in [src/config-manager.ts](src/config-manager.ts); keep defaults in [src/config-constants.ts](src/config-constants.ts).
- **Reasoning systems**: When touching `BacktrackingManager` or `ThoughtDAG`, confirm scoring params and graph updates are coherent ([src/backtracking.ts](src/backtracking.ts), [src/dag.ts](src/dag.ts)).
- **Tests**: Run `pnpm test`; focus on failures in DAG, backtracking, circuit breaker, persistence. Don’t fix unrelated tests.

### PR Checklist Snippet
Include in your PR description:

- [ ] No tool execution added; still recommends via `sequentialthinking_tools`
- [ ] Inputs validated against `SequentialThinkingSchema` (see [src/schema.ts](src/schema.ts))
- [ ] Circuit breakers respected for persistence/DAG; thresholds sensible
- [ ] `ENABLE_PERSISTENCE` respected; no unconditional DB calls
- [ ] Logging uses `logger` and `measureTime()` with meaningful messages
- [ ] Config changes routed through `ConfigurationManager`; defaults untouched
- [ ] Reasoning systems coherent (backtracking/DAG scoring and graph updates)
- [ ] Tests pass locally with `pnpm test` (focused suite)