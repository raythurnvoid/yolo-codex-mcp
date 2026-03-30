# Operating Guide

`yolo-codex-mcp` is simple to use:

1. Call `agent-start` to start a new Smart Cheap Agent session.
2. Read `structuredContent.threadId` from the result.
3. Call `agent-reply` with that same `threadId` for follow-up turns in the same conversation.

Legacy aliases `codex` and `codex-reply` are still accepted for compatibility, but `agent-start` and `agent-reply` are the advertised outer tool ids.

Example:

```json
{
	"name": "agent-start",
	"arguments": {
		"prompt": "Debug why the proxy does not preserve cwd on Windows."
	}
}
```

The result includes:

- `structuredContent.threadId`: the session/thread identifier
- `structuredContent.content`: the latest Smart Cheap Agent message

Follow-up:

```json
{
	"name": "agent-reply",
	"arguments": {
		"threadId": "thr_123",
		"prompt": "Now propose the smallest patch."
	}
}
```

Notes:

- Keep reusing the same `threadId` while you want Smart Cheap Agent to keep the same chat context.
- `agent-reply` still accepts deprecated `conversationId`, but `threadId` is the preferred field.
- If a caller still passes legacy `cwd`, the wrapper ignores it and chooses `cwd` from client workspace context when available, then `process.cwd()`.
- Optional `agent-instructions` on `agent-start` are forwarded to the inner agent as `developer-instructions`.

## Sessions And Rollouts

Smart Cheap Agent session state is organized around the returned `threadId`.

- The wrapper returns a `threadId` from `agent-start`.
- That same `threadId` is what you pass into `agent-reply`.
- Rollout files usually include the thread id in the filename suffix: `rollout-...-<threadId>.jsonl`.

Under the hood, those sessions still live in the inner Codex session store. By default, the session files live under:

- macOS/Linux: `~/.codex/sessions`
- Windows native: `%USERPROFILE%\\.codex\\sessions`

If `CODEX_HOME` is set, the sessions root becomes:

- POSIX: `$CODEX_HOME/sessions`
- Windows: `%CODEX_HOME%\\sessions`

When this wrapper launches Codex through WSL on Windows, the real sessions root is the WSL path `~/.codex/sessions`. The wrapper converts that to a Windows-accessible UNC path like `\\\\wsl$\\<distro>\\home\\<user>\\.codex\\sessions` when it needs to read rollout files from Node on Windows.

The current inner Codex layout is date-organized, for example:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
```

If Smart Cheap Agent stalls after a terminal rollout event, the wrapper falls back to the rollout files:

1. It resolves the sessions root.
2. It scans recursively for `rollout-*.jsonl`.
3. If it already knows the `threadId`, it prefers files ending in `-<threadId>.jsonl`.
4. It reads the last JSONL line and looks for `task_complete`, `turn_complete`, or `turn_aborted`.
5. It synthesizes the final MCP tool result from `last_agent_message` for completions, or an interrupted `isError` result for `turn_aborted`.

## When To Use Smart Cheap Agent

Smart Cheap Agent is the preferred first delegation tool exposed by this wrapper. It uses a smarter model that can read and edit files, browse the web, and use user-configured MCP tools. It is comparatively cheap for large-context work and is a good fit for long, token-heavy tasks such as:

- debugging complex failures
- broad code or documentation research
- browser-tool workflows
- long-running investigations that benefit from reusing the same `threadId`

If you expect several rounds of follow-up questions or debugging iterations, keep using `agent-reply` with the same `threadId` instead of starting a fresh Smart Cheap Agent session each time.
