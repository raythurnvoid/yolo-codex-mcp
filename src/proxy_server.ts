import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
	createJsonRpcResponse,
	isJsonRpcError,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	jsonRpcIdKey,
	parseJsonRpcMessage,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
} from "./jsonrpc.ts";
import { JsonRpcLineWriter } from "./line_transport.ts";
import { loadProxyConfig } from "./proxy_config.ts";
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
};

export async function runProxyServer(): Promise<void> {
	const config = loadProxyConfig();
	const resolvedLaunch = resolveInnerServerLaunch(config.innerCommand, config.innerArgs);
	const spawnSpec = createInnerServerSpawnSpec(resolvedLaunch.command, resolvedLaunch.args);
	const inner = spawn(spawnSpec.command, spawnSpec.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
		windowsHide: true,
	});

	await ensureInnerProcessStarted(inner, spawnSpec);

	const clientWriter = new JsonRpcLineWriter(process.stdout);
	const innerWriter = new JsonRpcLineWriter(inner.stdin);
	const pendingInnerRequests = new Map<string, PendingInnerRequest>();
	let nextOuterServerRequestId = 0;
	let softKillTimer: NodeJS.Timeout | null = null;
	let hardKillTimer: NodeJS.Timeout | null = null;

	inner.stderr.on("data", (chunk: Buffer | string) => {
		process.stderr.write(prefixInnerStderr(chunk));
	});

	const clientReader = createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const innerReader = createInterface({
		input: inner.stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
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

	clientReader.on("line", (line) => {
		void handleLine(line, async (message) => {
			await onClientMessage(message, {
				clientWriter,
				config,
				innerWriter,
				pendingInnerRequests,
			});
		});
	});

	innerReader.on("line", (line) => {
		void handleLine(line, async (message) => {
			await onInnerMessage(message, {
				clientWriter,
				pendingInnerRequests,
				allocateOuterServerRequestId: () => `proxy:${++nextOuterServerRequestId}`,
			});
		});
	});

	clientReader.once("close", () => {
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

	await Promise.race([once(clientReader, "close"), childExit]);
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
	},
): Promise<void> {
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
			await context.innerWriter.write({
				...message,
				params: {
					...requestParams,
					name: "codex",
					arguments: buildInnerCodexArguments(call, context.config.policy),
				},
			});
			return;
		}

		if (toolName === "codex-reply") {
			const call = parseOuterCodexReplyCall(requestParams.arguments);
			await context.innerWriter.write({
				...message,
				params: {
					...requestParams,
					name: "codex-reply",
					arguments: buildInnerCodexReplyArguments(call),
				},
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
	},
): Promise<void> {
	if (isJsonRpcRequest(message)) {
		const outerId = context.allocateOuterServerRequestId();
		context.pendingInnerRequests.set(jsonRpcIdKey(outerId), {
			innerId: message.id,
		});
		await context.clientWriter.write({
			...message,
			id: outerId,
		});
		return;
	}

	if (isJsonRpcNotification(message) || isJsonRpcResponse(message) || isJsonRpcError(message)) {
		await context.clientWriter.write(message);
	}
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
