## PR Checklist

- [ ] No tool execution added; still recommends via `sequentialthinking_tools`
- [ ] Inputs validated against `SequentialThinkingSchema` (see [src/schema.ts](src/schema.ts))
- [ ] Circuit breakers respected for persistence/DAG; thresholds sensible
- [ ] `ENABLE_PERSISTENCE` respected; no unconditional DB calls
- [ ] Logging uses `logger` and `measureTime()` with meaningful messages
- [ ] Config changes routed through `ConfigurationManager`; defaults untouched
- [ ] Reasoning systems coherent (backtracking/DAG scoring and graph updates)
- [ ] Tests pass locally with `pnpm test` (focused suite)

## Summary

Describe what changed and why. Link to relevant files or issues.

## Risk & Impact

- Affected modules: list key files (e.g., [src/index.ts](src/index.ts), [src/thought-processor.ts](src/thought-processor.ts))
- Runtime flags/envs touched: `MAX_HISTORY_SIZE`, `ENABLE_PERSISTENCE`, etc.
- Migration notes (if any):

## Validation

- Commands run:
  - `pnpm build`
  - `pnpm dev` or `pnpm start`
  - `pnpm test`
- Logs reviewed (structured/non-structured): observations
- Manual scenario(s) tried for `sequentialthinking_tools`: brief result
