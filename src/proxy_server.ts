import { existsSync, realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
	createJsonRpcError,
	createJsonRpcResponse,
	isJsonRpcError,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isRecord,
	jsonRpcIdKey,
	parseJsonRpcMessage,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
} from "./jsonrpc.ts";
import { JsonRpcLineWriter } from "./line_transport.ts";
import { loadProxyConfig } from "./proxy_config.ts";
import { createResourcesListResult, createResourcesReadResult } from "./resource_contract.ts";
import {
	buildInnerCodexArgumentsWithBaseInstructions,
	buildInnerCodexReplyArguments,
	createReducedToolsListResult,
	createToolCallErrorResult,
	normalizeOuterToolName,
	type OuterToolName,
	parseOuterCodexCall,
	parseOuterCodexReplyCall,
} from "./tool_contract.ts";

type PendingInnerRequest = {
	innerId: JsonRpcId;
	method: string;
};

type PendingClientRequest = {
	method: string;
};

type PendingWorkspaceRequest = {
	method: "roots/list";
	reason: string;
};

type PendingToolCall = {
	callId: JsonRpcId;
	cleanupTimer: NodeJS.Timeout | null;
	completed: boolean;
	lastAgentMessage: string | null;
	pollInFlight: boolean;
	pollTimer: NodeJS.Timeout | null;
	rolloutPath: string | null;
	startedAtMs: number;
	syntheticCompletionSent: boolean;
	syntheticResultKind: "completion" | "interrupted" | null;
	/** Session id for the in-flight agent tool call; used when normalizing the tool result for the outer MCP client. */
	threadId: string | null;
	toolName: OuterToolName;
};

type ResolvedSessionRoot = {
	path: string;
	source: "native" | "wsl";
	wslDistro: string | null;
};

type CodexEventSnapshot = {
	lastAgentMessage: string | null;
	reason: string | null;
	requestId: JsonRpcId | null;
	rolloutPath: string | null;
	threadId: string | null;
	type: string | null;
};

type RolloutTerminalSnapshot = {
	lastAgentMessage: string | null;
	reason: string | null;
	terminalState: "completed" | "aborted";
	threadId: string | null;
};

type RolloutCandidate = {
	mtimeMs: number;
	path: string;
};

type WslSessionsRoot = {
	distro: string;
	sessionsRoot: string;
};

type ClientWorkspaceEntry = {
	name: string | null;
	path: string | null;
	source: string;
	uri: string | null;
};

type ClientWorkspaceState = {
	initializeEntries: ClientWorkspaceEntry[];
	rootsAdvertised: boolean;
	rootsEntries: ClientWorkspaceEntry[];
	rootsRequested: boolean;
	selectedCwd: string | null;
	selectedSource: string | null;
	selectionVersion: number;
	sessionId: string;
	workspaceEntries: ClientWorkspaceEntry[];
};

type ResolvedClientCwd = {
	candidateCount: number;
	cwd: string;
	detail: string;
	source: string;
};

type LogLevel = "error" | "info" | "warn";

const ROLLOUT_POLL_INTERVAL_MS = 5_000;

function createSessionId(): string {
	return `s${process.pid.toString(36)}-${Date.now().toString(36)}`;
}

function createLogPayload(
	sessionId: string,
	event: string,
	level: LogLevel,
	workspaceVersion: number,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	return {
		event,
		level,
		sessionId,
		workspaceVersion,
		...payload,
	};
}

function writeTaggedLog(tag: string, payload: Record<string, unknown>): void {
	process.stderr.write(`[yolo-codex-mcp][${tag}] ${JSON.stringify(payload)}\n`);
}

export async function runProxyServer(): Promise<void> {
	const config = loadProxyConfig();
	const sessionId = createSessionId();
	writeTaggedLog(
		"cwd-baseline",
		createLogPayload(sessionId, "startup-baseline", "info", 0, {
			cwd: process.cwd(),
			source: "process.cwd()",
			usedForToolCall: false,
			warning: "Temporary baseline only. Expected normal cwd resolution to come from client workspace context.",
		}),
	);
	const resolvedLaunch = resolveInnerServerLaunch(config.innerCommand, config.innerArgs);
	const spawnSpec = createInnerServerSpawnSpec(resolvedLaunch.command, resolvedLaunch.args);
	const sessionRoot = resolveSessionRoot(spawnSpec, process.env);
	const inner = spawn(spawnSpec.command, spawnSpec.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
		windowsHide: true,
	});

	await ensureInnerProcessStarted(inner, spawnSpec);

	const clientWriter = new JsonRpcLineWriter(process.stdout);
	const innerWriter = new JsonRpcLineWriter(inner.stdin);
	const clientWorkspaceState = createClientWorkspaceState(sessionId);
	const pendingClientRequests = new Map<string, PendingClientRequest>();
	const pendingInnerRequests = new Map<string, PendingInnerRequest>();
	const pendingWorkspaceRequests = new Map<string, PendingWorkspaceRequest>();
	const pendingToolCalls = new Map<string, PendingToolCall>();
	let nextOuterServerRequestId = 0;
	let softKillTimer: NodeJS.Timeout | null = null;
	let hardKillTimer: NodeJS.Timeout | null = null;
	const clientClosed = new Promise<void>((resolve) => {
		const onClose = () => {
			process.stdin.off("end", onClose);
			process.stdin.off("close", onClose);
			resolve();
		};
		process.stdin.once("end", onClose);
		process.stdin.once("close", onClose);
	});

	process.stdin.resume();

	inner.stderr.on("data", (chunk: Buffer | string) => {
		process.stderr.write(prefixInnerStderr(chunk));
	});

	const clientReader = attachLineReader(process.stdin, (line) => {
		void handleLine(line, async (message) => {
			await onClientMessage(message, {
				allocateOuterServerRequestId: () => `proxy:${++nextOuterServerRequestId}`,
				clientWorkspaceState,
				clientWriter,
				config,
				innerWriter,
				pendingClientRequests,
				pendingInnerRequests,
				pendingWorkspaceRequests,
				pendingToolCalls,
				sessionRoot,
			});
		});
	});
	const innerReader = attachLineReader(inner.stdout, (line) => {
		void handleLine(line, async (message) => {
			await onInnerMessage(message, {
				clientWriter,
				pendingClientRequests,
				pendingToolCalls,
				pendingInnerRequests,
				allocateOuterServerRequestId: () => `proxy:${++nextOuterServerRequestId}`,
				sessionRoot,
			});
		});
	});

	let shuttingDown = false;
	const clearShutdownTimers = () => {
		if (softKillTimer !== null) {
			clearTimeout(softKillTimer);
			softKillTimer = null;
		}
		if (hardKillTimer !== null) {
			clearTimeout(hardKillTimer);
			hardKillTimer = null;
		}
	};
	const killInnerIfStillRunning = (signal: NodeJS.Signals) => {
		if (inner.exitCode !== null || inner.signalCode !== null || inner.killed) {
			return;
		}
		inner.kill(signal);
	};
	const shutdown = async () => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		for (const pendingToolCall of pendingToolCalls.values()) {
			stopPendingToolCallPolling(pendingToolCall);
			if (pendingToolCall.cleanupTimer !== null) {
				clearTimeout(pendingToolCall.cleanupTimer);
				pendingToolCall.cleanupTimer = null;
			}
		}
		pendingToolCalls.clear();
		clientReader.close();
		innerReader.close();
		if (!inner.stdin.destroyed) {
			inner.stdin.end();
		}
		if (inner.exitCode === null && inner.signalCode === null) {
			softKillTimer = setTimeout(() => {
				if (inner.exitCode !== null || inner.signalCode !== null) {
					return;
				}
				process.stderr.write("Inner Codex MCP server did not exit after stdin closed; sending SIGTERM.\n");
				killInnerIfStillRunning("SIGTERM");
				hardKillTimer = setTimeout(() => {
					if (inner.exitCode !== null || inner.signalCode !== null) {
						return;
					}
					process.stderr.write("Inner Codex MCP server did not exit after SIGTERM; sending SIGKILL.\n");
					killInnerIfStillRunning("SIGKILL");
				}, 1_000);
				hardKillTimer.unref();
			}, 500);
			softKillTimer.unref();
		}
	};
	const onProcessExit = () => {
		clearShutdownTimers();
		killInnerIfStillRunning("SIGTERM");
	};
	process.once("exit", onProcessExit);

	process.stdin.once("end", () => {
		void shutdown();
	});
	process.stdin.once("close", () => {
		void shutdown();
	});

	const childExit = once(inner, "exit").then(([code, signal]) => {
		clearShutdownTimers();
		if (!shuttingDown) {
			process.stderr.write(
				`Inner Codex MCP server exited${code === null ? "" : ` with code ${String(code)}`}${
					signal === null ? "" : ` (signal ${String(signal)})`
				}\n`,
			);
		}
	});
	inner.once("error", (error) => {
		process.stderr.write(
			`Inner Codex MCP server process error while running ${formatSpawnSpec(spawnSpec)}: ${error.message}\n`,
		);
	});

	await Promise.race([clientClosed, childExit]);
	await shutdown();
	await childExit;
	process.removeListener("exit", onProcessExit);
}

async function onClientMessage(
	message: JsonRpcMessage,
	context: {
		allocateOuterServerRequestId: () => JsonRpcId;
		clientWorkspaceState: ClientWorkspaceState;
		clientWriter: JsonRpcLineWriter;
		config: ReturnType<typeof loadProxyConfig>;
		innerWriter: JsonRpcLineWriter;
		pendingClientRequests: Map<string, PendingClientRequest>;
		pendingInnerRequests: Map<string, PendingInnerRequest>;
		pendingWorkspaceRequests: Map<string, PendingWorkspaceRequest>;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	observeClientWorkspaceMessage(message, context.clientWorkspaceState, context.pendingInnerRequests);
	logInboundClientMessage(message, context.pendingInnerRequests, context.pendingWorkspaceRequests);

	if (isJsonRpcRequest(message)) {
		if (message.method === "tools/list") {
			await context.clientWriter.write(createJsonRpcResponse(message.id, createReducedToolsListResult()));
			return;
		}

		if (message.method === "tools/call") {
			await handleToolsCallRequest(message, context);
			return;
		}

		if (message.method === "resources/list") {
			await context.clientWriter.write(createJsonRpcResponse(message.id, createResourcesListResult()));
			return;
		}

		if (message.method === "resources/read") {
			await handleResourcesReadRequest(message, context.clientWriter);
			return;
		}

		const key = jsonRpcIdKey(message.id);
		context.pendingClientRequests.set(key, {
			method: message.method,
		});
		try {
			await context.innerWriter.write(message);
		} catch (error) {
			context.pendingClientRequests.delete(key);
			throw error;
		}
		return;
	}

	if (isJsonRpcNotification(message) && message.method === "notifications/initialized") {
		await maybeRequestClientRoots("notifications/initialized", context);
	}

	if (isJsonRpcResponse(message)) {
		const key = jsonRpcIdKey(message.id);
		const pendingWorkspaceRequest = context.pendingWorkspaceRequests.get(key);
		if (pendingWorkspaceRequest) {
			context.pendingWorkspaceRequests.delete(key);
			observeWorkspaceRequestResult(message.result, context.clientWorkspaceState, pendingWorkspaceRequest.method);
			logWorkspaceRequestCompletion(pendingWorkspaceRequest, context.clientWorkspaceState);
			return;
		}
		const pendingRequest = context.pendingInnerRequests.get(key);
		if (pendingRequest) {
			context.pendingInnerRequests.delete(key);
			await context.innerWriter.write({
				...message,
				id: pendingRequest.innerId,
			});
			return;
		}
	}

	if (isJsonRpcError(message)) {
		const key = jsonRpcIdKey(message.id);
		const pendingWorkspaceRequest = context.pendingWorkspaceRequests.get(key);
		if (pendingWorkspaceRequest) {
			context.pendingWorkspaceRequests.delete(key);
			if (pendingWorkspaceRequest.method === "roots/list") {
				context.clientWorkspaceState.rootsRequested = false;
			}
			writeTaggedLog(
				"client-cwd",
				createLogPayload(
					context.clientWorkspaceState.sessionId,
					"workspace-request-error",
					"error",
					context.clientWorkspaceState.selectionVersion,
					{
						error: message.error,
						method: pendingWorkspaceRequest.method,
						reason: pendingWorkspaceRequest.reason,
						status: "error",
					},
				),
			);
			return;
		}
	}

	await context.innerWriter.write(message);
}

async function handleToolsCallRequest(
	message: JsonRpcRequest,
	context: {
		clientWorkspaceState: ClientWorkspaceState;
		clientWriter: JsonRpcLineWriter;
		config: ReturnType<typeof loadProxyConfig>;
		innerWriter: JsonRpcLineWriter;
		allocateOuterServerRequestId: () => JsonRpcId;
		pendingInnerRequests: Map<string, PendingInnerRequest>;
		pendingWorkspaceRequests: Map<string, PendingWorkspaceRequest>;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	const params = message.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		await context.clientWriter.write(
			createJsonRpcResponse(message.id, createToolCallErrorResult("Expected tools/call params to be an object")),
		);
		return;
	}

	const requestParams = { ...params } as Record<string, unknown>;
	const requestedToolName = typeof requestParams.name === "string" ? requestParams.name.trim() : null;
	if (requestedToolName === null || requestedToolName === "") {
		await context.clientWriter.write(
			createJsonRpcResponse(message.id, createToolCallErrorResult("Expected tools/call params.name to be a string")),
		);
		return;
	}
	const toolName = normalizeOuterToolName(requestedToolName);

	try {
		if (toolName === "codex") {
			const call = parseOuterCodexCall(requestParams.arguments, requestedToolName);
			if (call.legacyCwd !== null) {
				logIgnoredLegacyToolCwd(
					message.id,
					requestedToolName as OuterToolName,
					call.legacyCwd,
					context.clientWorkspaceState,
				);
			}
			await maybeRequestClientRoots("tools/call", context);
			const resolvedCwd = resolveToolCallCwd(context.clientWorkspaceState);
			logToolCallCwdDecision(message.id, requestedToolName as OuterToolName, resolvedCwd, context.clientWorkspaceState);
			const pendingToolCall = createPendingToolCall(message.id, requestedToolName as OuterToolName);
			const forwardedArguments = buildInnerCodexArgumentsWithBaseInstructions(
				{
					...call,
					cwd: resolvedCwd.cwd,
				},
				context.config.policy,
				context.config.baseDeveloperInstructions,
			);
			logForwardedToolArguments(
				message.id,
				requestedToolName as OuterToolName,
				forwardedArguments,
				resolvedCwd,
				context.clientWorkspaceState,
			);
			context.pendingToolCalls.set(jsonRpcIdKey(message.id), pendingToolCall);
			try {
				await context.innerWriter.write({
					...message,
					params: {
						...requestParams,
						name: "codex",
						arguments: forwardedArguments,
					},
				});
			} catch (error) {
				context.pendingToolCalls.delete(jsonRpcIdKey(message.id));
				throw error;
			}
			startPendingToolCallPolling(pendingToolCall, {
				clientWriter: context.clientWriter,
				pendingToolCalls: context.pendingToolCalls,
				sessionRoot: context.sessionRoot,
			});
			return;
		}

		if (toolName === "codex-reply") {
			const call = parseOuterCodexReplyCall(requestParams.arguments, requestedToolName);
			if (call.legacyCwd !== null) {
				logIgnoredLegacyToolCwd(
					message.id,
					requestedToolName as OuterToolName,
					call.legacyCwd,
					context.clientWorkspaceState,
				);
			}
			await maybeRequestClientRoots("tools/call", context);
			const resolvedCwd = resolveToolCallCwd(context.clientWorkspaceState);
			logToolCallCwdDecision(message.id, requestedToolName as OuterToolName, resolvedCwd, context.clientWorkspaceState);
			const pendingToolCall = createPendingToolCall(message.id, requestedToolName as OuterToolName, call.threadId);
			const forwardedArguments = buildInnerCodexReplyArguments(
				{
					...call,
					cwd: resolvedCwd.cwd,
				},
				context.config.policy,
			);
			logForwardedToolArguments(
				message.id,
				requestedToolName as OuterToolName,
				forwardedArguments,
				resolvedCwd,
				context.clientWorkspaceState,
			);
			context.pendingToolCalls.set(jsonRpcIdKey(message.id), pendingToolCall);
			try {
				await context.innerWriter.write({
					...message,
					params: {
						...requestParams,
						name: "codex-reply",
						arguments: forwardedArguments,
					},
				});
			} catch (error) {
				context.pendingToolCalls.delete(jsonRpcIdKey(message.id));
				throw error;
			}
			startPendingToolCallPolling(pendingToolCall, {
				clientWriter: context.clientWriter,
				pendingToolCalls: context.pendingToolCalls,
				sessionRoot: context.sessionRoot,
			});
			return;
		}
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error);
		await context.clientWriter.write(createJsonRpcResponse(message.id, createToolCallErrorResult(messageText)));
		return;
	}

	await context.innerWriter.write(message);
}

async function handleResourcesReadRequest(message: JsonRpcRequest, clientWriter: JsonRpcLineWriter): Promise<void> {
	if (!isRecord(message.params)) {
		await clientWriter.write(createJsonRpcError(message.id, -32602, "Expected resources/read params to be an object"));
		return;
	}

	const uri = typeof message.params.uri === "string" ? message.params.uri.trim() : "";
	if (!uri) {
		await clientWriter.write(
			createJsonRpcError(message.id, -32602, "Expected resources/read params.uri to be a string"),
		);
		return;
	}

	const result = await createResourcesReadResult(uri);
	if (result === null) {
		await clientWriter.write(createJsonRpcError(message.id, -32602, `Unknown resource URI: ${uri}`));
		return;
	}

	await clientWriter.write(createJsonRpcResponse(message.id, result));
}

async function onInnerMessage(
	message: JsonRpcMessage,
	context: {
		allocateOuterServerRequestId: () => JsonRpcId;
		clientWriter: JsonRpcLineWriter;
		pendingClientRequests: Map<string, PendingClientRequest>;
		pendingInnerRequests: Map<string, PendingInnerRequest>;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	if (isJsonRpcRequest(message)) {
		const outerId = context.allocateOuterServerRequestId();
		context.pendingInnerRequests.set(jsonRpcIdKey(outerId), {
			innerId: message.id,
			method: message.method,
		});
		await context.clientWriter.write({
			...message,
			id: outerId,
		});
		return;
	}

	if (isJsonRpcNotification(message)) {
		await observeCodexEvent(message, context);
		await context.clientWriter.write(message);
		return;
	}

	if (isJsonRpcResponse(message) || isJsonRpcError(message)) {
		const clientRequest = context.pendingClientRequests.get(jsonRpcIdKey(message.id)) ?? null;
		if (clientRequest !== null) {
			context.pendingClientRequests.delete(jsonRpcIdKey(message.id));
		}

		const pendingToolCall = context.pendingToolCalls.get(jsonRpcIdKey(message.id));
		let normalizedResponseMessage = message;
		if (pendingToolCall) {
			// Outer MCP clients (e.g. Cursor) only see this JSON-RPC response. For agent-start / agent-reply we enrich
			// the inner tool result here so clients can read the Codex session id without a separate host hook.
			if (pendingToolCall.syntheticCompletionSent) {
				if (pendingToolCall.syntheticResultKind === "interrupted") {
					process.stderr.write(
						`[yolo-codex-mcp] Suppressed late inner response after synthetic interruption completion for ${formatPendingToolCallLogContext(
							pendingToolCall,
						)}.\n`,
					);
				}
				finishPendingToolCall(pendingToolCall, context.pendingToolCalls);
				return;
			}
			if (isJsonRpcResponse(message)) {
				normalizedResponseMessage = {
					...message,
					result: normalizeToolCallResult(message.result, pendingToolCall),
				};
			}
			finishPendingToolCall(pendingToolCall, context.pendingToolCalls);
		}

		if (clientRequest?.method === "initialize" && isJsonRpcResponse(message)) {
			await context.clientWriter.write({
				...message,
				result: createInitializeResultWithResourcesCapability(message.result),
			});
			return;
		}

		await context.clientWriter.write(normalizedResponseMessage);
	}
}

function createInitializeResultWithResourcesCapability(result: unknown): unknown {
	if (!isRecord(result)) {
		return result;
	}

	const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
	return {
		...result,
		capabilities: {
			...capabilities,
			resources: isRecord(capabilities.resources) ? capabilities.resources : {},
		},
	};
}

function createClientWorkspaceState(sessionId: string): ClientWorkspaceState {
	return {
		initializeEntries: [],
		rootsAdvertised: false,
		rootsEntries: [],
		rootsRequested: false,
		selectedCwd: null,
		selectedSource: null,
		selectionVersion: 0,
		sessionId,
		workspaceEntries: [],
	};
}

function observeClientWorkspaceMessage(
	message: JsonRpcMessage,
	state: ClientWorkspaceState,
	pendingInnerRequests: Map<string, PendingInnerRequest>,
): void {
	if (isJsonRpcRequest(message) && message.method === "initialize") {
		state.rootsAdvertised = detectClientRootsSupport(message.params);
		replaceWorkspaceEntries(state, "initializeEntries", extractClientWorkspaceEntries(message.params, "initialize"));
		logObservedClientWorkspaceState("initialize", state, {
			rootsAdvertised: state.rootsAdvertised,
		});
		return;
	}

	if (isJsonRpcRequest(message) || isJsonRpcNotification(message)) {
		if (message.method === "workspace/didChangeWorkspaceFolders") {
			const change = extractWorkspaceFolderChange(message.params, message.method);
			if (change.added.length === 0 && change.removed.length === 0) {
				return;
			}
			state.workspaceEntries = applyWorkspaceFolderChange(state.workspaceEntries, change.added, change.removed);
			logObservedClientWorkspaceState(message.method, state, {
				added: summarizeWorkspaceEntries(change.added),
				removed: summarizeWorkspaceEntries(change.removed),
			});
			return;
		}

		if (message.method.startsWith("workspace/")) {
			const entries = extractClientWorkspaceEntries(message.params, message.method);
			if (entries.length === 0) {
				return;
			}
			replaceWorkspaceEntries(state, "workspaceEntries", entries);
			logObservedClientWorkspaceState(message.method, state);
			return;
		}
	}

	if (!isJsonRpcResponse(message)) {
		return;
	}

	const pendingRequest = pendingInnerRequests.get(jsonRpcIdKey(message.id));
	if (!pendingRequest) {
		return;
	}

	if (pendingRequest.method === "roots/list") {
		observeWorkspaceRequestResult(message.result, state, pendingRequest.method);
		logObservedClientWorkspaceState(pendingRequest.method, state);
		return;
	}

	if (pendingRequest.method.startsWith("workspace/")) {
		const entries = extractClientWorkspaceEntries(message.result, pendingRequest.method);
		if (entries.length === 0) {
			return;
		}
		replaceWorkspaceEntries(state, "workspaceEntries", entries);
		logObservedClientWorkspaceState(pendingRequest.method, state);
	}
}

function observeWorkspaceRequestResult(
	result: unknown,
	state: ClientWorkspaceState,
	source: string,
): ClientWorkspaceEntry[] {
	const entries = extractClientWorkspaceEntries(result, source);
	if (source === "roots/list") {
		replaceWorkspaceEntries(state, "rootsEntries", entries);
	}
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
	if (!isRecord(value)) {
		return false;
	}
	if (!isRecord(value.capabilities)) {
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

export function fileUriToFilesystemPath(uri: string, platform: NodeJS.Platform = process.platform): string | null {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return null;
	}

	if (parsed.protocol !== "file:") {
		return null;
	}

	const hostname = parsed.hostname;
	const decodedPath = decodeURIComponent(parsed.pathname);
	if (platform === "win32") {
		if (hostname && hostname !== "localhost") {
			return `\\\\${hostname}${decodedPath.replaceAll("/", "\\")}`;
		}
		if (/^\/[A-Za-z]:/.test(decodedPath)) {
			return decodedPath.slice(1).replaceAll("/", "\\");
		}
		// Preserve POSIX-style file URIs like file:///tmp/repo on Windows instead of
		// fabricating \\tmp\\repo, which is not a meaningful Windows filesystem path.
		return decodedPath || "/";
	}

	if (hostname && hostname !== "localhost") {
		return `//${hostname}${decodedPath}`;
	}
	return decodedPath || "/";
}

function resolveClientDerivedCwd(state: ClientWorkspaceState): ResolvedClientCwd | null {
	const candidates = [
		{
			detail: "roots/list",
			entries: state.rootsEntries,
			source: "client-roots",
		},
		{
			detail: "workspace context",
			entries: state.workspaceEntries,
			source: "client-workspace",
		},
		{
			detail: "initialize payload",
			entries: state.initializeEntries,
			source: "client-initialize",
		},
	];

	for (const candidateGroup of candidates) {
		const pathEntries = candidateGroup.entries.filter((entry) => entry.path !== null);
		if (pathEntries.length === 0) {
			continue;
		}

		return {
			candidateCount: pathEntries.length,
			cwd: pathEntries[0].path ?? "",
			detail: pathEntries.length > 1 ? `${candidateGroup.detail} first root` : `${candidateGroup.detail} only root`,
			source: candidateGroup.source,
		};
	}

	return null;
}

function resolveToolCallCwd(state: ClientWorkspaceState): {
	candidateCount: number;
	cwd: string;
	detail: string;
	selectionSource: string;
	source: "client-derived" | "process.cwd()";
	warning: string | null;
} {
	const clientDerived = resolveClientDerivedCwd(state);
	if (clientDerived !== null) {
		return {
			...clientDerived,
			selectionSource: clientDerived.source,
			source: "client-derived",
			warning: null,
		};
	}

	return {
		candidateCount: 0,
		cwd: process.cwd(),
		detail: "last-resort process.cwd() fallback",
		selectionSource: "process.cwd()",
		source: "process.cwd()",
		warning: "No usable client-derived workspace cwd was available for this call.",
	};
}

async function maybeRequestClientRoots(
	reason: string,
	context: {
		allocateOuterServerRequestId: () => JsonRpcId;
		clientWorkspaceState: ClientWorkspaceState;
		clientWriter: JsonRpcLineWriter;
		pendingWorkspaceRequests: Map<string, PendingWorkspaceRequest>;
	},
): Promise<void> {
	if (!context.clientWorkspaceState.rootsAdvertised) {
		return;
	}
	if (context.clientWorkspaceState.rootsEntries.length > 0 || context.clientWorkspaceState.rootsRequested) {
		return;
	}
	if (context.pendingWorkspaceRequests.size > 0) {
		return;
	}

	const requestId = context.allocateOuterServerRequestId();
	context.clientWorkspaceState.rootsRequested = true;
	context.pendingWorkspaceRequests.set(jsonRpcIdKey(requestId), {
		method: "roots/list",
		reason,
	});
	writeTaggedLog(
		"client-cwd",
		createLogPayload(
			context.clientWorkspaceState.sessionId,
			"roots-requested",
			"info",
			context.clientWorkspaceState.selectionVersion,
			{
				method: "roots/list",
				reason,
				status: "requesting",
			},
		),
	);
	await context.clientWriter.write({
		id: requestId,
		jsonrpc: "2.0",
		method: "roots/list",
		params: {},
	});
}

function logWorkspaceRequestCompletion(request: PendingWorkspaceRequest, state: ClientWorkspaceState): void {
	logObservedClientWorkspaceState(request.method, state, {
		reason: request.reason,
		status: "completed",
	});
}

function logObservedClientWorkspaceState(
	source: string,
	state: ClientWorkspaceState,
	extra: Record<string, unknown> = {},
): void {
	maybeLogClientCwdSelectionChange(source, state, extra);
	const selected = resolveClientDerivedCwd(state);
	const heuristic = getSelectionHeuristic(selected);
	writeTaggedLog(
		"client-cwd",
		createLogPayload(
			state.sessionId,
			"workspace-observed",
			heuristic === null ? "info" : "warn",
			state.selectionVersion,
			{
				...extra,
				activeInitialize: summarizeWorkspaceEntries(state.initializeEntries),
				activeRoots: summarizeWorkspaceEntries(state.rootsEntries),
				activeWorkspace: summarizeWorkspaceEntries(state.workspaceEntries),
				candidateCount: selected?.candidateCount ?? 0,
				heuristic,
				selectedCwd: selected?.cwd ?? null,
				selectedSource: selected?.source ?? null,
				source,
			},
		),
	);
}

function maybeLogClientCwdSelectionChange(
	trigger: string,
	state: ClientWorkspaceState,
	extra: Record<string, unknown> = {},
): void {
	const selected = resolveClientDerivedCwd(state);
	const nextCwd = selected?.cwd ?? null;
	const nextSource = selected?.source ?? null;
	if (state.selectedCwd === nextCwd && state.selectedSource === nextSource) {
		return;
	}

	const wasStartupBaseline =
		state.selectionVersion === 0 && state.selectedCwd === null && state.selectedSource === null;
	const previous = wasStartupBaseline
		? {
				cwd: process.cwd(),
				kind: "startup-baseline",
				source: "process.cwd()",
			}
		: state.selectedCwd === null && state.selectedSource === null
			? null
			: {
					cwd: state.selectedCwd,
					kind: "client-derived",
					source: state.selectedSource,
				};

	state.selectionVersion += 1;
	state.selectedCwd = nextCwd;
	state.selectedSource = nextSource;

	const heuristic = getSelectionHeuristic(selected);
	writeTaggedLog(
		"client-cwd",
		createLogPayload(
			state.sessionId,
			"selection-changed",
			heuristic === null ? "info" : "warn",
			state.selectionVersion,
			{
				...(extra.reason !== undefined ? { reason: extra.reason } : {}),
				candidateCount: selected?.candidateCount ?? 0,
				from: previous,
				heuristic,
				to:
					selected === null
						? null
						: {
								candidateCount: selected.candidateCount,
								cwd: selected.cwd,
								heuristic,
								kind: "client-derived",
								source: selected.source,
							},
				trigger,
			},
		),
	);
}

function getSelectionHeuristic(selected: ResolvedClientCwd | null): string | null {
	return selected !== null && selected.candidateCount > 1 ? "first-root" : null;
}

function logToolCallCwdDecision(
	requestId: JsonRpcId,
	toolName: PendingToolCall["toolName"],
	resolved: {
		candidateCount: number;
		cwd: string;
		detail: string;
		selectionSource: string;
		source: "client-derived" | "process.cwd()";
		warning: string | null;
	},
	state: ClientWorkspaceState,
): void {
	if (resolved.source === "process.cwd()") {
		writeTaggedLog(
			"cwd-fallback",
			createLogPayload(state.sessionId, "tool-call-fallback", "warn", state.selectionVersion, {
				cwd: resolved.cwd,
				cwdSource: resolved.selectionSource,
				detail: resolved.detail,
				requestId,
				tool: toolName,
				warning: resolved.warning,
			}),
		);
	}

	writeTaggedLog(
		"cwd",
		createLogPayload(
			state.sessionId,
			"tool-call-cwd",
			resolved.source === "process.cwd()" ? "warn" : "info",
			state.selectionVersion,
			{
				activeClientRoots: summarizeWorkspaceEntries(state.rootsEntries),
				activeWorkspaceRoots: summarizeWorkspaceEntries(state.workspaceEntries),
				candidateCount: resolved.candidateCount,
				cwd: resolved.cwd,
				cwdSource: resolved.selectionSource,
				detail: resolved.detail,
				requestId,
				source: resolved.source,
				tool: toolName,
				warning: resolved.warning,
			},
		),
	);
}

function logForwardedToolArguments(
	requestId: JsonRpcId,
	toolName: PendingToolCall["toolName"],
	argumentsValue: Record<string, unknown>,
	resolved: {
		selectionSource: string;
	},
	state: ClientWorkspaceState,
): void {
	writeTaggedLog(
		"tools-forward",
		createLogPayload(state.sessionId, "forward-to-inner", "info", state.selectionVersion, {
			arguments: argumentsValue,
			cwdSource: resolved.selectionSource,
			forwardedCwd: readOptionalWorkspaceString(argumentsValue.cwd),
			requestId,
			tool: toolName,
		}),
	);
}

function logIgnoredLegacyToolCwd(
	requestId: JsonRpcId,
	toolName: PendingToolCall["toolName"],
	cwd: string,
	state: ClientWorkspaceState,
): void {
	writeTaggedLog(
		"cwd-legacy",
		createLogPayload(state.sessionId, "ignored-legacy-cwd", "warn", state.selectionVersion, {
			ignoredCwd: cwd,
			reason:
				"Outer tool cwd is legacy-only and ignored. The wrapper derives cwd server-side from client workspace context.",
			requestId,
			tool: toolName,
		}),
	);
}

function summarizeWorkspaceEntries(entries: ClientWorkspaceEntry[]): Array<Record<string, unknown>> {
	return entries.map((entry) => ({
		name: entry.name,
		path: entry.path,
		source: entry.source,
		uri: entry.uri,
	}));
}

function createPendingToolCall(
	callId: JsonRpcId,
	toolName: PendingToolCall["toolName"],
	threadId: string | null = null,
): PendingToolCall {
	return {
		callId,
		cleanupTimer: null,
		completed: false,
		lastAgentMessage: null,
		pollInFlight: false,
		pollTimer: null,
		rolloutPath: null,
		startedAtMs: Date.now(),
		syntheticCompletionSent: false,
		syntheticResultKind: null,
		threadId,
		toolName,
	};
}

function startPendingToolCallPolling(
	pendingToolCall: PendingToolCall,
	context: {
		clientWriter: JsonRpcLineWriter;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): void {
	if (pendingToolCall.pollTimer !== null) {
		return;
	}
	pendingToolCall.pollTimer = setInterval(() => {
		void pollPendingToolCall(pendingToolCall, context);
	}, ROLLOUT_POLL_INTERVAL_MS);
	pendingToolCall.pollTimer.unref();
}

function stopPendingToolCallPolling(pendingToolCall: PendingToolCall): void {
	if (pendingToolCall.pollTimer === null) {
		return;
	}
	clearInterval(pendingToolCall.pollTimer);
	pendingToolCall.pollTimer = null;
}

function finishPendingToolCall(pendingToolCall: PendingToolCall, pendingToolCalls: Map<string, PendingToolCall>): void {
	pendingToolCall.completed = true;
	stopPendingToolCallPolling(pendingToolCall);
	if (pendingToolCall.cleanupTimer !== null) {
		clearTimeout(pendingToolCall.cleanupTimer);
		pendingToolCall.cleanupTimer = null;
	}
	pendingToolCalls.delete(jsonRpcIdKey(pendingToolCall.callId));
}

function retainPendingToolCallUntilInnerCompletion(
	pendingToolCall: PendingToolCall,
	pendingToolCalls: Map<string, PendingToolCall>,
): void {
	pendingToolCall.completed = true;
	stopPendingToolCallPolling(pendingToolCall);
	if (pendingToolCall.cleanupTimer !== null) {
		return;
	}
	pendingToolCall.cleanupTimer = setTimeout(() => {
		pendingToolCall.cleanupTimer = null;
		pendingToolCalls.delete(jsonRpcIdKey(pendingToolCall.callId));
	}, 60_000);
	pendingToolCall.cleanupTimer.unref();
}

async function observeCodexEvent(
	message: JsonRpcMessage,
	context: {
		clientWriter: JsonRpcLineWriter;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	if (!isJsonRpcNotification(message)) {
		return;
	}
	const snapshot = parseCodexEventSnapshot(message);
	if (snapshot === null) {
		return;
	}

	const pendingToolCall =
		(snapshot.requestId !== null ? context.pendingToolCalls.get(jsonRpcIdKey(snapshot.requestId)) : undefined) ??
		findPendingToolCallByThreadId(context.pendingToolCalls, snapshot.threadId);
	if (!pendingToolCall || pendingToolCall.completed || pendingToolCall.syntheticCompletionSent) {
		return;
	}

	// Inner Codex emits thread id on codex/event before the tool call finishes; stash it for normalizeToolCallResult.
	if (snapshot.threadId !== null) {
		pendingToolCall.threadId = snapshot.threadId;
	}
	if (snapshot.rolloutPath !== null) {
		setPendingToolCallRolloutPath(
			pendingToolCall,
			normalizeRolloutPathForFilesystem(snapshot.rolloutPath, context.sessionRoot),
			`codex/event ${snapshot.type ?? "unknown"}`,
		);
	}
	if (snapshot.lastAgentMessage !== null) {
		pendingToolCall.lastAgentMessage = snapshot.lastAgentMessage;
	}
	await resolvePendingToolCallRolloutPath(pendingToolCall, context.sessionRoot);
	if (snapshot.type === "turn_aborted") {
		process.stderr.write(
			`[yolo-codex-mcp] Observed turn_aborted via live codex/event for ${formatPendingToolCallLogContext(
				pendingToolCall,
				snapshot.reason,
			)}.\n`,
		);
		await emitSyntheticInterruptedToolCallResult(pendingToolCall, context, "live codex/event", snapshot.reason);
	}
}

function setPendingToolCallRolloutPath(
	pendingToolCall: PendingToolCall,
	rolloutPath: string | null,
	source: string,
): string | null {
	if (rolloutPath === null || pendingToolCall.rolloutPath === rolloutPath) {
		return pendingToolCall.rolloutPath;
	}

	pendingToolCall.rolloutPath = rolloutPath;
	process.stderr.write(
		`[yolo-codex-mcp] Resolved rollout path via ${source} for request ${String(pendingToolCall.callId)}${
			pendingToolCall.threadId === null ? "" : ` thread ${pendingToolCall.threadId}`
		}: ${rolloutPath}\n`,
	);
	return rolloutPath;
}

function findPendingToolCallByThreadId(
	pendingToolCalls: Map<string, PendingToolCall>,
	threadId: string | null,
): PendingToolCall | null {
	if (threadId === null) {
		return null;
	}

	let newestMatch: PendingToolCall | null = null;
	for (const pendingToolCall of pendingToolCalls.values()) {
		if (pendingToolCall.completed || pendingToolCall.threadId !== threadId) {
			continue;
		}
		if (newestMatch === null || newestMatch.startedAtMs < pendingToolCall.startedAtMs) {
			newestMatch = pendingToolCall;
		}
	}
	return newestMatch;
}

function parseCodexEventSnapshot(message: JsonRpcMessage): CodexEventSnapshot | null {
	if (!isJsonRpcNotification(message) || message.method !== "codex/event" || !isRecord(message.params)) {
		return null;
	}

	const meta = isRecord(message.params._meta) ? message.params._meta : null;
	const eventMessage = isRecord(message.params.msg) ? message.params.msg : null;
	return {
		lastAgentMessage: readOptionalRecordString(eventMessage, "last_agent_message"),
		reason: readOptionalRecordString(eventMessage, "reason"),
		requestId: readJsonRpcId(meta?.requestId),
		rolloutPath: readOptionalRecordString(eventMessage, "rollout_path"),
		threadId:
			readOptionalRecordString(meta, "threadId") ??
			readOptionalRecordString(eventMessage, "session_id") ??
			readOptionalRecordString(message.params, "threadId"),
		type: readOptionalRecordString(eventMessage, "type"),
	};
}

async function pollPendingToolCall(
	pendingToolCall: PendingToolCall,
	context: {
		clientWriter: JsonRpcLineWriter;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	if (pendingToolCall.completed || pendingToolCall.syntheticCompletionSent || pendingToolCall.pollInFlight) {
		return;
	}
	pendingToolCall.pollInFlight = true;
	try {
		process.stderr.write(
			`[yolo-codex-mcp] Polling rollout fallback for request ${String(pendingToolCall.callId)}${
				pendingToolCall.threadId === null ? "" : ` thread ${pendingToolCall.threadId}`
			} rollout ${pendingToolCall.rolloutPath ?? "<unresolved>"}.\n`,
		);
		await resolvePendingToolCallRolloutPath(pendingToolCall, context.sessionRoot);
		if (pendingToolCall.threadId === null && pendingToolCall.rolloutPath !== null) {
			pendingToolCall.threadId = inferThreadIdFromRolloutPath(pendingToolCall.rolloutPath);
		}

		const rolloutSnapshot =
			pendingToolCall.rolloutPath === null ? null : await readRolloutTerminalSnapshot(pendingToolCall.rolloutPath);
		const rolloutThreadId = rolloutSnapshot?.threadId ?? null;
		if (rolloutThreadId !== null) {
			pendingToolCall.threadId = rolloutThreadId;
		}
		const rolloutLastAgentMessage = rolloutSnapshot?.lastAgentMessage ?? null;
		if (rolloutLastAgentMessage !== null) {
			pendingToolCall.lastAgentMessage = rolloutLastAgentMessage;
		}
		if (rolloutSnapshot?.terminalState === "aborted") {
			process.stderr.write(
				`[yolo-codex-mcp] Observed turn_aborted via rollout polling for ${formatPendingToolCallLogContext(
					pendingToolCall,
					rolloutSnapshot.reason,
				)}.\n`,
			);
			await emitSyntheticInterruptedToolCallResult(pendingToolCall, context, "rollout polling", rolloutSnapshot.reason);
			return;
		}

		const threadId =
			pendingToolCall.threadId ??
			(pendingToolCall.rolloutPath === null ? null : inferThreadIdFromRolloutPath(pendingToolCall.rolloutPath));
		if (threadId === null || (rolloutSnapshot === null && pendingToolCall.lastAgentMessage === null)) {
			return;
		}

		await context.clientWriter.write(
			createJsonRpcResponse(
				pendingToolCall.callId,
				createSyntheticToolCallResult(threadId, pendingToolCall.lastAgentMessage ?? ""),
			),
		);
		pendingToolCall.syntheticCompletionSent = true;
		pendingToolCall.syntheticResultKind = "completion";
		retainPendingToolCallUntilInnerCompletion(pendingToolCall, context.pendingToolCalls);
		process.stderr.write(
			`[yolo-codex-mcp] Synthesized ${pendingToolCall.toolName} completion from rollout polling for request ${String(
				pendingToolCall.callId,
			)} thread ${threadId} rollout ${pendingToolCall.rolloutPath ?? "<unresolved>"}.\n`,
		);
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[yolo-codex-mcp] Rollout polling failed: ${messageText}\n`);
	} finally {
		pendingToolCall.pollInFlight = false;
	}
}

async function emitSyntheticInterruptedToolCallResult(
	pendingToolCall: PendingToolCall,
	context: {
		clientWriter: JsonRpcLineWriter;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
	source: "live codex/event" | "rollout polling",
	reason: string | null,
): Promise<void> {
	if (pendingToolCall.completed || pendingToolCall.syntheticCompletionSent) {
		return;
	}

	await resolvePendingToolCallRolloutPath(pendingToolCall, context.sessionRoot);
	const threadId =
		pendingToolCall.threadId ??
		(pendingToolCall.rolloutPath === null ? null : inferThreadIdFromRolloutPath(pendingToolCall.rolloutPath));
	if (threadId !== null) {
		pendingToolCall.threadId = threadId;
	}

	await context.clientWriter.write(
		createJsonRpcResponse(pendingToolCall.callId, createSyntheticInterruptedToolCallResult(threadId, reason)),
	);
	pendingToolCall.syntheticCompletionSent = true;
	pendingToolCall.syntheticResultKind = "interrupted";
	retainPendingToolCallUntilInnerCompletion(pendingToolCall, context.pendingToolCalls);
	process.stderr.write(
		`[yolo-codex-mcp] Synthesized ${pendingToolCall.toolName} interruption result from ${source} for ${formatPendingToolCallLogContext(
			pendingToolCall,
			reason,
		)}.\n`,
	);
}

async function resolvePendingToolCallRolloutPath(
	pendingToolCall: PendingToolCall,
	sessionRoot: ResolvedSessionRoot | null,
): Promise<string | null> {
	if (pendingToolCall.rolloutPath !== null) {
		return pendingToolCall.rolloutPath;
	}
	if (sessionRoot === null) {
		return null;
	}

	const candidates = await listRolloutCandidates(sessionRoot.path, pendingToolCall.threadId);
	if (candidates.length === 0) {
		return null;
	}

	const sortedCandidates = candidates
		.slice()
		.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
	if (pendingToolCall.threadId !== null) {
		return setPendingToolCallRolloutPath(
			pendingToolCall,
			sortedCandidates[0]?.path ?? null,
			`sessions scan (${sessionRoot.source})`,
		);
	}

	const recentCandidate =
		sortedCandidates.find((candidate) => candidate.mtimeMs >= pendingToolCall.startedAtMs - 1_000) ?? null;
	return setPendingToolCallRolloutPath(
		pendingToolCall,
		recentCandidate?.path ?? null,
		`sessions scan (${sessionRoot.source})`,
	);
}

async function listRolloutCandidates(rootPath: string, threadId: string | null): Promise<RolloutCandidate[]> {
	const candidates: RolloutCandidate[] = [];
	await collectRolloutCandidates(rootPath, threadId, candidates);
	return candidates;
}

async function collectRolloutCandidates(
	rootPath: string,
	threadId: string | null,
	candidates: RolloutCandidate[],
): Promise<void> {
	try {
		const entries = await readdir(rootPath, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(rootPath, entry.name);
			if (entry.isDirectory()) {
				await collectRolloutCandidates(entryPath, threadId, candidates);
				continue;
			}
			if (!entry.isFile() || !matchesRolloutFileName(entry.name, threadId)) {
				continue;
			}
			try {
				const entryStat = await stat(entryPath);
				candidates.push({
					mtimeMs: entryStat.mtimeMs,
					path: entryPath,
				});
			} catch {
				// Ignore files that disappear mid-scan.
			}
		}
	} catch {
		return;
	}
}

function matchesRolloutFileName(fileName: string, threadId: string | null): boolean {
	if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) {
		return false;
	}
	return threadId === null ? true : fileName.endsWith(`-${threadId}.jsonl`);
}

async function readRolloutTerminalSnapshot(rolloutPath: string): Promise<RolloutTerminalSnapshot | null> {
	return parseRolloutTerminalLine(await readLastRolloutLine(rolloutPath));
}

async function readLastRolloutLine(rolloutPath: string): Promise<string | null> {
	const fileHandle = await open(rolloutPath, "r");
	try {
		const fileStat = await fileHandle.stat();
		if (fileStat.size === 0) {
			return null;
		}

		let buffered = "";
		let position = fileStat.size;
		while (position > 0) {
			const readSize = Math.min(4_096, position);
			position -= readSize;
			const chunkBuffer = Buffer.alloc(readSize);
			const { bytesRead } = await fileHandle.read(chunkBuffer, 0, readSize, position);
			buffered = chunkBuffer.toString("utf8", 0, bytesRead) + buffered;
			if (buffered.includes("\n")) {
				break;
			}
		}

		const lines = buffered
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		return lines.at(-1) ?? null;
	} finally {
		await fileHandle.close();
	}
}

function parseRolloutTerminalLine(line: string | null): RolloutTerminalSnapshot | null {
	if (!line) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}

	const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
	const eventMessage = isRecord(payload.msg) ? payload.msg : null;
	const eventType = readOptionalRecordString(eventMessage, "type");
	if (eventType !== "task_complete" && eventType !== "turn_complete" && eventType !== "turn_aborted") {
		return null;
	}

	return {
		lastAgentMessage: readOptionalRecordString(eventMessage, "last_agent_message"),
		reason: readOptionalRecordString(eventMessage, "reason"),
		terminalState: eventType === "turn_aborted" ? "aborted" : "completed",
		threadId:
			readOptionalRecordString(payload, "threadId") ??
			readOptionalRecordString(isRecord(payload._meta) ? payload._meta : null, "threadId"),
	};
}

/** Same thread-id surface as real inner completions so clients always get a consistent tool result shape. */
function createSyntheticToolCallResult(threadId: string, content: string) {
	return addThreadContextToToolResult(
		{
			content: [
				{
					type: "text",
					text: content,
				},
			],
			structuredContent: {
				content,
			},
		},
		threadId,
	);
}

function createSyntheticInterruptedToolCallResult(threadId: string | null, reason: string | null) {
	const content = createInterruptedToolCallMessage(reason);
	if (threadId === null) {
		return {
			content: [
				{
					type: "text",
					text: content,
				},
			],
			isError: true,
		};
	}

	return addThreadContextToToolResult(
		{
			content: [
				{
					type: "text",
					text: content,
				},
			],
			isError: true,
			structuredContent: {
				content,
			},
		},
		threadId,
	);
}

/**
 * Ensures the tool result forwarded to the outer MCP client includes the Codex session thread id.
 * Resolution order: id already present on the inner result, then pending state from codex/event / rollout filename.
 * When no id can be found, the inner payload is passed through unchanged.
 */
function normalizeToolCallResult(result: unknown, pendingToolCall: PendingToolCall): unknown {
	if (!isRecord(result)) {
		return result;
	}

	const threadId =
		readToolResultThreadId(result) ??
		pendingToolCall.threadId ??
		(pendingToolCall.rolloutPath === null ? null : inferThreadIdFromRolloutPath(pendingToolCall.rolloutPath));
	if (threadId === null) {
		return result;
	}

	pendingToolCall.threadId = threadId;
	return addThreadContextToToolResult(result, threadId);
}

/** Reads thread id the inner server may already attach to the tool result (top-level or structuredContent). */
function readToolResultThreadId(result: Record<string, unknown>): string | null {
	return (
		readOptionalRecordString(result, "threadId") ??
		readOptionalRecordString(isRecord(result.structuredContent) ? result.structuredContent : null, "threadId") ??
		readOptionalRecordString(isRecord(result.structuredContent) ? result.structuredContent : null, "thread_id")
	);
}

/**
 * Mutates the CallToolResult-shaped object so MCP clients can discover the session id:
 * - Appends a final `content` text item: `threadId: <uuid>` (human-visible in UIs that show tool output).
 * - Sets `structuredContent.threadId` and `structuredContent.thread_id` (machine-readable; some clients prefer one key).
 * - Fills `structuredContent.content` when missing so structured output stays aligned with visible text.
 */
function addThreadContextToToolResult(result: Record<string, unknown>, threadId: string): Record<string, unknown> {
	const threadIdLine = `threadId: ${threadId}`;
	const content = Array.isArray(result.content) ? [...result.content] : [];
	if (
		!content.some(
			(item) => isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text === threadIdLine,
		)
	) {
		content.push({
			type: "text",
			text: threadIdLine,
		});
	}

	const existingStructuredContent = isRecord(result.structuredContent) ? result.structuredContent : {};
	const structuredContentValue =
		readOptionalRecordString(existingStructuredContent, "content") ?? readPrimaryToolResultText(content, threadIdLine);

	return {
		...result,
		content: [...content],
		structuredContent: {
			...existingStructuredContent,
			...(structuredContentValue === null ? {} : { content: structuredContentValue }),
			threadId,
			thread_id: threadId,
		},
	};
}

function readPrimaryToolResultText(content: unknown[], threadIdLine: string): string | null {
	for (const item of content) {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string" || item.text === threadIdLine) {
			continue;
		}
		return item.text;
	}

	return null;
}

function createInterruptedToolCallMessage(reason: string | null): string {
	if (reason === "replaced") {
		return "Smart Cheap Agent run was aborted before the inner MCP returned a final tool result (reason: replaced).";
	}
	if (reason === "review_ended") {
		return "Smart Cheap Agent run was aborted before the inner MCP returned a final tool result (reason: review_ended).";
	}
	return `Smart Cheap Agent run was interrupted before the inner MCP returned a final tool result${
		reason === null ? "." : ` (reason: ${reason}).`
	}`;
}

function formatPendingToolCallLogContext(pendingToolCall: PendingToolCall, reason: string | null = null): string {
	return `request ${String(pendingToolCall.callId)}${pendingToolCall.threadId === null ? "" : ` thread ${pendingToolCall.threadId}`}${
		pendingToolCall.rolloutPath === null ? "" : ` rollout ${pendingToolCall.rolloutPath}`
	}${reason === null ? "" : ` reason ${reason}`}`;
}

function inferThreadIdFromRolloutPath(rolloutPath: string): string | null {
	const match = /^rollout-.*-([^/\\]+)\.jsonl$/.exec(path.basename(rolloutPath));
	return match?.[1] ?? null;
}

export function normalizeRolloutPathForFilesystem(
	rolloutPath: string,
	sessionRoot: ResolvedSessionRoot | null,
	options: {
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		wslDistro?: string | null;
	} = {},
): string {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32" || !rolloutPath.startsWith("/")) {
		return rolloutPath;
	}

	const wslDistro =
		sessionRoot?.wslDistro ??
		options.wslDistro ??
		(options.env === undefined
			? lookupWslSessionsRoot(process.env)?.distro
			: lookupWslSessionsRoot(options.env)?.distro) ??
		null;
	return wslDistro === null ? rolloutPath : `\\\\wsl$\\${wslDistro}${rolloutPath.replace(/\//g, "\\")}`;
}

function readOptionalRecordString(record: Record<string, unknown> | null, key: string): string | null {
	if (record === null) {
		return null;
	}
	const value = record[key];
	return typeof value === "string" && value.trim() ? value : null;
}

function readJsonRpcId(value: unknown): JsonRpcId | null {
	return typeof value === "number" || typeof value === "string" || value === null ? value : null;
}

export function resolveSessionRoot(
	spawnSpec: { args: string[]; command: string },
	env: NodeJS.ProcessEnv = process.env,
	options: {
		platform?: NodeJS.Platform;
		wslSessionsRootLookup?: (env: NodeJS.ProcessEnv) => WslSessionsRoot | null;
	} = {},
): ResolvedSessionRoot | null {
	const platform = options.platform ?? process.platform;
	if (platform === "win32" && isWslLaunch(spawnSpec)) {
		const wslSessionsRoot = (options.wslSessionsRootLookup ?? lookupWslSessionsRoot)(env);
		if (wslSessionsRoot !== null) {
			return {
				path: `\\\\wsl$\\${wslSessionsRoot.distro}${wslSessionsRoot.sessionsRoot.replace(/\//g, "\\")}`,
				source: "wsl",
				wslDistro: wslSessionsRoot.distro,
			};
		}
	}

	const nativeSessionRoot = getNativeSessionRoot(platform, env);
	return nativeSessionRoot === null
		? null
		: {
				path: nativeSessionRoot,
				source: "native",
				wslDistro: null,
			};
}

function isWslLaunch(spawnSpec: { args: string[]; command: string }): boolean {
	return /(^|[\\/])wsl\.exe$/i.test(spawnSpec.command) || spawnSpec.command === "wsl.exe";
}

function getNativeSessionRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
	const configuredCodexHome = getConfiguredCodexHome(platform, env);
	if (configuredCodexHome !== null) {
		return joinCodexSessionsPath(platform, configuredCodexHome);
	}

	if (platform === "win32") {
		const basePath = env.USERPROFILE ?? homedir();
		return basePath ? path.win32.join(basePath, ".codex", "sessions") : null;
	}

	const basePath = env.HOME ?? homedir();
	return basePath ? path.posix.join(basePath, ".codex", "sessions") : null;
}

function getConfiguredCodexHome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
	const configured = env.CODEX_HOME?.trim();
	if (!configured) {
		return null;
	}
	if (platform === "win32") {
		return path.win32.isAbsolute(configured) ? configured : null;
	}
	return configured.startsWith("/") ? configured : null;
}

function joinCodexSessionsPath(platform: NodeJS.Platform, codexHome: string): string {
	return platform === "win32" ? path.win32.join(codexHome, "sessions") : path.posix.join(codexHome, "sessions");
}

function attachLineReader(
	input: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): {
	close: () => void;
} {
	let buffered = "";
	const onData = (chunk: Buffer | string) => {
		buffered += String(chunk);

		for (;;) {
			const newlineIndex = buffered.indexOf("\n");
			if (newlineIndex < 0) {
				return;
			}

			const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
			buffered = buffered.slice(newlineIndex + 1);
			onLine(line);
		}
	};

	input.on("data", onData);

	return {
		close: () => {
			input.off("data", onData);
		},
	};
}

async function handleLine(line: string, onMessage: (message: JsonRpcMessage) => Promise<void>): Promise<void> {
	if (!line.trim()) {
		return;
	}

	try {
		const message = parseJsonRpcMessage(line);
		if (message !== null) {
			await onMessage(message);
		}
	} catch (error) {
		const errorText = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Failed to parse JSON-RPC message: ${errorText}\n`);
	}
}

async function ensureInnerProcessStarted(
	inner: ChildProcessWithoutNullStreams,
	spawnSpec: { args: string[]; command: string },
): Promise<void> {
	const startup = new Promise<void>((resolve, reject) => {
		inner.once("spawn", () => resolve());
		inner.once("error", (error) => reject(error));
	});

	try {
		await startup;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start inner Codex MCP server via ${formatSpawnSpec(spawnSpec)}: ${message}`);
	}
}

function formatSpawnSpec(spawnSpec: { args: string[]; command: string }): string {
	return [spawnSpec.command, ...spawnSpec.args].map(quoteForCmd).join(" ");
}

function prefixInnerStderr(chunk: Buffer | string): string {
	const text = String(chunk);
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	return `[inner codex] ${normalized.replaceAll("\n", "\n[inner codex] ")}${text.endsWith("\n") ? "\n" : ""}`;
}

function logInboundClientMessage(
	message: JsonRpcMessage,
	pendingInnerRequests: Map<string, PendingInnerRequest>,
	pendingWorkspaceRequests: Map<string, PendingWorkspaceRequest>,
): void {
	const logEntry = createInboundLogEntry(message, pendingInnerRequests, pendingWorkspaceRequests);
	if (logEntry === null) {
		return;
	}

	process.stderr.write(`[yolo-codex-mcp][mcp-in] ${JSON.stringify(logEntry)}\n`);
}

function createInboundLogEntry(
	message: JsonRpcMessage,
	pendingInnerRequests: Map<string, PendingInnerRequest>,
	pendingWorkspaceRequests: Map<string, PendingWorkspaceRequest>,
): Record<string, unknown> | null {
	if (isJsonRpcRequest(message)) {
		if (!shouldLogInboundMethod(message.method)) {
			return null;
		}

		return {
			id: message.id,
			kind: "request",
			method: message.method,
			params: message.params,
		};
	}

	if (isJsonRpcNotification(message)) {
		if (!shouldLogInboundMethod(message.method)) {
			return null;
		}

		return {
			kind: "notification",
			method: message.method,
			params: message.params,
		};
	}

	const pendingRequest =
		pendingInnerRequests.get(jsonRpcIdKey(message.id)) ?? pendingWorkspaceRequests.get(jsonRpcIdKey(message.id));
	if (!pendingRequest || !shouldLogInboundMethod(pendingRequest.method)) {
		return null;
	}

	if (isJsonRpcResponse(message)) {
		return {
			forMethod: pendingRequest.method,
			id: message.id,
			kind: "response",
			result: message.result,
		};
	}

	if (isJsonRpcError(message)) {
		return {
			error: message.error,
			forMethod: pendingRequest.method,
			id: message.id,
			kind: "error",
		};
	}

	return null;
}

function shouldLogInboundMethod(method: string): boolean {
	return (
		method === "initialize" ||
		method === "notifications/initialized" ||
		method === "tools/call" ||
		method.startsWith("elicitation/") ||
		method.startsWith("roots/") ||
		method.startsWith("workspace/") ||
		method.startsWith("$/")
	);
}

export function createInnerServerSpawnSpec(
	command: string,
	args: string[],
	options: {
		comSpec?: string;
		platform?: NodeJS.Platform;
	} = {},
): { args: string[]; command: string } {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32" || !isWindowsBatchCommand(command)) {
		return { command, args };
	}

	const comSpec = options.comSpec ?? process.env.ComSpec ?? "cmd.exe";
	return {
		command: comSpec,
		args: ["/d", "/s", "/c", formatCmdInvocation(command, args)],
	};
}

export function resolveInnerServerLaunch(
	command: string,
	args: string[],
	options: {
		env?: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
		pathLookup?: (candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string | null;
		pathRealpath?: (candidate: string) => string | null;
		platform?: NodeJS.Platform;
		wslLookup?: (env: NodeJS.ProcessEnv) => { args: string[]; command: string } | null;
	} = {},
): { args: string[]; command: string } {
	const resolvedCommand = resolveInnerServerCommand(command, options);
	if (resolvedCommand !== null) {
		return {
			command: resolvedCommand,
			args,
		};
	}

	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const wslLookup = options.wslLookup ?? lookupCodexInWsl;
	if (platform === "win32" && command.toLowerCase() === "codex") {
		const wslLaunch = wslLookup(env);
		if (wslLaunch !== null) {
			return {
				command: wslLaunch.command,
				args: [...wslLaunch.args, ...args],
			};
		}
	}

	throw new Error(createMissingInnerCommandMessage(command, platform));
}

export function resolveInnerServerCommand(
	command: string,
	options: {
		env?: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
		pathLookup?: (candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string | null;
		pathRealpath?: (candidate: string) => string | null;
		platform?: NodeJS.Platform;
	} = {},
): string | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const pathExists = options.pathExists ?? existsSync;
	const pathRealpath = options.pathRealpath ?? getRealpathIfAccessible;
	const pathLookup = options.pathLookup ?? lookupCommandOnPath;

	if (looksLikePath(command)) {
		if (platform === "win32") {
			return resolveWindowsSpawnablePath(command, pathExists, pathRealpath);
		}
		if (pathExists(command)) {
			return command;
		}
		return null;
	}

	const resolvedOnPath = pathLookup(command, platform, env);
	if (resolvedOnPath !== null) {
		if (platform === "win32") {
			return resolveWindowsSpawnablePath(resolvedOnPath, pathExists, pathRealpath);
		}
		return resolvedOnPath;
	}

	if (platform === "win32" && command.toLowerCase() === "codex") {
		for (const candidate of getCommonWindowsCodexCandidates(env)) {
			const resolvedCandidate = resolveWindowsSpawnablePath(candidate, pathExists, pathRealpath);
			if (resolvedCandidate !== null) {
				return resolvedCandidate;
			}
		}
	}

	return null;
}

function formatCmdInvocation(command: string, args: string[]): string {
	return [command, ...args].map(quoteForCmd).join(" ");
}

function isWindowsBatchCommand(command: string): boolean {
	return /\.(bat|cmd)$/i.test(command);
}

function quoteForCmd(value: string): string {
	if (value.length === 0) {
		return '""';
	}

	const escaped = value.replace(/"/g, '""');
	return /[\s"&<>|^]/.test(escaped) ? `"${escaped}"` : escaped;
}

function createMissingInnerCommandMessage(command: string, platform: NodeJS.Platform): string {
	const base = `Failed to resolve inner Codex MCP server command "${command}".`;
	if (platform !== "win32") {
		return `${base} The wrapper tried PATH lookup automatically. Ensure \`${command}\` is installed normally, or set CODEX_MCP_BIN to the full Codex path as a last-resort override.`;
	}

	return `${base} The wrapper tried PATH lookup, common Windows install locations, user shims, and WSL automatically. If Codex is installed normally it should usually work without extra config. As a last resort, set CODEX_MCP_BIN in your mcp.json env block to the full Codex path, for example "CODEX_MCP_BIN": "C:\\\\Users\\\\<you>\\\\AppData\\\\Local\\\\Programs\\\\Codex\\\\codex.exe". CODEX_BIN is also accepted for compatibility.`;
}

function resolveWindowsSpawnablePath(
	command: string,
	pathExists: (candidate: string) => boolean,
	pathRealpath: (candidate: string) => string | null,
	seen = new Set<string>(),
): string | null {
	const normalizedKey = path.win32.normalize(command).toLowerCase();
	if (seen.has(normalizedKey)) {
		return null;
	}
	seen.add(normalizedKey);

	if (path.win32.extname(command)) {
		return pathExists(command) ? command : null;
	}

	for (const extension of [".exe", ".cmd", ".bat"]) {
		const candidate = `${command}${extension}`;
		if (pathExists(candidate)) {
			return candidate;
		}
	}

	if (!pathExists(command)) {
		return null;
	}

	const realPath = pathRealpath(command);
	if (realPath !== null && !isSameWindowsPath(realPath, command)) {
		return resolveWindowsSpawnablePath(realPath, pathExists, pathRealpath, seen);
	}

	return null;
}

function getCommonWindowsCodexCandidates(env: NodeJS.ProcessEnv): string[] {
	const candidates = new Set<string>();
	const localAppData = env.LOCALAPPDATA;
	const appData = env.APPDATA;
	const userProfile = env.USERPROFILE;

	for (const base of [localAppData, userProfile].filter((value): value is string => Boolean(value))) {
		candidates.add(path.win32.join(base, "Programs", "Codex", "codex.exe"));
		candidates.add(path.win32.join(base, "Programs", "Codex", "codex.cmd"));
		candidates.add(path.win32.join(base, ".codex", "bin", "codex.exe"));
		candidates.add(path.win32.join(base, ".codex", "bin", "codex.cmd"));
		candidates.add(path.win32.join(base, "bin", "codex"));
		candidates.add(path.win32.join(base, "Programs", "OpenAI Codex", "codex.exe"));
		candidates.add(path.win32.join(base, "Programs", "OpenAI Codex", "codex.cmd"));
		candidates.add(path.win32.join(base, "Programs", "OpenAI", "Codex", "codex.exe"));
		candidates.add(path.win32.join(base, "Programs", "OpenAI", "Codex", "codex.cmd"));
	}

	if (localAppData) {
		candidates.add(path.win32.join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"));
		candidates.add(path.win32.join(localAppData, "Microsoft", "WinGet", "Links", "codex.cmd"));
	}

	if (appData) {
		candidates.add(path.win32.join(appData, "npm", "codex.cmd"));
	}
	if (userProfile) {
		candidates.add(path.win32.join(userProfile, "scoop", "shims", "codex.cmd"));
		candidates.add(path.win32.join(userProfile, "scoop", "shims", "codex.exe"));
		candidates.add(path.win32.join(userProfile, ".local", "bin", "codex"));
	}

	return [...candidates];
}

function lookupCommandOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
	const lookupCommand = platform === "win32" ? resolveWindowsWhereCommand(env) : "which";
	const lookup = spawnSync(lookupCommand, [command], {
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (lookup.status !== 0 || !lookup.stdout) {
		return null;
	}

	for (const match of lookup.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)) {
		if (platform !== "win32") {
			return match;
		}

		const resolved = resolveWindowsSpawnablePath(match, existsSync, getRealpathIfAccessible);
		if (resolved !== null) {
			return resolved;
		}
	}

	return null;
}

function resolveWindowsWhereCommand(env: NodeJS.ProcessEnv): string {
	const systemRoot = env.SystemRoot ?? env.WINDIR;
	return systemRoot ? path.win32.join(systemRoot, "System32", "where.exe") : "where";
}

function getRealpathIfAccessible(candidate: string): string | null {
	try {
		return realpathSync.native(candidate);
	} catch {
		return null;
	}
}

function isSameWindowsPath(left: string, right: string): boolean {
	return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function looksLikePath(command: string): boolean {
	return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
}

function lookupCodexInWsl(env: NodeJS.ProcessEnv): { args: string[]; command: string } | null {
	const wslCommand = resolveWindowsWslCommand(env);
	if (wslCommand === null) {
		return null;
	}

	const lookup = spawnSync(wslCommand, ["-e", "sh", "-lc", "command -v codex"], {
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (lookup.status !== 0 || !lookup.stdout?.trim()) {
		return null;
	}

	return {
		command: wslCommand,
		args: ["-e", "codex"],
	};
}

function lookupWslSessionsRoot(env: NodeJS.ProcessEnv): WslSessionsRoot | null {
	const wslCommand = resolveWindowsWslCommand(env);
	if (wslCommand === null) {
		return null;
	}

	const lookup = spawnSync(
		wslCommand,
		[
			"-e",
			"sh",
			"-lc",
			[
				'codex_bin="${CODEX_BIN:-}"',
				'case "$codex_bin" in',
				"  /*) ;;",
				'  *) codex_bin="" ;;',
				"esac",
				'if [ -z "$codex_bin" ]; then codex_bin=$(command -v codex 2>/dev/null || true); fi',
				'codex_home="${CODEX_HOME:-}"',
				'case "$codex_home" in',
				"  /*) ;;",
				'  *) codex_home="" ;;',
				"esac",
				'if [ -z "$codex_home" ]; then',
				'  case "$codex_bin" in',
				'    */.codex/bin/*/codex) codex_home="${codex_bin%/bin/*}" ;;',
				'    */.codex/bin/codex) codex_home="${codex_bin%/bin/codex}" ;;',
				"  esac",
				"fi",
				'if [ -z "$codex_home" ]; then codex_home="$HOME/.codex"; fi',
				'printf "__DISTRO__=%s\\n" "${WSL_DISTRO_NAME:-}"',
				'printf "__SESSIONS__=%s\\n" "$codex_home/sessions"',
			].join("\n"),
		],
		{
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (lookup.status !== 0 || !lookup.stdout) {
		return null;
	}

	const distro = readNamedShellValue(lookup.stdout, "DISTRO");
	const sessionsRoot = readNamedShellValue(lookup.stdout, "SESSIONS");
	return distro && sessionsRoot ? { distro, sessionsRoot } : null;
}

function readNamedShellValue(output: string, key: string): string {
	const match = output.match(new RegExp(`^__${key}__=(.*)$`, "m"));
	return match?.[1]?.trim() ?? "";
}

function resolveWindowsWslCommand(env: NodeJS.ProcessEnv): string | null {
	const systemRoot = env.SystemRoot ?? env.WINDIR;
	const candidates = [systemRoot ? path.win32.join(systemRoot, "System32", "wsl.exe") : null, "wsl.exe"].filter(
		(value): value is string => value !== null,
	);

	for (const candidate of candidates) {
		if (!looksLikePath(candidate)) {
			return candidate;
		}
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}
