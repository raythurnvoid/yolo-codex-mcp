This repository is a Vite+-managed TypeScript Node.js MCP server. This file is the always-on instruction set for coding agents working in this repo.

Use this file for repo-wide operating guidance. If a workflow is specialized or only relevant on demand, prefer a skill. If instructions become area-specific, add nested `AGENTS.md` files in subdirectories instead of making this file harder to use.

# Project Summary

- Purpose: wrap the official Codex MCP server (`codex mcp-server`) as an inner child process and expose a reduced outer MCP tool surface.
- Runtime entrypoint: `src/server.ts`
- Built artifact: `dist/server.mjs`
- Primary tools exposed by the server: `agent-start`, `agent-reply` (with legacy `codex`, `codex-reply` aliases still accepted)
- Core dependencies: `@modelcontextprotocol/sdk`, `zod`, `vite-plus`
- Generated output: `dist/`
- Upstream reference material: `reference-submodules/`

Behavior summary:

- The outer server is a stdio JSON-RPC proxy around the official inner Codex MCP server.
- It simplifies the tool contract clients see by advertising reduced `agent-start` / `agent-reply` schemas instead of the full official schema.
- It applies fixed, opinionated defaults in proxy code, including sandbox / approval behavior, `cwd` injection from `process.cwd()`, and field mapping such as outer `agent-instructions` to inner `developer-instructions`.
- The default expectation is that the wrapper auto-resolves the inner Codex binary the way a normal local install would work: explicit overrides first, then PATH, then common Windows install locations / user shims, then WSL on Windows where available.
- `CODEX_MCP_BIN` and `CODEX_MCP_ARGS` are optional launch overrides, not the primary expected setup.

Do not edit `dist/` by hand. Rebuild it with Vite+.

Do not modify `reference-submodules/` unless the user explicitly asks you to work there.

# Repository Operating Model

This repo intentionally uses:

- Vite+ for formatting, linting, type-checking, and packaging
- native Node.js TypeScript type stripping for local runtime
- `pnpm` as the package manager recorded in `package.json`

That means:

- prefer Vite+ commands for checks and packaging
- use the package scripts for runtime entrypoints
- do not reintroduce `tsx` for local runtime unless the user explicitly asks for it
- do not reintroduce a standalone `tsc --noEmit` script when `vp check` already covers the required checks

# Canonical Commands

Use these commands by default:

- Install dependencies: `vp install`
- Run the source server directly: `pnpm start`
- Run in watch mode: `pnpm run dev`
- Run all static checks: `vp check`
- Auto-fix formatting/lint issues: `vp check --fix`
- Build the distributable server: `vp pack`
- Run the built artifact: `pnpm run start:dist`

Prefer `vp check` over separate formatter, linter, or typechecker commands unless you are debugging a specific layer.

If you need a focused formatter pass, use `vp fmt <path>`.

# Vite+ Conventions

Keep Vite+ as the source of truth for project automation.

- Formatting and linting configuration belongs in `vite.config.ts`
- Do not introduce separate Oxc or tsdown config files unless the user explicitly requests them
- Keep the `lint.options.typeAware` and `lint.options.typeCheck` settings enabled unless there is a strong, intentional reason to change the verification model
- Keep packaging configuration in the `pack` block of `vite.config.ts`

When changing commands or workflow, update `README.md` so the documented commands stay in sync with the actual project setup.

# Native Node TypeScript Rules

The local runtime depends on Node's native support for strippable TypeScript syntax. Preserve that constraint.

- Keep `tsconfig.json` aligned with native Node type stripping
- Preserve `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, and `verbatimModuleSyntax` unless the runtime strategy is intentionally changing
- Use ES module syntax
- If you add local relative imports, include explicit file extensions such as `./foo.ts`
- Do not add `.tsx` runtime entrypoints
- Do not rely on `tsconfig` path alias rewriting at runtime

Avoid TypeScript features that require code generation or are otherwise incompatible with the current runtime model:

- `enum`
- parameter properties
- namespaces with runtime values
- decorators
- import patterns that depend on TypeScript rewriting them for Node

If a requested change would require those features, call that out explicitly instead of silently reworking the runtime model.

# Formatting And Style

Project style is enforced by Oxc through Vite+ and workspace settings.

- Use tabs, not spaces, for indentation in project code and config files that follow the formatter
- Use double quotes
- Keep line width compatible with `printWidth: 120`
- Let the formatter drive layout instead of hand-formatting unusual styles

Before finishing substantive work, run `vp check`. If it fails only because of formatting, run `vp check --fix` and re-run `vp check`.

Do not do broad stylistic cleanup outside the scope of the task.

# Architecture Notes

`src/server.ts` is the main implementation file. It currently contains:

- proxy entrypoint and stdio transport setup
- inner-server launch via `codex mcp-server` by default
- reduced outer tool schemas for `agent-start` and `agent-reply`, with legacy `codex` / `codex-reply` aliases still accepted
- JSON-RPC request / response / notification forwarding between outer client and inner Codex MCP server
- fixed outer-to-inner argument rewriting, including `agent-instructions` -> inner `developer-instructions`
- server-initiated request id remapping for inner requests such as `elicitation/create`

Related modules:

- `src/proxy_server.ts`: core proxy implementation, forwarding logic, launch handling, and Windows batch-wrapper support
- `src/proxy_config.ts`: proxy launch config and fixed policy defaults
- `src/tool_contract.ts`: reduced outer tool schemas and outer-to-inner argument mapping
- `tests/proxy.test.ts`: proxy contract tests plus a real subprocess smoke test when the inner Codex binary is reachable

When changing server behavior:

- keep input schemas, runtime behavior, and structured output aligned
- keep tool descriptions concise and accurate
- preserve the existing `zod`-first pattern for schemas and inferred types
- add new logic next to the most similar existing logic instead of creating arbitrary new sections
- preserve wire compatibility with the official inner server wherever possible, especially request ids, notifications, and server-initiated requests
- do not add project-specific policy env vars; keep policy fixed in code unless the user explicitly asks to expand the config surface

When changing the outer tool surface:

1. Define or extend the relevant Zod schemas near the current schema declarations.
2. Keep the reduced outer schema and the forwarded inner arguments aligned.
3. Return both human-readable `content` and machine-readable `structuredContent` when appropriate.
4. Keep error handling and JSON-RPC passthrough behavior consistent with the proxy implementation.
5. Update `README.md` if the public tool surface changes.

# Windows, PATH, And WSL Considerations

This project is often used on Windows and must not regress there.

- Be careful with path handling changes
- Preserve support for `CODEX_MCP_BIN`
- Preserve support for `CODEX_MCP_ARGS`
- Preserve compatibility fallback for `CODEX_BIN`
- Preserve PATH lookup for `codex`
- Preserve automatic discovery of normal Codex installs before falling back to manual env overrides
- Preserve Windows path handling and WSL path conversion behavior
- Preserve the distinction between launching a Windows binary directly and launching a WSL binary through `wsl.exe`
- Preserve `.cmd` / `.bat` wrapping through `cmd.exe` when launching the inner server on Windows
- Remember that Cursor and other GUI-launched MCP hosts may have a thinner PATH than the user’s terminal, so docs and errors should describe `CODEX_MCP_BIN` as a fallback after auto-discovery fails, not as the primary setup
- When the user asks to **find Codex CLI session history** (rollouts, transcripts, `rollout-*.jsonl`, or “the sessions folder”), **read the maintainer’s Cursor skill `run-codex-windows`** (`run-codex` / `run-codex-windows` in `.cursor/skills/`) **before** searching disk. For Codex **CLI** runs from WSL, rollouts live under **WSL `~/.codex/sessions`**, which is **not** the same tree as Windows `%USERPROFILE%\.codex\sessions`; do not infer that no sessions exist from an empty Windows-only folder.

If you change launch logic, validate the affected paths and explain what cases were verified.

# What Not To Change Casually

Do not casually change these without a clear reason:

- the native Node runtime model
- the Vite+ command model
- `@modelcontextprotocol/sdk` major version
- stdio transport choice
- `packageManager`
- Oxc formatting/linting defaults

If one of these must change, document the reason in `README.md` and verify the new workflow end to end.

# Verification Expectations

Minimum verification for most code changes:

- `vp check`

Additional verification when relevant:

- run `vp pack` after packaging, entrypoint, or build config changes
- run `pnpm start` after startup or runtime changes
- run `pnpm run start:dist` if you changed built-output behavior and need to verify the packaged artifact
- run `pnpm test` after proxy, launch, tool-contract, or request-routing changes

If you start a long-running process to verify behavior, stop it before finishing your task.

Do not claim checks passed unless you actually ran them.

# Documentation Expectations

Keep documentation aligned with the real workflow.

- `README.md` should describe the current install, start, dev, check, and build commands
- MCP configuration examples in `README.md` should stay accurate when entrypoints or runtime assumptions change
- If you change how Codex binary resolution works, update the relevant documentation section
- If you change the reduced outer tool surface or fixed proxy defaults, update `README.md`

# When To Use Skills Or Cursor Rules Instead

Per the Cursor, OpenAI Codex, and open Agent Skills docs, use the right level of customization:

- Keep `AGENTS.md` for always-on repo instructions
- Use nested `AGENTS.md` files for subdirectory-specific guidance
- Use `.agents/skills/` or `.cursor/skills/` for specialized, reusable workflows that should load only when relevant
- Use `.cursor/rules/` when you need metadata-driven or path-scoped rule behavior beyond plain markdown instructions

If you add a skill in this repo, keep the skill focused, give it a strong `description`, and keep the main `SKILL.md` concise with larger details moved to references.

# Done Means

A task is usually done in this repo when:

- the requested code or config change is implemented with a minimal diff
- `vp check` passes
- `pnpm test` passes when proxy/runtime behavior changed
- `vp pack` passes when build behavior may have been affected
- runtime was smoke-tested when startup behavior changed
- docs were updated if the developer workflow or public behavior changed

When in doubt, optimize for keeping the Vite+ workflow simple, the Node runtime native, and the MCP server behavior predictable.
