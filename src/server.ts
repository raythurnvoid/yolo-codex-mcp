import process from "node:process";

import {
	createClientWorkspaceState,
	fileUriToFilesystemPath,
	getKnownWorkspacePaths,
	maybeOverrideToolCallCwd,
	resolveClientDerivedCwd,
	resolveToolCallCwd,
	summarizeWorkspaceEntries,
	type ClientWorkspaceEntry,
	type ClientWorkspaceState,
} from "./cwd_policy.ts";
import type { TurnTranscript } from "./acp_runtime.ts";
import { createProgressContext, createRuntimeObserver, startToolHeartbeat, type ProgressContext } from "./progress.ts";

const serverInfo = {
	name: "smart-agent-mcp",
	version: "0.0.2",
};
const protocolVersion = "2025-06-18";
const operationalGuidelinesUri = "smart-agent://guides/operational-guidelines.md";
const smartAgentPromptName = "prompt";
const operationalGuidelinesText = [
	"# Smart Agent Operational Guidelines",
	"",
	"You are an LLM calling another LLM through this MCP server.",
	"",
	"## Core Rules",
	"",
	"- Use `start_agent` to begin a new conversation turn.",
	"- Use `resume_agent` with the returned `sessionId` to continue an existing conversation.",
	"- Put the full user-facing prompt in the plain `message` field.",
	"- Do not assume the smart agent can see your surrounding conversation, system prompt, tool results, or private chain-of-thought.",
	"- The smart agent only receives the content you send through this MCP call plus its own prior session history.",
	"- If the smart agent needs context that you already know, include that context explicitly in the `message` prompt for that turn.",
	"- When resuming a session, restate any important constraints, goals, files, paths, or facts that are required for a correct answer.",
	"- The server converts the public `message` input into the backend message format internally.",
	"- The backend model is fixed by the server and cannot be selected through this MCP surface.",
	"",
	"## Session Continuity",
	"",
	"- Treat a prompt-wrapper turn as the start of a delegated workflow, not as a single-turn special case.",
	"- Prompt-wrapper presence is a strong start signal for delegation, but it is not the only valid continuation signal.",
	"- If a delegated turn returns a `sessionId`, carry that `sessionId` forward and prefer `resume_agent` for later related follow-up turns even if the wrapper is not repeated.",
	"- Treat messages such as `continue`, `proceed`, `revert that`, `explain that change`, and similar same-task follow-ups as part of the same delegated workflow when the task context still matches.",
	"- Treat clearly different requests, repo/context switches, or explicit user opt-outs from delegation as reasons to stop reusing the current delegated session.",
	"- If it is unclear whether a later user turn is still part of the same delegated workflow, ask instead of guessing.",
	"- When resuming a delegated workflow, restate any newly learned local context or constraints that the smart agent needs for the next turn.",
	"",
	"## Incomplete Delegated Output",
	"",
	"- If `resume_agent` returns only interim progress, status text, or another incomplete answer that does not contain the requested artifact, continue or retry the same delegated session with a bounded retry count.",
	"- If the delegated run is still incomplete after those bounded retries, surface that the delegated run did not produce the requested result.",
	"- Do not silently switch to fully local execution as if the delegated run had already succeeded.",
].join("\n");

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string | null;
type JsonRpcError = {
	code: number;
	message: string;
};
type AgentTurnResult = {
	sessionId: string;
	stopReason: string | null;
	text: string;
	thought: string;
	transcript?: TurnTranscript;
	toolCalls: number;
};
type JsonRpcRequest = {
	error?: JsonRpcError;
	id?: JsonRpcId;
	jsonrpc?: string;
	method?: string;
	params?: unknown;
	result?: unknown;
};
type PendingWorkspaceRequest = {
	done: Promise<void>;
	method: "roots/list";
	reason: string;
	resolve: () => void;
};
type AgentToolArgs = {
	cwd: string;
	input: unknown[];
	sessionId?: string;
};
const MAX_EMPTY_TURN_RETRIES = 1;
const MAX_INTERIM_TURN_RETRIES = 6;

let runtimeModulePromise: Promise<typeof import("./acp_runtime.ts")> | null = null;
let runtimeInstancePromise: Promise<import("./acp_runtime.ts").OpenCodeAcpRuntime> | null = null;
let shutdownPromise: Promise<void> | null = null;
const clientWorkspaceState = createClientWorkspaceState();
const pendingWorkspaceRequests = new Map<string, PendingWorkspaceRequest>();
let nextServerRequestId = 0;
const ROOTS_REQUEST_WAIT_MS = 750;

function infoLog(message: string): void {
	process.stderr.write(`[smart-agent-mcp] ${message}\n`);
}

function debugLog(message: string): void {
	if (process.env.DEBUG_SMART_AGENT_MCP !== "1") {
		return;
	}
	infoLog(message);
}

async function getRuntime(): Promise<import("./acp_runtime.ts").OpenCodeAcpRuntime> {
	if (runtimeInstancePromise !== null) {
		return await runtimeInstancePromise;
	}
	runtimeInstancePromise = (async () => {
		infoLog("loading agent runtime module");
		runtimeModulePromise ??= import("./acp_runtime.ts");
		const { OpenCodeAcpRuntime } = await runtimeModulePromise;
		const runtime = new OpenCodeAcpRuntime();
		infoLog("starting agent runtime");
		await runtime.start();
		infoLog("agent runtime ready");
		return runtime;
	})();
	try {
		return await runtimeInstancePromise;
	} catch (error) {
		runtimeInstancePromise = null;
		throw error;
	}
}

async function restartRuntime(): Promise<import("./acp_runtime.ts").OpenCodeAcpRuntime> {
	infoLog("restarting agent runtime");
	if (runtimeInstancePromise !== null) {
		const runtime = await runtimeInstancePromise.catch(() => null);
		runtimeInstancePromise = null;
		await runtime?.close().catch(() => {});
	}
	return await getRuntime();
}

function warmRuntimeInBackground(): void {
	void getRuntime().catch((error) => {
		debugLog(`runtime warmup failed: ${error instanceof Error ? error.message : String(error)}`);
	});
}

function formatResult(result: AgentTurnResult) {
	const text = `${result.text}\n\nsessionId: ${result.sessionId}`;
	return {
		content: [
			{
				text,
				type: "text",
			},
		],
		structuredContent: {
			sessionId: result.sessionId,
			stopReason: result.stopReason,
			text: result.text,
			thought: result.thought,
			toolCalls: result.toolCalls,
		},
	};
}

function formatErrorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [
			{
				text: message,
				type: "text",
			},
		],
		isError: true,
		structuredContent: {
			error: buildStructuredToolError(message, error),
		},
	};
}

function buildStructuredToolError(message: string, error: unknown) {
	const providerId = readNamedStringField(message, "providerID");
	const modelId = readNamedStringField(message, "modelID");
	const code = readLeadingErrorCode(message) ?? (error instanceof Error && error.name ? error.name : "ToolError");
	const category = message.startsWith("OpenCode backend error:") ? "backend_error" : "tool_error";
	return {
		backend: category === "backend_error" ? "opencode" : "smart-agent-mcp",
		category,
		code,
		message,
		modelId,
		providerId,
		retryable: false,
	};
}

function readLeadingErrorCode(message: string): string | null {
	const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
	const match = firstLine.match(/^([A-Za-z][A-Za-z0-9]+Error)(?::|\b)/);
	if (match) {
		return match[1];
	}
	const laterMatch = message.match(/\b([A-Za-z][A-Za-z0-9]+Error)(?::|\b)/);
	return laterMatch?.[1] ?? null;
}

function readNamedStringField(message: string, fieldName: string): string | null {
	const match = message.match(new RegExp(`${fieldName}:\\s*"([^"]+)"`));
	return match?.[1] ?? null;
}

function createToolDefinitions() {
	return [
		{
			description:
				"Starts a new smart-agent conversation turn from a plain text prompt and returns text plus structured session metadata.",
			inputSchema: {
				properties: {
					message: {
						description: "Full prompt to send to the smart agent for this turn.",
						type: "string",
					},
				},
				required: ["message"],
				type: "object",
			},
			name: "start_agent",
			title: "Start Agent",
		},
		{
			description: "Continues an existing smart-agent conversation using a previous sessionId and a plain text prompt.",
			inputSchema: {
				properties: {
					message: {
						description: "Full follow-up prompt to send to the existing smart-agent session.",
						type: "string",
					},
					sessionId: {
						description: "Session identifier returned by a previous start_agent or resume_agent call.",
						type: "string",
					},
				},
				required: ["sessionId", "message"],
				type: "object",
			},
			name: "resume_agent",
			title: "Resume Agent",
		},
	];
}

function createPromptDefinitions() {
	return [
		{
			description:
				"Instruction prefix that starts a delegated smart-agent workflow for the appended request and prefers the returned sessionId for later related follow-up turns.",
			name: smartAgentPromptName,
			title: "Prompt",
		},
	];
}

function createResourceDefinition() {
	return {
		description:
			"Operational guidance for LLM callers using the smart-agent MCP surface, including the requirement to pass all necessary context in each prompt.",
		mimeType: "text/markdown",
		name: "smart-agent-operational-guidelines",
		title: "Smart Agent Operational Guidelines",
		uri: operationalGuidelinesUri,
	};
}

function createSmartAgentPromptResult() {
	return {
		description:
			"Instruction prefix for starting a delegated smart-agent workflow and preferring session reuse for later related follow-up turns.",
		messages: [
			{
				content: {
					text: [
						"The user is asking you to start a delegated workflow through the smart-agent MCP server instead of handling this request directly yourself.",
						"The user's real request will be appended immediately after this instruction in the same message.",
						"Treat the text that follows as the prompt to send to `start_agent` in the `message` field for the first delegated turn.",
						"If that delegated turn returns a `sessionId`, prefer `resume_agent` with that same `sessionId` for later related follow-up turns even if this wrapper is not repeated.",
						"Treat messages like `continue`, `proceed`, `revert that`, `explain that change`, and similar same-task follow-ups as part of the same delegated workflow when the task context still matches.",
						"Stop reusing the delegated session when the user clearly starts a different task, changes repo/context, or explicitly says not to use the smart agent.",
						"If you are unsure whether a later follow-up is still part of the same delegated workflow, ask instead of guessing.",
						"",
						"Use the smart agent for work such as analysis, editing content, writing, planning, brainstorming, and similar delegated tasks.",
					].join("\n"),
					type: "text",
				},
				role: "user",
			},
		],
	};
}

function sendJson(message: JsonObject): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNotification(method: string, params: JsonObject): void {
	if (method === "notifications/message") {
		const data =
			typeof params.data === "string" ? params.data : params && typeof params === "object" ? String(params.data) : null;
		if (data !== null && shouldLogNotificationMessage(data)) {
			infoLog(`emit notifications/message text=${formatLogValue(data, 100)}`);
		}
	}
	if (method === "notifications/progress") {
		const progress = typeof params.progress === "number" ? params.progress : null;
		const total = typeof params.total === "number" ? params.total : null;
		if (progress !== null && total !== null) {
			infoLog(`emit notifications/progress ${progress}/${total}`);
		}
	}
	sendJson({
		jsonrpc: "2.0",
		method,
		params,
	});
}

function sendResult(id: JsonRpcId, result: JsonObject, options: { log?: boolean } = {}): void {
	const preview =
		typeof result.content === "object" &&
		result.content &&
		Array.isArray(result.content) &&
		result.content[0] &&
		typeof result.content[0] === "object" &&
		!Array.isArray(result.content[0]) &&
		typeof (result.content[0] as { text?: unknown }).text === "string"
			? ((result.content[0] as { text: string }).text ?? "")
			: null;
	if (options.log && preview !== null) {
		infoLog(`send result id=${String(id)} text=${formatLogValue(preview, 100)}`);
	} else if (options.log) {
		infoLog(`send result id=${String(id)}`);
	}
	sendJson({
		id,
		jsonrpc: "2.0",
		result,
	});
}

function shouldLogNotificationMessage(message: string): boolean {
	if (message === "Agent turn still running") {
		return false;
	}
	if (message.startsWith("Agent turn still running (")) {
		return false;
	}
	if (message.startsWith("Tool: ")) {
		return /(failed|completed)\)$/.test(message);
	}
	return true;
}

function sendError(id: JsonRpcId, code: number, message: string): void {
	sendJson({
		error: {
			code,
			message,
		},
		id,
		jsonrpc: "2.0",
	});
}

async function executeAgentToolCall(options: {
	args: AgentToolArgs;
	id: JsonRpcId;
	progressSource: unknown;
	requestLogDetail: string;
	runEmptyRecoveryTurn?: (
		runtime: import("./acp_runtime.ts").OpenCodeAcpRuntime,
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	runContinueTurn: (
		runtime: import("./acp_runtime.ts").OpenCodeAcpRuntime,
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	runInitialTurn: (
		runtime: import("./acp_runtime.ts").OpenCodeAcpRuntime,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	runRetryTurn: (
		runtime: import("./acp_runtime.ts").OpenCodeAcpRuntime,
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	toolName: "resume_agent" | "start_agent";
}): Promise<void> {
	infoLog(`${options.toolName} requested ${options.requestLogDetail}`);
	const progress = createProgressContext({
		infoLog,
		sendNotification,
		value: options.progressSource,
	});
	const heartbeat = startToolHeartbeat(progress, "Waiting for agent output");
	try {
		progress.logMessage(`${options.toolName} running`);
		progress.setPhaseSummary("Initializing agent runtime");
		const runtime = await getRuntime();
		progress.setPhaseSummary("Waiting for agent output");
		const result = await runAgentToolTurn({
			args: options.args,
			progress,
			runEmptyRecoveryTurn: options.runEmptyRecoveryTurn
				? (previousResult, observer) => options.runEmptyRecoveryTurn!(runtime, previousResult, observer)
				: undefined,
			runContinueTurn: (previousResult, observer) => options.runContinueTurn(runtime, previousResult, observer),
			runInitialTurn: (observer) => options.runInitialTurn(runtime, observer),
			runRetryTurn: (previousResult, observer) => options.runRetryTurn(runtime, previousResult, observer),
		});
		progress.logMessage("Agent turn completed");
		infoLog(
			`${options.toolName} completed session=${result.sessionId} stopReason=${result.stopReason ?? "null"} textBytes=${Buffer.byteLength(result.text, "utf8")}`,
		);
		sendResult(options.id, formatResult(result), { log: true });
	} finally {
		heartbeat.stop();
	}
}

async function handleMessage(message: JsonRpcRequest): Promise<void> {
	observeClientWorkspaceMessage(message, clientWorkspaceState);

	if ((message.result !== undefined || message.error !== undefined) && message.method === undefined) {
		const handledWorkspaceResponse = handleWorkspaceResponse(message);
		if (handledWorkspaceResponse) {
			return;
		}
		return;
	}

	const method = message.method;
	const id = message.id ?? null;
	if (!method) {
		sendError(id, -32600, "Invalid request");
		return;
	}

	try {
		switch (method) {
			case "initialize":
				infoLog("initialize request received");
				sendResult(id, {
					capabilities: {
						prompts: {},
						resources: {},
						tools: {},
					},
					instructions:
						"Use the `prompt` prompt for delegation guidance, `start_agent` to begin, and `resume_agent` to continue with the returned `sessionId`.",
					protocolVersion,
					serverInfo,
				});
				logWorkspaceSnapshot("initialize", clientWorkspaceState);
				return;
			case "ping":
				sendResult(id, {});
				return;
			case "tools/list":
				warmRuntimeInBackground();
				sendResult(id, {
					tools: createToolDefinitions(),
				});
				return;
			case "prompts/list":
				sendResult(id, {
					prompts: createPromptDefinitions(),
				});
				return;
			case "prompts/get": {
				const params = parsePromptGetParams(message.params);
				if (params.name !== smartAgentPromptName) {
					sendError(id, -32602, `Unknown prompt ${params.name}`);
					return;
				}
				sendResult(id, createSmartAgentPromptResult());
				return;
			}
			case "resources/list":
				warmRuntimeInBackground();
				sendResult(id, {
					resources: [createResourceDefinition()],
				});
				return;
			case "resources/read": {
				warmRuntimeInBackground();
				const params = parseReadResourceParams(message.params);
				if (params.uri !== operationalGuidelinesUri) {
					sendError(id, -32602, `Unknown resource ${params.uri}`);
					return;
				}
				sendResult(id, {
					contents: [
						{
							mimeType: "text/markdown",
							text: operationalGuidelinesText,
							uri: operationalGuidelinesUri,
						},
					],
				});
				return;
			}
			case "tools/call": {
				const params = parseToolCallParams(message.params);
				await maybeRequestClientRoots("tools/call");
				const resolvedCwd = resolveToolCallCwd(clientWorkspaceState, params.meta);
				const effectiveCwd = maybeOverrideToolCallCwd(
					params.arguments,
					resolvedCwd.cwd,
					getKnownWorkspacePaths(clientWorkspaceState),
					{
						allowNeutralization: resolvedCwd.source === "process.cwd()",
					},
				);
				if (effectiveCwd.reason) {
					infoLog(
						`cwd override applied reason=non-workspace-absolute-path-task from=${resolvedCwd.cwd} to=${effectiveCwd.cwd}`,
					);
				} else if (effectiveCwd.absolutePaths.length > 0 && !effectiveCwd.neutralizationAllowed) {
					infoLog(
						`cwd override skipped reason=trusted-workspace-context source=${resolvedCwd.source} cwd=${resolvedCwd.cwd} paths=${formatLogValue(
							effectiveCwd.absolutePaths,
							180,
						)}`,
					);
				}
				logToolCallCwdDecision(
					id,
					params.name,
					{
						...resolvedCwd,
						cwd: effectiveCwd.cwd,
						detail: effectiveCwd.reason ? `${resolvedCwd.detail}; ${effectiveCwd.reason}` : resolvedCwd.detail,
					},
					clientWorkspaceState,
					params.meta,
				);
				if (params.name === "start_agent") {
					const args = parseStartAgentArgs(params.arguments, effectiveCwd.cwd);
					await executeAgentToolCall({
						args,
						id,
						progressSource: message.params,
						requestLogDetail: `textParts=${args.input.length}`,
						runContinueTurn: (runtime, previousResult, observer) =>
							runtime.resumeAgent(
								{
									cwd: args.cwd,
									input: args.input,
									session: previousResult.sessionId,
								},
								observer,
							),
						runInitialTurn: (runtime, observer) => runtime.startAgent(args, observer),
						runEmptyRecoveryTurn: async (_runtime, _previousResult, observer) => {
							infoLog("empty turn recovery restarting runtime before final start_agent attempt");
							const freshRuntime = await restartRuntime();
							return await freshRuntime.startAgent(args, observer);
						},
						runRetryTurn: (runtime, _previousResult, observer) => runtime.startAgent(args, observer),
						toolName: "start_agent",
					});
					return;
				}
				if (params.name === "resume_agent") {
					const args = parseResumeAgentArgs(params.arguments, effectiveCwd.cwd);
					await executeAgentToolCall({
						args,
						id,
						progressSource: message.params,
						requestLogDetail: `sessionId=${args.sessionId} textParts=${args.input.length}`,
						runContinueTurn: (runtime, previousResult, observer) =>
							runtime.resumeAgent(
								{
									cwd: args.cwd,
									input: args.input,
									session: previousResult.sessionId,
								},
								observer,
							),
						runInitialTurn: (runtime, observer) => runtime.resumeAgent(args, observer),
						runRetryTurn: (runtime, _previousResult, observer) => runtime.resumeAgent(args, observer),
						toolName: "resume_agent",
					});
					return;
				}
				sendError(id, -32602, `Unknown tool ${params.name}`);
				return;
			}
			case "notifications/initialized":
				warmRuntimeInBackground();
				await maybeRequestClientRoots("notifications/initialized");
				return;
			default:
				sendError(id, -32601, `Method ${method} not found`);
				return;
		}
	} catch (error) {
		infoLog(`${method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		if (method === "tools/call") {
			sendResult(id, formatErrorResult(error));
			return;
		}
		sendError(id, -32603, error instanceof Error ? error.message : String(error));
	}
}

function handleWorkspaceResponse(message: JsonRpcRequest): boolean {
	const idKey = jsonRpcIdKey(message.id ?? null);
	const pendingWorkspaceRequest = pendingWorkspaceRequests.get(idKey);
	if (!pendingWorkspaceRequest) {
		return false;
	}
	pendingWorkspaceRequests.delete(idKey);
	if (message.error) {
		clientWorkspaceState.rootsRequested = false;
		pendingWorkspaceRequest.resolve();
		infoLog(
			`client roots request failed reason=${pendingWorkspaceRequest.reason} error=${formatLogValue(message.error.message, 120)}`,
		);
		return true;
	}
	if (pendingWorkspaceRequest.method === "roots/list") {
		observeWorkspaceRequestResult(message.result, clientWorkspaceState, pendingWorkspaceRequest.method);
		logWorkspaceSnapshot(pendingWorkspaceRequest.method, clientWorkspaceState, {
			reason: pendingWorkspaceRequest.reason,
			status: "completed",
		});
	}
	pendingWorkspaceRequest.resolve();
	return true;
}

function observeClientWorkspaceMessage(message: JsonRpcRequest, state: ClientWorkspaceState): void {
	if (message.method === "initialize") {
		state.rootsAdvertised = detectClientRootsSupport(message.params);
		replaceWorkspaceEntries(state, "initializeEntries", extractClientWorkspaceEntries(message.params, "initialize"));
		return;
	}

	if (message.method === "workspace/didChangeWorkspaceFolders") {
		const change = extractWorkspaceFolderChange(message.params, message.method);
		if (change.added.length === 0 && change.removed.length === 0) {
			return;
		}
		state.workspaceEntries = applyWorkspaceFolderChange(state.workspaceEntries, change.added, change.removed);
		logWorkspaceSnapshot(message.method, state, {
			added: summarizeWorkspaceEntries(change.added),
			removed: summarizeWorkspaceEntries(change.removed),
		});
		return;
	}

	if (typeof message.method === "string" && message.method.startsWith("workspace/")) {
		const entries = extractClientWorkspaceEntries(message.params, message.method);
		if (entries.length === 0) {
			return;
		}
		replaceWorkspaceEntries(state, "workspaceEntries", entries);
		logWorkspaceSnapshot(message.method, state);
	}
}

function observeWorkspaceRequestResult(
	result: unknown,
	state: ClientWorkspaceState,
	source: "roots/list",
): ClientWorkspaceEntry[] {
	const entries = extractClientWorkspaceEntries(result, source);
	replaceWorkspaceEntries(state, "rootsEntries", entries);
	return entries;
}

function replaceWorkspaceEntries(
	state: ClientWorkspaceState,
	key: "initializeEntries" | "rootsEntries" | "workspaceEntries",
	entries: ClientWorkspaceEntry[],
): void {
	state[key] = dedupeWorkspaceEntries(entries);
}

function applyWorkspaceFolderChange(
	currentEntries: ClientWorkspaceEntry[],
	addedEntries: ClientWorkspaceEntry[],
	removedEntries: ClientWorkspaceEntry[],
): ClientWorkspaceEntry[] {
	const nextEntries = [...currentEntries];
	for (const removedEntry of removedEntries) {
		for (let index = nextEntries.length - 1; index >= 0; index -= 1) {
			if (workspaceEntriesMatch(nextEntries[index], removedEntry)) {
				nextEntries.splice(index, 1);
			}
		}
	}
	return dedupeWorkspaceEntries([...nextEntries, ...addedEntries]);
}

function workspaceEntriesMatch(left: ClientWorkspaceEntry, right: ClientWorkspaceEntry): boolean {
	if (left.uri !== null && right.uri !== null) {
		return left.uri === right.uri;
	}
	if (left.path !== null && right.path !== null) {
		return left.path === right.path;
	}
	return false;
}

function dedupeWorkspaceEntries(entries: ClientWorkspaceEntry[]): ClientWorkspaceEntry[] {
	const deduped: ClientWorkspaceEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.uri ?? ""}\u0000${entry.path ?? ""}\u0000${entry.name ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}

function detectClientRootsSupport(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.capabilities)) {
		return false;
	}
	return isRecord(value.capabilities.roots);
}

function extractWorkspaceFolderChange(
	value: unknown,
	source: string,
): {
	added: ClientWorkspaceEntry[];
	removed: ClientWorkspaceEntry[];
} {
	if (!isRecord(value) || !isRecord(value.event)) {
		return {
			added: [],
			removed: [],
		};
	}

	return {
		added: extractClientWorkspaceEntries(value.event.added, `${source}:added`),
		removed: extractClientWorkspaceEntries(value.event.removed, `${source}:removed`),
	};
}

function extractClientWorkspaceEntries(value: unknown, source: string): ClientWorkspaceEntry[] {
	const entries: ClientWorkspaceEntry[] = [];
	const seenObjects = new Set<unknown>();

	const visit = (node: unknown, key: string | null = null, inheritedName: string | null = null) => {
		if (Array.isArray(node)) {
			for (const entry of node) {
				visit(entry, key, inheritedName);
			}
			return;
		}

		if (isRecord(node)) {
			if (seenObjects.has(node)) {
				return;
			}
			seenObjects.add(node);
			const name = readOptionalWorkspaceString(node.name) ?? inheritedName;
			const uri =
				readOptionalWorkspaceString(node.uri) ??
				readOptionalWorkspaceString(node.rootUri) ??
				readOptionalWorkspaceString(node.root_uri) ??
				readOptionalWorkspaceString(node.url);
			const rawPath =
				readOptionalWorkspaceString(node.path) ??
				readOptionalWorkspaceString(node.rootPath) ??
				readOptionalWorkspaceString(node.root_path) ??
				readOptionalWorkspaceString(node.cwd) ??
				readOptionalWorkspaceString(node.workspacePath) ??
				readOptionalWorkspaceString(node.workspaceRoot);

			if (uri !== null || rawPath !== null) {
				entries.push({
					name,
					path: uri !== null ? (fileUriToFilesystemPath(uri) ?? rawPath) : rawPath,
					source,
					uri,
				});
			}

			for (const [childKey, childValue] of Object.entries(node)) {
				visit(childValue, childKey, name);
			}
			return;
		}

		if (typeof node !== "string") {
			return;
		}

		const trimmed = node.trim();
		if (!trimmed) {
			return;
		}

		if (looksLikeWorkspaceUriKey(key) && trimmed.startsWith("file:")) {
			entries.push({
				name: inheritedName,
				path: fileUriToFilesystemPath(trimmed),
				source,
				uri: trimmed,
			});
			return;
		}

		if (looksLikeWorkspacePathKey(key) && looksLikeAbsolutePath(trimmed)) {
			entries.push({
				name: inheritedName,
				path: trimmed,
				source,
				uri: null,
			});
		}
	};

	visit(value);
	return dedupeWorkspaceEntries(entries);
}

function readOptionalWorkspaceString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function looksLikeWorkspaceUriKey(key: string | null): boolean {
	return key === "uri" || key === "rootUri" || key === "root_uri" || key === "url";
}

function looksLikeWorkspacePathKey(key: string | null): boolean {
	return (
		key === "path" ||
		key === "rootPath" ||
		key === "root_path" ||
		key === "cwd" ||
		key === "workspacePath" ||
		key === "workspaceRoot"
	);
}

function looksLikeAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

async function maybeRequestClientRoots(reason: string): Promise<void> {
	if (!clientWorkspaceState.rootsAdvertised) {
		return;
	}
	if (clientWorkspaceState.rootsEntries.length > 0) {
		return;
	}
	const existingPendingRequest = pendingWorkspaceRequests.values().next().value as PendingWorkspaceRequest | undefined;
	if (existingPendingRequest) {
		await waitForWorkspaceRequest(existingPendingRequest, reason);
		return;
	}
	if (clientWorkspaceState.rootsRequested) {
		return;
	}

	const requestId = `roots:${++nextServerRequestId}`;
	let resolvePending = () => {};
	const done = new Promise<void>((resolve) => {
		resolvePending = resolve;
	});
	clientWorkspaceState.rootsRequested = true;
	pendingWorkspaceRequests.set(jsonRpcIdKey(requestId), {
		done,
		method: "roots/list",
		reason,
		resolve: resolvePending,
	});
	infoLog(`client roots request sent reason=${reason}`);
	sendJson({
		id: requestId,
		jsonrpc: "2.0",
		method: "roots/list",
		params: {},
	});
	await waitForWorkspaceRequest(
		pendingWorkspaceRequests.get(jsonRpcIdKey(requestId)) ?? {
			done,
			method: "roots/list",
			reason,
			resolve: resolvePending,
		},
		reason,
	);
}

async function waitForWorkspaceRequest(pendingRequest: PendingWorkspaceRequest, reason: string): Promise<void> {
	let timedOut = false;
	await Promise.race([
		pendingRequest.done,
		delay(ROOTS_REQUEST_WAIT_MS).then(() => {
			timedOut = true;
		}),
	]);
	if (!timedOut) {
		return;
	}
	infoLog(
		`client roots request timed out reason=${reason} afterMs=${ROOTS_REQUEST_WAIT_MS} fallback=${formatLogValue(process.cwd(), 120)}`,
	);
}

function logWorkspaceSnapshot(source: string, state: ClientWorkspaceState, extra: Record<string, unknown> = {}): void {
	const selected = resolveClientDerivedCwd(state);
	infoLog(
		`cwd context ${formatLogValue(
			{
				...extra,
				rootsAdvertised: state.rootsAdvertised,
				selectedCwd: selected?.cwd ?? null,
				selectedSource: selected?.source ?? null,
				source,
				workspaceCandidates: {
					initialize: summarizeWorkspaceEntries(state.initializeEntries),
					roots: summarizeWorkspaceEntries(state.rootsEntries),
					workspace: summarizeWorkspaceEntries(state.workspaceEntries),
				},
			},
			240,
		)}`,
	);
}

function logToolCallCwdDecision(
	requestId: JsonRpcId,
	toolName: string,
	resolved: {
		candidateCount: number;
		cwd: string;
		detail: string;
		source: "tool-meta" | "client-derived" | "process.cwd()";
		warning: string | null;
	},
	state: ClientWorkspaceState,
	metaValue: unknown,
): void {
	const metaKeys = isRecord(metaValue) ? Object.keys(metaValue).sort() : [];
	infoLog(
		`cwd selected ${formatLogValue(
			{
				activeRoots: summarizeWorkspaceEntries(state.rootsEntries),
				activeWorkspace: summarizeWorkspaceEntries(state.workspaceEntries),
				candidateCount: resolved.candidateCount,
				cwd: resolved.cwd,
				detail: resolved.detail,
				metaKeys,
				requestId,
				source: resolved.source,
				tool: toolName,
				warning: resolved.warning,
			},
			240,
		)}`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcIdKey(id: JsonRpcId): string {
	return id === null ? "null" : String(id);
}

function attachStdinReader(): void {
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			let message: JsonRpcRequest;
			try {
				message = JSON.parse(line) as JsonRpcRequest;
			} catch (error) {
				sendError(null, -32700, error instanceof Error ? error.message : String(error));
				continue;
			}
			void handleMessage(message);
		}
	});
	process.stdin.resume();
	const handleDisconnect = () => {
		void shutdown().finally(() => {
			process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
		});
	};
	process.stdin.once("close", handleDisconnect);
	process.stdin.once("end", handleDisconnect);
}

function parseReadResourceParams(value: unknown): { uri: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resources/read requires an object with a uri string");
	}
	const uri = (value as { uri?: unknown }).uri;
	if (typeof uri !== "string") {
		throw new Error("resources/read requires a uri string");
	}
	return { uri };
}

function parsePromptGetParams(value: unknown): { name: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("prompts/get requires an object with a prompt name");
	}
	const name = (value as { name?: unknown }).name;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("prompts/get requires a prompt name string");
	}
	return { name };
}

function parseToolCallParams(value: unknown): { arguments?: unknown; meta?: unknown; name: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("tools/call requires an object with a name");
	}
	const name = (value as { name?: unknown }).name;
	if (typeof name !== "string") {
		throw new Error("tools/call requires a name string");
	}
	return {
		arguments: (value as { arguments?: unknown }).arguments,
		meta: (value as { _meta?: unknown })._meta,
		name,
	};
}

function formatLogValue(value: unknown, maxLength = 400): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}

async function runAgentToolTurn(options: {
	args: AgentToolArgs;
	progress: ProgressContext;
	runEmptyRecoveryTurn?: (
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	runInitialTurn: (observer: import("./acp_runtime.ts").AgentTurnObserver) => Promise<AgentTurnResult>;
	runRetryTurn?: (
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
	runContinueTurn?: (
		previousResult: AgentTurnResult,
		observer: import("./acp_runtime.ts").AgentTurnObserver,
	) => Promise<AgentTurnResult>;
}): Promise<AgentTurnResult> {
	const observer = createRuntimeObserver({
		infoLog,
		progress: options.progress,
	});
	const promptText = extractPromptTextFromAgentInput(options.args.input);
	let result = await options.runInitialTurn(observer);
	let emptyAttempts = 0;
	while (emptyAttempts < MAX_EMPTY_TURN_RETRIES && isRetriableEmptyTurnResult(result)) {
		emptyAttempts += 1;
		infoLog(
			`empty turn retry triggered session=${result.sessionId} attempt=${emptyAttempts} stopReason=${result.stopReason ?? "null"}`,
		);
		options.progress.setStepSummary("Retrying empty turn");
		options.progress.logMessage("Agent returned no output; retrying the same turn");
		result = options.runRetryTurn
			? await options.runRetryTurn(result, observer)
			: await options.runInitialTurn(observer);
	}
	if (isRetriableEmptyTurnResult(result) && options.runEmptyRecoveryTurn) {
		infoLog(`empty turn recovery triggered session=${result.sessionId} stopReason=${result.stopReason ?? "null"}`);
		options.progress.setStepSummary("Restarting backend after empty turn");
		options.progress.logMessage("Agent still returned no output; restarting the backend once");
		result = await options.runEmptyRecoveryTurn(result, observer);
	}
	if (isRetriableEmptyTurnResult(result)) {
		infoLog(`empty turn fallback used session=${result.sessionId} stopReason=${result.stopReason ?? "null"}`);
		options.progress.setStepSummary("Backend returned no output");
		options.progress.logMessage("Agent returned no output after retrying the same turn");
		return {
			...result,
			text: "The smart agent completed the turn without returning any text after retrying the same prompt.",
		};
	}
	let interimAttempts = 0;
	const seenInterimTexts = new Set<string>();
	let interimReason = getRetriableInterimTurnReason(result, promptText);
	while (interimAttempts < MAX_INTERIM_TURN_RETRIES && interimReason !== null) {
		const normalizedInterimText = result.text.replace(/\s+/g, " ").trim();
		if (seenInterimTexts.has(normalizedInterimText)) {
			infoLog(
				`interim turn retry stopped session=${result.sessionId} reason=repeated-text text=${formatLogValue(normalizedInterimText, 140)}`,
			);
			break;
		}
		seenInterimTexts.add(normalizedInterimText);
		interimAttempts += 1;
		if (result.stopReason === "end_turn") {
			infoLog(
				`heuristic detected early end_turn ${formatLogValue(
					buildInterimTurnLogContext(result, interimAttempts, interimReason),
					260,
				)}`,
			);
		}
		infoLog(
			`interim turn retry triggered session=${result.sessionId} attempt=${interimAttempts} reason=${interimReason} stopReason=${result.stopReason ?? "null"} text=${formatLogValue(result.text, 140)}`,
		);
		options.progress.setStepSummary("Continuing same turn");
		options.progress.logMessage("Agent returned an interim update; continuing the same turn");
		if (!options.runContinueTurn) {
			break;
		}
		result = await options.runContinueTurn(result, observer);
		interimReason = getRetriableInterimTurnReason(result, promptText);
	}
	if (
		result.stopReason === "end_turn" &&
		result.text.trim().length > 0 &&
		result.toolCalls === 0 &&
		interimReason === null &&
		!isClearlyFinalTurnText(result.text.replace(/\s+/g, " ").trim())
	) {
		infoLog(`interim turn accepted as final ${formatLogValue(buildAcceptedFinalTurnLogContext(result), 260)}`);
	}
	return result;
}

function isRetriableEmptyTurnResult(result: AgentTurnResult): boolean {
	return result.text.trim().length === 0 && result.thought.trim().length === 0 && result.toolCalls === 0;
}

function getRetriableInterimTurnReason(result: AgentTurnResult, promptText = ""): string | null {
	const text = getResultTextForHeuristics(result);
	if (!text || isRetriableEmptyTurnResult(result)) {
		return null;
	}
	if (isClearlyFinalTurnText(text)) {
		return null;
	}
	// Some ACP/OpenCode turns end on progress text instead of a final answer.
	// When that happens, continue the same prompt in the same session without injecting new instructions.
	const progressReason = getStillWorkingUpdateReason(text);
	if (progressReason !== null) {
		return progressReason;
	}
	if (isActionPlanInsteadOfExecution(promptText, text, result.toolCalls)) {
		return "action-plan-before-execution";
	}
	return null;
}

function getResultTextForHeuristics(result: AgentTurnResult): string {
	const transcriptText =
		result.transcript?.assistantMessages
			.map((entry) => entry.text)
			.join("")
			.trim() ?? "";
	return (transcriptText || result.text).replace(/\s+/g, " ").trim();
}

function buildInterimTurnLogContext(result: AgentTurnResult, attempt: number, reason: string): Record<string, unknown> {
	const transcript = result.transcript;
	return {
		attempt,
		hasAvailableCommandsUpdate: transcript?.availableCommands !== null,
		hasConfigUpdate: transcript?.configOptions !== null,
		hasPlanUpdate: transcript?.plan !== null,
		hasSessionInfoUpdate: transcript?.sessionInfo !== null,
		latestToolStatuses: transcript ? [...transcript.toolCalls.values()].map((entry) => entry.status ?? "unknown") : [],
		messageIds: transcript?.assistantMessages.map((entry) => entry.messageId).filter((entry) => entry !== null) ?? [],
		reason,
		sessionId: result.sessionId,
		stopReason: result.stopReason ?? "null",
		text: formatLogValue(result.text, 140),
		toolCallCount: transcript?.toolCallCount ?? result.toolCalls,
	};
}

function buildAcceptedFinalTurnLogContext(result: AgentTurnResult): Record<string, unknown> {
	const transcript = result.transcript;
	return {
		hasAvailableCommandsUpdate: transcript?.availableCommands !== null,
		hasConfigUpdate: transcript?.configOptions !== null,
		hasPlanUpdate: transcript?.plan !== null,
		hasSessionInfoUpdate: transcript?.sessionInfo !== null,
		messageIds: transcript?.assistantMessages.map((entry) => entry.messageId).filter((entry) => entry !== null) ?? [],
		reason: "not-classified",
		sessionId: result.sessionId,
		stopReason: result.stopReason ?? "null",
		text: formatLogValue(result.text, 140),
		toolCallCount: transcript?.toolCallCount ?? result.toolCalls,
	};
}

function isClearlyFinalTurnText(text: string): boolean {
	return /^(?:Verified done\b|Verified\b|Overall\b|In short\b|This repo\b|This app\b|The project\b|It is\b|`[^`]+`\s+is\b)/i.test(
		text,
	);
}

function getStillWorkingUpdateReason(text: string): string | null {
	const ongoingVerb = String.raw`checking|inspecting|looking|searching|reading|reviewing|analyzing|analysing|exploring|investigating|determining|clarifying|verifying|pulling|gathering|collecting|extracting|tracing|confirming|comparing|mapping|validating|locating`;
	const patterns: Array<[reason: string, regex: RegExp]> = [
		["direct-progress", new RegExp(String.raw`^(?:(?:I|We)(?:['’]m| am| are)\s+)?(?:${ongoingVerb})\b`, "i")],
		[
			"found-then-continue",
			new RegExp(
				String.raw`^(?:(?:I|We)\s+)?(?:found|see|located|identified|discovered)\b.{0,220}\b(?:I(?:['’]m| am)\s+(?:now\s+)?(?:${ongoingVerb})|we are\s+(?:now\s+)?(?:${ongoingVerb})|next\s+I(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb})|then\s+I(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb}))\b`,
				"i",
			),
		],
		[
			"continuing-work",
			new RegExp(
				String.raw`^continuing\b.{0,220}\b(?:${ongoingVerb}|discovery|investigation|verification|review|summary|writeup)\b`,
				"i",
			),
		],
		[
			"next-step",
			new RegExp(String.raw`^(?:next|then)\b.{0,80}\bI(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb})\b`, "i"),
		],
		[
			"gerund-before-writeup",
			new RegExp(
				String.raw`^(?:pulling|gathering|collecting|extracting|tracing|confirming|comparing|mapping|validating|locating)\b.{0,220}\b(?:before\s+(?:writing|sending|posting|returning|sharing)\b|so\s+(?:that\s+)?I\s+can\s+(?:write|finish|send|return|share)\b|then\s+I(?:['’]ll| will)\b|next\s+I(?:['’]ll| will)\b)`,
				"i",
			),
		],
		[
			"explanation-then-continue",
			new RegExp(
				String.raw`^(?:The|This|That|It)\b.{0,220}\b(?:so|then)\s+I(?:['’]m| am|['’]ll| will)\s+(?:now\s+)?(?:${ongoingVerb})\b`,
				"i",
			),
		],
		[
			"have-partial-findings-then-continue",
			new RegExp(
				String.raw`^(?:I|We)(?:['’]ve| have)\s+(?:got|found|identified|confirmed)\b.{0,220}\bI(?:['’]m| am)\s+(?:now\s+)?(?:${ongoingVerb})\b`,
				"i",
			),
		],
	];
	for (const [reason, regex] of patterns) {
		if (regex.test(text)) {
			return reason;
		}
	}
	return null;
}

function isActionPlanInsteadOfExecution(promptText: string, responseText: string, toolCalls: number): boolean {
	if (toolCalls > 0 || !looksLikeActionPrompt(promptText) || hasExecutionCompletionMarkers(responseText)) {
		return false;
	}
	return (
		/^(?:Yes\b|No\b|First\b|Start by\b|Begin by\b|The standard\b|You\s+(?:can|should|need to)\b|(?:Move|Relocate|Rename|Update|Delete|Remove|Then)\b)/i.test(
			responseText,
		) ||
		/\b(?:standard move pattern|update imports|then delete|then remove|then rename|then update)\b/i.test(responseText)
	);
}

function looksLikeActionPrompt(text: string): boolean {
	return /\b(?:move|rename|relocate|update|change|edit|fix|implement|write|create|delete|remove|refactor|patch|modify|add|replace)\b/i.test(
		text,
	);
}

function hasExecutionCompletionMarkers(text: string): boolean {
	return /\b(?:done|completed|finished|moved|renamed|updated|implemented|fixed|created|deleted|removed|applied|refactored|changed)\b/i.test(
		text,
	);
}

function extractPromptTextFromAgentInput(input: unknown[]): string {
	const parts: string[] = [];
	for (const message of input) {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			continue;
		}
		const messageParts = (message as { parts?: unknown }).parts;
		if (!Array.isArray(messageParts)) {
			continue;
		}
		for (const part of messageParts) {
			if (!part || typeof part !== "object" || Array.isArray(part)) {
				continue;
			}
			const record = part as Record<string, unknown>;
			if (typeof record.content === "string") {
				parts.push(record.content);
				continue;
			}
			const typedContent =
				record.content && typeof record.content === "object" && !Array.isArray(record.content)
					? (record.content as Record<string, unknown>)
					: null;
			if (typedContent?.type === "text" && typeof typedContent.text === "string") {
				parts.push(typedContent.text);
			}
		}
	}
	return parts.join("\n").trim();
}

function parseStartAgentArgs(value: unknown, cwd: string): { cwd: string; input: unknown[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("start_agent requires an object with a message string");
	}
	const message = readAgentMessageField(value);
	if (message !== null) {
		return {
			cwd,
			input: [{ parts: [{ content: message }] }],
		};
	}
	const input = coerceLegacyInput((value as { input?: unknown }).input);
	if (input !== null) {
		return { cwd, input };
	}
	throw new Error("start_agent requires a non-empty message string");
}

function parseResumeAgentArgs(
	value: unknown,
	cwd: string,
): { cwd: string; input: unknown[]; session: string; sessionId: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resume_agent requires an object with sessionId and message");
	}
	const sessionIdValue = readAgentSessionIdField(value);
	const session = sessionIdValue;
	if (typeof session !== "string" || session.length === 0) {
		throw new Error("resume_agent requires a sessionId string");
	}
	const message = readAgentMessageField(value);
	if (message !== null) {
		return {
			cwd,
			input: [{ parts: [{ content: message }] }],
			session,
			sessionId: session,
		};
	}
	const input = coerceLegacyInput((value as { input?: unknown }).input);
	if (input !== null) {
		return { cwd, input, session, sessionId: session };
	}
	throw new Error("resume_agent requires a non-empty message string");
}

function readAgentSessionIdField(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const sessionId = (value as { sessionId?: unknown }).sessionId;
	if (typeof sessionId === "string" && sessionId.length > 0) {
		return sessionId;
	}
	const legacySession = (value as { session?: unknown }).session;
	if (typeof legacySession === "string" && legacySession.length > 0) {
		return legacySession;
	}
	return null;
}

function readAgentMessageField(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const message = (value as { message?: unknown }).message;
	if (typeof message === "string" && message.trim().length > 0) {
		return message;
	}
	const legacyText = (value as { text?: unknown }).text;
	if (typeof legacyText === "string" && legacyText.trim().length > 0) {
		return legacyText;
	}
	return null;
}

function coerceLegacyInput(value: unknown): unknown[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	return value.map((entry) => coerceLegacyMessage(entry));
}

function coerceLegacyMessage(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.parts)) {
		return value;
	}
	if (typeof record.content === "string") {
		return {
			parts: [{ content: record.content }],
		};
	}
	const content = record.content;
	if (content && typeof content === "object" && !Array.isArray(content)) {
		const contentRecord = content as Record<string, unknown>;
		if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
			return {
				parts: [{ content: { text: contentRecord.text, type: "text" } }],
			};
		}
	}
	return value;
}

async function shutdown(): Promise<void> {
	if (shutdownPromise !== null) {
		await shutdownPromise;
		return;
	}
	debugLog("shutdown");
	shutdownPromise = (async () => {
		process.stdin.pause();
		if (runtimeInstancePromise !== null) {
			const runtime = await runtimeInstancePromise.catch(() => null);
			await runtime?.close().catch(() => {});
		}
	})();
	await shutdownPromise;
}

async function main(): Promise<void> {
	infoLog(`boot version=${serverInfo.version}`);
	attachStdinReader();
	infoLog("stdio transport connected");
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void shutdown().finally(() => {
				process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
			});
		});
	}
}

main().catch(async (error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	await shutdown().catch(() => {});
	process.exitCode = 1;
});
