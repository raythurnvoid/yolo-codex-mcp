import { existsSync, realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
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
import { loadProxyConfig, type DebugInboundMode } from "./proxy_config.ts";
import {
	buildInnerCodexArguments,
	buildInnerCodexReplyArguments,
	createReducedToolsListResult,
	createToolCallErrorResult,
	parseOuterCodexCall,
	parseOuterCodexReplyCall,
} from "./tool_contract.ts";

type PendingInnerRequest = {
	innerId: JsonRpcId;
	method: string;
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
	threadId: string | null;
	toolName: "codex" | "codex-reply";
};

type ResolvedSessionRoot = {
	path: string;
	source: "native" | "wsl";
	wslDistro: string | null;
};

type CodexEventSnapshot = {
	lastAgentMessage: string | null;
	requestId: JsonRpcId | null;
	rolloutPath: string | null;
	threadId: string | null;
	type: string | null;
};

type RolloutTaskCompleteSnapshot = {
	lastAgentMessage: string | null;
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

const ROLLOUT_POLL_INTERVAL_MS = 5_000;

export async function runProxyServer(): Promise<void> {
	const config = loadProxyConfig();
	process.stderr.write(`[yolo-codex-mcp] Raw CODEX_MCP_CWD: ${formatLoggedEnvValue(process.env.CODEX_MCP_CWD)}\n`);
	process.stderr.write(`[yolo-codex-mcp] Resolved Codex working directory: ${config.policy.cwd}\n`);
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
	const pendingInnerRequests = new Map<string, PendingInnerRequest>();
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
				clientWriter,
				config,
				innerWriter,
				pendingInnerRequests,
				pendingToolCalls,
				sessionRoot,
			});
		});
	});
	const innerReader = attachLineReader(inner.stdout, (line) => {
		void handleLine(line, async (message) => {
			await onInnerMessage(message, {
				clientWriter,
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
		clientWriter: JsonRpcLineWriter;
		config: ReturnType<typeof loadProxyConfig>;
		innerWriter: JsonRpcLineWriter;
		pendingInnerRequests: Map<string, PendingInnerRequest>;
		pendingToolCalls: Map<string, PendingToolCall>;
		sessionRoot: ResolvedSessionRoot | null;
	},
): Promise<void> {
	if (context.config.debugInbound !== "off") {
		logInboundClientMessage(message, context.pendingInnerRequests, context.config.debugInbound);
	}

	if (isJsonRpcRequest(message)) {
		if (message.method === "tools/list") {
			await context.clientWriter.write(createJsonRpcResponse(message.id, createReducedToolsListResult()));
			return;
		}

		if (message.method === "tools/call") {
			await handleToolsCallRequest(message, context);
			return;
		}
	}

	if (isJsonRpcResponse(message)) {
		const key = jsonRpcIdKey(message.id);
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

	await context.innerWriter.write(message);
}

async function handleToolsCallRequest(
	message: JsonRpcRequest,
	context: {
		clientWriter: JsonRpcLineWriter;
		config: ReturnType<typeof loadProxyConfig>;
		innerWriter: JsonRpcLineWriter;
		pendingInnerRequests: Map<string, PendingInnerRequest>;
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
	const toolName = typeof requestParams.name === "string" ? requestParams.name : null;
	if (toolName === null) {
		await context.clientWriter.write(
			createJsonRpcResponse(message.id, createToolCallErrorResult("Expected tools/call params.name to be a string")),
		);
		return;
	}

	try {
		if (toolName === "codex") {
			const call = parseOuterCodexCall(requestParams.arguments);
			const pendingToolCall = createPendingToolCall(message.id, "codex");
			context.pendingToolCalls.set(jsonRpcIdKey(message.id), pendingToolCall);
			try {
				await context.innerWriter.write({
					...message,
					params: {
						...requestParams,
						name: "codex",
						arguments: buildInnerCodexArguments(call, context.config.policy),
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
			const call = parseOuterCodexReplyCall(requestParams.arguments);
			const pendingToolCall = createPendingToolCall(message.id, "codex-reply", call.threadId);
			context.pendingToolCalls.set(jsonRpcIdKey(message.id), pendingToolCall);
			try {
				await context.innerWriter.write({
					...message,
					params: {
						...requestParams,
						name: "codex-reply",
						arguments: buildInnerCodexReplyArguments(call, context.config.policy),
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

async function onInnerMessage(
	message: JsonRpcMessage,
	context: {
		allocateOuterServerRequestId: () => JsonRpcId;
		clientWriter: JsonRpcLineWriter;
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
		const pendingToolCall = context.pendingToolCalls.get(jsonRpcIdKey(message.id));
		if (pendingToolCall) {
			if (pendingToolCall.syntheticCompletionSent) {
				finishPendingToolCall(pendingToolCall, context.pendingToolCalls);
				return;
			}
			finishPendingToolCall(pendingToolCall, context.pendingToolCalls);
		}
		await context.clientWriter.write(message);
	}
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
	if (!pendingToolCall) {
		return;
	}

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
			pendingToolCall.rolloutPath === null ? null : await readRolloutTaskCompleteSnapshot(pendingToolCall.rolloutPath);
		const rolloutThreadId = rolloutSnapshot?.threadId ?? null;
		if (rolloutThreadId !== null) {
			pendingToolCall.threadId = rolloutThreadId;
		}
		const rolloutLastAgentMessage = rolloutSnapshot?.lastAgentMessage ?? null;
		if (rolloutLastAgentMessage !== null) {
			pendingToolCall.lastAgentMessage = rolloutLastAgentMessage;
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

async function readRolloutTaskCompleteSnapshot(rolloutPath: string): Promise<RolloutTaskCompleteSnapshot | null> {
	return parseRolloutTaskCompleteLine(await readLastRolloutLine(rolloutPath));
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

function parseRolloutTaskCompleteLine(line: string | null): RolloutTaskCompleteSnapshot | null {
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
	if (eventType !== "task_complete" && eventType !== "turn_complete") {
		return null;
	}

	return {
		lastAgentMessage: readOptionalRecordString(eventMessage, "last_agent_message"),
		threadId:
			readOptionalRecordString(payload, "threadId") ??
			readOptionalRecordString(isRecord(payload._meta) ? payload._meta : null, "threadId"),
	};
}

function createSyntheticToolCallResult(threadId: string, content: string) {
	return {
		content: [
			{
				type: "text",
				text: content,
			},
		],
		structuredContent: {
			threadId,
			content,
		},
	};
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
		(options.env === undefined ? lookupWslSessionsRoot(process.env)?.distro : lookupWslSessionsRoot(options.env)?.distro) ??
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

function formatLoggedEnvValue(value: string | undefined): string {
	return value === undefined ? '"undefined"' : JSON.stringify(value);
}

function logInboundClientMessage(
	message: JsonRpcMessage,
	pendingInnerRequests: Map<string, PendingInnerRequest>,
	mode: DebugInboundMode,
): void {
	const logEntry = createInboundLogEntry(message, pendingInnerRequests, mode);
	if (logEntry === null) {
		return;
	}

	process.stderr.write(`[yolo-codex-mcp][mcp-in] ${JSON.stringify(logEntry)}\n`);
}

function createInboundLogEntry(
	message: JsonRpcMessage,
	pendingInnerRequests: Map<string, PendingInnerRequest>,
	mode: DebugInboundMode,
): Record<string, unknown> | null {
	if (isJsonRpcRequest(message)) {
		if (!shouldLogInboundMethod(message.method, mode)) {
			return null;
		}

		return {
			id: message.id,
			kind: "request",
			method: message.method,
			params: formatInboundPayload(message.params, mode),
		};
	}

	if (isJsonRpcNotification(message)) {
		if (!shouldLogInboundMethod(message.method, mode)) {
			return null;
		}

		return {
			kind: "notification",
			method: message.method,
			params: formatInboundPayload(message.params, mode),
		};
	}

	const pendingRequest = pendingInnerRequests.get(jsonRpcIdKey(message.id));
	if (!pendingRequest || !shouldLogInboundMethod(pendingRequest.method, mode)) {
		return null;
	}

	if (isJsonRpcResponse(message)) {
		return {
			forMethod: pendingRequest.method,
			id: message.id,
			kind: "response",
			result: formatInboundPayload(message.result, mode),
		};
	}

	if (isJsonRpcError(message)) {
		return {
			error: formatInboundPayload(message.error, mode),
			forMethod: pendingRequest.method,
			id: message.id,
			kind: "error",
		};
	}

	return null;
}

function shouldLogInboundMethod(method: string, mode: DebugInboundMode): boolean {
	const isSelectedMethod = isSelectedInboundMethod(method);
	switch (mode) {
		case "selected":
			return isSelectedMethod;
		case "unknown":
			return !isSelectedMethod;
		case "all":
		case "verbose":
			return true;
		case "off":
			return false;
	}
}

function isSelectedInboundMethod(method: string): boolean {
	return (
		method === "initialize" ||
		method === "notifications/initialized" ||
		method.startsWith("roots/") ||
		method.startsWith("workspace/") ||
		method.startsWith("$/")
	);
}

function formatInboundPayload(value: unknown, mode: DebugInboundMode): unknown {
	return mode === "verbose" ? value : summarizeForLog(value);
}

function summarizeForLog(value: unknown, depth = 0): unknown {
	const maxArrayEntries = 10;
	const maxDepth = 4;
	const maxObjectEntries = 20;
	const maxStringLength = 240;

	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "undefined") {
		return value;
	}

	if (typeof value === "string") {
		return value.length <= maxStringLength ? value : `${value.slice(0, maxStringLength)}... (${value.length} chars)`;
	}

	if (Array.isArray(value)) {
		if (depth >= maxDepth) {
			return `[array(${value.length})]`;
		}

		const summarized = value.slice(0, maxArrayEntries).map((entry) => summarizeForLog(entry, depth + 1));
		if (value.length > maxArrayEntries) {
			summarized.push(`... (${value.length - maxArrayEntries} more items)`);
		}
		return summarized;
	}

	if (isRecord(value)) {
		if (depth >= maxDepth) {
			return {
				__keys: Object.keys(value).slice(0, maxObjectEntries),
				__summary: "object truncated",
			};
		}

		const summarized: Record<string, unknown> = {};
		const entries = Object.entries(value);
		for (const [key, entryValue] of entries.slice(0, maxObjectEntries)) {
			summarized[key] = summarizeForLog(entryValue, depth + 1);
		}
		if (entries.length > maxObjectEntries) {
			summarized.__truncated__ = `${entries.length - maxObjectEntries} more keys`;
		}
		return summarized;
	}

	return Object.prototype.toString.call(value);
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
