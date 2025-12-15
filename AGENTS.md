# Purpose

This file is the operating manual for AI coding agents working in this repository.
If instructions are unclear or missing, stop and ask for clarification rather than guessing.

## Instruction precedence (monorepos)

- If a directory contains a nested `AGENTS.md`, follow the closest (most specific) file for work in that subtree.
- If nested and root instructions conflict, the nested file wins for that subtree.

## Commands (run via MCP)

- ALWAYS execute commands via MCP servers/tools (never via unmanaged/direct execution).
- If the exact commands are not listed below, first discover them by reading project config (e.g., `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `.github/workflows/*`), then ASK before running anything destructive.

## Non-negotiable development approach

- Implement one feature/change at a time (single-scope increments).
- Prefer a small correct change over a large refactor.
- Treat existing code as the source of truth for architecture, naming, and style; extend established patterns.

## MCP-first tooling (ALWAYS)

- ALWAYS use MCP servers for all tool access and external actions (repo inspection, search/retrieval, command execution, CI/test runs, issue tracker interactions, etc.).
- Do NOT use direct network access or ad-hoc integrations when an MCP server/tool exists for the task.
- If no MCP server/tool exists for a required action, STOP and ask the user to provide/configure an MCP server or to do the action manually.
- Prefer least-privilege: request only the minimum scopes/paths/commands needed.

## Boundaries (Always / Ask first / Never)

- ✅ Always:
  - Keep changes minimal and localized to the requested scope.
  - Add/update tests for any behavior change.
  - Keep code consistent with existing patterns in the repo.
  - Run relevant checks (tests/lint/typecheck) via MCP before finalizing.

- ⚠️ Ask first:
  - Adding/removing dependencies.
  - Changing public APIs, schemas, migrations, or data formats.
  - Modifying CI/CD, deployment, infra, security settings, or auth flows.
  - Large refactors, renames across many files, or moving directories.

- 🚫 Never:
  - Commit or output secrets (tokens/keys/passwords); do not “test with real credentials”.
  - Remove or weaken tests to make the suite pass.
  - Edit generated files, vendored code, or `node_modules/` (or equivalents) unless explicitly instructed.
  - Change lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, etc.) unless explicitly instructed.

## Modularity and file size

- Keep files small and single-purpose; target <= 250 lines per file (excluding generated code).
- Prefer fine-grained modules within a feature:
  - Validation isolated from business logic.
  - Error mapping/handling isolated from core logic.
  - Side effects (I/O, network, DB) behind interfaces/adapters.

## Testing is mandatory

- Tests are required for all behavior changes (features and bug fixes).
- Prefer TDD when feasible:
  1) Write/adjust tests to specify behavior.
  2) Implement the minimum code to pass.
  3) Refactor only after tests are green.
- Keep tests deterministic (no reliance on real network, real secrets, or flaky time-based behavior).

## Required change protocol

1. Restate the single scope of work and acceptance criteria.
2. Identify the closest existing code/tests to mirror (patterns win).
3. Make the smallest implementation that meets acceptance criteria.
4. Add/adjust tests to cover success and key edge cases.
5. Verify by running relevant commands via MCP.
6. Report results: what changed, what was run, and any follow-ups needed.

## Communication rules

- State assumptions explicitly; if an assumption affects behavior, ask first.
- Keep plans short and actionable.
- When producing code, ensure it is consistent with repo conventions and backed by tests.
