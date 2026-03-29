import process from "node:process";

type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";
type ApprovalPolicy = "never" | "on-failure" | "on-request" | "untrusted";

export type ProxyPolicy = {
	approvalPolicy: ApprovalPolicy;
	cwd: string | null;
	model: string | null;
	profile: string | null;
	sandbox: SandboxMode;
};

export type ProxyConfig = {
	innerArgs: string[];
	innerCommand: string;
	policy: ProxyPolicy;
};

export const DEFAULT_PROXY_POLICY: ProxyPolicy = {
	approvalPolicy: "never",
	cwd: process.cwd(),
	model: null,
	profile: null,
	sandbox: "danger-full-access",
};

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	const innerCommand = readOptionalString(env.CODEX_MCP_BIN) ?? readOptionalString(env.CODEX_BIN) ?? "codex";
	const innerArgs = parseOptionalArgsJson(env.CODEX_MCP_ARGS) ?? ["mcp-server"];

	return {
		innerCommand,
		innerArgs,
		policy: DEFAULT_PROXY_POLICY,
	};
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
