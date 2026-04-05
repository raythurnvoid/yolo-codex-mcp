import os from "node:os";
import process from "node:process";

import { convertWindowsPathToWsl } from "./acp_runtime.ts";

// This policy exists to avoid unrelated repo context poisoning global Windows-path tasks.
// For normal contextual work we keep the triggering workspace cwd. We only neutralize cwd
// from prompt text when no trustworthy tool-call or client workspace context is available,
// so incidental absolute paths in delegated prompts do not break repo-local work.

export type ClientWorkspaceEntry = {
	name: string | null;
	path: string | null;
	source: string;
	uri: string | null;
};

export type ClientWorkspaceState = {
	initializeEntries: ClientWorkspaceEntry[];
	rootsAdvertised: boolean;
	rootsEntries: ClientWorkspaceEntry[];
	rootsRequested: boolean;
	workspaceEntries: ClientWorkspaceEntry[];
};

export type ResolvedClientCwd = {
	candidateCount: number;
	cwd: string;
	detail: string;
	source: string;
};

export type ResolvedToolCallCwd = {
	candidateCount: number;
	cwd: string;
	detail: string;
	source: "tool-meta" | "client-derived" | "process.cwd()";
	warning: string | null;
};

export type ToolCallCwdOverride = {
	absolutePaths: string[];
	cwd: string;
	neutralizationAllowed: boolean;
	reason: string | null;
};

export function createClientWorkspaceState(): ClientWorkspaceState {
	return {
		initializeEntries: [],
		rootsAdvertised: false,
		rootsEntries: [],
		rootsRequested: false,
		workspaceEntries: [],
	};
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
		return decodedPath || "/";
	}

	if (hostname && hostname !== "localhost") {
		return `//${hostname}${decodedPath}`;
	}
	return normalizeNonWindowsFileUriPath(decodedPath || "/");
}

export function resolveToolCallCwd(state: ClientWorkspaceState, metaValue?: unknown): ResolvedToolCallCwd {
	const metaDerived = resolveToolMetaCwd(state, metaValue);
	if (metaDerived !== null) {
		return {
			...metaDerived,
			source: "tool-meta",
			warning: null,
		};
	}

	const clientDerived = resolveClientDerivedCwd(state);
	if (clientDerived !== null) {
		return {
			...clientDerived,
			source: "client-derived",
			warning: null,
		};
	}

	return {
		candidateCount: 0,
		cwd: process.cwd(),
		detail: "last-resort process.cwd() fallback",
		source: "process.cwd()",
		warning: "No usable client-derived workspace cwd was available for this call.",
	};
}

export function getKnownWorkspacePaths(state: ClientWorkspaceState): string[] {
	const paths = [...state.rootsEntries, ...state.workspaceEntries, ...state.initializeEntries]
		.map((entry) => entry.path)
		.filter((path): path is string => typeof path === "string" && path.length > 0);
	return [...new Set(paths)];
}

export function maybeOverrideToolCallCwd(
	value: unknown,
	resolvedCwd: string,
	workspacePaths: string[] = [resolvedCwd],
	options: { allowNeutralization?: boolean } = {},
): ToolCallCwdOverride {
	const text = readToolCallTextArgument(value);
	const allowNeutralization = options.allowNeutralization ?? true;
	if (!text) {
		return {
			absolutePaths: [],
			cwd: resolvedCwd,
			neutralizationAllowed: allowNeutralization,
			reason: null,
		};
	}
	const absolutePaths = extractAbsolutePathsFromText(text).map((entry) => normalizeComparablePath(entry));
	if (absolutePaths.length === 0) {
		return {
			absolutePaths,
			cwd: resolvedCwd,
			neutralizationAllowed: allowNeutralization,
			reason: null,
		};
	}
	if (!allowNeutralization) {
		return {
			absolutePaths,
			cwd: resolvedCwd,
			neutralizationAllowed: false,
			reason: null,
		};
	}
	const normalizedWorkspaces = [...new Set(workspacePaths.map((entry) => normalizeComparablePath(entry)))];
	const outsideWorkspace = absolutePaths.every(
		(entry) => !normalizedWorkspaces.some((workspace) => isPathWithinWorkspace(entry, workspace)),
	);
	if (!outsideWorkspace) {
		return {
			absolutePaths,
			cwd: resolvedCwd,
			neutralizationAllowed: allowNeutralization,
			reason: null,
		};
	}
	const neutralCwd = os.homedir();
	if (!neutralCwd || neutralCwd === resolvedCwd) {
		return {
			absolutePaths,
			cwd: resolvedCwd,
			neutralizationAllowed: allowNeutralization,
			reason: null,
		};
	}
	return {
		absolutePaths,
		cwd: neutralCwd,
		neutralizationAllowed: allowNeutralization,
		reason: "cwd override: non-workspace absolute-path task",
	};
}

export function summarizeWorkspaceEntries(entries: ClientWorkspaceEntry[]): Array<Record<string, unknown>> {
	return entries.map((entry) => ({
		name: entry.name,
		path: entry.path,
		source: entry.source,
		uri: entry.uri,
	}));
}

function normalizeNonWindowsFileUriPath(decodedPath: string): string {
	const windowsDrivePath = decodedPath.match(/^\/([A-Za-z]):(\/.*)?$/);
	if (!windowsDrivePath) {
		return decodedPath;
	}
	const drive = windowsDrivePath[1].toLowerCase();
	const remainder = windowsDrivePath[2] ?? "";
	return `/mnt/${drive}${remainder}`;
}

export function resolveClientDerivedCwd(state: ClientWorkspaceState): ResolvedClientCwd | null {
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

function resolveToolMetaCwd(state: ClientWorkspaceState, metaValue: unknown): ResolvedClientCwd | null {
	const workspacePaths = getKnownWorkspacePaths(state);
	if (workspacePaths.length === 0) {
		return null;
	}
	const metaPaths = extractWorkspaceLikePathsFromMeta(metaValue).map((entry) => normalizeComparablePath(entry));
	if (metaPaths.length === 0) {
		return null;
	}
	let bestMatch: string | null = null;
	for (const workspacePath of workspacePaths) {
		const normalizedWorkspace = normalizeComparablePath(workspacePath);
		if (!metaPaths.some((entry) => isPathWithinWorkspace(entry, normalizedWorkspace))) {
			continue;
		}
		if (bestMatch === null || normalizedWorkspace.length > normalizeComparablePath(bestMatch).length) {
			bestMatch = workspacePath;
		}
	}
	if (bestMatch === null) {
		return null;
	}
	return {
		candidateCount: metaPaths.length,
		cwd: bestMatch,
		detail: "tool metadata matched workspace",
		source: "tool-meta",
	};
}

function readToolCallTextArgument(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const message = (value as { message?: unknown }).message;
	if (typeof message === "string" && message.trim().length > 0) {
		return message;
	}
	const text = (value as { text?: unknown }).text;
	if (typeof text === "string" && text.trim().length > 0) {
		return text;
	}
	return null;
}

function extractWorkspaceLikePathsFromMeta(value: unknown): string[] {
	const results: string[] = [];
	const seenObjects = new Set<unknown>();

	const visit = (node: unknown, key: string | null = null) => {
		if (Array.isArray(node)) {
			for (const entry of node) {
				visit(entry, key);
			}
			return;
		}

		if (typeof node === "string") {
			const trimmed = node.trim();
			if (!trimmed) {
				return;
			}
			if (trimmed.startsWith("file:")) {
				const filesystemPath = fileUriToFilesystemPath(trimmed);
				if (filesystemPath !== null) {
					results.push(filesystemPath);
				}
				return;
			}
			if (looksLikeMetaPathKey(key) && looksLikeAbsolutePath(trimmed)) {
				results.push(trimmed);
			}
			return;
		}

		if (!node || typeof node !== "object") {
			return;
		}
		if (seenObjects.has(node)) {
			return;
		}
		seenObjects.add(node);
		for (const [childKey, childValue] of Object.entries(node)) {
			visit(childValue, childKey);
		}
	};

	visit(value);
	return [...new Set(results)];
}

function extractAbsolutePathsFromText(text: string): string[] {
	const matches = text.match(
		/\\\\[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+|(?<![A-Za-z0-9+.-])[A-Za-z]:\/(?!\/)[^\s"'`]+|\/(?:mnt\/[A-Za-z]|home|tmp|var|etc|opt|srv|usr|private|Volumes|Users)\b[^\s"'`]*/g,
	);
	if (!matches) {
		return [];
	}
	return matches.filter((entry) => looksLikeAbsolutePath(entry));
}

function normalizeComparablePath(value: string): string {
	const trimmed = value.trim();
	const windowsAsWsl = convertWindowsPathToWsl(trimmed);
	const normalized = windowsAsWsl ?? trimmed;
	return normalized.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function isPathWithinWorkspace(candidate: string, workspace: string): boolean {
	if (candidate === workspace) {
		return true;
	}
	return candidate.startsWith(`${workspace}/`);
}

function looksLikeMetaPathKey(key: string | null): boolean {
	return (
		key === "cwd" ||
		key === "path" ||
		key === "uri" ||
		key === "rootPath" ||
		key === "rootUri" ||
		key === "workspacePath" ||
		key === "workspaceRoot" ||
		key === "filePath" ||
		key === "documentPath" ||
		key === "activeDocumentPath" ||
		key === "activeFilePath" ||
		key === "selectedPath"
	);
}

function looksLikeAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}
