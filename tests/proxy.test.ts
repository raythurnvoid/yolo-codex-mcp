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
	normalizeRolloutPathForFilesystem,
	resolveInnerServerCommand,
	resolveInnerServerLaunch,
	resolveSessionRoot,
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
		"cwd",
		"prompt",
	]);
	assert.deepEqual(Object.keys(result.tools[1].inputSchema.properties).sort(), ["cwd", "prompt", "threadId"]);
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

void test("codex call uses CODEX_MCP_CWD when configured", async () => {
	const configuredCwd = path.join(path.resolve("."), "custom-cwd");
	const server = await createProxyHarness({
		CODEX_MCP_CWD: configuredCwd,
	});
	await server.initialize();

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-override",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, configuredCwd);
});

void test("codex call prefers an explicit per-call cwd over the wrapper default", async () => {
	const configuredCwd = path.join(path.resolve("."), "policy-cwd");
	const explicitCwd = path.join(path.resolve("."), "call-cwd");
	const server = await createProxyHarness({
		CODEX_MCP_CWD: configuredCwd,
	});
	await server.initialize();

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-explicit",
			cwd: explicitCwd,
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, explicitCwd);
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
		cwd: process.cwd(),
	});
});

void test("codex-reply forwards an explicit per-call cwd", async () => {
	const explicitCwd = path.join(path.resolve("."), "reply-cwd");
	const server = await createProxyHarness();
	await server.initialize();

	await server.request("tools/call", {
		name: "codex-reply",
		arguments: {
			threadId: "thr_explicit_cwd",
			prompt: "next",
			cwd: explicitCwd,
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex-reply");
	const forwardedReplyParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.deepEqual(forwardedReplyParams.arguments, {
		threadId: "thr_explicit_cwd",
		prompt: "next",
		cwd: explicitCwd,
	});
});

void test("rollout polling synthesizes completion when the inner response never arrives", async () => {
	const server = await createProxyHarness({}, { requestTimeoutMs: 12_000 });
	await server.initialize();

	const response = await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "stuck-rollout",
		},
	});

	assert.deepEqual(response.result, {
		content: [
			{
				type: "text",
				text: "rollout ok",
			},
		],
		structuredContent: {
			threadId: "thr_stuck_rollout",
			content: "rollout ok",
		},
	});

	const stderr = await server.waitForStderr("Synthesized codex completion from rollout polling");
	assert.match(stderr, /\[yolo-codex-mcp\] Resolved rollout path via codex\/event session_configured/);
	assert.match(stderr, /\[yolo-codex-mcp\] Polling rollout fallback for request 2 thread thr_stuck_rollout rollout /);
});

void test("rollout polling falls back to the sessions folder when rollout_path is missing", async () => {
	const sessionHome = await mkdtemp(path.join(os.tmpdir(), "yolo-codex-session-home-"));
	const server = await createProxyHarness(
		{
			HOME: sessionHome,
			USERPROFILE: sessionHome,
		},
		{ requestTimeoutMs: 12_000 },
	);
	await server.initialize();

	const response = await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "stuck-rollout-session-scan",
		},
	});

	assert.deepEqual(response.result, {
		content: [
			{
				type: "text",
				text: "session scan ok",
			},
		],
		structuredContent: {
			threadId: "thr_session_scan",
			content: "session scan ok",
		},
	});

	const stderr = await server.waitForStderr("sessions scan");
	assert.match(
		stderr,
		/\[yolo-codex-mcp\] Resolved rollout path via sessions scan \(native\) for request 2 thread thr_session_scan/,
	);
	assert.match(stderr, /\[yolo-codex-mcp\] Polling rollout fallback for request 2 thread thr_session_scan rollout /);
});

void test("late inner responses are suppressed after synthetic rollout completion", async () => {
	const server = await createProxyHarness({}, { requestTimeoutMs: 12_000 });
	await server.initialize();

	const { response } = await server.requestWithRaw("tools/call", {
		name: "codex",
		arguments: {
			prompt: "stuck-rollout-delayed-response",
		},
	});

	assert.deepEqual(response.result, {
		content: [
			{
				type: "text",
				text: "delayed rollout ok",
			},
		],
		structuredContent: {
			threadId: "thr_stuck_rollout",
			content: "delayed rollout ok",
		},
	});
	await server.assertNoAdditionalResponse(response.id, 2_500);
});

void test("debug inbound logging captures handshake, workspace notifications, and roots responses", async () => {
	const server = await createProxyHarness({
		CODEX_MCP_DEBUG_INBOUND: "1",
	});
	await server.initialize();
	await server.notify("workspace/didChangeWorkspaceFolders", {
		event: {
			added: [
				{
					name: "repo",
					uri: "file:///tmp/repo",
				},
			],
			removed: [],
		},
	});
	await server.notify("$/progress", {
		params: {
			message: "indexing",
		},
		token: "tok-1",
	});

	const responsePromise = server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "needs-roots",
		},
	});
	const rootsRequest = await server.readUntilRequest("roots/list");
	await server.respond(rootsRequest.id, {
		roots: [
			{
				name: "repo",
				uri: "file:///tmp/repo",
			},
		],
	});
	await responsePromise;

	const stderr = await server.waitForStderr('"forMethod":"roots/list"');
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"initialize"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"notifications\/initialized"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"workspace\/didChangeWorkspaceFolders"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"\$\/progress"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"forMethod":"roots\/list"/);
	assert.match(stderr, /file:\/\/\/tmp\/repo/);
});

void test("debug inbound unknown mode logs non-whitelisted methods without selected handshake noise", async () => {
	const server = await createProxyHarness({
		CODEX_MCP_DEBUG_INBOUND: "unknown",
	});
	await server.initialize();
	await server.notify("client/custom", {
		content: "hello",
	});

	const stderr = await server.waitForStderr('"method":"client/custom"');
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"client\/custom"/);
	assert.doesNotMatch(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"initialize"/);
	assert.doesNotMatch(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"notifications\/initialized"/);
});

void test("debug inbound all mode logs tools requests with summarized payloads", async () => {
	const server = await createProxyHarness({
		CODEX_MCP_DEBUG_INBOUND: "all",
	});
	await server.initialize();

	await server.request("tools/list", {});

	const stderr = await server.waitForStderr('"method":"tools/list"');
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"tools\/list"/);
});

void test("debug inbound verbose mode logs full tool payloads", async () => {
	const server = await createProxyHarness({
		CODEX_MCP_DEBUG_INBOUND: "verbose",
	});
	await server.initialize();

	const fullPrompt = `${"x".repeat(280)}-tail`;
	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: fullPrompt,
		},
	});

	const stderr = await server.waitForStderr(fullPrompt);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"tools\/call"/);
	assert.match(stderr, new RegExp(`${fullPrompt}"`));
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
			requestTimeoutMs: 90_000,
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

void test("loadProxyConfig uses CODEX_MCP_CWD when it is non-empty after trimming", () => {
	const config = loadProxyConfig({
		CODEX_MCP_CWD: "  /tmp/codex-workspace  ",
	});

	assert.equal(config.policy.cwd, "/tmp/codex-workspace");
});

void test("loadProxyConfig defaults cwd to process.cwd() when CODEX_MCP_CWD is unset or blank", () => {
	assert.equal(loadProxyConfig({}).policy.cwd, process.cwd());
	assert.equal(
		loadProxyConfig({
			CODEX_MCP_CWD: "   ",
		}).policy.cwd,
		process.cwd(),
	);
});

void test("loadProxyConfig treats an unexpanded Cursor workspace placeholder as unset", () => {
	assert.equal(
		loadProxyConfig({
			CODEX_MCP_CWD: "  ${workspaceFolder}  ",
		}).policy.cwd,
		process.cwd(),
	);
});

void test("loadProxyConfig parses inbound debug modes", () => {
	assert.equal(loadProxyConfig({}).debugInbound, "off");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "1" }).debugInbound, "selected");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "true" }).debugInbound, "selected");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "selected" }).debugInbound, "selected");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "all" }).debugInbound, "all");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "verbose" }).debugInbound, "verbose");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "unknown" }).debugInbound, "unknown");
	assert.equal(loadProxyConfig({ CODEX_MCP_DEBUG_INBOUND: "0" }).debugInbound, "off");
});

void test("resolveSessionRoot prefers a Windows-accessible WSL sessions root for WSL launches", () => {
	const root = resolveSessionRoot(
		{
			command: "C:\\Windows\\System32\\wsl.exe",
			args: ["-e", "codex", "mcp-server"],
		},
		{
			USERPROFILE: "C:\\Users\\dev",
		},
		{
			platform: "win32",
			wslSessionsRootLookup: () => ({
				distro: "Ubuntu",
				sessionsRoot: "/home/dev/.codex/sessions",
			}),
		},
	);

	assert.deepEqual(root, {
		path: "\\\\wsl$\\Ubuntu\\home\\dev\\.codex\\sessions",
		source: "wsl",
		wslDistro: "Ubuntu",
	});
});

void test("resolveSessionRoot falls back to the native root for non-WSL launches", () => {
	const root = resolveSessionRoot(
		{
			command: "codex",
			args: ["mcp-server"],
		},
		{
			HOME: "/home/dev",
		},
		{
			platform: "linux",
		},
	);

	assert.deepEqual(root, {
		path: "/home/dev/.codex/sessions",
		source: "native",
		wslDistro: null,
	});
});

void test("resolveSessionRoot falls back to the native root when WSL sessions lookup fails", () => {
	const root = resolveSessionRoot(
		{
			command: "C:\\Windows\\System32\\wsl.exe",
			args: ["-e", "codex", "mcp-server"],
		},
		{
			USERPROFILE: "C:\\Users\\dev",
		},
		{
			platform: "win32",
			wslSessionsRootLookup: () => null,
		},
	);

	assert.deepEqual(root, {
		path: "C:\\Users\\dev\\.codex\\sessions",
		source: "native",
		wslDistro: null,
	});
});

void test("normalizeRolloutPathForFilesystem converts WSL rollout paths even without a WSL session root", () => {
	const normalized = normalizeRolloutPathForFilesystem(
		"/home/dev/.codex/sessions/2026/03/29/rollout-2026-03-29T10-00-00-thr_123.jsonl",
		{
			path: "C:\\Users\\dev\\.codex\\sessions",
			source: "native",
			wslDistro: null,
		},
		{
			platform: "win32",
			wslDistro: "Ubuntu",
		},
	);

	assert.equal(
		normalized,
		"\\\\wsl$\\Ubuntu\\home\\dev\\.codex\\sessions\\2026\\03\\29\\rollout-2026-03-29T10-00-00-thr_123.jsonl",
	);
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
	assertNoAdditionalResponse: (id: JsonRpcId, waitMs: number) => Promise<void>;
	capturePath: string;
	child: ReturnType<typeof spawn>;
	findCapturedRequest: (method: string, toolName: string) => Promise<JsonRpcRequest>;
	findCapturedResponse: (id: JsonRpcId) => Promise<JsonRpcResponse>;
	initialize: () => Promise<void>;
	notify: (method: string, params?: unknown) => Promise<void>;
	readUntilNotification: (method: string) => Promise<JsonRpcNotification>;
	readUntilRequest: (method: string) => Promise<JsonRpcRequest>;
	request: (method: string, params: unknown) => Promise<JsonRpcResponse>;
	requestWithRaw: (method: string, params: unknown) => Promise<JsonRpcResponseWithRaw>;
	respond: (id: JsonRpcId, result: unknown) => Promise<void>;
	waitForStderr: (pattern: RegExp | string) => Promise<string>;
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
	const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
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

	const stdout = createInterface({
		input: child.stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let nextId = 0;
	const pendingResponses = new Map<string, PendingRequest>();
	const bufferedMessages: JsonRpcMessage[] = [];
	let stderrText = "";
	let childExitSummary: string | null = null;
	let stdoutParseFailure: Error | null = null;

	stdout.on("line", (line) => {
		if (!line.trim()) {
			return;
		}
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch (error) {
			stdoutParseFailure = new Error(
				`Failed to parse proxy stdout line as JSON: ${line}\n${formatHarnessDiagnostics(stderrText, childExitSummary)}`,
				{
					cause: error,
				},
			);
			return;
		}
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
	child.stderr.on("data", (chunk) => {
		stderrText += String(chunk);
	});
	child.once("exit", (code, signal) => {
		childExitSummary = `proxy exited with code ${String(code)} and signal ${String(signal)}`;
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
		assertNoAdditionalResponse: async (id: JsonRpcId, waitMs: number) => {
			const deadline = Date.now() + waitMs;
			for (;;) {
				const duplicateResponse = bufferedMessages.find(
					(message): message is JsonRpcResponse | JsonRpcErrorMessage =>
						"id" in message && message.id === id && ("result" in message || "error" in message),
				);
				if (duplicateResponse) {
					assert.fail(`Unexpected duplicate response for id ${String(id)}: ${JSON.stringify(duplicateResponse)}`);
				}
				if (Date.now() >= deadline) {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
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
		notify: async (method: string, params?: unknown) => {
			await write({
				jsonrpc: "2.0",
				method,
				params,
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
		waitForStderr: async (pattern: RegExp | string) => {
			return await withTimeout(
				(async () => {
					for (;;) {
						const matches = typeof pattern === "string" ? stderrText.includes(pattern) : pattern.test(stderrText);
						if (matches) {
							return stderrText;
						}
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				})(),
				`stderr pattern ${String(pattern)}`,
				requestTimeoutMs,
			);
		},
	};

	async function writeRequest(method: string, params: unknown): Promise<JsonRpcResponseWithRaw> {
		if (stdoutParseFailure !== null) {
			throw stdoutParseFailure;
		}
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
		try {
			return await withTimeout(responsePromise, `response for request ${String(id)}`, requestTimeoutMs);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}\n${formatHarnessDiagnostics(stderrText, childExitSummary)}`);
		}
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

async function getConfiguredInnerServerLaunchSpec(): Promise<{
	args: string[];
	command: string;
} | null> {
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

function formatHarnessDiagnostics(stderrText: string, childExitSummary: string | null): string {
	return [
		childExitSummary ?? "proxy is still running",
		stderrText ? `proxy stderr:\n${stderrText}` : "proxy stderr: <empty>",
	].join("\n");
}
