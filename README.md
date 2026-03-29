# yolo-codex-mcp

`yolo-codex-mcp` is a stdio MCP wrapper around the official Codex MCP server.

You run one MCP server: the wrapper. The wrapper then starts and supervises the inner official `codex mcp-server` process for you.

It starts the real inner server with the same shape people already use today:

```json
{
	"command": "codex",
	"args": ["mcp-server"]
}
```

The wrapper keeps the outer tool names `codex` and `codex-reply`, but simplifies what MCP clients need to send:

- `codex`: `prompt`, optional `agent-instructions`, optional `compact-prompt`, optional `cwd`
- `codex-reply`: `threadId`, `prompt`, optional `cwd`

Everything else is handled by the wrapper with fixed defaults:

- `sandbox`: `danger-full-access` (no Codex filesystem sandbox)
- `approval-policy`: `never` (no command approval prompts)
- `cwd`: per-call `cwd` when provided, otherwise `CODEX_MCP_CWD` when set to a non-empty value other than a literal unexpanded `${workspaceFolder}`, otherwise the wrapper process working directory from `process.cwd()`
- `model` / `profile`: not forced by the wrapper, so the inner official server keeps using normal Codex config resolution, including `CODEX_HOME` config and default profile behavior
- `agent-instructions`: forwarded to the inner official tool as `developer-instructions`
- inner Codex binary resolution: override env first, then normal PATH lookup, then common Windows install locations and user shims, then WSL on Windows when available
- completion fallback: if the inner Codex MCP stalls after writing `task_complete` to its rollout JSONL, the wrapper resolves the rollout path, polls the rollout every 5 seconds, logs each poll cycle to `stderr`, and synthesizes the final tool result from the last agent message

## How It Runs

Single process setup from the MCP host point of view:

1. Your MCP host starts `yolo-codex-mcp`.
2. `yolo-codex-mcp` starts the inner official `codex mcp-server` child process automatically.
3. The wrapper rewrites the reduced outer tool args and forwards JSON-RPC to the inner server.
4. The wrapper forwards inner notifications, approvals, and results back to the MCP host.

You do not start `codex mcp-server` yourself in another terminal, and you do not add a second MCP server entry for it.

## Prerequisites

You need:

- Node.js 22.18+ so Node can run `src/server.ts` directly with native TypeScript stripping
- `pnpm`
- Vite+ commands available as `vp`
- a normal Codex installation

If Codex is installed normally, the wrapper should work out of the box, including when Cursor launches it with a thin PATH. The wrapper automatically tries PATH lookup, common Windows install locations, user-level shims, and WSL on Windows before falling back to manual overrides.

## Install

```bash
vp install
```

## Run Locally

Run the source entrypoint:

```bash
pnpm start
```

This runs [`src/server.ts`](/mnt/c/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp/src/server.ts).

Run in watch mode during development:

```bash
pnpm run dev
```

## Build

Build the distributable server:

```bash
vp pack
```

Run the built artifact:

```bash
pnpm run start:dist
```

## Test And Quality

Run tests:

```bash
pnpm test
```

Run formatting, lint, and type checks:

```bash
vp check
```

Auto-fix formatting and lint issues where possible:

```bash
vp check --fix
```

Format a specific path:

```bash
vp fmt <path>
```

## MCP Configuration

### Cursor Example

Cursor supports both project-specific `.cursor/mcp.json` and global `~/.cursor/mcp.json`.

#### What Cursor actually documents about substitution

Per the [Cursor MCP docs](https://cursor.com/docs/mcp) (**Config interpolation**):

- Substitution is applied to these JSON fields: **`command`**, **`args`**, **`env`**, **`url`**, and **`headers`** — not to other keys unless Cursor extends behavior beyond the docs.
- **`${workspaceFolder}`** is defined as the folder that contains the **project** `.cursor/mcp.json`. It is not defined relative to **`~/.cursor/mcp.json`**, so placeholders in a **global** MCP file often stay **literal** or behave inconsistently; do not rely on `${workspaceFolder}` there.
- In practice, some Cursor versions also appear to pass placeholders through unchanged in **`env`** even when you might expect expansion. Confirm with the wrapper’s stderr line **`[yolo-codex-mcp] Raw CODEX_MCP_CWD: ...`** after restart.

**Reliable approaches:**

1. **Per-project** `.cursor/mcp.json` in the repo you are working on, and set **`CODEX_MCP_CWD`** in **`env`** to **`${workspaceFolder}`** _if_ your Cursor build expands it (check the raw log line). If you still see the literal string, use an absolute path for that project.
2. **Global** `~/.cursor/mcp.json`: use a real **`CODEX_MCP_CWD`** absolute path for the project you care about. This is the safest setup when `${workspaceFolder}` is not expanded there. If you omit it, the wrapper falls back to `process.cwd()` (often the wrapper checkout directory).

Recommended **project-level** setup (try `${workspaceFolder}` in **`env` only**; verify with raw stderr):

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"],
			"env": {
				"CODEX_MCP_CWD": "${workspaceFolder}"
			}
		}
	}
}
```

When you adapt this for your own machine, replace `<path-to-repo>` with your own checkout path.

Global config with an explicit absolute path (when placeholders are not expanded):

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"],
			"env": {
				"CODEX_MCP_CWD": "C:/Users/<you>/path/to/project"
			}
		}
	}
}
```

`CODEX_MCP_CWD` is optional. If you omit it, or it is blank, or it is the literal unexpanded `${workspaceFolder}`, the wrapper uses `process.cwd()` and forwards that to the inner Codex server. At startup the wrapper logs both **`[yolo-codex-mcp] Raw CODEX_MCP_CWD: ...`** and **`[yolo-codex-mcp] Resolved Codex working directory: ...`** to `stderr` so you can confirm exactly what Cursor passed and what the inner Codex process will receive.

If automatic discovery still misses an unusual Codex install, add `CODEX_MCP_BIN` in the same `env` block as a fallback:

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"],
			"env": {
				"CODEX_MCP_BIN": "C:/Users/<you>/AppData/Local/Programs/Codex/codex.exe"
			}
		}
	}
}
```

### Cursor Hooks For Workspace `cwd`

This repo also ships a project hook at [`.cursor/hooks.json`](/mnt/c/Users/rt0/C:/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp/.cursor/hooks.json) plus [`.cursor/hooks/inject-yolo-cwd.mjs`](/mnt/c/Users/rt0/C:/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp/.cursor/hooks/inject-yolo-cwd.mjs).

Per the current [Cursor Hooks docs](https://cursor.com/docs/hooks):

- all hooks receive `workspace_roots`
- `preToolUse` can return `updated_input`
- `beforeMCPExecution` currently documents permission output only, not input mutation
- `preToolUse` MCP matchers use the `MCP:<tool_name>` format

Because of that, this repo uses a `preToolUse` hook for `MCP:codex` and `MCP:codex-reply`, not `beforeMCPExecution`.

Hook behavior:

- if Cursor runs project hooks for this trusted workspace, the hook reads `workspace_roots[0]`
- it injects `cwd` only when the outgoing tool payload does not already include a non-empty `cwd`
- explicit per-call `cwd` still wins
- multi-root workspaces currently use the first root only

Enablement and trust notes:

- project hooks load from `.cursor/hooks.json` when the workspace is trusted
- Cursor watches `hooks.json` and reloads it on save
- hooks execute local code, so review the script before trusting the workspace
- if you want the same behavior globally instead, copy the files to `~/.cursor/hooks.json` and `~/.cursor/hooks/inject-yolo-cwd.mjs`, then adjust the command path to `node ./hooks/inject-yolo-cwd.mjs`

### Alternative: Run Through `pnpm`

If you prefer to launch through the package manager instead of calling Node directly:

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "pnpm",
			"args": ["exec", "node", "<path-to-repo>/src/server.ts"]
		}
	}
}
```

Tradeoff:

- `node src/server.ts` is the simplest direct runtime path
- `pnpm exec node src/server.ts` can be convenient if your host already expects to launch project commands from the repo root

### Alternative: Run The Built Artifact

After `vp pack`, you can point your MCP host at the packaged output:

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/dist/server.mjs"]
		}
	}
}
```

Tradeoff:

- source entrypoint is better during development
- built output is better if you want the exact packaged artifact

## Environment

The wrapper supports these environment overrides:

- `CODEX_MCP_BIN`: optional override for the inner Codex command. Default behavior is automatic discovery.
- `CODEX_MCP_ARGS`: override inner startup args as a JSON array of strings. Default: `["mcp-server"]`
- `CODEX_MCP_CWD`: optional override for the inner Codex working directory. If unset, blank, or the literal unexpanded `${workspaceFolder}`, the wrapper uses `process.cwd()`
- `CODEX_MCP_DEBUG_INBOUND`: optional diagnostic mode for outer client -> proxy JSON-RPC logging to `stderr`

Compatibility note:

- `CODEX_BIN` is also accepted as a fallback launcher variable for compatibility with older local setups, but prefer `CODEX_MCP_BIN` when you need an explicit override

Examples:

- default behavior: wrapper auto-resolves Codex, then launches `codex mcp-server`
- custom Windows binary: `CODEX_MCP_BIN=C:\\path\\to\\codex.exe`
- extensionless Windows path override: `CODEX_MCP_BIN=C:\\Users\\<you>\\bin\\codex` and the wrapper will probe `codex.exe`, `codex.cmd`, then `codex.bat`
- WSL launch: `CODEX_MCP_BIN=wsl.exe` and `CODEX_MCP_ARGS=["-e","codex","mcp-server"]`

`CODEX_MCP_DEBUG_INBOUND` modes:

- `1`, `true`, `yes`, `on`, or `selected`: log the handshake and path-related methods the wrapper already expects: `initialize`, `notifications/initialized`, `roots/*`, `workspace/*`, and `$/...`
- `unknown`: log only non-whitelisted inbound methods so you can discover extra client traffic without the usual handshake noise
- `all`: log every inbound request, notification, and response with summarized payloads
- `verbose`: log every inbound request, notification, and response with full payloads, including `tools/call` arguments

There are no extra wrapper-specific policy env vars. `CODEX_MCP_DEBUG_INBOUND` is diagnostic-only and does not change proxy behavior.

## Tool Behavior

### `codex`

Outer input:

- `prompt` required
- `agent-instructions` optional
- `compact-prompt` optional
- `cwd` optional

Forwarded to the inner official tool:

- `prompt` -> `prompt`
- `agent-instructions` -> `developer-instructions`
- `compact-prompt` -> `compact-prompt`
- `cwd` -> `cwd` when provided
- wrapper also injects fixed `sandbox` and `approval-policy`, plus fallback `cwd` resolved from `CODEX_MCP_CWD` or `process.cwd()`, with a literal unexpanded `${workspaceFolder}` treated as unset

### `codex-reply`

Outer input:

- `threadId` required
- `prompt` required
- `cwd` optional

Compatibility note:

- deprecated `conversationId` is still accepted and rewritten to `threadId`

## Troubleshooting

### Inner Codex Server Not Found

If the wrapper cannot start the inner server, it has already tried automatic discovery. That includes PATH lookup, common Windows install locations, user shims such as `C:\Users\<you>\bin\codex`, and WSL on Windows. If your install is unusual, set `CODEX_MCP_BIN` in your `mcp.json` `env` block to the full Codex path. You should still launch only the wrapper from your MCP host; the wrapper will start the inner server itself.

### Wrong Working Directory

The wrapper itself still does not auto-read Cursor `workspace_roots` over MCP and map them to `cwd`. Instead, this repo now ships a Cursor `preToolUse` hook that can inject `workspace_roots[0]` into outgoing `codex` and `codex-reply` tool payloads before execution. If hooks are disabled, the workspace is untrusted, or your Cursor build does not run the project hook, the wrapper falls back to per-call `cwd`, then `CODEX_MCP_CWD`, then `process.cwd()`.

In Cursor, keep a **project** `.cursor/mcp.json` with **`CODEX_MCP_CWD`** in **`env`** as the fallback path (see [Cursor MCP interpolation](https://cursor.com/docs/mcp)). The hook is the best-effort workspace-aware override; `CODEX_MCP_CWD` is still the deterministic backup when hooks do not run. The wrapper logs both **`[yolo-codex-mcp] Raw CODEX_MCP_CWD: ...`** and **`[yolo-codex-mcp] Resolved Codex working directory: ...`** at startup so you can see what fallback value it would use.

Cursor hook limitation, verified against the live Hooks docs: `beforeMCPExecution` currently documents `permission`, `user_message`, and `agent_message`, but not `updated_input`, so this repo uses `preToolUse` for mutation. If Cursor later adds MCP input mutation there, this can be revisited.

### Debug Inbound MCP Handshake

To inspect what Cursor is actually sending to the wrapper, set `CODEX_MCP_DEBUG_INBOUND` in the MCP server `env` block. The wrapper writes grep-friendly `stderr` lines prefixed with `[yolo-codex-mcp][mcp-in]`.

Recommended modes:

- `selected` or `1`: handshake and path-related methods only
- `unknown`: only methods outside the normal handshake/path whitelist
- `all`: every inbound method with summarized payloads
- `verbose`: every inbound method with full payloads, including full `tools/call` arguments

The default `selected` mode logs:

- `initialize` requests, including summarized `params`
- `notifications/initialized`
- `roots/*`
- `workspace/*`
- `$/...` notifications or requests
- client responses to server-initiated `roots/*`, `workspace/*`, or `$/...` requests

This is intended to answer whether the MCP client supplied workspace roots or similar path context over the wire. If you need to inspect `tools/call` arguments, use `all` or `verbose`.

Cursor limitation:

- Cursor’s MCP log UI usually still shows only high-level tool lifecycle lines such as “Handling CallTool”, “Calling”, and “Success”. Detailed JSON-RPC payloads come from the wrapper’s own `stderr` diagnostics, not from Cursor’s default MCP log view.
- If Cursor shows a trailing literal `undefined` next to stderr lines, that appears to be host-side log rendering rather than output emitted by this wrapper.

### Inner Codex Hangs After `task_complete`

If the inner Codex MCP writes `task_complete` to its rollout JSONL but never returns the final `tools/call` response, the wrapper falls back to the rollout file. It prefers the `rollout_path` from `session_configured`, and otherwise scans one resolved Codex sessions root for the matching `rollout-*.jsonl` file by thread id or newest recent rollout. On Windows WSL launches, that sessions root is converted up front to a Windows-accessible `\\\\wsl$\\...` path so normal Node filesystem reads can be reused. Every 5 seconds the wrapper logs a poll cycle to `stderr`, reads the last JSONL line, and once it sees `task_complete` it synthesizes the final MCP tool result from `last_agent_message`.

### Smoke Test Is Skipped

`pnpm test` always runs the mock proxy tests. The real subprocess smoke test is skipped when the configured inner Codex command is not reachable from the test process.

### Windows `.cmd` / `.bat`

If `CODEX_MCP_BIN` points to a `.cmd` or `.bat` shim, the wrapper launches it through `cmd.exe` automatically. If discovery or `CODEX_MCP_BIN` yields an extensionless Windows path such as `C:\Users\<you>\bin\codex`, the wrapper first probes `codex.exe`, `codex.cmd`, and `codex.bat`, and also follows shim realpaths when needed, so the final launch target is something `spawn` can execute directly.
