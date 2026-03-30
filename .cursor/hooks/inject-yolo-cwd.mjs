#!/usr/bin/env node

import { stderr, stdin, stdout } from "node:process";

const inputText = await readStdin();

const hookInput = parseJsonObject(inputText);
if (hookInput === null) {
	log("Failed to parse hook input JSON from stdin; allowing tool call without cwd injection.");
	writeOutput({
		permission: "allow",
	});
	process.exit(0);
}

const workspaceRoots = readWorkspaceRoots(hookInput.workspace_roots);
const toolName = typeof hookInput?.tool_name === "string" ? hookInput.tool_name.trim() : "";
const normalizedToolName = toolName.startsWith("MCP:") ? toolName.slice(4) : toolName;
const toolInput = parseJsonObject(hookInput?.tool_input);

if (isSupportedTool(normalizedToolName)) {
	log(
		JSON.stringify({
			legacyToolCwd: hasNonEmptyString(toolInput?.cwd) ? toolInput.cwd : null,
			tool: normalizedToolName,
			warning: "Hook no longer injects cwd. The wrapper derives cwd server-side from MCP client workspace context.",
			workspaceRoots,
		}),
	);
}

writeOutput({
	permission: "allow",
});

function isSupportedTool(toolName) {
	return toolName === "codex" || toolName === "codex-reply";
}

function readWorkspaceRoots(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => {
			if (typeof entry === "string") {
				return entry.trim();
			}
			if (entry && typeof entry === "object" && !Array.isArray(entry)) {
				if (typeof entry.path === "string") {
					return entry.path.trim();
				}
				if (typeof entry.uri === "string") {
					return entry.uri.trim();
				}
			}
			return "";
		})
		.filter(Boolean);
}

function parseJsonObject(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	for (const candidate of collectJsonCandidates(trimmed)) {
		const parsed = parseNestedJson(candidate);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed;
		}
	}

	return null;
}

function collectJsonCandidates(text) {
	const candidates = [text];
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		candidates.push(text.slice(1, -1));
	}

	const firstObject = text.indexOf("{");
	const lastObject = text.lastIndexOf("}");
	if (firstObject >= 0 && lastObject > firstObject) {
		candidates.push(text.slice(firstObject, lastObject + 1));
	}

	return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function parseNestedJson(text) {
	let current = text;
	for (let depth = 0; depth < 3; depth += 1) {
		if (current && typeof current === "object") {
			return current;
		}
		if (typeof current !== "string") {
			return null;
		}
		const trimmed = current.trim();
		if (!trimmed) {
			return null;
		}

		try {
			current = JSON.parse(trimmed);
			continue;
		} catch (error) {
			const strippedQuotedObject = stripQuotedObject(trimmed);
			if (strippedQuotedObject !== null) {
				current = strippedQuotedObject;
				continue;
			}
			log(`Failed to parse JSON candidate: ${formatError(error)}`);
			return null;
		}
	}

	return current && typeof current === "object" && !Array.isArray(current) ? current : null;
}

function stripQuotedObject(text) {
	if (!(text.startsWith('"') && text.endsWith('"'))) {
		return null;
	}
	const inner = text.slice(1, -1).trim();
	if ((inner.startsWith("{") && inner.endsWith("}")) || (inner.startsWith("[") && inner.endsWith("]"))) {
		return inner;
	}
	return null;
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
