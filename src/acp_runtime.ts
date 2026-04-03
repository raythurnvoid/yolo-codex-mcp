import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";

import type {
	AvailableCommand,
	ContentBlock,
	ContentChunk,
	CreateTerminalRequest,
	CreateTerminalResponse,
	InitializeResponse,
	McpServer,
	Plan,
	PromptResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	ReleaseTerminalRequest,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionInfoUpdate,
	SessionModeId,
	SessionUpdate,
	TerminalOutputRequest,
	TerminalOutputResponse,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallUpdate,
	UsageUpdate,
	WaitForTerminalExitRequest,
	WaitForTerminalExitResponse,
	WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

import { createOpenCodeSpawnSpec, loadOpenCodeConfig, resolveOpenCodeLaunch } from "./opencode_config.ts";

type JsonRpcId = number;
type JsonObject = Record<string, unknown>;

type JsonRpcError = {
	code: number;
	message: string;
};

type JsonRpcMessage = {
	error?: JsonRpcError;
	id?: JsonRpcId;
	jsonrpc?: string;
	method?: string;
	params?: unknown;
	result?: unknown;
};

type SessionUpdateNotification = {
	sessionId: string;
	update: SessionUpdate;
};

type KillTerminalRequest = {
	sessionId: string;
	terminalId: string;
};

type StartAgentArgs = {
	cwd?: string | null;
	input: unknown[];
	session?: string | null;
};

type TranscriptMessageKind = "assistant" | "thought" | "user";

export type TurnMessageGroup = {
	chunkCount: number;
	contentTypes: string[];
	firstAt: number;
	kind: TranscriptMessageKind;
	lastAt: number;
	messageId: string | null;
	text: string;
};

export type TranscriptToolCallState = {
	content: ToolCallContent[];
	kind: ToolCall["kind"] | null;
	locations: ToolCallLocation[];
	rawInput: unknown;
	rawOutput: unknown;
	status: ToolCall["status"] | null;
	title: string;
	toolCallId: string;
	updates: number;
};

export type TurnTranscript = {
	assistantMessages: TurnMessageGroup[];
	availableCommands: AvailableCommand[] | null;
	configOptions: SessionConfigOption[] | null;
	currentModeId: SessionModeId | null;
	drainCompletedAt: number | null;
	events: Array<{ at: number; update: SessionUpdate }>;
	firstActivityAt: number;
	firstAssistantAt: number | null;
	lastActivityAt: number;
	lastAssistantAt: number | null;
	lastMessagePreviewBytes: number;
	lastUpdateKind: SessionUpdate["sessionUpdate"] | null;
	plan: Plan | null;
	promptResponseAt: number | null;
	sessionInfo: SessionInfoUpdate | null;
	thoughtMessages: TurnMessageGroup[];
	toolCallCount: number;
	toolCalls: Map<string, TranscriptToolCallState>;
	usage: UsageUpdate | null;
	userMessages: TurnMessageGroup[];
};

export type AgentTurnResult = {
	sessionId: string;
	stopReason: string | null;
	text: string;
	thought: string;
	transcript: TurnTranscript;
	toolCalls: number;
};

export type AgentTurnObserver = {
	onMessageChunk?: (event: { chunk: string; text: string; textBytes: number }) => void;
	onPromptResponseReceived?: (event: { stopReason: string | null; textBytes: number }) => void;
	onThoughtChunk?: (chunk: string) => void;
	onToolCall?: (event: { status?: string; title?: string; toolCallId?: string }) => void;
	onTranscriptUpdate?: (transcript: TurnTranscript) => void;
	onUsageUpdate?: (usage: { size: number; used: number }) => void;
};

type PromptCollector = {
	lastToolSummaryByKey: Map<string, string>;
	observer?: AgentTurnObserver;
	onUpdate: (update: SessionUpdateNotification["update"]) => void;
	transcript: TurnTranscript;
};

type ManagedTerminal = {
	child: ChildProcessByStdio<null, Readable, Readable>;
	completed: Promise<void>;
	exitCode: number | null;
	output: string;
	outputByteLimit: number | null;
	sessionId: string;
	signal: NodeJS.Signals | null;
};

type PendingRequest = {
	reject: (error: Error) => void;
	resolve: (value: unknown) => void;
};

type RuntimeStderrEvent = {
	at: number;
	text: string;
};

const ACP_PROTOCOL_VERSION = 1;
const OPEN_CODE_MODEL_ID = "openai/gpt-5.4/high";
const PROMPT_PRE_RESPONSE_INACTIVITY_CANCEL_MS = 60_000;
const PROMPT_POST_RESPONSE_IDLE_MS = 1_250;
const PROMPT_POST_RESPONSE_MESSAGE_IDLE_MS = 3_000;
const PROMPT_POST_RESPONSE_MAX_WAIT_MS = 25_000;
const PROMPT_EMPTY_RESPONSE_IDLE_MS = 2_000;
const PROMPT_EMPTY_RESPONSE_MAX_WAIT_MS = 3_000;
const ACP_SESSION_WORKSPACE = path.join(os.tmpdir(), "smart-agent-mcp-workspace");

const ACP_METHODS = {
	createTerminal: "terminal/create",
	fsReadTextFile: "fs/read_text_file",
	fsWriteTextFile: "fs/write_text_file",
	initialize: "initialize",
	killTerminal: "terminal/kill",
	loadSession: "session/load",
	newSession: "session/new",
	prompt: "session/prompt",
	releaseTerminal: "terminal/release",
	requestPermission: "session/request_permission",
	resumeSession: "session/resume",
	sessionUpdate: "session/update",
	setSessionModel: "session/set_model",
	terminalOutput: "terminal/output",
	waitForTerminalExit: "terminal/wait_for_exit",
} as const;

function debugLog(message: string): void {
	if (process.env.DEBUG_SMART_AGENT_MCP !== "1") {
		return;
	}
	process.stderr.write(`[smart-agent-mcp] ${message}\n`);
}

function infoLog(message: string): void {
	process.stderr.write(`[smart-agent-runtime] ${message}\n`);
}

function formatLogValue(value: unknown, maxLength = 400): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...`;
}

function createTurnTranscript(): TurnTranscript {
	const now = Date.now();
	return {
		assistantMessages: [],
		availableCommands: null,
		configOptions: null,
		currentModeId: null,
		drainCompletedAt: null,
		events: [],
		firstActivityAt: now,
		firstAssistantAt: null,
		lastActivityAt: now,
		lastAssistantAt: null,
		lastMessagePreviewBytes: 0,
		lastUpdateKind: null,
		plan: null,
		promptResponseAt: null,
		sessionInfo: null,
		thoughtMessages: [],
		toolCallCount: 0,
		toolCalls: new Map(),
		usage: null,
		userMessages: [],
	};
}

function appendTranscriptEvent(transcript: TurnTranscript, update: SessionUpdate, at: number): void {
	transcript.events.push({ at, update });
	transcript.lastActivityAt = at;
	transcript.lastUpdateKind = update.sessionUpdate;

	switch (update.sessionUpdate) {
		case "user_message_chunk":
			appendMessageChunk(transcript.userMessages, update, "user", at);
			break;
		case "agent_message_chunk":
			appendMessageChunk(transcript.assistantMessages, update, "assistant", at);
			transcript.lastAssistantAt = at;
			transcript.firstAssistantAt ??= at;
			break;
		case "agent_thought_chunk":
			appendMessageChunk(transcript.thoughtMessages, update, "thought", at);
			break;
		case "tool_call":
			transcript.toolCallCount += 1;
			transcript.toolCalls.set(update.toolCallId, createToolCallState(update));
			break;
		case "tool_call_update":
			mergeToolCallUpdate(transcript.toolCalls, update);
			break;
		case "plan":
			transcript.plan = update;
			break;
		case "available_commands_update":
			transcript.availableCommands = update.availableCommands;
			break;
		case "current_mode_update":
			transcript.currentModeId = update.currentModeId;
			break;
		case "config_option_update":
			transcript.configOptions = update.configOptions;
			break;
		case "session_info_update":
			transcript.sessionInfo = {
				...transcript.sessionInfo,
				...update,
			};
			break;
		case "usage_update":
			transcript.usage = update;
			break;
		default:
			assertNever(update);
	}
}

function appendMessageChunk(
	groups: TurnMessageGroup[],
	update: ContentChunk,
	kind: TranscriptMessageKind,
	at: number,
): TurnMessageGroup {
	const contentType = update.content.type;
	const chunkText = extractDisplayTextFromContentBlock(update.content);
	const lastGroup = groups.at(-1) ?? null;
	const canAppendToLast =
		lastGroup !== null &&
		lastGroup.kind === kind &&
		lastGroup.messageId === (update.messageId ?? null) &&
		(lastGroup.messageId !== null || contentType === "text");
	if (canAppendToLast) {
		lastGroup.chunkCount += 1;
		lastGroup.lastAt = at;
		if (!lastGroup.contentTypes.includes(contentType)) {
			lastGroup.contentTypes.push(contentType);
		}
		lastGroup.text += chunkText;
		return lastGroup;
	}
	const nextGroup: TurnMessageGroup = {
		chunkCount: 1,
		contentTypes: [contentType],
		firstAt: at,
		kind,
		lastAt: at,
		messageId: update.messageId ?? null,
		text: chunkText,
	};
	groups.push(nextGroup);
	return nextGroup;
}

function extractDisplayTextFromContentBlock(content: ContentBlock): string {
	switch (content.type) {
		case "text":
			return content.text ?? "";
		case "image":
			return "[image]";
		case "audio":
			return "[audio]";
		case "resource":
			return "[resource]";
		case "resource_link":
			return content.uri ? `[resource:${content.uri}]` : "[resource_link]";
		default:
			assertNever(content);
	}
}

function createToolCallState(update: ToolCall): TranscriptToolCallState {
	return {
		content: [...(update.content ?? [])],
		kind: update.kind ?? null,
		locations: [...(update.locations ?? [])],
		rawInput: update.rawInput,
		rawOutput: update.rawOutput,
		status: update.status ?? null,
		title: update.title,
		toolCallId: update.toolCallId,
		updates: 0,
	};
}

function mergeToolCallUpdate(
	toolCalls: Map<string, TranscriptToolCallState>,
	update: ToolCallUpdate,
): TranscriptToolCallState {
	const existing =
		toolCalls.get(update.toolCallId) ??
		({
			content: [],
			kind: null,
			locations: [],
			rawInput: null,
			rawOutput: null,
			status: null,
			title: update.toolCallId,
			toolCallId: update.toolCallId,
			updates: 0,
		} satisfies TranscriptToolCallState);
	const merged: TranscriptToolCallState = {
		content: update.content === undefined || update.content === null ? existing.content : [...update.content],
		kind: update.kind === undefined || update.kind === null ? existing.kind : update.kind,
		locations: update.locations === undefined || update.locations === null ? existing.locations : [...update.locations],
		rawInput: update.rawInput === undefined ? existing.rawInput : update.rawInput,
		rawOutput: update.rawOutput === undefined ? existing.rawOutput : update.rawOutput,
		status: update.status === undefined || update.status === null ? existing.status : update.status,
		title: update.title === undefined || update.title === null ? existing.title : update.title,
		toolCallId: update.toolCallId,
		updates: existing.updates + 1,
	};
	toolCalls.set(update.toolCallId, merged);
	return merged;
}

function getTranscriptAssistantText(transcript: TurnTranscript): string {
	return transcript.assistantMessages.map((entry) => entry.text).join("");
}

function getTranscriptThoughtText(transcript: TurnTranscript): string {
	return transcript.thoughtMessages.map((entry) => entry.text).join("");
}

function transcriptHasVisibleOutput(transcript: TurnTranscript): boolean {
	return (
		getTranscriptAssistantText(transcript).trim().length > 0 ||
		getTranscriptThoughtText(transcript).trim().length > 0 ||
		transcript.toolCallCount > 0
	);
}

function buildSessionUpdateLogPayload(sessionId: string, update: SessionUpdate): Record<string, unknown> | null {
	switch (update.sessionUpdate) {
		case "user_message_chunk":
		case "agent_message_chunk":
		case "agent_thought_chunk":
			// Chunk-level session/update logs are intentionally suppressed here. Re-enable logging in this branch only if
			// chunk payloads become useful enough to justify the extra stderr noise.
			return null;
		case "tool_call":
			return {
				contentCount: update.content?.length ?? 0,
				kind: update.kind ?? null,
				locationCount: update.locations?.length ?? 0,
				sessionId,
				sessionUpdate: update.sessionUpdate,
				status: update.status ?? null,
				title: update.title,
				toolCallId: update.toolCallId,
			};
		case "tool_call_update":
			return {
				contentCount: update.content?.length ?? null,
				kind: update.kind ?? null,
				locationCount: update.locations?.length ?? null,
				sessionId,
				sessionUpdate: update.sessionUpdate,
				status: update.status ?? null,
				title: update.title ?? null,
				toolCallId: update.toolCallId,
			};
		case "plan":
			return {
				entryCount: update.entries.length,
				sessionId,
				sessionUpdate: update.sessionUpdate,
				statuses: update.entries.map((entry) => entry.status),
			};
		case "available_commands_update":
			return {
				commandCount: update.availableCommands.length,
				commands: update.availableCommands.map((entry) => entry.name),
				sessionId,
				sessionUpdate: update.sessionUpdate,
			};
		case "current_mode_update":
			return {
				currentModeId: update.currentModeId,
				sessionId,
				sessionUpdate: update.sessionUpdate,
			};
		case "config_option_update":
			return {
				configIds: update.configOptions.map((entry) => entry.id),
				sessionId,
				sessionUpdate: update.sessionUpdate,
			};
		case "session_info_update":
			return {
				sessionId,
				sessionUpdate: update.sessionUpdate,
				title: update.title ?? null,
				updatedAt: update.updatedAt ?? null,
			};
		case "usage_update":
			return {
				cost: update.cost ?? null,
				sessionId,
				sessionUpdate: update.sessionUpdate,
				size: update.size,
				used: update.used,
			};
		default:
			return assertNever(update);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled ACP variant: ${JSON.stringify(value)}`);
}

class RawAcpConnection {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly runtime: OpenCodeAcpRuntime;
	private buffer = "";
	private nextId = 1;

	constructor(child: ChildProcessWithoutNullStreams, runtime: OpenCodeAcpRuntime) {
		this.child = child;
		this.runtime = runtime;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			while (true) {
				const newlineIndex = this.buffer.indexOf("\n");
				if (newlineIndex === -1) {
					return;
				}
				const line = this.buffer.slice(0, newlineIndex).trim();
				this.buffer = this.buffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				try {
					debugLog(`ACP <- ${line}`);
					const message = JSON.parse(line) as JsonRpcMessage;
					void this.handleMessage(message);
				} catch {
					process.stderr.write(`[inner agent runtime stdout] ${line}\n`);
				}
			}
		});
		child.stdout.on("error", (error) => {
			this.failPending(error instanceof Error ? error : new Error(String(error)));
		});
		child.on("exit", (code, signal) => {
			this.failPending(new Error(`ACP child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
		});
	}

	async initialize(params: JsonObject): Promise<InitializeResponse> {
		return (await this.sendRequest(ACP_METHODS.initialize, params)) as InitializeResponse;
	}

	async newSession(params: JsonObject): Promise<{ sessionId: string }> {
		return (await this.sendRequest(ACP_METHODS.newSession, params)) as { sessionId: string };
	}

	async loadSession(params: JsonObject): Promise<void> {
		await this.sendRequest(ACP_METHODS.loadSession, params);
	}

	async unstable_resumeSession(params: JsonObject): Promise<void> {
		await this.sendRequest(ACP_METHODS.resumeSession, params);
	}

	async unstable_setSessionModel(params: JsonObject): Promise<void> {
		await this.sendRequest(ACP_METHODS.setSessionModel, params);
	}

	async prompt(params: JsonObject): Promise<PromptResponse> {
		return (await this.sendRequest(ACP_METHODS.prompt, params)) as PromptResponse;
	}

	async cancel(params: JsonObject): Promise<void> {
		this.sendNotification("session/cancel", params);
	}

	private async handleMessage(message: JsonRpcMessage): Promise<void> {
		if (typeof message.id === "number" && !message.method) {
			debugLog(`ACP response <- id=${message.id}${message.error ? ` error=${message.error.message}` : ""}`);
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(message.error.message));
				return;
			}
			pending.resolve(message.result);
			return;
		}

		if (!message.method) {
			return;
		}

		if (typeof message.id === "number") {
			debugLog(`ACP request <- ${message.method}`);
			try {
				const result = await this.handleIncomingRequest(message.method, message.params);
				this.send({
					id: message.id,
					jsonrpc: "2.0",
					result: result ?? {},
				});
			} catch (error) {
				this.send({
					error: {
						code: -32603,
						message: error instanceof Error ? error.message : String(error),
					},
					id: message.id,
					jsonrpc: "2.0",
				});
			}
			return;
		}

		if (message.method === ACP_METHODS.sessionUpdate) {
			debugLog(`ACP notification <- session/update`);
			this.runtime.handleSessionUpdate(message.params as SessionUpdateNotification);
		}
	}

	private async handleIncomingRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case ACP_METHODS.requestPermission:
				return await this.runtime.requestPermission(params as RequestPermissionRequest);
			case ACP_METHODS.fsReadTextFile:
				return await this.runtime.readTextFile(params as ReadTextFileRequest);
			case ACP_METHODS.fsWriteTextFile:
				return await this.runtime.writeTextFile(params as WriteTextFileRequest);
			case ACP_METHODS.createTerminal:
				return this.runtime.createTerminal(params as CreateTerminalRequest);
			case ACP_METHODS.terminalOutput:
				return await this.runtime.getTerminalOutput(params as TerminalOutputRequest);
			case ACP_METHODS.releaseTerminal:
				return await this.runtime.releaseTerminal(params as ReleaseTerminalRequest);
			case ACP_METHODS.waitForTerminalExit:
				return await this.runtime.waitForTerminalExit(params as WaitForTerminalExitRequest);
			case ACP_METHODS.killTerminal:
				return await this.runtime.killTerminal(params as KillTerminalRequest);
			default:
				infoLog(`unhandled ACP client request method=${method}`);
				throw new Error(`Unhandled ACP client request ${method}`);
		}
	}

	private send(message: JsonRpcMessage): void {
		debugLog(`ACP -> ${JSON.stringify(message)}`);
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private sendNotification(method: string, params: JsonObject): void {
		this.send({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	private async sendRequest(method: string, params: JsonObject): Promise<unknown> {
		const id = this.nextId++;
		const payload: JsonRpcMessage = {
			id,
			jsonrpc: "2.0",
			method,
			params,
		};
		debugLog(`ACP -> request ${method} id=${id}`);
		return await new Promise((resolve, reject) => {
			this.pending.set(id, { reject, resolve });
			this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (!error) {
					debugLog(`ACP write ok ${method} id=${id}`);
					return;
				}
				this.pending.delete(id);
				debugLog(`ACP write error ${method} id=${id} message=${error.message}`);
				reject(error);
			});
		});
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class OpenCodeAcpRuntime {
	private readonly collectors = new Map<string, PromptCollector>();
	private readonly sessions = new Set<string>();
	private readonly sessionCwds = new Map<string, string>();
	private readonly stderrEvents: RuntimeStderrEvent[] = [];
	private readonly terminals = new Map<string, ManagedTerminal>();
	private child: ChildProcessWithoutNullStreams | null = null;
	private connection: RawAcpConnection | null = null;
	private initializeResponse: InitializeResponse | null = null;
	private launchedViaWsl = false;
	private startPromise: Promise<void> | null = null;

	async start(): Promise<void> {
		if (this.connection !== null) {
			return;
		}
		if (this.startPromise !== null) {
			await this.startPromise;
			return;
		}

		this.startPromise = (async () => {
			const config = loadOpenCodeConfig();
			const resolvedLaunch = resolveOpenCodeLaunch(config.innerCommand, config.innerArgs);
			const spawnSpec = createOpenCodeSpawnSpec(resolvedLaunch.command, resolvedLaunch.args);
			this.launchedViaWsl = isWslLaunch(spawnSpec.command);
			infoLog(`launching runtime command=${spawnSpec.command} args=${JSON.stringify(spawnSpec.args)}`);
			const child = spawn(spawnSpec.command, spawnSpec.args, {
				detached: process.platform !== "win32",
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			try {
				await ensureChildSpawned(child, spawnSpec);
				child.stderr.on("data", (chunk: Buffer | string) => {
					const text = String(chunk);
					this.recordBackendStderr(text);
					process.stderr.write(`[inner agent runtime] ${text}`);
				});

				const connection = new RawAcpConnection(child, this);
				const initializeResponse = await connection.initialize({
					clientCapabilities: {
						fs: {
							readTextFile: true,
							writeTextFile: true,
						},
						terminal: true,
					},
					protocolVersion: ACP_PROTOCOL_VERSION,
				});

				this.child = child;
				this.connection = connection;
				this.initializeResponse = initializeResponse;
				infoLog(
					`runtime initialized agent=${initializeResponse.agentInfo?.name ?? "unknown"} version=${initializeResponse.agentInfo?.version ?? "unknown"}`,
				);
			} catch (error) {
				if (child.exitCode === null && child.signalCode === null) {
					terminateChildProcessTree(child, "SIGTERM");
				}
				throw error;
			}
		})().finally(() => {
			this.startPromise = null;
		});

		await this.startPromise;
	}

	async close(): Promise<void> {
		infoLog("closing runtime");
		for (const [terminalId, terminal] of this.terminals.entries()) {
			await this.releaseTerminal({ sessionId: terminal.sessionId, terminalId }).catch(() => {});
		}

		this.collectors.clear();
		this.sessions.clear();
		this.sessionCwds.clear();
		this.terminals.clear();

		const child = this.child;
		this.connection = null;
		this.initializeResponse = null;
		this.child = null;
		if (!child) {
			return;
		}
		if (!child.stdin.destroyed) {
			child.stdin.end();
		}
		if (child.exitCode === null && child.signalCode === null) {
			terminateChildProcessTree(child, "SIGTERM");
		}
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
					terminateChildProcessTree(child, "SIGKILL");
				}
			}, 2_000);
			bailoutTimer = setTimeout(finish, 5_000);
		});
	}

	handleSessionUpdate(params: SessionUpdateNotification): void {
		debugLog(`session/update kind=${params.update.sessionUpdate} session=${params.sessionId}`);
		const updateLogPayload = buildSessionUpdateLogPayload(params.sessionId, params.update);
		if (updateLogPayload !== null) {
			infoLog(`session/update ${formatLogValue(updateLogPayload, 260)}`);
		}
		const collector = this.collectors.get(params.sessionId);
		if (!collector) {
			infoLog(`session/update ignored session=${params.sessionId} kind=${params.update.sessionUpdate}`);
			return;
		}
		const updateAt = Date.now();
		appendTranscriptEvent(collector.transcript, params.update, updateAt);

		switch (params.update.sessionUpdate) {
			case "agent_message_chunk":
				handleAssistantMessageChunk(params.sessionId, collector, params.update);
				break;
			case "agent_thought_chunk":
				handleThoughtChunk(collector, params.update);
				break;
			case "user_message_chunk":
				break;
			case "tool_call":
				reportToolUpdate(params.sessionId, collector, params.update);
				break;
			case "tool_call_update":
				reportToolUpdate(params.sessionId, collector, params.update);
				break;
			case "plan":
			case "available_commands_update":
			case "current_mode_update":
			case "config_option_update":
			case "session_info_update":
				break;
			case "usage_update":
				if (typeof params.update.used === "number" && typeof params.update.size === "number") {
					if (params.update.used > 0 || process.env.DEBUG_SMART_AGENT_MCP === "1") {
						infoLog(`usage reported session=${params.sessionId} used=${params.update.used} size=${params.update.size}`);
					}
					collector.observer?.onUsageUpdate?.({
						size: params.update.size,
						used: params.update.used,
					});
				}
				break;
			default:
				assertNever(params.update);
		}
		collector.observer?.onTranscriptUpdate?.(collector.transcript);
		collector.onUpdate(params.update);
	}

	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		const option =
			params.options.find((entry) => entry.kind === "allow_once") ??
			params.options.find((entry) => entry.kind === "allow_always") ??
			params.options[0];
		if (!option) {
			return {
				outcome: {
					outcome: "cancelled",
				},
			};
		}
		return {
			outcome: {
				optionId: option.optionId,
				outcome: "selected",
			},
		};
	}

	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		return {
			content: await readFile(params.path, "utf8"),
		};
	}

	async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
		await writeFile(params.path, params.content, "utf8");
		return {};
	}

	async startAgent(args: StartAgentArgs, observer?: AgentTurnObserver): Promise<AgentTurnResult> {
		const connection = this.requireConnection();
		const sessionId = await this.ensureSession(args.session ?? null, args.cwd ?? null);
		await this.setRequiredModel(sessionId);
		const stderrCursor = this.stderrEvents.length;
		const prompt = normalizePromptInput(args.input);
		infoLog(
			`prompt starting session=${sessionId} promptParts=${prompt.length} cwd=${this.sessionCwds.get(sessionId) ?? ACP_SESSION_WORKSPACE}`,
		);
		debugLog(`startAgent session=${sessionId} promptParts=${prompt.length}`);
		let inactivityCancelTimer: NodeJS.Timeout | null = null;
		let cancelScheduled = false;
		let promptSettled = false;
		const clearInactivityCancelTimer = () => {
			if (inactivityCancelTimer !== null) {
				clearTimeout(inactivityCancelTimer);
				inactivityCancelTimer = null;
			}
		};
		const scheduleCancel = (reason: "pre-response-inactivity") => {
			if (promptSettled || cancelScheduled) {
				return;
			}
			cancelScheduled = true;
			infoLog(`prompt cancel scheduled session=${sessionId} reason=${reason}`);
			void connection.cancel({ sessionId }).catch(() => {});
		};
		const resetInactivityCancelTimer = () => {
			if (promptSettled || cancelScheduled) {
				return;
			}
			clearInactivityCancelTimer();
			inactivityCancelTimer = setTimeout(
				() => scheduleCancel("pre-response-inactivity"),
				PROMPT_PRE_RESPONSE_INACTIVITY_CANCEL_MS,
			);
		};
		const collector: PromptCollector = {
			lastToolSummaryByKey: new Map(),
			observer,
			onUpdate: (update) => {
				if (promptSettled) {
					return;
				}
				if (isMeaningfulPromptActivity(update)) {
					resetInactivityCancelTimer();
				}
			},
			transcript: createTurnTranscript(),
		};
		this.collectors.set(sessionId, collector);
		resetInactivityCancelTimer();

		try {
			const result = await connection.prompt({ prompt, sessionId });
			const promptResponseAt = Date.now();
			clearInactivityCancelTimer();
			collector.transcript.promptResponseAt = promptResponseAt;
			const finalText = getTranscriptAssistantText(collector.transcript);
			infoLog(
				`prompt response received session=${sessionId} stopReason=${result.stopReason ?? "null"} textBytes=${Buffer.byteLength(
					finalText,
					"utf8",
				)}`,
			);
			collector.observer?.onPromptResponseReceived?.({
				stopReason: result.stopReason,
				textBytes: Buffer.byteLength(finalText, "utf8"),
			});
			await waitForCollectorToDrain(sessionId, collector, promptResponseAt);
			this.throwIfBackendErrorSince(stderrCursor, sessionId, collector);
			infoLog(`prompt finished session=${sessionId} stopReason=${result.stopReason ?? "null"}`);
			const settledText = getTranscriptAssistantText(collector.transcript);
			const settledThought = getTranscriptThoughtText(collector.transcript);
			if (settledText.trim().length === 0) {
				infoLog(
					`response empty session=${sessionId} stopReason=${result.stopReason ?? "null"} thoughtBytes=${Buffer.byteLength(
						settledThought,
						"utf8",
					)} toolCalls=${collector.transcript.toolCallCount} lastUpdateKind=${collector.transcript.lastUpdateKind ?? "null"}`,
				);
			}
			infoLog(`response final session=${sessionId} text=${formatLogValue(settledText, 100)}`);
			debugLog(
				`prompt complete session=${sessionId} stopReason=${result.stopReason} textBytes=${Buffer.byteLength(
					settledText,
					"utf8",
				)}`,
			);
			promptSettled = true;
			return {
				sessionId,
				stopReason: result.stopReason,
				text: settledText,
				thought: settledThought,
				toolCalls: collector.transcript.toolCallCount,
				transcript: collector.transcript,
			};
		} finally {
			promptSettled = true;
			clearInactivityCancelTimer();
			this.collectors.delete(sessionId);
		}
	}

	async resumeAgent(
		args: { cwd?: string | null; input: unknown[]; session: string },
		observer?: AgentTurnObserver,
	): Promise<AgentTurnResult> {
		return await this.startAgent(
			{
				cwd: args.cwd ?? null,
				input: args.input,
				session: args.session,
			},
			observer,
		);
	}

	createTerminal(params: CreateTerminalRequest): CreateTerminalResponse {
		const shell =
			process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/bash");
		const shellArgs =
			process.platform === "win32"
				? ["/d", "/s", "/c", formatShellCommand(params.command, params.args ?? [])]
				: ["-lc", formatShellCommand(params.command, params.args ?? [])];
		const child = spawn(shell, shellArgs, {
			cwd: params.cwd ?? process.cwd(),
			env: {
				...process.env,
				...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const terminalId = randomUUID();
		const terminal: ManagedTerminal = {
			child,
			completed: new Promise<void>((resolve) => {
				child.once("exit", (code, signal) => {
					terminal.exitCode = code;
					terminal.signal = signal;
					resolve();
				});
			}),
			exitCode: null,
			signal: null,
			output: "",
			outputByteLimit: params.outputByteLimit ?? null,
			sessionId: params.sessionId,
		};
		child.stdout.on("data", (chunk: Buffer | string) => appendTerminalOutput(terminal, String(chunk)));
		child.stderr.on("data", (chunk: Buffer | string) => appendTerminalOutput(terminal, String(chunk)));
		this.terminals.set(terminalId, terminal);
		return { terminalId };
	}

	async getTerminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
		const terminal = this.requireTerminal(params.terminalId, params.sessionId);
		return {
			exitStatus:
				terminal.exitCode === null && terminal.signal === null
					? null
					: {
							exitCode: terminal.exitCode,
							signal: terminal.signal,
						},
			output: terminal.output,
			truncated:
				terminal.outputByteLimit !== null && Buffer.byteLength(terminal.output, "utf8") >= terminal.outputByteLimit,
		};
	}

	async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
		const terminal = this.requireTerminal(params.terminalId, params.sessionId);
		await terminal.completed;
		return {
			exitCode: terminal.exitCode,
			signal: terminal.signal,
		};
	}

	async releaseTerminal(params: ReleaseTerminalRequest): Promise<Record<string, never>> {
		const terminal = this.requireTerminal(params.terminalId, params.sessionId);
		if (terminal.child.exitCode === null && terminal.child.signalCode === null) {
			terminal.child.kill("SIGTERM");
		}
		await terminal.completed;
		this.terminals.delete(params.terminalId);
		return {};
	}

	async killTerminal(params: KillTerminalRequest): Promise<Record<string, never>> {
		const terminal = this.requireTerminal(params.terminalId, params.sessionId);
		if (terminal.child.exitCode === null && terminal.child.signalCode === null) {
			terminal.child.kill("SIGTERM");
		}
		return {};
	}

	private requireConnection(): RawAcpConnection {
		if (this.connection === null) {
			throw new Error("Agent runtime has not been started");
		}
		return this.connection;
	}

	private async ensureSession(sessionId: string | null, requestedCwd: string | null): Promise<string> {
		const connection = this.requireConnection();
		const sessionRequest = await createSessionRequest(requestedCwd, this.launchedViaWsl);
		if (!sessionId) {
			const created = await connection.newSession(sessionRequest);
			this.sessions.add(created.sessionId);
			this.sessionCwds.set(created.sessionId, sessionRequest.cwd);
			infoLog(`session created session=${created.sessionId} cwd=${sessionRequest.cwd}`);
			return created.sessionId;
		}

		if (this.sessions.has(sessionId)) {
			const existingCwd = this.sessionCwds.get(sessionId) ?? null;
			if (existingCwd !== null && existingCwd !== sessionRequest.cwd) {
				const capabilities = this.initializeResponse?.agentCapabilities;
				if (capabilities?.sessionCapabilities?.resume) {
					await connection.unstable_resumeSession({ ...sessionRequest, sessionId });
					this.sessionCwds.set(sessionId, sessionRequest.cwd);
					infoLog(`session cwd updated session=${sessionId} from=${existingCwd} to=${sessionRequest.cwd}`);
					return sessionId;
				}
				if (capabilities?.loadSession) {
					await connection.loadSession({ ...sessionRequest, sessionId });
					this.sessionCwds.set(sessionId, sessionRequest.cwd);
					infoLog(`session cwd updated via load session=${sessionId} from=${existingCwd} to=${sessionRequest.cwd}`);
					return sessionId;
				}
			}
			const cwdDetail = existingCwd !== null ? ` cwd=${existingCwd}` : "";
			infoLog(`session reused session=${sessionId}${cwdDetail}`);
			return sessionId;
		}

		const capabilities = this.initializeResponse?.agentCapabilities;
		if (capabilities?.sessionCapabilities?.resume) {
			await connection.unstable_resumeSession({ sessionId });
			this.sessions.add(sessionId);
			this.sessionCwds.set(sessionId, sessionRequest.cwd);
			infoLog(`session resumed session=${sessionId} cwd=${sessionRequest.cwd}`);
			return sessionId;
		}
		if (capabilities?.loadSession) {
			await connection.loadSession({ ...sessionRequest, sessionId });
			this.sessions.add(sessionId);
			this.sessionCwds.set(sessionId, sessionRequest.cwd);
			infoLog(`session loaded session=${sessionId} cwd=${sessionRequest.cwd}`);
			return sessionId;
		}

		throw new Error(
			`Session ${sessionId} is unknown and the configured agent runtime does not support session resume/loading.`,
		);
	}

	private async setRequiredModel(sessionId: string): Promise<void> {
		const connection = this.requireConnection();
		await connection.unstable_setSessionModel({
			modelId: OPEN_CODE_MODEL_ID,
			sessionId,
		});
		infoLog(`model pinned session=${sessionId} model=${OPEN_CODE_MODEL_ID}`);
	}

	private requireTerminal(terminalId: string, sessionId: string): ManagedTerminal {
		const terminal = this.terminals.get(terminalId);
		if (!terminal || terminal.sessionId !== sessionId) {
			throw new Error(`Unknown terminal ${terminalId}`);
		}
		return terminal;
	}

	private recordBackendStderr(text: string): void {
		this.stderrEvents.push({
			at: Date.now(),
			text,
		});
		if (this.stderrEvents.length > 100) {
			this.stderrEvents.splice(0, this.stderrEvents.length - 100);
		}
	}

	private throwIfBackendErrorSince(stderrCursor: number, sessionId: string, collector: PromptCollector): void {
		if (transcriptHasVisibleOutput(collector.transcript)) {
			return;
		}
		const stderrText = this.stderrEvents
			.slice(stderrCursor)
			.map((event) => event.text)
			.join("");
		const backendError = extractBackendErrorMessage(stderrText);
		if (backendError === null) {
			return;
		}
		infoLog(`backend error surfaced session=${sessionId} text=${formatLogValue(backendError, 200)}`);
		throw new Error(backendError);
	}
}

function extractBackendErrorMessage(stderrText: string): string | null {
	const normalized = stderrText.replace(/\r\n/g, "\n").trim();
	if (!normalized) {
		return null;
	}
	const lines = normalized
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const firstErrorIndex = lines.findIndex((line) =>
		/\b(?:[A-Za-z][A-Za-z0-9]*Error|Error:|Exception|Failed to)\b/.test(line),
	);
	if (firstErrorIndex === -1) {
		return null;
	}
	const excerpt = lines.slice(firstErrorIndex, firstErrorIndex + 6).join("\n");
	return `OpenCode backend error:\n${excerpt}`;
}

async function waitForCollectorToDrain(
	sessionId: string,
	collector: PromptCollector,
	promptResponseAt: number,
): Promise<void> {
	const startTime = Date.now();
	while (true) {
		const now = Date.now();
		const elapsed = now - startTime;
		const idleFor = now - collector.transcript.lastActivityAt;
		const lastMessageAt = collector.transcript.lastAssistantAt ?? collector.transcript.lastActivityAt;
		const messageIdleFor = now - lastMessageAt;
		const sawLateUpdates = collector.transcript.lastActivityAt > promptResponseAt || lastMessageAt > promptResponseAt;
		const sawVisibleOutput = transcriptHasVisibleOutput(collector.transcript);
		const idleThreshold = sawVisibleOutput ? PROMPT_POST_RESPONSE_IDLE_MS : PROMPT_EMPTY_RESPONSE_IDLE_MS;
		const messageIdleThreshold = sawVisibleOutput
			? PROMPT_POST_RESPONSE_MESSAGE_IDLE_MS
			: PROMPT_EMPTY_RESPONSE_IDLE_MS;
		const maxWaitThreshold = sawVisibleOutput ? PROMPT_POST_RESPONSE_MAX_WAIT_MS : PROMPT_EMPTY_RESPONSE_MAX_WAIT_MS;
		if (idleFor >= idleThreshold && messageIdleFor >= messageIdleThreshold) {
			collector.transcript.drainCompletedAt = now;
			if (elapsed > 0) {
				infoLog(
					`post-response drain completed session=${sessionId} waitedMs=${elapsed} idleMs=${idleFor} messageIdleMs=${messageIdleFor} lateUpdates=${sawLateUpdates}`,
				);
			}
			return;
		}
		if (elapsed >= maxWaitThreshold) {
			collector.transcript.drainCompletedAt = now;
			infoLog(
				`post-response drain timed out session=${sessionId} waitedMs=${elapsed} lastIdleMs=${idleFor} messageIdleMs=${messageIdleFor} lateUpdates=${sawLateUpdates} textBytes=${Buffer.byteLength(
					getTranscriptAssistantText(collector.transcript),
					"utf8",
				)}`,
			);
			return;
		}
		const waitForIdleMs = Math.max(
			Math.max(idleThreshold - idleFor, 0),
			Math.max(messageIdleThreshold - messageIdleFor, 0),
		);
		await delay(Math.min(waitForIdleMs, 250));
	}
}

function handleAssistantMessageChunk(
	sessionId: string,
	collector: PromptCollector,
	update: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>,
): void {
	const chunk = extractDisplayTextFromContentBlock(update.content);
	const text = getTranscriptAssistantText(collector.transcript);
	const textBytes = Buffer.byteLength(text, "utf8");
	collector.observer?.onMessageChunk?.({
		chunk,
		text,
		textBytes,
	});
	if (collector.transcript.firstAssistantAt === collector.transcript.lastAssistantAt) {
		infoLog(`first output chunk received session=${sessionId} text=${formatLogValue(chunk, 100)}`);
	} else if (textBytes - collector.transcript.lastMessagePreviewBytes >= 200) {
		collector.transcript.lastMessagePreviewBytes = textBytes;
		infoLog(`response streaming session=${sessionId} textBytes=${textBytes}`);
	}
}

function handleThoughtChunk(
	collector: PromptCollector,
	update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
): void {
	if (update.content.type !== "text") {
		return;
	}
	collector.observer?.onThoughtChunk?.(update.content.text ?? "");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}

function reportToolUpdate(
	sessionId: string,
	collector: PromptCollector,
	update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): void {
	const state = collector.transcript.toolCalls.get(update.toolCallId);
	if (!state) {
		return;
	}
	const title = state.title;
	const status = state.status ?? "unknown";
	const toolKey = state.toolCallId;
	const summaryKey = `${title}\u0000${status}`;
	if (collector.lastToolSummaryByKey.get(toolKey) === summaryKey) {
		return;
	}
	collector.lastToolSummaryByKey.set(toolKey, summaryKey);
	if (status === "failed" || status === "completed" || process.env.DEBUG_SMART_AGENT_MCP === "1") {
		infoLog(`tool update session=${sessionId} title=${title} status=${status}`);
	}
	collector.observer?.onToolCall?.({
		status: state.status ?? undefined,
		title: title || undefined,
		toolCallId: state.toolCallId,
	});
}

function isMeaningfulPromptActivity(_update: SessionUpdate): boolean {
	return true;
}

async function createSessionRequest(
	requestedCwd: string | null,
	launchedViaWsl: boolean,
): Promise<{ cwd: string; mcpServers: McpServer[] }> {
	await mkdir(ACP_SESSION_WORKSPACE, { recursive: true });
	const cwd = normalizeSessionCwd(requestedCwd, launchedViaWsl);
	return {
		cwd,
		mcpServers: [],
	};
}

export function normalizeSessionCwd(requestedCwd: string | null, launchedViaWsl: boolean): string {
	const rawCwd = requestedCwd && requestedCwd.trim().length > 0 ? requestedCwd.trim() : ACP_SESSION_WORKSPACE;
	if (!launchedViaWsl) {
		return rawCwd;
	}
	const converted = convertWindowsPathToWsl(rawCwd);
	if (converted !== null && converted !== rawCwd) {
		infoLog(`session cwd translated for WSL from=${rawCwd} to=${converted}`);
		return converted;
	}
	return rawCwd;
}

export function convertWindowsPathToWsl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.startsWith("/")) {
		return trimmed;
	}
	const driveMatch = trimmed.match(/^([A-Za-z]):[\\/](.*)$/);
	if (driveMatch) {
		const drive = driveMatch[1].toLowerCase();
		const remainder = driveMatch[2].replace(/\\/g, "/");
		return `/mnt/${drive}/${remainder}`;
	}
	const uncMatch = trimmed.match(/^\\\\wsl\$\\([^\\]+)\\(.*)$/i);
	if (uncMatch) {
		return `/${uncMatch[2].replace(/\\/g, "/")}`;
	}
	return null;
}

function isWslLaunch(command: string): boolean {
	return /(^|[\\/])wsl\.exe$/i.test(command) || command === "wsl.exe";
}

function terminateChildProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform !== "win32" && typeof child.pid === "number") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to the direct child if the process group is already gone or unavailable.
		}
	}
	child.kill(signal);
}

function appendTerminalOutput(terminal: ManagedTerminal, chunk: string): void {
	terminal.output += chunk;
	if (terminal.outputByteLimit === null) {
		return;
	}

	const limit = Math.max(terminal.outputByteLimit, 0);
	const buffer = Buffer.from(terminal.output, "utf8");
	if (buffer.byteLength <= limit) {
		return;
	}

	let truncated = buffer.subarray(buffer.byteLength - limit);
	while (truncated.length > 0 && (truncated[0] & 0b1100_0000) === 0b1000_0000) {
		truncated = truncated.subarray(1);
	}
	terminal.output = truncated.toString("utf8");
}

function normalizePromptInput(input: unknown[]): Array<{ text: string; type: "text" }> {
	const prompt: Array<{ text: string; type: "text" }> = [];
	for (const message of input) {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			throw new Error("Agent input entries must be objects with a parts array");
		}
		const parts = (message as { parts?: unknown }).parts;
		if (!Array.isArray(parts)) {
			throw new Error("Agent input entries must contain a parts array");
		}

		for (const part of parts) {
			if (!part || typeof part !== "object" || Array.isArray(part)) {
				throw new Error("Agent input parts must be objects");
			}
			const record = part as Record<string, unknown>;
			const plainContent = typeof record.content === "string" ? record.content : null;
			const typedContent =
				record.content && typeof record.content === "object" && !Array.isArray(record.content)
					? (record.content as Record<string, unknown>)
					: null;
			if (plainContent !== null) {
				prompt.push({
					text: plainContent,
					type: "text",
				});
				continue;
			}
			if (typedContent?.type === "text" && typeof typedContent.text === "string") {
				prompt.push({
					text: typedContent.text,
					type: "text",
				});
				continue;
			}
			throw new Error("Agent input currently supports only text message parts");
		}
	}

	if (prompt.length === 0) {
		throw new Error("Agent input must contain at least one text part");
	}
	return prompt;
}

function formatShellCommand(command: string, args: string[]): string {
	return [command, ...args].map(quoteForShell).join(" ");
}

function quoteForShell(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	if (/^[A-Za-z0-9_\-./:=]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function ensureChildSpawned(
	child: ChildProcessWithoutNullStreams,
	spawnSpec: { args: string[]; command: string },
): Promise<void> {
	const startup = new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (error) => reject(error));
	});
	try {
		await startup;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to start the agent runtime via ${[spawnSpec.command, ...spawnSpec.args].join(" ")}: ${message}`,
		);
	}
}
