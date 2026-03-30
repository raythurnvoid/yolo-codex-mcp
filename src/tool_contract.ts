import { ListToolsResultSchema, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyPolicy } from "./proxy_config.ts";
import { isRecord } from "./jsonrpc.ts";

type JsonObjectSchema = NonNullable<Tool["outputSchema"]>;

export const primaryOuterToolNames = {
	start: "agent-start",
	reply: "agent-reply",
} as const;

export const legacyOuterToolNames = {
	start: "codex",
	reply: "codex-reply",
} as const;

export type CanonicalInnerToolName = "codex" | "codex-reply";
export type OuterToolName =
	| typeof primaryOuterToolNames.start
	| typeof primaryOuterToolNames.reply
	| typeof legacyOuterToolNames.start
	| typeof legacyOuterToolNames.reply;

const contentTextSchema: NonNullable<JsonObjectSchema["properties"]>[string] = {
	type: "string",
};

const codexOutputSchema: JsonObjectSchema = {
	type: "object",
	properties: {
		threadId: {
			type: "string",
		},
		content: contentTextSchema,
	},
	required: ["threadId", "content"],
};

export type OuterCodexCall = {
	agentInstructions: string | null;
	compactPrompt: string | null;
	legacyCwd: string | null;
	prompt: string;
};

export type OuterCodexReplyCall = {
	legacyCwd: string | null;
	prompt: string;
	threadId: string;
};

type InnerCodexCall = {
	agentInstructions: string | null;
	compactPrompt: string | null;
	cwd: string | null;
	prompt: string;
};

type InnerCodexReplyCall = {
	cwd: string | null;
	prompt: string;
	threadId: string;
};

export function createReducedToolsListResult(): ListToolsResult {
	return ListToolsResultSchema.parse({
		tools: [
			{
				name: primaryOuterToolNames.start,
				title: "Smart Cheap Agent",
				description:
					"Preferred first tool for delegating complex, context-heavy work with proxy-managed policy settings. Smart Cheap Agent runs a smarter reasoning agent that can read and edit files, browse the web, and use MCP tools configured for the user; prefer it for architectural decisions, deep research, browser navigation, testing and QA, or multi-step debugging because it is usually cheaper and more cost-efficient than spending the host model's context. The response includes a human-readable answer in content/text, a trailing threadId text line, and structuredContent with threadId, thread_id, and content. To continue the same session, call agent-reply with the returned threadId from the prior response. Legacy aliases codex and codex-reply are still accepted for compatibility. For attached guidance, read yolo-codex-mcp://guides/operating-guide.md.",
				inputSchema: {
					type: "object",
					properties: {
						prompt: {
							type: "string",
							description: "The initial user prompt to start the Smart Cheap Agent conversation.",
						},
						"agent-instructions": {
							type: "string",
							description: "Optional developer instructions forwarded to Smart Cheap Agent.",
						},
						"compact-prompt": {
							type: "string",
							description: "Optional prompt override used when Smart Cheap Agent compacts the conversation.",
						},
					},
					required: ["prompt"],
				},
				outputSchema: codexOutputSchema,
			},
			{
				name: primaryOuterToolNames.reply,
				title: "Smart Cheap Agent Reply",
				description:
					"Continue the same Smart Cheap Agent session with proxy-managed policy settings. Pass the threadId returned by agent-start or a previous agent-reply call to keep the conversation on the same session. The response includes the same shape as agent-start: a human-readable answer in content/text, a trailing threadId text line, and structuredContent with threadId, thread_id, and content. Legacy aliases codex and codex-reply are still accepted for compatibility. For attached guidance, read yolo-codex-mcp://guides/operating-guide.md.",
				inputSchema: {
					type: "object",
					properties: {
						threadId: {
							type: "string",
							description:
								"The threadId returned by agent-start or a previous agent-reply call for the same Smart Cheap Agent session.",
						},
						prompt: {
							type: "string",
							description: "The next user prompt to continue the Smart Cheap Agent conversation.",
						},
					},
					required: ["threadId", "prompt"],
				},
				outputSchema: codexOutputSchema,
			},
		],
	});
}

export function normalizeOuterToolName(toolName: string): CanonicalInnerToolName | null {
	if (toolName === primaryOuterToolNames.start || toolName === legacyOuterToolNames.start) {
		return "codex";
	}
	if (toolName === primaryOuterToolNames.reply || toolName === legacyOuterToolNames.reply) {
		return "codex-reply";
	}
	return null;
}

export function parseOuterCodexCall(
	argumentsValue: unknown,
	toolName: string = primaryOuterToolNames.start,
): OuterCodexCall {
	const args = expectArgumentsObject(argumentsValue, toolName);
	const prompt = expectRequiredString(args.prompt, "prompt");
	return {
		prompt,
		agentInstructions: readOptionalString(args["agent-instructions"]),
		compactPrompt: readOptionalString(args["compact-prompt"]),
		legacyCwd: readOptionalString(args.cwd),
	};
}

export function parseOuterCodexReplyCall(
	argumentsValue: unknown,
	toolName: string = primaryOuterToolNames.reply,
): OuterCodexReplyCall {
	const args = expectArgumentsObject(argumentsValue, toolName);
	const prompt = expectRequiredString(args.prompt, "prompt");
	const threadId = readOptionalString(args.threadId) ?? readOptionalString(args.conversationId);
	if (threadId === null) {
		throw new Error("either threadId or conversationId must be provided");
	}

	return {
		threadId,
		prompt,
		legacyCwd: readOptionalString(args.cwd),
	};
}

export function buildInnerCodexArguments(call: InnerCodexCall, policy: ProxyPolicy) {
	return buildInnerCodexArgumentsWithBaseInstructions(call, policy, null);
}

export function buildInnerCodexArgumentsWithBaseInstructions(
	call: InnerCodexCall,
	policy: ProxyPolicy,
	baseDeveloperInstructions: string | null,
) {
	const forwarded: Record<string, unknown> = {
		prompt: call.prompt,
		sandbox: policy.sandbox,
		"approval-policy": policy.approvalPolicy,
	};
	const developerInstructions = mergeDeveloperInstructions(baseDeveloperInstructions, call.agentInstructions);

	if (policy.model !== null) {
		forwarded.model = policy.model;
	}
	if (policy.profile !== null) {
		forwarded.profile = policy.profile;
	}
	if (call.cwd !== null) {
		forwarded.cwd = call.cwd;
	}
	if (developerInstructions !== null) {
		forwarded["developer-instructions"] = developerInstructions;
	}
	if (call.compactPrompt !== null) {
		forwarded["compact-prompt"] = call.compactPrompt;
	}

	return forwarded;
}

export function buildInnerCodexReplyArguments(call: InnerCodexReplyCall, _policy: ProxyPolicy) {
	const forwarded: Record<string, unknown> = {
		threadId: call.threadId,
		prompt: call.prompt,
	};

	if (call.cwd !== null) {
		forwarded.cwd = call.cwd;
	}

	return forwarded;
}

export function createToolCallErrorResult(message: string) {
	return {
		content: [
			{
				type: "text",
				text: message,
			},
		],
		isError: true,
	};
}

function expectArgumentsObject(argumentsValue: unknown, toolName: string): Record<string, unknown> {
	if (!isRecord(argumentsValue)) {
		throw new Error(`Missing arguments for ${toolName} tool-call.`);
	}
	return argumentsValue;
}

function expectRequiredString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Expected ${fieldName} to be a non-empty string`);
	}
	return value;
}

function readOptionalString(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new Error("Expected optional field to be a string when present");
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function mergeDeveloperInstructions(
	baseDeveloperInstructions: string | null,
	agentInstructions: string | null,
): string | null {
	if (baseDeveloperInstructions === null) {
		return agentInstructions;
	}
	if (agentInstructions === null) {
		return baseDeveloperInstructions;
	}
	return `${baseDeveloperInstructions}\n\n${agentInstructions}`;
}
