import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

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
const input = createInterface({
	input: process.stdin,
	crlfDelay: Number.POSITIVE_INFINITY,
});

let pendingApprovalRequestId: JsonRpcId | null = null;
let pendingCallId: JsonRpcId | null = null;

input.on("line", (line) => {
	void handleLine(line);
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
