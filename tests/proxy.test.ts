import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadProxyConfig } from "../src/proxy_config.ts";
import {
	createInnerServerSpawnSpec,
	fileUriToFilesystemPath,
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
			description: string;
			inputSchema: {
				properties: Record<string, unknown>;
			};
			name: string;
			title?: string;
		}>;
	};

	assert.deepEqual(
		result.tools.map((tool) => tool.name),
		["codex", "codex-reply"],
	);
	assert.deepEqual(
		result.tools.map((tool) => tool.title),
		["Smart Cheap Agent", "Smart Cheap Agent Reply"],
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
	assert.match(result.tools[0].description, /Preferred first tool for delegating complex, context-heavy work/);
	assert.match(result.tools[0].description, /Smart Cheap Agent runs a smarter reasoning agent/);
	assert.match(result.tools[0].description, /usually cheaper and more cost-efficient/);
	assert.match(
		result.tools[0].description,
		/human-readable answer in content\/text plus structuredContent with threadId and content/,
	);
	assert.match(result.tools[0].description, /call codex-reply with the returned threadId from the prior response/);
	assert.match(result.tools[1].description, /Pass the threadId returned by codex or a previous codex-reply call/);
	assert.match(result.tools[1].description, /Continue the same Smart Cheap Agent session/);
	assert.match(result.tools[1].description, /same shape as codex/);
});

void test("initialize advertises resources capability on the outer wrapper", async () => {
	const server = await createProxyHarness();

	const { response } = await server.requestWithRaw("initialize", {
		clientInfo: {
			name: "test-client",
			title: "Test Client",
			version: "0.0.0",
		},
		capabilities: {},
		protocolVersion: "2025-03-26",
	});
	const result = response.result as {
		capabilities?: Record<string, unknown>;
	};

	assert.deepEqual(result.capabilities?.tools, {
		listChanged: true,
	});
	assert.deepEqual(result.capabilities?.resources, {});
});

void test("resources/list exposes attached guidance documents", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const response = await server.request("resources/list", {});
	const result = response.result as {
		resources: Array<{
			mimeType: string;
			name: string;
			uri: string;
		}>;
	};

	assert.deepEqual(
		result.resources.map((resource) => resource.name),
		["operating-guide"],
	);
	assert.deepEqual(
		result.resources.map((resource) => resource.uri),
		["yolo-codex-mcp://guides/operating-guide.md"],
	);
	assert.ok(result.resources.every((resource) => resource.mimeType === "text/markdown"));
});

void test("resources/read returns usage and rollout guidance", async () => {
	const server = await createProxyHarness();
	await server.initialize();

	const response = await server.request("resources/read", {
		uri: "yolo-codex-mcp://guides/operating-guide.md",
	});

	const guideText = (
		response.result as {
			contents: Array<{
				text: string;
			}>;
		}
	).contents[0]?.text;

	assert.match(guideText ?? "", /structuredContent\.threadId/);
	assert.match(guideText ?? "", /Smart Cheap Agent/);
	assert.match(guideText ?? "", /codex-reply/);
	assert.match(guideText ?? "", /~\/\.codex\/sessions/);
	assert.match(guideText ?? "", /rollout-<timestamp>-<threadId>\.jsonl/);
	assert.match(guideText ?? "", /debugging complex failures/);
	assert.match(guideText ?? "", /browser-tool workflows/);
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

void test("codex call derives cwd from inbound workspace notifications", async () => {
	const server = await createProxyHarness();
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

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-from-workspace-notification",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, "/tmp/repo");

	const stderr = await server.waitForStderr('"source":"client-derived"');
	assert.match(stderr, /\[yolo-codex-mcp\]\[client-cwd\].*"source":"workspace\/didChangeWorkspaceFolders"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd\].*"detail":"workspace context only root"/);
});

void test("legacy outer cwd is ignored and logged while server-derived cwd wins", async () => {
	const server = await createProxyHarness();
	await server.initialize();
	await server.notify("workspace/didChangeWorkspaceFolders", {
		event: {
			added: [
				{
					name: "repo",
					uri: "file:///tmp/dynamic-root",
				},
			],
			removed: [],
		},
	});

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "ignore-legacy-cwd",
			cwd: "/tmp/legacy-path",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, "/tmp/dynamic-root");

	const stderr = await server.waitForStderr("[yolo-codex-mcp][cwd-legacy]");
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd-legacy\].*"ignoredCwd":"\/tmp\/legacy-path"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd\].*"source":"client-derived"/);
});

void test("codex call derives cwd from proactive roots/list when the client advertises roots support", async () => {
	const server = await createProxyHarness();
	await server.initialize({
		capabilities: {
			roots: {
				listChanged: true,
			},
		},
	});

	const rootsRequest = await server.readUntilRequest("roots/list");
	await server.respond(rootsRequest.id, {
		roots: [
			{
				name: "repo",
				uri: "file:///tmp/from-roots",
			},
		],
	});

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-from-proactive-roots",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, "/tmp/from-roots");

	const stderr = await server.waitForStderr('"reason":"notifications/initialized"');
	assert.match(stderr, /\[yolo-codex-mcp\]\[client-cwd\].*"method":"roots\/list".*"status":"requesting"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"forMethod":"roots\/list"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd\].*"detail":"roots\/list only root"/);
});

void test("codex call falls back to process.cwd only when client context is unavailable", async () => {
	const server = await createProxyHarness({
		CODEX_MCP_CWD: path.join(path.resolve("."), "ignored-env-cwd"),
	});
	await server.initialize();

	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: "cwd-process-fallback",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex");
	const forwardedRunParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.equal(forwardedRunParams.arguments.cwd, process.cwd());

	const stderr = await server.waitForStderr("No usable client-derived workspace cwd was available");
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd-fallback\].*"source":"process\.cwd\(\)"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[cwd\].*"source":"process\.cwd\(\)"/);
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

void test("codex-reply derives cwd server-side and ignores legacy outer cwd", async () => {
	const server = await createProxyHarness();
	await server.initialize();
	await server.notify("workspace/didChangeWorkspaceFolders", {
		event: {
			added: [
				{
					name: "reply-repo",
					uri: "file:///tmp/reply-root",
				},
			],
			removed: [],
		},
	});

	await server.request("tools/call", {
		name: "codex-reply",
		arguments: {
			threadId: "thr_explicit_cwd",
			prompt: "next",
			cwd: "/tmp/legacy-reply-cwd",
		},
	});

	const forwardedCall = await server.findCapturedRequest("tools/call", "codex-reply");
	const forwardedReplyParams = forwardedCall.params as {
		arguments: Record<string, unknown>;
	};
	assert.deepEqual(forwardedReplyParams.arguments, {
		threadId: "thr_explicit_cwd",
		prompt: "next",
		cwd: "/tmp/reply-root",
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

void test("always-on logging captures handshake, workspace notifications, roots responses, and forwarded tool args", async () => {
	const server = await createProxyHarness();
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

	const fullPrompt = `${"x".repeat(280)}-tail`;
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
	await server.request("tools/call", {
		name: "codex",
		arguments: {
			prompt: fullPrompt,
		},
	});

	const stderr = await server.waitForStderr(fullPrompt);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"initialize"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"notifications\/initialized"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"workspace\/didChangeWorkspaceFolders"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"\$\/progress"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"method":"tools\/call"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[mcp-in\].*"forMethod":"roots\/list"/);
	assert.match(stderr, /\[yolo-codex-mcp\]\[tools-forward\].*"tool":"codex"/);
	assert.match(stderr, /file:\/\/\/tmp\/repo/);
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

void test("loadProxyConfig ignores removed cwd/debug env vars", () => {
	const config = loadProxyConfig({
		CODEX_MCP_CWD: "/tmp/ignored",
		CODEX_MCP_DEBUG_INBOUND: "off",
	});

	assert.deepEqual(config.policy, {
		approvalPolicy: "never",
		model: null,
		profile: null,
		sandbox: "danger-full-access",
	});
});

void test("fileUriToFilesystemPath handles Windows drive and UNC roots", () => {
	assert.equal(fileUriToFilesystemPath("file:///C:/Users/dev/repo", "win32"), "C:\\Users\\dev\\repo");
	assert.equal(fileUriToFilesystemPath("file://server/share/repo", "win32"), "\\\\server\\share\\repo");
	assert.equal(fileUriToFilesystemPath("file:///tmp/repo", "win32"), "/tmp/repo");
});

void test("Cursor cwd hook tolerates quoted hook envelopes and does not inject cwd", async () => {
	const hookPath = path.resolve(".cursor/hooks/inject-yolo-cwd.mjs");
	const malformedQuotedEnvelope =
		'"{"tool_name":"MCP:codex","workspace_roots":["/tmp/hook-repo"],"tool_input":"{\\"prompt\\":\\"hello\\"}"}"';
	const result = await runScriptWithStdin(hookPath, malformedQuotedEnvelope);

	assert.equal(result.exitCode, 0);
	assert.equal(result.stderr.includes("Failed to parse hook input JSON from stdin"), false);
	assert.deepEqual(JSON.parse(result.stdout), {
		permission: "allow",
	});
	assert.match(result.stderr, /Hook no longer injects cwd/);
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
	initialize: (overrides?: Record<string, unknown>) => Promise<void>;
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
		initialize: async (overrides: Record<string, unknown> = {}) => {
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
						...overrides,
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

async function runScriptWithStdin(
	scriptPath: string,
	stdinText: string,
): Promise<{
	exitCode: number | null;
	stderr: string;
	stdout: string;
}> {
	const child = spawn(process.execPath, [scriptPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	child.stdin.end(stdinText);

	const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
	return {
		exitCode,
		stderr,
		stdout: stdout.trim(),
	};
}
