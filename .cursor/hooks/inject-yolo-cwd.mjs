#!/usr/bin/env node

import { stderr, stdin, stdout } from "node:process";

const inputText = await readStdin();

let hookInput;
try {
	hookInput = JSON.parse(inputText);
} catch (error) {
	log(`Failed to parse hook input JSON: ${formatError(error)}`);
	writeOutput({
		permission: "allow",
	});
	process.exit(0);
}

const workspaceRoots = Array.isArray(hookInput?.workspace_roots)
	? hookInput.workspace_roots.filter((value) => typeof value === "string" && value.trim() !== "")
	: [];
const workspaceCwd = workspaceRoots[0]?.trim() ?? null;
const toolName = typeof hookInput?.tool_name === "string" ? hookInput.tool_name.trim() : "";
const normalizedToolName = toolName.startsWith("MCP:") ? toolName.slice(4) : toolName;

if (workspaceRoots.length > 1) {
	log(`Multiple workspace roots detected; using the first root for cwd injection: ${workspaceCwd ?? "<none>"}`);
}

if (!isSupportedTool(normalizedToolName) || workspaceCwd === null) {
	writeOutput({
		permission: "allow",
	});
	process.exit(0);
}

const toolInput = parseToolInput(hookInput?.tool_input);
if (toolInput === null) {
	log(`Skipping cwd injection for ${toolName || "<unknown>"} because tool_input was not a JSON object.`);
	writeOutput({
		permission: "allow",
	});
	process.exit(0);
}

if (hasNonEmptyString(toolInput.cwd)) {
	writeOutput({
		permission: "allow",
	});
	process.exit(0);
}

writeOutput({
	permission: "allow",
	updated_input: {
		...toolInput,
		cwd: workspaceCwd,
	},
});

function isSupportedTool(toolName) {
	return toolName === "codex" || toolName === "codex-reply";
}

function parseToolInput(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return null;
	}

	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch (error) {
		log(`Failed to parse string tool_input JSON: ${formatError(error)}`);
		return null;
	}
}

function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

function log(message) {
	stderr.write(`[yolo-codex-mcp hook] ${message}\n`);
}

function writeOutput(value) {
	stdout.write(`${JSON.stringify(value)}\n`);
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let text = "";
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk) => {
			text += chunk;
		});
		stdin.on("end", () => resolve(text));
		stdin.on("error", reject);
	});
}
