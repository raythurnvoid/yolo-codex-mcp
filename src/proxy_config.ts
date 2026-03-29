import process from "node:process";

type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";
type ApprovalPolicy = "never" | "on-failure" | "on-request" | "untrusted";
export type DebugInboundMode = "all" | "off" | "selected" | "unknown" | "verbose";

export type ProxyPolicy = {
	approvalPolicy: ApprovalPolicy;
	cwd: string | null;
	model: string | null;
	profile: string | null;
	sandbox: SandboxMode;
};

export type ProxyConfig = {
	debugInbound: DebugInboundMode;
	innerArgs: string[];
	innerCommand: string;
	policy: ProxyPolicy;
};

export const DEFAULT_PROXY_POLICY: ProxyPolicy = {
	approvalPolicy: "never",
	cwd: null,
	model: null,
	profile: null,
	sandbox: "danger-full-access",
};

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	const innerCommand = readOptionalString(env.CODEX_MCP_BIN) ?? readOptionalString(env.CODEX_BIN) ?? "codex";
	const innerArgs = parseOptionalArgsJson(env.CODEX_MCP_ARGS) ?? ["mcp-server"];
	const policy: ProxyPolicy = {
		...DEFAULT_PROXY_POLICY,
		cwd: resolveProxyCwd(env),
	};

	return {
		debugInbound: readDebugInboundMode(env.CODEX_MCP_DEBUG_INBOUND),
		innerCommand,
		innerArgs,
		policy,
	};
}

export function resolveProxyCwd(env: NodeJS.ProcessEnv = process.env): string {
	const configuredCwd = readOptionalString(env.CODEX_MCP_CWD);
	if (configuredCwd === null || configuredCwd === "${workspaceFolder}") {
		return process.cwd();
	}
	return configuredCwd;
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

function readBooleanFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readDebugInboundMode(value: string | undefined): DebugInboundMode {
	const normalized = value?.trim().toLowerCase();
	switch (normalized) {
		case "all":
			return "all";
		case "unknown":
		case "unknown-methods":
			return "unknown";
		case "verbose":
		case "full":
			return "verbose";
		case "selected":
		case "summary":
			return "selected";
		default:
			return readBooleanFlag(value) ? "selected" : "off";
	}
}
