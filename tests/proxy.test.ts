import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadProxyConfig } from "../src/proxy_config.ts";
import {
	createInnerServerSpawnSpec,
	resolveInnerServerCommand,
	resolveInnerServerLaunch,
} from "../src/proxy_server.ts";

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

type JsonRpcResponseWithRaw = {
	rawLine: string;
	response: JsonRpcResponse;
};

type JsonRpcErrorBody = {
	code: number;
	data?: unknown;
	message: string;
};

type JsonRpcErrorMessage = {
	jsonrpc: "2.0";
	error: JsonRpcErrorBody;
	id: JsonRpcId;
};

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest | JsonRpcResponse | JsonRpcErrorMessage;

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			child.kill();
			await new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				setTimeout(resolve, 1_000);
			});
		}),
	);
});

void test("tools/list exposes only the reduced outer schemas", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const { rawLine, response } = await server.requestWithRaw("tools/list", {});
	const result = response.result as {
		nextCursor?: unknown;
		tools: Array<{
			inputSchema: {
				properties: Record<string, unknown>;
			};
			name: string;
		}>;
	};

	assert.deepEqual(
		result.tools.map((tool) => tool.name),
		["codex", "codex-reply"],
	);
	assert.equal(rawLine.includes('"nextCursor":'), false);
	assert.doesNotThrow(() => ListToolsResultSchema.parse(result));
	assert.equal("nextCursor" in result, false);
	assert.deepEqual(Object.keys(result.tools[0].inputSchema.properties).sort(), [
		"agent-instructions",
		"compact-prompt",
		"prompt",
	]);
	assert.deepEqual(Object.keys(result.tools[1].inputSchema.properties).sort(), ["prompt", "threadId"]);
});

void test("codex call injects fixed policy and maps agent-instructions", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const responsePromise = server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "hello",
			"agent-instructions": "Be terse.",
			"compact-prompt": "Compact it.",
		},
	});
	const notification = await server.readUntilNotification("codex/event");
	const response = await responsePromise;

	assert.equal(notification.method, "codex/event");
	assert.deepEqual(response.result, {
		content: [
			{
				type: "text",
				text: "run ok",
			},
		],
		structuredContent: {
			threadId: "thr_mock",
			content: "run ok",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.deepEqual(forwardedRunParams.arguments, {
		prompt: "hello",
		cwd: process.cwd(),
		sandbox: "danger-full-access",
		"approval-policy": "never",
		"developer-instructions": "Be terse.",
		"compact-prompt": "Compact it.",
	});
});

void test("codex call defaults cwd to the wrapper process cwd", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-default",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, process.cwd());
});

void test("codex-reply forwards threadId and supports deprecated conversationId input", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const response = await server.request("tools/call", {
		name: "codex-reply",
		arguments: {
			conversationId: "thr_from_conversation",
			prompt: "next",
		},
	});

	assert.deepEqual(response.result, {
		content: [
			{
				type: "text",
				text: "reply ok",
			},
		],
		structuredContent: {
			threadId: "thr_from_conversation",
			content: "reply ok",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex-reply");
	const forwardedReplyParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.deepEqual(forwardedReplyParams.arguments, {
		threadId: "thr_from_conversation",
		prompt: "next",
	});
});

void test("server-initiated elicitation requests are remapped back to the inner ids", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const responsePromise = server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "needs-approval",
		},
	});
	const request = await server.readUntilRequest("elicitation/create");
	assert.notEqual(request.id, 0);

	await server.respond(request.id, {
		decision: "approved",
	});

	const response = await responsePromise;
	assert.deepEqual(response.result, {
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
	});

	const forwardedResponse = await server.findCapturedResponse(0);
	assert.deepEqual(forwardedResponse.result, {
		decision: "approved",
	});
});

void test("real codex subprocess smoke test for initialize and reduced tools/list", async (t) => {
	const launchSpec = await getConfiguredInnerServerLaunchSpec();
	if (launchSpec === null) {
		t.skip(
			"Configured inner Codex MCP server is not reachable; set CODEX_MCP_BIN/CODEX_MCP_ARGS or ensure codex is on PATH",
		);
		return;
	}

	const server = await createProxyHarness(
		{
			CODEX_MCP_BIN: launchSpec.command,
			CODEX_MCP_ARGS: JSON.stringify(launchSpec.args),
		},
		{
			useMockInner: false,
			requestTimeoutMs: 30_000,
		},
	);
	await server.initialize();

	const response = await server.request("tools/list", {});
	const result = response.result as {
		tools: Array<{
			name: string;
		}>;
	};

	assert.deepEqual(
		result.tools.map((tool) => tool.name),
		["codex", "codex-reply"],
	);
});

void test("windows batch launch spec uses cmd.exe wrapping", () => {
	const spec = createInnerServerSpawnSpec("C:\\Users\\dev\\Codex Bin\\codex.cmd", ["mcp-server"], {
		comSpec: "cmd.exe",
		platform: "win32",
	});

	assert.equal(spec.command, "cmd.exe");
	assert.deepEqual(spec.args, ["/d", "/s", "/c", '"C:\\Users\\dev\\Codex Bin\\codex.cmd" mcp-server']);
});

void test("non-batch launch spec stays direct", () => {
	const spec = createInnerServerSpawnSpec("codex", ["mcp-server"], {
		platform: "linux",
	});

	assert.equal(spec.command, "codex");
	assert.deepEqual(spec.args, ["mcp-server"]);
});

void test("loadProxyConfig falls back to CODEX_BIN for compatibility", () => {
	const config = loadProxyConfig({
		CODEX_BIN: "C:\\Codex\\codex.exe",
	});

	assert.equal(config.innerCommand, "C:\\Codex\\codex.exe");
	assert.deepEqual(config.innerArgs, ["mcp-server"]);
});

void test("resolveInnerServerCommand finds Codex in common Windows install paths", () => {
	const resolved = resolveInnerServerCommand("codex", {
		env: {
			APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
			USERPROFILE: "C:\\Users\\dev",
		},
		pathExists: (candidate) => candidate === "C:\\Users\\dev\\AppData\\Local\\Programs\\Codex\\codex.exe",
		pathLookup: () => null,
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\AppData\\Local\\Programs\\Codex\\codex.exe");
});

void test("resolveInnerServerCommand probes spawnable extensions for explicit Windows paths", () => {
	const resolved = resolveInnerServerCommand("C:\\Users\\dev\\bin\\codex", {
		pathExists: (candidate) => candidate === "C:\\Users\\dev\\bin\\codex.cmd",
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\bin\\codex.cmd");
});

void test("resolveInnerServerCommand follows extensionless Windows shim realpaths to a spawnable target", () => {
	const resolved = resolveInnerServerCommand("C:\\Users\\dev\\bin\\codex", {
		pathExists: (candidate) =>
			candidate === "C:\\Users\\dev\\bin\\codex" || candidate === "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd",
		pathRealpath: (candidate) =>
			candidate === "C:\\Users\\dev\\bin\\codex" ? "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd" : null,
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd");
});

void test("resolveInnerServerCommand finds Codex in user .codex bin shims", () => {
	const resolved = resolveInnerServerCommand("codex", {
		env: {
			USERPROFILE: "C:\\Users\\dev",
		},
		pathExists: (candidate) => candidate === "C:\\Users\\dev\\.codex\\bin\\codex.cmd",
		pathLookup: () => null,
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\.codex\\bin\\codex.cmd");
});

void test("resolveInnerServerCommand finds Codex in user bin shims for thin PATH launches", () => {
	const resolved = resolveInnerServerCommand("codex", {
		env: {
			USERPROFILE: "C:\\Users\\dev",
		},
		pathExists: (candidate) => candidate === "C:\\Users\\dev\\bin\\codex.cmd",
		pathLookup: () => null,
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\bin\\codex.cmd");
});

void test("resolveInnerServerCommand normalizes extensionless Windows PATH results", () => {
	const resolved = resolveInnerServerCommand("codex", {
		pathExists: (candidate) => candidate === "C:\\Users\\dev\\bin\\codex.exe",
		pathLookup: () => "C:\\Users\\dev\\bin\\codex",
		platform: "win32",
	});

	assert.equal(resolved, "C:\\Users\\dev\\bin\\codex.exe");
});

void test("resolveInnerServerLaunch falls back to WSL when Windows discovery misses", () => {
	const resolved = resolveInnerServerLaunch("codex", ["mcp-server"], {
		env: {},
		pathExists: () => false,
		pathLookup: () => null,
		platform: "win32",
		wslLookup: () => ({
			command: "C:\\Windows\\System32\\wsl.exe",
			args: ["-e", "codex"],
		}),
	});

	assert.deepEqual(resolved, {
		command: "C:\\Windows\\System32\\wsl.exe",
		args: ["-e", "codex", "mcp-server"],
	});
});

void test("resolveInnerServerLaunch failure tells Cursor users to set CODEX_MCP_BIN only as last resort", () => {
	assert.throws(
		() =>
			resolveInnerServerLaunch("codex", ["mcp-server"], {
				env: {},
				pathExists: () => false,
				pathLookup: () => null,
				platform: "win32",
				wslLookup: () => null,
			}),
		(error: unknown) => {
			assert.match(String(error), /should usually work without extra config/);
			assert.match(String(error), /CODEX_MCP_BIN/);
			return true;
		},
	);
});

type ProxyHarness = {
	capturePath: string;
	child: ReturnType<typeof spawn>;
	findCapturedRequest: (method: string, toolName: string) => Promise<JsonRpcRequest>;
	findCapturedResponse: (id: JsonRpcId) => Promise<JsonRpcResponse>;
	initialize: () => Promise<void>;
	readUntilNotification: (method: string) => Promise<JsonRpcNotification>;
	readUntilRequest: (method: string) => Promise<JsonRpcRequest>;
	request: (method: string, params: unknown) => Promise<JsonRpcResponse>;
	requestWithRaw: (method: string, params: unknown) => Promise<JsonRpcResponseWithRaw>;
	respond: (id: JsonRpcId, result: unknown) => Promise<void>;
};

type PendingRequest = {
	reject: (error: Error) => void;
	resolve: (response: JsonRpcResponseWithRaw) => void;
};

async function createProxyHarness(
	extraEnv: Record<string, string> = {},
	options: {
		requestTimeoutMs?: number;
		useMockInner?: boolean;
	} = {},
): Promise<ProxyHarness> {
	const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "yolo-codex-mcp-test-"));
	const capturePath = path.join(tempDir, "mock-inner-capture.jsonl");
	const mockInnerPath = path.resolve("tests/fixtures/mock_inner_server.ts");
	const serverPath = path.resolve("src/server.ts");
	const useMockInner = options.useMockInner ?? true;
	const configuredInner = loadProxyConfig(process.env);
	const child = spawn(process.execPath, [serverPath], {
		cwd: path.resolve("."),
		env: {
			...process.env,
			CODEX_MCP_BIN: useMockInner ? process.execPath : configuredInner.innerCommand,
			CODEX_MCP_ARGS: JSON.stringify(useMockInner ? [mockInnerPath] : configuredInner.innerArgs),
			MOCK_INNER_CAPTURE: useMockInner ? capturePath : "",
			RUST_LOG: "",
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);

	child.stderr.on("data", () => {
		// Tests consume stderr only on failure via process output.
	});

	const stdout = createInterface({
		input: child.stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let nextId = 0;
	const pendingResponses = new Map<string, PendingRequest>();
	const bufferedMessages: JsonRpcMessage[] = [];

	stdout.on("line", (line) => {
		if (!line.trim()) {
			return;
		}
		const message = JSON.parse(line) as JsonRpcMessage;
		if ("id" in message && ("result" in message || "error" in message)) {
			const resolver = pendingResponses.get(idKey(message.id));
			if (resolver) {
				pendingResponses.delete(idKey(message.id));
				if ("error" in message) {
					resolver.reject(
						new Error(`JSON-RPC error for id ${String(message.id)}: ${serializeJsonRpcError(message.error)}`),
					);
				} else {
					resolver.resolve({
						rawLine: line,
						response: message,
					});
				}
				return;
			}
		}
		bufferedMessages.push(message);
	});

	const write = async (message: JsonRpcMessage) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	const readBuffered = async <T extends JsonRpcMessage>(
		predicate: (message: JsonRpcMessage) => message is T,
	): Promise<T> => {
		return await withTimeout(
			(async () => {
				for (;;) {
					const index = bufferedMessages.findIndex((message) => predicate(message));
					if (index >= 0) {
						return bufferedMessages.splice(index, 1)[0] as T;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			})(),
			"buffered JSON-RPC message",
			requestTimeoutMs,
		);
	};

	return {
		capturePath,
		child,
		findCapturedRequest: async (method: string, toolName: string) => {
			const messages = await readCapturedMessages(capturePath);
			const match = messages.find(
				(message): message is JsonRpcRequest =>
					"method" in message &&
					"id" in message &&
					message.method === method &&
					typeof message.params === "object" &&
					message.params !== null &&
					"name" in message.params &&
					(message.params as { name?: unknown }).name === toolName,
			);
			assert.ok(match, `Expected captured ${method} request for ${toolName}`);
			return match;
		},
		findCapturedResponse: async (id: JsonRpcId) => {
			const messages = await readCapturedMessages(capturePath);
			const match = messages.find((message): message is JsonRpcResponse => "result" in message && message.id === id);
			assert.ok(match, `Expected captured response for id ${String(id)}`);
			return match;
		},
		initialize: async () => {
			let response: JsonRpcResponse;
			try {
				response = (
					await writeRequest("initialize", {
						clientInfo: {
							name: "test-client",
							title: "Test Client",
							version: "0.0.0",
						},
						capabilities: {},
						protocolVersion: "2025-03-26",
					})
				).response;
			} catch (error) {
				assert.fail(`initialize failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
			}
			assert.equal(response.id, 1);
			await write({
				jsonrpc: "2.0",
				method: "notifications/initialized",
			});
		},
		readUntilNotification: (method: string) =>
			readBuffered(
				(message): message is JsonRpcNotification =>
					"method" in message && !("id" in message) && message.method === method,
			),
		readUntilRequest: (method: string) =>
			readBuffered(
				(message): message is JsonRpcRequest => "method" in message && "id" in message && message.method === method,
			),
		request: async (method: string, params: unknown) => (await writeRequest(method, params)).response,
		requestWithRaw: async (method: string, params: unknown) => await writeRequest(method, params),
		respond: async (id: JsonRpcId, result: unknown) => {
			await write({
				jsonrpc: "2.0",
				id,
				result,
			});
		},
	};

	async function writeRequest(method: string, params: unknown): Promise<JsonRpcResponseWithRaw> {
		const id = ++nextId;
		const responsePromise = new Promise<JsonRpcResponseWithRaw>((resolve, reject) => {
			pendingResponses.set(idKey(id), {
				resolve,
				reject,
			});
		});
		await write({
			jsonrpc: "2.0",
			id,
			method,
			params,
		});
		return await withTimeout(responsePromise, `response for request ${String(id)}`, requestTimeoutMs);
	}
}

async function readCapturedMessages(capturePath: string): Promise<JsonRpcMessage[]> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const file = await readFile(capturePath, "utf8");
			return file
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonRpcMessage);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	return [];
}

async function getConfiguredInnerServerLaunchSpec(): Promise<{ args: string[]; command: string } | null> {
	const config = loadProxyConfig(process.env);
	try {
		const launch = resolveInnerServerLaunch(config.innerCommand, config.innerArgs);
		if (looksLikePath(launch.command)) {
			await access(launch.command);
		}
		return launch;
	} catch {
		return null;
	}
}

function idKey(id: JsonRpcId): string {
	if (typeof id === "string") {
		return `string:${id}`;
	}
	if (typeof id === "number") {
		return `number:${id}`;
	}
	return "null";
}

function looksLikePath(command: string): boolean {
	return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Timed out waiting for ${label}`));
			}, timeoutMs);
		}),
	]);
}

function serializeJsonRpcError(error: JsonRpcErrorBody): string {
	return JSON.stringify({
		code: error.code,
		data: error.data,
		message: error.message,
	});
}
