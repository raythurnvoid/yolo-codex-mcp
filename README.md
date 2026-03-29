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

- `codex`: `prompt`, optional `agent-instructions`, optional `compact-prompt`
- `codex-reply`: `threadId`, `prompt`

Everything else is handled by the wrapper with fixed defaults:

- `sandbox`: `danger-full-access` (no Codex filesystem sandbox)
- `approval-policy`: `never` (no command approval prompts)
- `cwd`: the wrapper process working directory, from `process.cwd()`
- `model` / `profile`: not forced by the wrapper, so the inner official server keeps using normal Codex config resolution, including `CODEX_HOME` config and default profile behavior
- `agent-instructions`: forwarded to the inner official tool as `developer-instructions`
- inner Codex binary resolution: override env first, then normal PATH lookup, then common Windows install locations and user shims, then WSL on Windows when available

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

Primary setup:

```json
"codex-yolo": {
  "command": "node",
  "args": [
    "C:/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp/src/server.ts"
  ]
}
```

That single MCP config entry is enough. No `cwd`, no `env`, and no `CODEX_MCP_BIN` should be needed for a normal Codex install. When Cursor launches the wrapper, the wrapper launches the inner official Codex MCP server automatically.

When you adapt this for your own machine, replace the path with your own `<path-to-repo>/src/server.ts`.

The wrapper forwards its own `process.cwd()` as the inner Codex `cwd`. In Cursor, that means the working directory comes from how Cursor launches the MCP process. If you need to force a different directory, add `cwd` explicitly as an override, but that is not the normal setup.

If automatic discovery still misses an unusual Codex install, add an `env` block as a fallback:

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

The wrapper only supports inner-launch overrides:

- `CODEX_MCP_BIN`: optional override for the inner Codex command. Default behavior is automatic discovery.
- `CODEX_MCP_ARGS`: override inner startup args as a JSON array of strings. Default: `["mcp-server"]`

Compatibility note:

- `CODEX_BIN` is also accepted as a fallback launcher variable for compatibility with older local setups, but prefer `CODEX_MCP_BIN` when you need an explicit override

Examples:

- default behavior: wrapper auto-resolves Codex, then launches `codex mcp-server`
- custom Windows binary: `CODEX_MCP_BIN=C:\\path\\to\\codex.exe`
- extensionless Windows path override: `CODEX_MCP_BIN=C:\\Users\\<you>\\bin\\codex` and the wrapper will probe `codex.exe`, `codex.cmd`, then `codex.bat`
- WSL launch: `CODEX_MCP_BIN=wsl.exe` and `CODEX_MCP_ARGS=["-e","codex","mcp-server"]`

There are no extra wrapper-specific policy env vars.

## Tool Behavior

### `codex`

Outer input:

- `prompt` required
- `agent-instructions` optional
- `compact-prompt` optional

Forwarded to the inner official tool:

- `prompt` -> `prompt`
- `agent-instructions` -> `developer-instructions`
- `compact-prompt` -> `compact-prompt`
- wrapper also injects fixed `sandbox`, `approval-policy`, and `cwd`

### `codex-reply`

Outer input:

- `threadId` required
- `prompt` required

Compatibility note:

- deprecated `conversationId` is still accepted and rewritten to `threadId`

## Troubleshooting

### Inner Codex Server Not Found

If the wrapper cannot start the inner server, it has already tried automatic discovery. That includes PATH lookup, common Windows install locations, user shims such as `C:\Users\<you>\bin\codex`, and WSL on Windows. If your install is unusual, set `CODEX_MCP_BIN` in your `mcp.json` `env` block to the full Codex path. You should still launch only the wrapper from your MCP host; the wrapper will start the inner server itself.

### Wrong Working Directory

The wrapper does not auto-read Cursor `workspace_roots` or MCP roots and map them to `cwd`. By default it uses the wrapper process `cwd` from `process.cwd()`. If Cursor is launching the server from the wrong place for your workflow, add a `cwd` override in `mcp.json`.

### Smoke Test Is Skipped

`pnpm test` always runs the mock proxy tests. The real subprocess smoke test is skipped when the configured inner Codex command is not reachable from the test process.

### Windows `.cmd` / `.bat`

If `CODEX_MCP_BIN` points to a `.cmd` or `.bat` shim, the wrapper launches it through `cmd.exe` automatically. If discovery or `CODEX_MCP_BIN` yields an extensionless Windows path such as `C:\Users\<you>\bin\codex`, the wrapper first probes `codex.exe`, `codex.cmd`, and `codex.bat`, and also follows shim realpaths when needed, so the final launch target is something `spawn` can execute directly.
