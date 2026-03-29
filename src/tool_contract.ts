import { ListToolsResultSchema, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyPolicy } from "./proxy_config.ts";
import { isRecord } from "./jsonrpc.ts";

type JsonObjectSchema = NonNullable<Tool["outputSchema"]>;

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
	prompt: string;
};

export type OuterCodexReplyCall = {
	prompt: string;
	threadId: string;
};

export function createReducedToolsListResult(): ListToolsResult {
	return ListToolsResultSchema.parse({
		tools: [
			{
				name: "codex",
				title: "Codex",
				description: "Run a Codex session with proxy-managed policy settings.",
				inputSchema: {
					type: "object",
					properties: {
						prompt: {
							type: "string",
							description: "The initial user prompt to start the Codex conversation.",
						},
						"agent-instructions": {
							type: "string",
							description: "Optional developer instructions forwarded to Codex.",
						},
						"compact-prompt": {
							type: "string",
							description: "Optional prompt override used when Codex compacts the conversation.",
						},
					},
					required: ["prompt"],
				},
				outputSchema: codexOutputSchema,
			},
			{
				name: "codex-reply",
				title: "Codex Reply",
				description: "Continue a Codex conversation by thread id and prompt.",
				inputSchema: {
					type: "object",
					properties: {
						threadId: {
							type: "string",
							description: "The thread id for this Codex session.",
						},
						prompt: {
							type: "string",
							description: "The next user prompt to continue the Codex conversation.",
						},
					},
					required: ["threadId", "prompt"],
				},
				outputSchema: codexOutputSchema,
			},
		],
	});
}

export function parseOuterCodexCall(argumentsValue: unknown): OuterCodexCall {
	const args = expectArgumentsObject(argumentsValue, "codex");
	const prompt = expectRequiredString(args.prompt, "prompt");
	return {
		prompt,
		agentInstructions: readOptionalString(args["agent-instructions"]),
		compactPrompt: readOptionalString(args["compact-prompt"]),
	};
}

export function parseOuterCodexReplyCall(argumentsValue: unknown): OuterCodexReplyCall {
	const args = expectArgumentsObject(argumentsValue, "codex-reply");
	const prompt = expectRequiredString(args.prompt, "prompt");
	const threadId = readOptionalString(args.threadId) ?? readOptionalString(args.conversationId);
	if (threadId === null) {
		throw new Error("either threadId or conversationId must be provided");
	}

	return {
		threadId,
		prompt,
	};
}

export function buildInnerCodexArguments(call: OuterCodexCall, policy: ProxyPolicy) {
	const forwarded: Record<string, unknown> = {
		prompt: call.prompt,
		sandbox: policy.sandbox,
		"approval-policy": policy.approvalPolicy,
	};

	if (policy.model !== null) {
		forwarded.model = policy.model;
	}
	if (policy.profile !== null) {
		forwarded.profile = policy.profile;
	}
	if (policy.cwd !== null) {
		forwarded.cwd = policy.cwd;
	}
	if (call.agentInstructions !== null) {
		forwarded["developer-instructions"] = call.agentInstructions;
	}
	if (call.compactPrompt !== null) {
		forwarded["compact-prompt"] = call.compactPrompt;
	}

	return forwarded;
}

export function buildInnerCodexReplyArguments(call: OuterCodexReplyCall) {
	return {
		threadId: call.threadId,
		prompt: call.prompt,
	};
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
