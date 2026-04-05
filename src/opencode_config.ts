import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export type OpenCodeConfig = {
	innerArgs: string[];
	innerCommand: string;
};

export function loadOpenCodeConfig(env: NodeJS.ProcessEnv = process.env): OpenCodeConfig {
	return {
		innerCommand: readOptionalString(env.OPENCODE_BIN) ?? "opencode",
		innerArgs: parseOptionalArgsJson(env.OPENCODE_ARGS) ?? ["acp"],
	};
}

export function resolveOpenCodeLaunch(
	command: string,
	args: string[],
	options: {
		env?: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
		pathLookup?: (candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string | null;
		pathReadText?: (candidate: string) => string | null;
		pathRealpath?: (candidate: string) => string | null;
		platform?: NodeJS.Platform;
	} = {},
): { args: string[]; command: string } {
	const platform = options.platform ?? process.platform;
	const resolvedCommand = resolveOpenCodeCommand(command, options);
	if (resolvedCommand !== null) {
		return {
			command: resolvedCommand,
			args,
		};
	}

	throw new Error(createMissingOpenCodeMessage(command, platform));
}

export function resolveOpenCodeCommand(
	command: string,
	options: {
		env?: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
		pathLookup?: (candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string | null;
		pathReadText?: (candidate: string) => string | null;
		pathRealpath?: (candidate: string) => string | null;
		platform?: NodeJS.Platform;
	} = {},
): string | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const pathExists = options.pathExists ?? existsSync;
	const pathLookup = options.pathLookup ?? lookupCommandOnPath;
	const pathReadText = options.pathReadText ?? readTextIfAccessible;
	const pathRealpath = options.pathRealpath ?? getRealpathIfAccessible;

	if (looksLikePath(command)) {
		if (platform === "win32") {
			return resolveWindowsSpawnablePath(command, pathExists, pathReadText, pathRealpath);
		}
		return pathExists(command) ? command : null;
	}

	const resolvedOnPath = pathLookup(command, platform, env);
	if (resolvedOnPath !== null) {
		if (platform !== "win32") {
			return resolvedOnPath;
		}
		const nativeResolvedOnPath = resolveWindowsSpawnablePath(resolvedOnPath, pathExists, pathReadText, pathRealpath);
		if (nativeResolvedOnPath !== null) {
			return nativeResolvedOnPath;
		}
	}

	if (platform === "win32" && command.toLowerCase() === "opencode") {
		return resolveWindowsUserInstallPath(pathExists, pathReadText, pathRealpath, env);
	}

	return null;
}

export function createOpenCodeSpawnSpec(
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

function parseOptionalArgsJson(value: string | undefined): string[] | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}

	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error("OPENCODE_ARGS must be a JSON array of strings");
	}
	return parsed;
}

function readOptionalString(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function createMissingOpenCodeMessage(command: string, platform: NodeJS.Platform): string {
	const base = `Failed to resolve OpenCode command "${command}".`;
	if (platform === "win32") {
		return `${base} The wrapper tried PATH lookup plus common Windows install locations, including user shims and pnpm/npm global bin folders. Ensure \`opencode\` is installed for Windows, or set OPENCODE_BIN / OPENCODE_ARGS explicitly.`;
	}
	return `${base} Ensure \`${command}\` is installed and on PATH, or set OPENCODE_BIN / OPENCODE_ARGS explicitly.`;
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

	for (const line of lookup.stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean)) {
		return line;
	}
	return null;
}

function resolveWindowsWhereCommand(env: NodeJS.ProcessEnv): string {
	const systemRoot = env.SystemRoot ?? env.WINDIR;
	return systemRoot ? path.win32.join(systemRoot, "System32", "where.exe") : "where";
}

function resolveWindowsUserInstallPath(
	pathExists: (candidate: string) => boolean,
	pathReadText: (candidate: string) => string | null,
	pathRealpath: (candidate: string) => string | null,
	env: NodeJS.ProcessEnv,
): string | null {
	for (const home of getWindowsHomeDirectories(env)) {
		for (const candidate of getWindowsOpenCodeInstallCandidates(home)) {
			const resolved = resolveWindowsSpawnablePath(candidate, pathExists, pathReadText, pathRealpath);
			if (resolved !== null) {
				return resolved;
			}
		}
	}
	return null;
}

function getWindowsHomeDirectories(env: NodeJS.ProcessEnv): string[] {
	const unique = new Set<string>();
	for (const rawValue of [env.USERPROFILE, env.HOME]) {
		const normalized = normalizeWindowsHomeDirectory(rawValue);
		if (normalized) {
			unique.add(normalized);
		}
	}
	return [...unique];
}

function normalizeWindowsHomeDirectory(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}
	if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
		return path.win32.normalize(trimmed);
	}
	const mntMatch = trimmed.match(/^\/mnt\/([A-Za-z])\/(.+)$/);
	if (mntMatch) {
		return path.win32.join(`${mntMatch[1].toUpperCase()}:\\`, ...mntMatch[2].split("/"));
	}
	const rootDriveMatch = trimmed.match(/^\/([A-Za-z])\/(.+)$/);
	if (rootDriveMatch) {
		return path.win32.join(`${rootDriveMatch[1].toUpperCase()}:\\`, ...rootDriveMatch[2].split("/"));
	}
	return null;
}

function getWindowsOpenCodeInstallCandidates(home: string): string[] {
	return [
		path.win32.join(home, ".opencode", "bin", "opencode"),
		path.win32.join(home, ".opencode", "bin", "opencode.cmd"),
		path.win32.join(home, ".opencode", "bin", "opencode.bat"),
		path.win32.join(home, ".opencode", "bin", "opencode.exe"),
		path.win32.join(home, ".vite-plus", "bin", "opencode"),
		path.win32.join(home, ".vite-plus", "bin", "opencode.cmd"),
		path.win32.join(home, ".vite-plus", "bin", "opencode.bat"),
		path.win32.join(home, ".vite-plus", "bin", "opencode.exe"),
		path.win32.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "opencode.exe"),
		path.win32.join(home, "AppData", "Local", "pnpm", "opencode"),
		path.win32.join(home, "AppData", "Local", "pnpm", "opencode.cmd"),
		path.win32.join(home, "AppData", "Local", "pnpm", "opencode.bat"),
		path.win32.join(home, "AppData", "Local", "pnpm", "opencode.exe"),
		path.win32.join(home, "AppData", "Roaming", "npm", "opencode"),
		path.win32.join(home, "AppData", "Roaming", "npm", "opencode.cmd"),
		path.win32.join(home, "AppData", "Roaming", "npm", "opencode.bat"),
		path.win32.join(home, "AppData", "Roaming", "npm", "opencode.exe"),
	];
}

function resolveWindowsSpawnablePath(
	command: string,
	pathExists: (candidate: string) => boolean,
	pathReadText: (candidate: string) => string | null,
	pathRealpath: (candidate: string) => string | null,
	seen = new Set<string>(),
): string | null {
	const normalizedKey = path.win32.normalize(command).toLowerCase();
	if (seen.has(normalizedKey)) {
		return null;
	}
	seen.add(normalizedKey);

	if (path.win32.extname(command)) {
		if (!pathExists(command)) {
			return null;
		}
		if (isWindowsWslWrapperScript(command, pathReadText)) {
			return null;
		}
		return command;
	}

	for (const extension of [".exe", ".cmd", ".bat"]) {
		const candidate = `${command}${extension}`;
		if (pathExists(candidate)) {
			if (isWindowsWslWrapperScript(candidate, pathReadText)) {
				continue;
			}
			return candidate;
		}
	}

	if (!pathExists(command)) {
		return null;
	}

	const realPath = pathRealpath(command);
	if (realPath !== null && path.win32.normalize(realPath).toLowerCase() !== normalizedKey) {
		return resolveWindowsSpawnablePath(realPath, pathExists, pathReadText, pathRealpath, seen);
	}

	return null;
}

function isWindowsWslWrapperScript(command: string, pathReadText: (candidate: string) => string | null): boolean {
	const extension = path.win32.extname(command).toLowerCase();
	if (extension !== ".cmd" && extension !== ".bat") {
		return false;
	}
	const text = pathReadText(command);
	if (text === null) {
		return false;
	}
	return /wsl\.exe/i.test(text) && /bash\s+-lic/i.test(text) && /exec opencode/i.test(text);
}

function getRealpathIfAccessible(candidate: string): string | null {
	try {
		return realpathSync.native(candidate);
	} catch {
		return null;
	}
}

function readTextIfAccessible(candidate: string): string | null {
	try {
		return readFileSync(candidate, "utf8");
	} catch {
		return null;
	}
}

function looksLikePath(command: string): boolean {
	return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
}

function isWindowsBatchCommand(command: string): boolean {
	return /\.(bat|cmd)$/i.test(command);
}

function formatCmdInvocation(command: string, args: string[]): string {
	return [command, ...args].map(quoteForCmd).join(" ");
}

function quoteForCmd(value: string): string {
	if (value.length === 0) {
		return '""';
	}
	const escaped = value.replace(/"/g, '""');
	return /[\s"&<>|^]/.test(escaped) ? `"${escaped}"` : escaped;
}
