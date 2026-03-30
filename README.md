# yolo-codex-mcp

`yolo-codex-mcp` is a stdio MCP wrapper around the official Codex MCP server. On the outer MCP surface, it presents the preferred delegation tool as Smart Cheap Agent while preserving the stable wire tool names `codex` and `codex-reply`.

You run one MCP server: the wrapper. The wrapper then starts and supervises the inner official `codex mcp-server` process for you.

It starts the real inner server with the same shape people already use today:

```json
{
	"command": "codex",
	"args": ["mcp-server"]
}
```

The wrapper keeps the outer wire tool names `codex` and `codex-reply`, but simplifies what MCP clients need to send and brands them for users as Smart Cheap Agent and Smart Cheap Agent Reply:

- `codex`: `prompt`, optional `agent-instructions`, optional `compact-prompt`
- `codex-reply`: `threadId`, `prompt`
- one attached MCP resource with operating guidance

The outer `codex` tool is the preferred first delegation tool for complex, context-heavy work. It is intended to be cheaper and more cost-efficient than spending the host model's context directly, while still giving the delegated agent file editing, web browsing, and user-configured MCP tool access.

Everything else is handled by the wrapper with fixed defaults:

- `sandbox`: `danger-full-access` (no Codex filesystem sandbox)
- `approval-policy`: `never` (no command approval prompts)
- `cwd`: derived server-side from the MCP client’s workspace/root context, with `process.cwd()` used only as a last-resort fallback
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

The wrapper now derives `cwd` server-side from MCP client workspace metadata. Do not configure `cwd` through MCP env vars for normal usage.

Recommended **project-level** setup:

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"]
		}
	}
}
```

When you adapt this for your own machine, replace `<path-to-repo>` with your own checkout path.

Global config:

```json
{
	"mcpServers": {
		"codex-yolo": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"]
		}
	}
}
```

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

Because of that, this repo uses a `preToolUse` hook for `MCP:codex` and `MCP:codex-reply`. The hook is diagnostics-only; the wrapper itself handles `cwd` derivation.

Hook behavior:

- if Cursor runs project hooks for this trusted workspace, the hook reads and logs `workspace_roots`
- it does not inject `cwd`
- the wrapper is the primary mechanism for `cwd` derivation
- multi-root workspaces are still best-effort and the wrapper logs when it uses a first-root heuristic

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

Compatibility note:

- `CODEX_BIN` is also accepted as a fallback launcher variable for compatibility with older local setups, but prefer `CODEX_MCP_BIN` when you need an explicit override

Examples:

- default behavior: wrapper auto-resolves Codex, then launches `codex mcp-server`
- custom Windows binary: `CODEX_MCP_BIN=C:\\path\\to\\codex.exe`
- extensionless Windows path override: `CODEX_MCP_BIN=C:\\Users\\<you>\\bin\\codex` and the wrapper will probe `codex.exe`, `codex.cmd`, then `codex.bat`
- WSL launch: `CODEX_MCP_BIN=wsl.exe` and `CODEX_MCP_ARGS=["-e","codex","mcp-server"]`

The wrapper always emits dedicated `stderr` lines for workspace discovery and per-call cwd choice:

- `[yolo-codex-mcp][client-cwd] ...`: observed client workspace roots, proactive `roots/list` requests, and the current selected client-derived `cwd`
- `[yolo-codex-mcp][cwd] ...`: the effective `cwd` chosen for each `codex` / `codex-reply` call and why
- `[yolo-codex-mcp][tools-forward] ...`: the exact forwarded inner tool arguments
- `[yolo-codex-mcp][cwd-legacy] ...`: any ignored legacy outer `cwd` supplied by the caller
- `[yolo-codex-mcp][cwd-fallback] ...`: the last-resort `process.cwd()` fallback baseline

There are no wrapper env vars for logging or working-directory selection.

## Guidance Resources

The wrapper also exposes one attached MCP resource so agents can read usage guidance directly from the server:

- `yolo-codex-mcp://guides/operating-guide.md`: how to use `codex` and `codex-reply`, where sessions and rollout files live, and when to prefer Smart Cheap Agent for long debugging, research, and browser-tool workflows

## Tool Behavior

### `codex`

Shown to users as `Smart Cheap Agent`.

Outer input:

- `prompt` required
- `agent-instructions` optional
- `compact-prompt` optional

Forwarded to the inner official tool:

- `prompt` -> `prompt`
- `agent-instructions` -> `developer-instructions`
- `compact-prompt` -> `compact-prompt`
- wrapper also injects fixed `sandbox`, `approval-policy`, and a server-derived `cwd`
- if a caller still sends `cwd`, the wrapper treats it as legacy-only, logs that it was ignored, and derives `cwd` server-side instead

Result shape:

- `structuredContent.threadId` is the Smart Cheap Agent session/thread identifier
- `structuredContent.content` is the latest Smart Cheap Agent message
- to continue the same session, call `codex-reply` with the same `threadId`

### `codex-reply`

Shown to users as `Smart Cheap Agent Reply`.

Outer input:

- `threadId` required
- `prompt` required

Compatibility note:

- deprecated `conversationId` is still accepted and rewritten to `threadId`
- in normal usage, pass the `threadId` previously returned by `codex` or a prior `codex-reply`

## Troubleshooting

### Inner Codex Server Not Found

If the wrapper cannot start the inner server, it has already tried automatic discovery. That includes PATH lookup, common Windows install locations, user shims such as `C:\Users\<you>\bin\codex`, and WSL on Windows. If your install is unusual, set `CODEX_MCP_BIN` in your `mcp.json` `env` block to the full Codex path. You should still launch only the wrapper from your MCP host; the wrapper will start the inner server itself.

### Wrong Working Directory

The wrapper tracks client workspace context over MCP and derives `cwd` server-side. It watches inbound `initialize`, `workspace/*`, and `roots/*` traffic, and when the client advertises roots support it proactively requests `roots/list` after `notifications/initialized`. The Cursor hook is optional and does not inject `cwd`.

Effective `cwd` precedence is:

- server-derived client workspace `cwd`
- ignored legacy outer `cwd` is logged but does not win
- `process.cwd()`

The server process location is only the final fallback. On startup the wrapper logs **`[yolo-codex-mcp][cwd-fallback] ...`** to make that fallback explicit.

Cursor hook limitation, verified against the live Hooks docs: `beforeMCPExecution` currently documents `permission`, `user_message`, and `agent_message`, but not `updated_input`. This repo keeps the hook on `preToolUse`, but only for diagnostics; the wrapper does not depend on hook-driven input mutation.

### Debug Inbound MCP Handshake

The wrapper logs inbound workspace-relevant MCP traffic all the time. It writes grep-friendly `stderr` lines prefixed with `[yolo-codex-mcp][mcp-in]`, plus `[yolo-codex-mcp][client-cwd]`, `[yolo-codex-mcp][cwd]`, `[yolo-codex-mcp][tools-forward]`, `[yolo-codex-mcp][cwd-legacy]`, and `[yolo-codex-mcp][cwd-fallback]`.

Always-on inbound logging includes:

- full `tools/call` payloads
- `initialize`
- `notifications/initialized`
- `roots/*`
- `workspace/*`
- `$/...` notifications or requests
- client responses to server-initiated `roots/*`, `workspace/*`, `$/...`, and `elicitation/*` requests

This is intended to answer whether the MCP client supplied workspace roots or similar path context over the wire, whether it is still sending a legacy outer `cwd`, and which `cwd` the wrapper chose for each tool call.

Cursor limitation:

- Cursor’s MCP log UI usually still shows only high-level tool lifecycle lines such as “Handling CallTool”, “Calling”, and “Success”. Detailed JSON-RPC payloads come from the wrapper’s own `stderr` diagnostics, not from Cursor’s default MCP log view.
- If Cursor shows a trailing literal `undefined` next to stderr lines, that appears to be host-side log rendering rather than output emitted by this wrapper.

### Inner Codex Hangs After `task_complete`

If the inner Codex MCP writes `task_complete` to its rollout JSONL but never returns the final `tools/call` response, the wrapper falls back to the rollout file. It prefers the `rollout_path` from `session_configured`, and otherwise scans one resolved Codex sessions root for the matching `rollout-*.jsonl` file by thread id or newest recent rollout. On Windows WSL launches, that sessions root is converted up front to a Windows-accessible `\\\\wsl$\\...` path so normal Node filesystem reads can be reused. Every 5 seconds the wrapper logs a poll cycle to `stderr`, reads the last JSONL line, and once it sees `task_complete` it synthesizes the final MCP tool result from `last_agent_message`.

### Smoke Test Is Skipped

`pnpm test` always runs the mock proxy tests. The real subprocess smoke test is skipped when the configured inner Codex command is not reachable from the test process.

### Windows `.cmd` / `.bat`

If `CODEX_MCP_BIN` points to a `.cmd` or `.bat` shim, the wrapper launches it through `cmd.exe` automatically. If discovery or `CODEX_MCP_BIN` yields an extensionless Windows path such as `C:\Users\<you>\bin\codex`, the wrapper first probes `codex.exe`, `codex.cmd`, and `codex.bat`, and also follows shim realpaths when needed, so the final launch target is something `spawn` can execute directly.
