import os from "node:os";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { convertWindowsPathToWsl, normalizeSessionCwd } from "../src/acp_runtime.ts";
import { createOpenCodeSpawnSpec, loadOpenCodeConfig, resolveOpenCodeLaunch } from "../src/opencode_config.ts";

type Harness = {
	call: (method: string, params?: unknown) => Promise<unknown>;
	close: () => Promise<void>;
	notify: (method: string, params?: unknown) => void;
	notifications: Array<{ method: string; params?: unknown }>;
	stderr: () => string;
};
type HarnessOptions = {
	env?: Record<string, string>;
	initializeParams?: Record<string, unknown>;
	rootsEntries?: Array<{ name?: string; uri?: string }>;
};

type ResourceReadResult = {
	contents: Array<{
		text?: string;
		uri?: string;
	}>;
};

type PromptGetResult = {
	description?: string;
	messages: Array<{
		content?: {
			text?: string;
			type?: string;
		};
		role?: string;
	}>;
};

type ToolCallResult = {
	content: Array<{
		text?: string;
		type: string;
	}>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
};

const harnesses: Harness[] = [];
const operationalGuidelinesUri = "smart-agent://guides/operational-guidelines.md";
const smartAgentPromptName = "prompt";

afterEach(async () => {
	await Promise.all(
		harnesses.splice(0).map(async (harness) => {
			await harness.close();
		}),
	);
});

async function createHarness(options: HarnessOptions | Record<string, string> = {}): Promise<Harness> {
	const normalizedOptions =
		"env" in options || "initializeParams" in options || "rootsEntries" in options
			? (options as HarnessOptions)
			: ({ env: options as Record<string, string> } satisfies HarnessOptions);
	const env = normalizedOptions.env ?? {};
	const childEnv =
		env.__USE_PARENT_ENV__ === "1"
			? Object.fromEntries(
					Object.entries({ ...process.env, ...env }).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: Object.fromEntries(
					Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				);
	const child = spawn(process.execPath, [path.resolve("src/server.ts")], {
		cwd: process.cwd(),
		env: childEnv,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();
	let nextId = 1;
	const notifications: Array<{ method: string; params?: unknown }> = [];
	let stdoutBuffer = "";
	let stderrBuffer = "";

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const line = stdoutBuffer.slice(0, newlineIndex).trim();
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			const message = JSON.parse(line) as {
				error?: { message?: string };
				id?: number | string;
				method?: string;
				params?: unknown;
				result?: unknown;
			};
			if (message.method === "roots/list" && typeof message.id === "string") {
				child.stdin.write(
					`${JSON.stringify({
						id: message.id,
						jsonrpc: "2.0",
						result: {
							roots: normalizedOptions.rootsEntries ?? [
								{
									name: "workspace",
									uri: `file://${process.cwd().replace(/\\/g, "/")}`,
								},
							],
						},
					})}\n`,
				);
				continue;
			}
			if (typeof message.id !== "number") {
				const notification = message as { method?: string; params?: unknown };
				if (typeof notification.method === "string") {
					notifications.push({ method: notification.method, params: notification.params });
				}
				continue;
			}
			const resolver = pending.get(message.id);
			if (!resolver) {
				continue;
			}
			pending.delete(message.id);
			if (message.error) {
				resolver.reject(new Error(message.error.message ?? "Unknown MCP error"));
				continue;
			}
			resolver.resolve(message.result);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderrBuffer += chunk;
	});
	child.on("exit", (code, signal) => {
		for (const resolver of pending.values()) {
			resolver.reject(
				new Error(
					`Server exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"}, stderr=${stderrBuffer.trim() || "none"})`,
				),
			);
		}
		pending.clear();
	});

	const request = (method: string, params?: unknown): Promise<unknown> => {
		const id = nextId++;
		const payload = {
			id,
			jsonrpc: "2.0",
			method,
			params: params ?? {},
		};
		return new Promise((resolve, reject) => {
			pending.set(id, { reject, resolve });
			child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (error) {
					pending.delete(id);
					reject(error);
				}
			});
		});
	};

	const notify = (method: string, params?: unknown): void => {
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method,
				params: params ?? {},
			})}\n`,
		);
	};

	await request("initialize", {
		capabilities: {
			roots: {},
		},
		clientInfo: { name: "test-client", version: "0.0.0" },
		protocolVersion: "2025-06-18",
		...normalizedOptions.initializeParams,
	});
	notify("notifications/initialized", {});

	const harness: Harness = {
		call: request,
		close: async () => {
			child.stdin.end();
			if (child.exitCode !== null || child.signalCode !== null) {
				return;
			}
			child.kill("SIGTERM");
			child.unref();
			child.stdout.destroy();
			child.stderr.destroy();
			await new Promise<void>((resolve) => {
				let settled = false;
				let forceKillTimer: NodeJS.Timeout | null = null;
				let bailoutTimer: NodeJS.Timeout | null = null;
				const finish = () => {
					if (settled) {
						return;
					}
					settled = true;
					if (forceKillTimer !== null) {
						clearTimeout(forceKillTimer);
					}
					if (bailoutTimer !== null) {
						clearTimeout(bailoutTimer);
					}
					resolve();
				};
				child.once("exit", finish);
				forceKillTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
					}
				}, 2_000);
				bailoutTimer = setTimeout(finish, 5_000);
			});
		},
		notify,
		notifications,
		stderr: () => stderrBuffer,
	};
	harnesses.push(harness);
	return harness;
}

function createMockEnv(): Record<string, string> {
	return {
		OPENCODE_BIN: process.execPath,
		OPENCODE_ARGS: JSON.stringify([path.resolve("tests/fixtures/mock_opencode_acp.ts")]),
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void test("tools/list exposes only the public smart-agent tools", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/list")) as { tools: Array<{ name: string }> };
	assert.deepEqual(
		result.tools.map((tool) => tool.name),
		["start_agent", "resume_agent"],
	);
});

void test("initialize advertises prompt capability", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("initialize", {
		capabilities: {
			roots: {},
		},
		clientInfo: { name: "test-client", version: "0.0.0" },
		protocolVersion: "2025-06-18",
	})) as { capabilities?: Record<string, unknown> };
	assert.deepEqual(result.capabilities, {
		prompts: {},
		resources: {},
		tools: {},
	});
});

void test("prompts/list exposes the prompt template with no arguments", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("prompts/list")) as {
		prompts: Array<{
			arguments?: Array<{ name: string; required?: boolean }>;
			name: string;
			title?: string;
		}>;
	};
	assert.deepEqual(
		result.prompts.map((prompt) => prompt.name),
		[smartAgentPromptName],
	);
	assert.equal(result.prompts[0]?.title, "Prompt");
	assert.equal(result.prompts[0]?.arguments, undefined);
});

void test("prompts/get returns the prompt injection template", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("prompts/get", {
		name: smartAgentPromptName,
	})) as PromptGetResult;
	assert.match(result.description ?? "", /Instruction prefix/);
	assert.doesNotMatch(result.description ?? "", /next appended request/i);
	assert.equal(result.messages[0]?.role, "user");
	assert.equal(result.messages[0]?.content?.type, "text");
	const text = result.messages[0]?.content?.text ?? "";
	assert.match(text, /start a delegated workflow through the smart-agent MCP server/i);
	assert.match(text, /appended immediately after this instruction/i);
	assert.match(text, /start_agent/);
	assert.match(text, /resume_agent/);
	assert.match(text, /sessionId/);
	assert.match(text, /later related follow-up turns/i);
	assert.match(text, /even if this wrapper is not repeated/i);
	assert.match(text, /continue.*proceed.*revert that.*explain that change/i);
	assert.match(text, /different task, changes repo\/context, or explicitly says not to use the smart agent/i);
	assert.match(text, /ask instead of guessing/i);
});

void test("resources/list exposes a generic operational-guidelines resource", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("resources/list")) as { resources: Array<{ name: string; uri: string }> };
	assert.deepEqual(
		result.resources.map((resource) => resource.uri),
		[operationalGuidelinesUri],
	);
	assert.deepEqual(
		result.resources.map((resource) => resource.name),
		["smart-agent-operational-guidelines"],
	);
});

void test("resources/read returns the generic markdown guidelines", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("resources/read", {
		uri: operationalGuidelinesUri,
	})) as ResourceReadResult;
	const text = result.contents[0]?.text ?? "";
	assert.match(text, /Smart Agent Operational Guidelines/);
	assert.match(text, /Session Continuity/);
	assert.match(text, /strong start signal.*not the only valid continuation signal/i);
	assert.match(text, /prefer `resume_agent` for later related follow-up turns even if the wrapper is not repeated/i);
	assert.match(text, /newly learned local context/i);
	assert.match(text, /Incomplete Delegated Output/);
	assert.match(text, /bounded retry count/i);
	assert.match(text, /Do not silently switch to fully local execution/i);
	assert.match(text, /start_agent/);
	assert.doesNotMatch(text, /opencode/i);
	assert.match(text, /plain `message` field/);
});

void test("start_agent creates a session and returns streamed text plus structured session metadata", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-1",
		},
		arguments: {
			message: "Howdy!",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: ses_/);
	assert.match(result.content[0]?.text ?? "", /echo\(ses_/);
	assert.equal(typeof result.structuredContent?.sessionId, "string");
	assert.equal(result.structuredContent?.stopReason, "end_turn");
	assert.match(JSON.stringify(result.structuredContent?.text ?? ""), /Howdy!/);
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/progress") {
				return false;
			}
			const params = notification.params as { progress?: unknown; progressToken?: unknown; total?: unknown };
			return params.progress === 9 && params.progressToken === "progress-test-1" && params.total === 1050;
		}),
	);
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/message") {
				return false;
			}
			const params = notification.params as { data?: unknown };
			return typeof params.data === "string" && params.data.includes("Drafting a short reply (9K/1M)");
		}),
	);
});

void test("resume_agent reuses a provided session id", async () => {
	const harness = await createHarness(createMockEnv());
	const first = (await harness.call("tools/call", {
		arguments: {
			message: "first",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const firstSessionId = String(first.structuredContent?.sessionId);
	const second = (await harness.call("tools/call", {
		arguments: {
			sessionId: firstSessionId,
			message: "second",
		},
		name: "resume_agent",
	})) as ToolCallResult;
	assert.match(second.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(second.content[0]?.text ?? "", /#2: second/);
	assert.equal(second.structuredContent?.sessionId, firstSessionId);
});

void test("resume_agent still accepts the legacy session field as a compatibility fallback", async () => {
	const harness = await createHarness(createMockEnv());
	const first = (await harness.call("tools/call", {
		arguments: {
			message: "first",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const firstSessionId = String(first.structuredContent?.sessionId);
	const second = (await harness.call("tools/call", {
		arguments: {
			session: firstSessionId,
			message: "second",
		},
		name: "resume_agent",
	})) as ToolCallResult;
	assert.match(second.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(second.content[0]?.text ?? "", /#2: second/);
	assert.equal(second.structuredContent?.sessionId, firstSessionId);
});

void test("resume_agent reuses the session usage snapshot for progress notifications across separate calls", async () => {
	const harness = await createHarness(createMockEnv());
	const first = (await harness.call("tools/call", {
		arguments: {
			message: "first",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const sessionId = String(first.structuredContent?.sessionId);
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-resume-session-usage",
		},
		arguments: {
			sessionId,
			message: "zero usage only",
		},
		name: "resume_agent",
	});
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/progress") {
				return false;
			}
			const params = notification.params as {
				message?: unknown;
				progress?: unknown;
				progressToken?: unknown;
				total?: unknown;
			};
			return (
				params.progress === 9 &&
				params.progressToken === "progress-test-resume-session-usage" &&
				params.total === 1050 &&
				typeof params.message === "string"
			);
		}),
	);
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/message") {
				return false;
			}
			const params = notification.params as { data?: unknown };
			return typeof params.data === "string" && params.data.includes("9K/1M");
		}),
	);
});

void test("start_agent derives the session cwd from client roots when available", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///tmp/client-root",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /cwd\(ses_.*\)#1: \/tmp\/client-root/);
});

void test("start_agent prefers tool-call metadata when it points inside a different active workspace root", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo-a",
				uri: "file:///tmp/repo-a",
			},
			{
				name: "repo-b",
				uri: "file:///tmp/repo-b",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		_meta: {
			editor: {
				uri: "file:///tmp/repo-b/packages/app/src/example.ts",
			},
		},
		arguments: {
			message: "cwd please",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /cwd\(ses_.*\)#1: \/tmp\/repo-b/);
});

void test("start_agent normalizes Windows file roots to platform-appropriate filesystem paths", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///c%3A/Users/rt0/Documents/workspace/example-repo",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const expectedCwd =
		process.platform === "win32"
			? "[Cc]:\\\\Users\\\\rt0\\\\Documents\\\\workspace\\\\example-repo"
			: "/mnt/c/Users/rt0/Documents/workspace/example-repo";
	assert.match(
		result.content[0]?.text ?? "",
		process.platform === "win32" ? new RegExp(expectedCwd) : new RegExp(escapeRegex(expectedCwd)),
	);
});

void test("start_agent uses a neutral cwd for absolute-path tasks only when no client workspace context is available", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		initializeParams: {
			capabilities: {},
			clientInfo: { name: "test-client", version: "0.0.0" },
			protocolVersion: "2025-06-18",
		},
		rootsEntries: [],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please C:\\Users\\rt0\\.cursor\\skills",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegex(os.homedir())));
});

void test("start_agent keeps the triggering workspace cwd even if the prompt text mentions unrelated absolute paths", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///tmp/client-root",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please C:\\Users\\rt0\\.cursor\\skills",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /cwd\(ses_.*\)#1: \/tmp\/client-root/);
});

void test("start_agent ignores https URLs when deciding whether to neutralize cwd", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///tmp/client-root",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please and use docs at https://docs.convex.dev/cli",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /cwd\(ses_.*\)#1: \/tmp\/client-root/);
});

void test("start_agent does not neutralize cwd for forward-slash Windows paths that point inside the active workspace", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///mnt/c/Users/rt0/Documents/workspace/sybill/flamingo-dashboard",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "cwd please for c:/Users/rt0/Documents/workspace/sybill/flamingo-dashboard",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/cwd\(ses_.*\)#1: \/mnt\/c\/Users\/rt0\/Documents\/workspace\/sybill\/flamingo-dashboard/,
	);
});

void test("start_agent does not neutralize cwd for workspace prompts that contain regex-like slash text", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///mnt/c/Users/rt0/Documents/workspace/sybill/flamingo-dashboard",
			},
		],
	});
	const result = (await harness.call("tools/call", {
		arguments: {
			message:
				"cwd please for c:/Users/rt0/Documents/workspace/sybill/flamingo-dashboard and token `\\b_className\\b` only.",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/cwd\(ses_.*\)#1: \/mnt\/c\/Users\/rt0\/Documents\/workspace\/sybill\/flamingo-dashboard/,
	);
});

void test("resume_agent restores the workspace cwd after a prior neutral-cwd task in the same session", async () => {
	const harness = await createHarness({
		env: createMockEnv(),
		rootsEntries: [
			{
				name: "repo",
				uri: "file:///tmp/client-root",
			},
		],
	});
	const first = (await harness.call("tools/call", {
		arguments: {
			message: "verify C:\\Users\\rt0\\.cursor\\skills",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const sessionId = String(first.structuredContent?.sessionId);
	const second = (await harness.call("tools/call", {
		arguments: {
			sessionId: sessionId,
			message: "cwd please",
		},
		name: "resume_agent",
	})) as ToolCallResult;
	assert.equal(second.isError, undefined);
	assert.match(second.content[0]?.text ?? "", /cwd\(ses_.*\)#2: \/tmp\/client-root/);
});

void test("start_agent completes stalled ACP prompts by cancelling the idle tail after text has streamed", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "stall",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(result.content[0]?.text ?? "", /#1: stall/);
	assert.equal(result.structuredContent?.stopReason, "end_turn");
});

void test("start_agent waits for late response chunks that arrive after the prompt RPC resolves", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "late flush",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /#1: late flush \(tail\) done/);
	assert.equal(result.structuredContent?.stopReason, "end_turn");
});

void test("start_agent waits for a second assistant burst that arrives well after the prompt RPC resolves", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "multi burst",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /#1: multi burst first burst second burst/);
	assert.equal(result.structuredContent?.stopReason, "end_turn");
});

void test("start_agent does not cancel an active turn just because output goes quiet before the ACP prompt finishes", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "slow active turn",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /#1: slow active turn first phase final phase/);
	assert.equal(result.structuredContent?.stopReason, "end_turn");
});

void test("start_agent logs ACP metadata updates to stderr while keeping chunk updates suppressed", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "acp metadata sweep",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /metadata ok/);
	const stderr = harness.stderr();
	assert.doesNotMatch(stderr, /session\/update .*"sessionUpdate":"user_message_chunk"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"plan"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"available_commands_update"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"current_mode_update"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"config_option_update"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"session_info_update"/);
	assert.match(stderr, /session\/update .*"sessionUpdate":"usage_update"/);
});

void test("start_agent preserves assistant message boundaries by messageId while still returning a flat final text", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "message id split",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /first message second message/);
	const stderr = harness.stderr();
	assert.match(stderr, /messageIds":\["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"\]/);
});

void test("start_agent merges tool_call and tool_call_update activity by toolCallId before outward progress logging", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "tool call merge",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /merge ok/);
	assert.equal(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				((notification.params as { data?: string } | undefined)?.data ?? "") === "Tool: read schema (completed)",
		).length,
		1,
	);
	assert.match(harness.stderr(), /session\/update .*"sessionUpdate":"tool_call_update"/);
});

void test("start_agent retries once when ACP ends a turn with no text, thought, or tool calls", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "empty retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /empty retry/);
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned no output; retrying the same turn",
				),
		),
	);
});

void test("start_agent returns an explicit fallback message when ACP stays empty after retrying", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "empty forever",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/The smart agent completed the turn without returning any text after retrying the same prompt\./,
	);
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned no output after retrying the same turn",
				),
		),
	);
});

void test("start_agent surfaces backend stderr errors instead of returning the empty-turn fallback", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "backend stderr failure",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /OpenCode backend error:/);
	assert.match(result.content[0]?.text ?? "", /ProviderModelNotFoundError/);
	assert.match(result.content[0]?.text ?? "", /gpt-5\.4\/high/);
	assert.deepEqual(result.structuredContent, {
		error: {
			backend: "opencode",
			category: "backend_error",
			code: "ProviderModelNotFoundError",
			message:
				'OpenCode backend error:\nProviderModelNotFoundError: ProviderModelNotFoundError\n data: {\n  providerID: "openai",\n  modelID: "gpt-5.4/high",\n  suggestions: [],\n },',
			modelId: "gpt-5.4/high",
			providerId: "openai",
			retryable: false,
		},
	});
	assert.doesNotMatch(
		result.content[0]?.text ?? "",
		/The smart agent completed the turn without returning any text after retrying the same prompt\./,
	);
});

void test("resume_agent surfaces backend stderr errors instead of returning the empty-turn fallback", async () => {
	const harness = await createHarness(createMockEnv());
	const first = (await harness.call("tools/call", {
		arguments: {
			message: "first",
		},
		name: "start_agent",
	})) as ToolCallResult;
	const sessionId = String(first.structuredContent?.sessionId);
	const result = (await harness.call("tools/call", {
		arguments: {
			sessionId,
			message: "backend stderr failure",
		},
		name: "resume_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /OpenCode backend error:/);
	assert.match(result.content[0]?.text ?? "", /ProviderModelNotFoundError/);
	const structuredError = result.structuredContent?.error as
		| {
				backend?: unknown;
				category?: unknown;
				code?: unknown;
				modelId?: unknown;
				providerId?: unknown;
		  }
		| undefined;
	assert.equal(structuredError?.backend, "opencode");
	assert.equal(structuredError?.category, "backend_error");
	assert.equal(structuredError?.code, "ProviderModelNotFoundError");
	assert.equal(structuredError?.providerId, "openai");
	assert.equal(structuredError?.modelId, "gpt-5.4/high");
	assert.doesNotMatch(
		result.content[0]?.text ?? "",
		/The smart agent completed the turn without returning any text after retrying the same prompt\./,
	);
});

void test("start_agent ignores non-error backend stderr noise and still uses the empty-turn fallback", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "backend stderr noise",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/The smart agent completed the turn without returning any text after retrying the same prompt\./,
	);
	assert.doesNotMatch(result.content[0]?.text ?? "", /OpenCode backend error:/);
});

void test("start_agent continues the same prompt once when ACP ends on an interim progress answer", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "interim retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /Verified done\. \(1\) folders found: edge-remote-debugging-mcp/);
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		),
	);
	assert.match(harness.stderr(), /heuristic detected early end_turn/);
	assert.match(harness.stderr(), /"reason":"direct-progress"/);
});

void test("start_agent promotes progress-like assistant text into the live status summary", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		arguments: {
			message: "interim retry",
		},
		name: "start_agent",
	});
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				((notification.params as { data?: string } | undefined)?.data ?? "") ===
					"I’m checking the Windows-side skill directories and current junction state first.",
		),
	);
});

void test("progress notifications stay hidden until real usage arrives", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-pre-usage-message",
		},
		arguments: {
			message: "interim retry",
		},
		name: "start_agent",
	});
	const firstProgressNotification = harness.notifications.find(
		(notification) => notification.method === "notifications/progress",
	);
	assert.ok(firstProgressNotification);
	assert.deepEqual(firstProgressNotification?.params, {
		message: "Continuing same turn",
		progress: 15,
		progressToken: "progress-test-pre-usage-message",
		total: 1050,
	});
	assert.equal(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/progress" &&
				typeof (notification.params as { progress?: unknown } | undefined)?.progress === "number" &&
				((notification.params as { progress?: number }).progress ?? 0) < 1,
		),
		false,
	);
});

void test("progress notifications include the summary text without duplicating token counts", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-message-with-usage",
		},
		arguments: {
			message: "hello",
		},
		name: "start_agent",
	});
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/progress") {
				return false;
			}
			const params = notification.params as {
				message?: unknown;
				progress?: unknown;
				progressToken?: unknown;
				total?: unknown;
			};
			return (
				params.progress === 9 &&
				params.progressToken === "progress-test-message-with-usage" &&
				params.total === 1050 &&
				typeof params.message === "string" &&
				params.message === "Drafting a short reply"
			);
		}),
	);
});

void test("assistant progress summaries no longer reach progress notifications before real usage exists", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-chunk-stream",
		},
		arguments: {
			message: "progress chunk stream",
		},
		name: "start_agent",
	});
	const progressMessages = harness.notifications
		.filter((notification) => notification.method === "notifications/progress")
		.map((notification) => (notification.params as { message?: string } | undefined)?.message)
		.filter((message): message is string => typeof message === "string");
	assert.deepEqual(progressMessages, []);
});

void test("start_agent can continue the same prompt twice when interim answers keep ending early", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "interim retry multi",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /Verified done\. \(1\) folders found: edge-remote-debugging-mcp/);
	assert.ok(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		).length >= 2,
	);
});

void test("start_agent can continue through several interim turns before returning the final answer", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "interim retry long",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/Architectural summary: header routing is guarded centrally and the version-group logic is confirmed in the repository\./,
	);
	assert.ok(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		).length >= 3,
	);
});

void test("start_agent continues locating-style progress replies instead of returning them as final", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "locating retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/Done\. `_className` appears on two matching lines under the requested folder\./,
	);
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		),
	);
});

void test("start_agent continues found-next-checking and continuing-with progress replies before returning the final answer", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "wsl config discovery retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/Confirmed paths: Windows config at `C:\\Users\\rt0\\\.config\\opencode`, plus the Linux-side WSL XDG locations under `~\/\.config\/opencode`, `~\/\.local\/share\/opencode`, and `~\/\.cache\/opencode` when present\./,
	);
	assert.ok(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		).length >= 3,
	);
});

void test("start_agent continues an action request when the first reply is only a move-plan explanation", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "Move the code now. action plan retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /Done\. I moved the files and updated the imports\./);
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		),
	);
});

void test("start_agent continues explanation-style interim replies that say the agent is still locating or reading", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "path explanation retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /Done\. I updated the skill guidance after reading the repo copy\./);
	assert.ok(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		).length >= 2,
	);
});

void test("start_agent continues partial-findings interim replies that say the agent has data and is now checking more", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "have got then checking retry",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(
		result.content[0]?.text ?? "",
		/Done\. I updated the migration skill with the CLI workflow and the repo-specific purge order\./,
	);
	assert.ok(
		harness.notifications.filter(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes(
					"Agent returned an interim update; continuing the same turn",
				),
		).length >= 2,
	);
});

void test("progress notifications keep the last non-zero usage value when the backend emits a trailing zero update", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-usage-reset",
		},
		arguments: {
			message: "usage reset",
		},
		name: "start_agent",
	});
	const progressNotifications = harness.notifications
		.filter((notification) => notification.method === "notifications/progress")
		.map((notification) => notification.params as { progress?: unknown; progressToken?: unknown; total?: unknown });
	assert.ok(
		progressNotifications.some(
			(params) =>
				params.progress === 9 && params.progressToken === "progress-test-usage-reset" && params.total === 1050,
		),
	);
	assert.equal(progressNotifications.at(-1)?.progress, 9);
	assert.equal(progressNotifications.at(-1)?.total, 1050);
});

void test("usage messages use compact token suffixes inside the combined progress summary", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		arguments: {
			message: "hello",
		},
		name: "start_agent",
	});
	assert.ok(
		harness.notifications.some(
			(notification) =>
				notification.method === "notifications/message" &&
				typeof (notification.params as { data?: unknown } | undefined)?.data === "string" &&
				((notification.params as { data?: string }).data ?? "").includes("Drafting a short reply (9K/1M)"),
		),
	);
});

void test("progress notifications stay hidden when the backend never reports meaningful usage", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		_meta: {
			progressToken: "progress-test-zero-only",
		},
		arguments: {
			message: "zero usage only",
		},
		name: "start_agent",
	});
	assert.equal(
		harness.notifications.some((notification) => notification.method === "notifications/progress"),
		false,
	);
});

void test("assistant text is surfaced progressively through message notifications", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		arguments: {
			message: "multi burst",
		},
		name: "start_agent",
	});
	assert.ok(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/message") {
				return false;
			}
			const params = notification.params as { data?: unknown };
			return typeof params.data === "string" && params.data.includes("Answer: echo(");
		}),
	);
});

void test("path-like completed tool labels stay hidden in progress notifications", async () => {
	const harness = await createHarness(createMockEnv());
	await harness.call("tools/call", {
		arguments: {
			message: "noisy tool label",
		},
		name: "start_agent",
	});
	assert.equal(
		harness.notifications.some((notification) => {
			if (notification.method !== "notifications/message") {
				return false;
			}
			const params = notification.params as { data?: unknown };
			return typeof params.data === "string" && params.data.includes("Tool: mnt/c/Users/rt0/.cursor/skills");
		}),
		false,
	);
});

void test("start_agent accepts chat-style role/content arrays as a compatibility fallback", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			input: [{ content: "compat hello", role: "user" }],
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(result.content[0]?.text ?? "", /compat hello/);
});

void test("prompts/get rejects unknown prompt names", async () => {
	const harness = await createHarness(createMockEnv());
	await assert.rejects(
		() =>
			harness.call("prompts/get", {
				arguments: {
					message: "hello",
				},
				name: "missing_prompt",
			}),
		/Unknown prompt missing_prompt/,
	);
});

void test("prompts/get ignores extra arguments for the prompt template", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("prompts/get", {
		arguments: {
			message: "ignored",
		},
		name: smartAgentPromptName,
	})) as PromptGetResult;
	assert.equal(result.messages[0]?.content?.type, "text");
});

void test("tools/call rejects unknown tool names", async () => {
	const harness = await createHarness(createMockEnv());
	await assert.rejects(
		() =>
			harness.call("tools/call", {
				arguments: {},
				name: "missing_tool",
			}),
		/Unknown tool missing_tool/,
	);
});

void test("start_agent rejects malformed input", async () => {
	const harness = await createHarness(createMockEnv());
	const result = (await harness.call("tools/call", {
		arguments: {
			message: "",
		},
		name: "start_agent",
	})) as ToolCallResult;
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /non-empty message string/);
});

void test("loadOpenCodeConfig reads new OpenCode env vars", () => {
	const config = loadOpenCodeConfig({
		OPENCODE_ARGS: JSON.stringify(["acp", "--cwd", "/tmp/project"]),
		OPENCODE_BIN: "/custom/opencode",
	});
	assert.equal(config.innerCommand, "/custom/opencode");
	assert.deepEqual(config.innerArgs, ["acp", "--cwd", "/tmp/project"]);
});

void test("createOpenCodeSpawnSpec wraps .cmd launchers on Windows", () => {
	const spec = createOpenCodeSpawnSpec("C:\\Tools\\opencode.cmd", ["acp"], {
		comSpec: "cmd.exe",
		platform: "win32",
	});
	assert.equal(spec.command, "cmd.exe");
	assert.deepEqual(spec.args, ["/d", "/s", "/c", "C:\\Tools\\opencode.cmd acp"]);
});

void test("resolveOpenCodeLaunch falls back to Windows pnpm installs when PATH lookup fails", () => {
	const resolved = resolveOpenCodeLaunch("opencode", ["acp"], {
		env: { USERPROFILE: "C:\\Users\\rt0" },
		pathExists: (candidate) => candidate === "C:\\Users\\rt0\\AppData\\Local\\pnpm\\opencode.cmd",
		pathLookup: () => null,
		platform: "win32",
	});
	assert.deepEqual(resolved, {
		command: "C:\\Users\\rt0\\AppData\\Local\\pnpm\\opencode.cmd",
		args: ["acp"],
	});
});

void test("resolveOpenCodeLaunch prefers a native PATH match on Windows", () => {
	const resolved = resolveOpenCodeLaunch("opencode", ["acp"], {
		pathLookup: () => "C:\\Tools\\opencode.cmd",
		pathExists: (candidate) => candidate === "C:\\Tools\\opencode.cmd",
		platform: "win32",
	});
	assert.deepEqual(resolved, {
		command: "C:\\Tools\\opencode.cmd",
		args: ["acp"],
	});
});

void test("resolveOpenCodeLaunch skips Windows WSL wrapper shims and keeps searching for native installs", () => {
	const resolved = resolveOpenCodeLaunch("opencode", ["acp"], {
		env: { USERPROFILE: "C:\\Users\\rt0" },
		pathExists: (candidate) =>
			candidate === "C:\\Users\\rt0\\.opencode\\bin\\opencode.cmd" ||
			candidate === "C:\\Users\\rt0\\AppData\\Local\\pnpm\\opencode.cmd",
		pathLookup: () => "C:\\Users\\rt0\\.opencode\\bin\\opencode.cmd",
		pathReadText: (candidate) =>
			candidate === "C:\\Users\\rt0\\.opencode\\bin\\opencode.cmd"
				? "@echo off\r\nwsl.exe bash -lic 'exec opencode \"$@\"' _ %*\r\n"
				: null,
		pathRealpath: () => null,
		platform: "win32",
	});
	assert.deepEqual(resolved, {
		command: "C:\\Users\\rt0\\AppData\\Local\\pnpm\\opencode.cmd",
		args: ["acp"],
	});
});

void test("resolveOpenCodeLaunch still honors explicit Windows command paths", () => {
	const resolved = resolveOpenCodeLaunch("C:\\Tools\\opencode.cmd", ["acp"], {
		pathExists: (candidate) => candidate === "C:\\Tools\\opencode.cmd",
		platform: "win32",
	});
	assert.deepEqual(resolved, {
		command: "C:\\Tools\\opencode.cmd",
		args: ["acp"],
	});
});

void test("convertWindowsPathToWsl converts Windows drive paths to /mnt paths", () => {
	assert.equal(
		convertWindowsPathToWsl("C:\\Users\\rt0\\Documents\\workspace\\rt0\\yolo-codex-mcp"),
		"/mnt/c/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp",
	);
});

void test("normalizeSessionCwd rewrites Windows cwd values when the runtime is launched through WSL", () => {
	assert.equal(
		normalizeSessionCwd("C:\\Users\\rt0\\Documents\\workspace\\rt0\\yolo-codex-mcp", true),
		"/mnt/c/Users/rt0/Documents/workspace/rt0/yolo-codex-mcp",
	);
	assert.equal(
		normalizeSessionCwd("C:\\Users\\rt0\\Documents\\workspace\\rt0\\yolo-codex-mcp", false),
		"C:\\Users\\rt0\\Documents\\workspace\\rt0\\yolo-codex-mcp",
	);
});

void test("real runtime smoke test initializes and serves the public smart-agent surface", async (context) => {
	let harness: Harness;
	try {
		harness = await createHarness({
			__USE_PARENT_ENV__: "1",
		});
	} catch (error) {
		context.skip(`Skipping real runtime smoke test: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const tools = (await harness.call("tools/list")) as { tools: Array<{ name: string }> };
	assert.deepEqual(
		tools.tools.map((tool) => tool.name),
		["start_agent", "resume_agent"],
	);
	const prompts = (await harness.call("prompts/list")) as { prompts: Array<{ name: string }> };
	assert.deepEqual(
		prompts.prompts.map((prompt) => prompt.name),
		[smartAgentPromptName],
	);
	const resources = (await harness.call("resources/list")) as { resources: Array<{ uri: string }> };
	assert.deepEqual(
		resources.resources.map((resource) => resource.uri),
		[operationalGuidelinesUri],
	);

	const run = (await harness.call("tools/call", {
		arguments: {
			message: "Reply with exactly: MCP_OK",
		},
		name: "start_agent",
	})) as ToolCallResult;
	if (run.isError) {
		await harness.close();
		context.skip(`Skipping real runtime smoke test: ${run.content[0]?.text ?? "unknown runtime error"}`);
		return;
	}
	assert.equal(run.isError, undefined);
	const responseText = run.content[0]?.text ?? "";
	assert.match(responseText, /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.equal(typeof run.structuredContent?.sessionId, "string");
});

void test("real runtime e2e flow supports start_agent followed by resume_agent", async (context) => {
	if (process.env.RUN_REAL_E2E !== "1") {
		context.skip("Skipping extended real runtime e2e flow. Set RUN_REAL_E2E=1 to enable it.");
		return;
	}

	let harness: Harness;
	try {
		harness = await createHarness({
			__USE_PARENT_ENV__: "1",
		});
	} catch (error) {
		context.skip(`Skipping real runtime e2e flow: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const first = (await harness.call("tools/call", {
		arguments: {
			message: "Reply with exactly: E2E_START_OK",
		},
		name: "start_agent",
	})) as ToolCallResult;
	if (first.isError) {
		await harness.close();
		context.skip(`Skipping extended real runtime e2e flow: ${first.content[0]?.text ?? "unknown runtime error"}`);
		return;
	}
	assert.equal(first.isError, undefined);
	assert.match(first.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(first.content[0]?.text ?? "", /E2E_START_OK/);

	const rawSessionId = first.structuredContent?.sessionId;
	assert.equal(typeof rawSessionId, "string");
	const sessionId = rawSessionId as string;
	assert.match(sessionId, /^.+$/);

	const second = (await harness.call("tools/call", {
		arguments: {
			sessionId: sessionId,
			message: "Reply with exactly: E2E_RESUME_OK",
		},
		name: "resume_agent",
	})) as ToolCallResult;
	assert.equal(second.isError, undefined);
	assert.match(second.content[0]?.text ?? "", /\n\n\nsessionID, \*use it to resume the conversation\*: /);
	assert.match(second.content[0]?.text ?? "", /E2E_RESUME_OK/);
	assert.equal(second.structuredContent?.sessionId, sessionId);
});
