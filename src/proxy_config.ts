import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";
type ApprovalPolicy = "never" | "on-failure" | "on-request" | "untrusted";

export type ProxyPolicy = {
	approvalPolicy: ApprovalPolicy;
	model: string | null;
	profile: string | null;
	sandbox: SandboxMode;
};

export type ProxyConfig = {
	baseDeveloperInstructions: string | null;
	innerArgs: string[];
	innerCommand: string;
	policy: ProxyPolicy;
};

export const DEFAULT_PROXY_POLICY: ProxyPolicy = {
	approvalPolicy: "never",
	model: null,
	profile: null,
	sandbox: "danger-full-access",
};

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	const innerCommand = readOptionalString(env.CODEX_MCP_BIN) ?? readOptionalString(env.CODEX_BIN) ?? "codex";
	const innerArgs = parseOptionalArgsJson(env.CODEX_MCP_ARGS) ?? ["mcp-server"];
	const baseDeveloperInstructions = loadOptionalDeveloperInstructions(env.SMART_CHEAP_AGENT_SYSTEM_PROMPT_FILE);
	const policy: ProxyPolicy = {
		...DEFAULT_PROXY_POLICY,
	};

	return {
		baseDeveloperInstructions,
		innerCommand,
		innerArgs,
		policy,
	};
}

function loadOptionalDeveloperInstructions(systemPromptFile: string | undefined): string | null {
	const filePath = readOptionalString(systemPromptFile);
	if (filePath === null) {
		return null;
	}
	if (!path.isAbsolute(filePath)) {
		logConfigWarning("SMART_CHEAP_AGENT_SYSTEM_PROMPT_FILE must be an absolute path", filePath);
		return null;
	}

	const extension = path.extname(filePath).toLowerCase();
	if (extension !== ".md" && extension !== ".txt") {
		logConfigWarning("SMART_CHEAP_AGENT_SYSTEM_PROMPT_FILE must point to a .md or .txt file", filePath);
		return null;
	}

	try {
		return readOptionalString(readFileSync(filePath, "utf8"));
	} catch (error) {
		logConfigWarning(
			`Could not read SMART_CHEAP_AGENT_SYSTEM_PROMPT_FILE: ${error instanceof Error ? error.message : String(error)}`,
			filePath,
		);
		return null;
	}
}

function parseOptionalArgsJson(value: string | undefined): string[] | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}

	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error("CODEX_MCP_ARGS must be a JSON array of strings");
	}
	return parsed;
}

function readOptionalString(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function logConfigWarning(message: string, filePath: string): void {
	process.stderr.write(`[yolo-codex-mcp][config] ${message}: ${filePath}\n`);
}
