import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

type JsonRpcId = number | string | null;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

type JsonRpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;

const capturePath = process.env.MOCK_INNER_CAPTURE;
const output = process.stdout;
let buffered = "";
setInterval(() => {}, 1_000_000);

let pendingApprovalRequestId: JsonRpcId | null = null;
let pendingCallId: JsonRpcId | null = null;
let pendingRootsRequestId: JsonRpcId | null = null;
let pendingRootsCallId: JsonRpcId | null = null;

process.stdin.on("data", (chunk: Buffer | string) => {
	buffered += String(chunk);

	for (;;) {
		const newlineIndex = buffered.indexOf("\n");
		if (newlineIndex < 0) {
			return;
		}

		const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
		buffered = buffered.slice(newlineIndex + 1);
		void handleLine(line);
	}
});

async function handleLine(line: string): Promise<void> {
	if (!line.trim()) {
		return;
	}

	const message = JSON.parse(line) as JsonRpcMessage;
	await record(message);

	if ("method" in message && "id" in message) {
		await onRequest(message);
		return;
	}

	if ("result" in message) {
		await onResponse(message);
	}
}

async function onRequest(message: JsonRpcRequest): Promise<void> {
	if (message.method === "initialize") {
		const protocolVersion =
			typeof message.params === "object" &&
			message.params !== null &&
			"protocolVersion" in message.params &&
			typeof (message.params as { protocolVersion?: unknown }).protocolVersion === "string"
				? (message.params as { protocolVersion: string }).protocolVersion
				: "2025-03-26";
		await write({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				capabilities: {
					tools: {
						listChanged: true,
					},
				},
				protocolVersion,
				serverInfo: {
					name: "codex-mcp-server",
					title: "Codex",
					version: "0.0.0-test",
				},
			},
		});
		return;
	}

	if (message.method === "tools/call") {
		const params = message.params as {
			arguments?: Record<string, unknown>;
			name?: string;
		};
		const toolName = params?.name;
		const argumentsObject = params?.arguments ?? {};
		const prompt =
			typeof argumentsObject.prompt === "string"
				? argumentsObject.prompt
				: typeof argumentsObject["prompt"] === "string"
					? (argumentsObject["prompt"] as string)
					: "";

		if (prompt === "needs-approval") {
			pendingApprovalRequestId = 0;
			pendingCallId = message.id;
			await write({
				jsonrpc: "2.0",
				id: pendingApprovalRequestId,
				method: "elicitation/create",
				params: {
					message: "Approve mock action?",
					requestedSchema: {
						type: "object",
						properties: {},
					},
				},
			});
			return;
		}

		if (prompt === "needs-roots") {
			pendingRootsRequestId = 1;
			pendingRootsCallId = message.id;
			await write({
				jsonrpc: "2.0",
				id: pendingRootsRequestId,
				method: "roots/list",
				params: {},
			});
			return;
		}

		if (
			prompt === "stuck-rollout" ||
			prompt === "stuck-rollout-aborted" ||
			prompt === "stuck-rollout-delayed-response" ||
			prompt === "stuck-rollout-session-scan" ||
			prompt === "turn-aborted-live-delayed-response"
		) {
			const threadId =
				toolName === "codex-reply" && typeof argumentsObject.threadId === "string"
					? argumentsObject.threadId
					: prompt === "stuck-rollout-session-scan"
						? "thr_session_scan"
						: prompt === "stuck-rollout-aborted"
							? "thr_rollout_aborted"
							: prompt === "turn-aborted-live-delayed-response"
								? "thr_turn_aborted_live"
								: "thr_stuck_rollout";
			const rolloutPath = await createMockRolloutFile(threadId, prompt === "stuck-rollout-session-scan");
			await write({
				jsonrpc: "2.0",
				method: "codex/event",
				params: {
					_meta: {
						requestId: message.id,
						threadId,
					},
					id: "evt-rollout",
					msg: {
						type: "session_configured",
						session_id: threadId,
						...(prompt === "stuck-rollout-session-scan" ? {} : { rollout_path: rolloutPath }),
					},
				},
			});
			if (prompt === "stuck-rollout-aborted") {
				setTimeout(() => {
					void appendTurnAbortedEvent(rolloutPath, message.id, threadId, "interrupted");
				}, 100);
				return;
			}
			if (prompt === "turn-aborted-live-delayed-response") {
				setTimeout(() => {
					void write({
						jsonrpc: "2.0",
						method: "codex/event",
						params: {
							_meta: {
								requestId: message.id,
								threadId,
							},
							id: "evt-turn-aborted",
							msg: {
								type: "turn_aborted",
								reason: "interrupted",
								session_id: threadId,
							},
						},
					});
				}, 100);
				setTimeout(() => {
					void write({
						jsonrpc: "2.0",
						id: message.id,
						result: createToolResult(threadId, "late interrupted real response"),
					});
				}, 6_000);
				return;
			}
			setTimeout(() => {
				void appendTaskCompleteEvent(
					rolloutPath,
					message.id,
					threadId,
					prompt === "stuck-rollout-delayed-response"
						? "delayed rollout ok"
						: prompt === "stuck-rollout-session-scan"
							? "session scan ok"
							: "rollout ok",
				);
			}, 100);
			if (prompt === "stuck-rollout-delayed-response") {
				setTimeout(() => {
					void write({
						jsonrpc: "2.0",
						id: message.id,
						result: createToolResult(threadId, "delayed real ok"),
					});
				}, 6_000);
			}
			return;
		}

		if (prompt === "thread-context-from-event-only") {
			const threadId = "thr_event_only";
			await write({
				jsonrpc: "2.0",
				method: "codex/event",
				params: {
					_meta: {
						requestId: message.id,
						threadId,
					},
					id: "evt-thread-context-only",
					msg: {
						type: "session_configured",
						session_id: threadId,
					},
				},
			});
			await write({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					content: [
						{
							type: "text",
							text: "event only ok",
						},
					],
				},
			});
			return;
		}

		const threadId =
			toolName === "codex-reply" && typeof argumentsObject.threadId === "string"
				? argumentsObject.threadId
				: "thr_mock";
		await write({
			jsonrpc: "2.0",
			method: "codex/event",
			params: {
				_meta: {
					requestId: message.id,
					threadId,
				},
				id: "evt-1",
				msg: {
					type: "session_configured",
					session_id: threadId,
				},
			},
		});
		await write({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [
					{
						type: "text",
						text: toolName === "codex-reply" ? "reply ok" : "run ok",
					},
				],
				structuredContent: {
					threadId,
					content: toolName === "codex-reply" ? "reply ok" : "run ok",
				},
			},
		});
	}
}

async function onResponse(message: JsonRpcResponse): Promise<void> {
	if (pendingRootsRequestId !== null && message.id === pendingRootsRequestId && pendingRootsCallId !== null) {
		const roots =
			typeof message.result === "object" && message.result !== null && "roots" in message.result
				? (message.result as { roots?: unknown }).roots
				: [];
		await write({
			jsonrpc: "2.0",
			id: pendingRootsCallId,
			result: {
				content: [
					{
						type: "text",
						text: "roots ok",
					},
				],
				structuredContent: {
					threadId: "thr_roots",
					content: JSON.stringify(roots),
				},
			},
		});
		pendingRootsRequestId = null;
		pendingRootsCallId = null;
		return;
	}

	if (pendingApprovalRequestId === null || message.id !== pendingApprovalRequestId || pendingCallId === null) {
		return;
	}

	await write({
		jsonrpc: "2.0",
		id: pendingCallId,
		result: {
			content: [
				{
					type: "text",
					text: "approval ok",
				},
			],
			structuredContent: {
				threadId: "thr_approval",
				content: "approval ok",
			},
		},
	});
	pendingApprovalRequestId = null;
	pendingCallId = null;
}

async function record(message: JsonRpcMessage): Promise<void> {
	if (!capturePath) {
		return;
	}
	await appendFile(capturePath, `${JSON.stringify(message)}\n`, "utf8");
}

async function write(message: JsonRpcMessage): Promise<void> {
	output.write(`${JSON.stringify(message)}\n`);
}

function createToolResult(threadId: string, text: string) {
	return {
		content: [
			{
				type: "text",
				text,
			},
		],
		structuredContent: {
			threadId,
			content: text,
		},
	};
}

async function createMockRolloutFile(threadId: string, useSessionsRoot: boolean): Promise<string> {
	const rolloutDirectory = useSessionsRoot
		? path.join(getNativeSessionsRoot(), "2026", "03", "29")
		: await mkdtemp(path.join(tmpdir(), "yolo-codex-rollout-"));
	await mkdir(rolloutDirectory, { recursive: true });
	const rolloutPath = path.join(rolloutDirectory, `rollout-2026-03-29T10-00-00-${threadId}.jsonl`);
	await writeFile(rolloutPath, "", "utf8");
	return rolloutPath;
}

async function appendTaskCompleteEvent(
	rolloutPath: string,
	requestId: JsonRpcId,
	threadId: string,
	lastAgentMessage: string,
): Promise<void> {
	await appendFile(
		rolloutPath,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			dir: "to_tui",
			kind: "codex_event",
			payload: {
				_meta: {
					requestId,
					threadId,
				},
				id: "evt-task-complete",
				msg: {
					type: "task_complete",
					last_agent_message: lastAgentMessage,
				},
			},
		})}\n`,
		"utf8",
	);
}

async function appendTurnAbortedEvent(
	rolloutPath: string,
	requestId: JsonRpcId,
	threadId: string,
	reason: string,
): Promise<void> {
	await appendFile(
		rolloutPath,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			dir: "to_tui",
			kind: "codex_event",
			payload: {
				_meta: {
					requestId,
					threadId,
				},
				id: "evt-turn-aborted",
				msg: {
					type: "turn_aborted",
					reason,
				},
			},
		})}\n`,
		"utf8",
	);
}

function getNativeSessionsRoot(): string {
	if (process.platform === "win32") {
		return path.win32.join(process.env.USERPROFILE ?? homedir(), ".codex", "sessions");
	}
	return path.posix.join(process.env.HOME ?? homedir(), ".codex", "sessions");
}
