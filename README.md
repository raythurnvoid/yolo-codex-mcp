# yolo-opencode-mcp

`yolo-opencode-mcp` is a stdio MCP server that wraps a long-lived `opencode acp` subprocess and exposes a small public smart-agent surface.

It does not proxy an inner MCP server anymore. The outer MCP server is now the product.

## Public Surface

Resources:

- `smart-agent://guides/operational-guidelines.md`

Prompts:

- `prompt`

Tools:

- `start_agent`
- `resume_agent`

The public MCP API is intentionally generic. It does not expose backend-specific agent names or backend-specific resources.

## Behavior

- starts `opencode acp` as a managed child process
- connects to it over ACP using `@agentclientprotocol/sdk`
- hard-pins every session to `openai/gpt-5.4/high`
- auto-approves ACP permission requests by selecting the first allow option when available
- supports continuing a conversation by passing the returned `sessionId` into `resume_agent.sessionId`
- works around a current ACP prompt-tail issue where the backend can keep the request open after streaming the final answer by cancelling the idle tail once text has already arrived
- accepts a simple public `message` field and converts it internally to the backend message format
- exposes a zero-argument `prompt` MCP prompt that acts as an instruction prefix for a user request appended immediately after it
- uses the active workspace cwd for contextual work
- temporarily neutralizes cwd for prompts that only target absolute paths outside the workspace, to avoid unrelated repo context poisoning global Windows-home tasks
- restores the session cwd on later contextual resumes when the caller switches back to workspace-scoped work

## Prerequisites

You need:

- Node.js 22.18+
- `pnpm`
- Vite+ available as `vp`
- OpenCode installed

Recommended Windows setup:

- install OpenCode natively on Windows so `opencode` resolves from PATH or a standard Windows global bin folder
- run this MCP server with a native Windows Node binary
- keep workspace paths in normal Windows form when running under Cursor on Windows
- the launcher also checks common fallback locations such as `%USERPROFILE%\.opencode\bin\`, `%USERPROFILE%\.vite-plus\bin\`, `%LOCALAPPDATA%\pnpm\`, `%APPDATA%\npm\`, and the WinGet links directory if PATH lookup is thin

## Install

```bash
vp install
```

This repo already includes these upstream references under `reference-submodules/`:

- `acp-mcp`
- `acp-typescript-sdk`
- `modelcontextprotocol`
- `opencode`
- `typescript-sdk`

## Run Locally

Run the source server:

```bash
pnpm start
```

Run in watch mode:

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
pnpm check
```

Auto-fix formatting and lint issues where possible:

```bash
pnpm run check:fix
```

## MCP Configuration

### Cursor Example

Recommended Windows project-level `.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"smart-agent": {
			"command": "C:/Users/<you>/.vite-plus/bin/node.exe",
			"args": ["C:/Users/<you>/path/to/repo/src/server.ts"]
		}
	}
}
```

Non-Windows source example:

```json
{
	"mcpServers": {
		"smart-agent": {
			"command": "node",
			"args": ["<path-to-repo>/src/server.ts"]
		}
	}
}
```

Built artifact example:

```json
{
	"mcpServers": {
		"smart-agent": {
			"command": "node",
			"args": ["<path-to-repo>/dist/server.mjs"]
		}
	}
}
```

## Environment

Supported environment overrides:

- `OPENCODE_BIN`: optional override for the backend executable. Default: `opencode`
- `OPENCODE_ARGS`: optional JSON array of strings passed to the child process. Default: `["acp"]`

Resolution behavior:

- first try the explicit `OPENCODE_BIN` or default `opencode`
- then try normal PATH lookup
- on Windows, if PATH lookup fails and the command is still `opencode`, try common Windows install locations such as `%USERPROFILE%\.opencode\bin\opencode.cmd`, `%USERPROFILE%\.vite-plus\bin\opencode.cmd`, `%LOCALAPPDATA%\pnpm\opencode.cmd`, `%APPDATA%\npm\opencode.cmd`, and the WinGet links directory
- if a discovered Windows batch shim is just a WSL login-shell wrapper, skip it and keep searching for a native Windows install so ACP stdout stays valid JSON
- if a Windows `.cmd` or `.bat` launcher is resolved, run it through `cmd.exe`

## Tool Details

### `start_agent`

Input:

- `message`: plain prompt text
- `message` description: full prompt to send to the smart agent for this turn

Compatibility fallback:

- legacy `input` arrays are still accepted
- chat-style items like `{ "role": "user", "content": "hello" }` are converted internally

Output:

- text content with the accumulated assistant message
- `structuredContent` containing:
  - `sessionId`
  - `stopReason`
  - `text`
  - `thought`
  - `toolCalls`
- tool failures return a normal MCP tool result with `isError: true` plus `structuredContent.error` metadata for machine-readable handling

### `resume_agent`

Input:

- `sessionId`: required existing session id
- `sessionId` description: session identifier returned by a previous `start_agent` or `resume_agent` call
- `message`: plain prompt text
- `message` description: full follow-up prompt to send to the existing smart-agent session

Output:

- same shape as `start_agent`

## Prompt Details

### `prompt`

Output:

- one MCP prompt message with a user-role text template
- the template tells the assistant that the user's actual request will be appended immediately after the prompt text in the same conversation message
- the template tells the assistant to treat that wrapped request as the start of a delegated workflow and send it through `start_agent`
- if the delegated turn returns a `sessionId`, the template tells the assistant to prefer `resume_agent` for later related follow-up turns even if the wrapper is not repeated
- the template treats same-task follow-ups such as `continue`, `proceed`, `revert that`, and `explain that change` as part of the same delegated workflow when the task context still matches
- the template tells the assistant to stop reusing the delegated session when the user clearly starts a different task, changes repo/context, or explicitly opts out of delegation
- if follow-up relatedness is unclear, the template tells the assistant to ask instead of guessing

Notes:

- this prompt text guides caller behavior; it does not hard-enforce session affinity on its own
- stricter “always continue this delegated session until told otherwise” behavior would require code changes in the caller or server, not just prompt wording

## Resources

### `smart-agent://guides/operational-guidelines.md`

Returns markdown guidance for MCP clients using this surface, including:

- soft-sticky session continuity guidance for related follow-up turns
- instructions to carry forward the active `sessionId` and restate newly learned local context when resuming
- incomplete delegated output handling guidance: continue or retry the same delegated session with a bounded retry count, then surface that the delegated run was incomplete instead of silently switching to local execution

## Verification

The rewrite is considered healthy when these pass:

- `pnpm test`
- `pnpm check`
- `vp pack`

The test suite includes:

- public tool and resource surface tests
- OpenCode launch config tests
- session continuation tests
- forced `gpt-5.4/high` model selection coverage
- stuck ACP prompt completion coverage
- Windows native fallback coverage for launch resolution
- a real `opencode acp` smoke test that executes `start_agent` when the local runtime is available
