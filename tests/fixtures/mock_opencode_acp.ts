import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
	AgentSideConnection,
	PROTOCOL_VERSION,
	ndJsonStream,
	type Agent,
	type InitializeRequest,
	type InitializeResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SessionId,
} from "@agentclientprotocol/sdk";

type SessionState = {
	cwd: string | null;
	modelId: string | null;
	pendingPromptResolve: ((value: PromptResponse) => void) | null;
	promptCount: number;
	texts: string[];
};

const REQUIRED_MODEL_ID = "openai/gpt-5.4/high";

class MockAgent implements Agent {
	private readonly sessions = new Map<SessionId, SessionState>();
	private readonly connection: AgentSideConnection;
	private readonly promptAttempts = new Map<string, number>();

	constructor(connection: AgentSideConnection) {
		this.connection = connection;
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		return {
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					list: {},
					resume: {},
				},
			},
			agentInfo: {
				name: "MockOpenCode",
				version: "0.0.0-test",
			},
			protocolVersion: PROTOCOL_VERSION,
		};
	}

	async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
		const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
		this.sessions.set(sessionId, {
			cwd: _params.cwd ?? null,
			modelId: REQUIRED_MODEL_ID,
			pendingPromptResolve: null,
			promptCount: 0,
			texts: [],
		});
		return { sessionId };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		if (!this.sessions.has(params.sessionId)) {
			this.sessions.set(params.sessionId, {
				cwd: params.cwd ?? null,
				modelId: REQUIRED_MODEL_ID,
				pendingPromptResolve: null,
				promptCount: 0,
				texts: [],
			});
		}
		return {};
	}

	async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		if (!this.sessions.has(params.sessionId)) {
			this.sessions.set(params.sessionId, {
				cwd: null,
				modelId: REQUIRED_MODEL_ID,
				pendingPromptResolve: null,
				promptCount: 0,
				texts: [],
			});
		}
		const session = this.sessions.get(params.sessionId);
		if (session) {
			session.cwd = params.cwd ?? session.cwd;
		}
		return {};
	}

	async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new Error(`Unknown session ${params.sessionId}`);
		}
		session.modelId = params.modelId;
		return {};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new Error(`Unknown session ${params.sessionId}`);
		}
		if (session.modelId !== REQUIRED_MODEL_ID) {
			throw new Error(`Expected hardcoded model ${REQUIRED_MODEL_ID} but received ${session.modelId ?? "none"}`);
		}
		const text = params.prompt
			.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
			.join(" ")
			.trim();
		const promptAttempt = (this.promptAttempts.get(text) ?? 0) + 1;
		this.promptAttempts.set(text, promptAttempt);
		session.promptCount += 1;
		session.texts.push(text);
		if (text === "empty retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 0,
					size: 1_050_000,
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "empty forever") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 0,
					size: 1_050_000,
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "backend stderr failure") {
			process.stderr.write(
				[
					"ProviderModelNotFoundError: ProviderModelNotFoundError",
					" data: {",
					'  providerID: "openai",',
					'  modelID: "gpt-5.4/high",',
					"  suggestions: [],",
					" },",
					"",
				].join("\n"),
			);
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "backend stderr noise") {
			process.stderr.write("notice: backend warming local cache\n");
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_thought_chunk",
					content: {
						type: "text",
						text: "Verifying task status.",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "completed",
					title: "Lists Windows target skills directory",
					toolCallId: "call_interim_retry",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I’m checking the Windows-side skill directories and current junction state first.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 14_597,
					size: 1_050_000,
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Verified done. (1) folders found: edge-remote-debugging-mcp",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry multi" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I’m checking the Windows-mapped paths and existing skill links first.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry multi" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I found one candidate folder. I’m now verifying whether the existing target is actually a junction to the same source.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry multi" && promptAttempt === 3) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Verified done. (1) folders found: edge-remote-debugging-mcp",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry long" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Pulling a few focused snippets to confirm the type guards and header routing before writing the summary.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry long" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I found the header route handling. I’m now comparing the remaining version-group guards.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry long" && promptAttempt === 3) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Collecting the last references so I can write the final architectural summary.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "interim retry long" && promptAttempt === 4) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Architectural summary: header routing is guarded centrally and the version-group logic is confirmed in the repository.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text.includes("action plan retry") && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Yes, that is the standard move pattern: relocate the folder, update the imports, then delete the old directory.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text.includes("action plan retry") && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "completed",
					title: "Moved requested module files",
					toolCallId: "call_action_plan_retry",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Done. I moved the files and updated the imports.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "locating retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Locating the target folder, then I’ll run a scoped search for `_className` with `_classNames` excluded.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "locating retry" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "completed",
					title: "Scoped grep for _className",
					toolCallId: "call_locating_retry",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Done. `_className` appears on two matching lines under the requested folder.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "wsl config discovery retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Checking the actual machine state now: local OpenCode config under the Windows user profile first, then WSL availability and any matching paths.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "wsl config discovery retry" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Found a real Windows-side config directory at `C:\\Users\\rt0\\.config\\opencode`. Next I’m checking whether OpenCode also has XDG-style data/cache dirs here, then querying the Ubuntu WSL distro for the same locations and any project `.opencode*` files.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "wsl config discovery retry" && promptAttempt === 3) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Continuing with the Linux-side discovery now: Ubuntu WSL home/XDG paths, mounted Windows side from inside WSL, and any repo-local `.opencode*` files.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "wsl config discovery retry" && promptAttempt === 4) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Confirmed paths: Windows config at `C:\\Users\\rt0\\.config\\opencode`, plus the Linux-side WSL XDG locations under `~/.config/opencode`, `~/.local/share/opencode`, and `~/.cache/opencode` when present.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "path explanation retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Inspecting the existing skill content and nearby Convex auth/schema files first so the new section matches the repo’s tone and guidance.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "path explanation retry" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "The skill file path wasn’t under `C:\\Users\\rt0` directly, so I’m locating the repo copy and reading the existing section layout before editing.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "path explanation retry" && promptAttempt === 3) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Done. I updated the skill guidance after reading the repo copy.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "progress chunk stream") {
			for (const chunk of [
				"Inspect",
				"ing the",
				" workspace",
				" scripts",
				" and test",
				" setup first",
				" so I can run",
				" the right scope",
				" instead of guessing.",
			]) {
				await this.connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: chunk,
						},
					},
				});
			}
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "have got then checking retry" && promptAttempt === 1) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I’m reviewing the existing migration skill, Convex rules, and the actual schema/modules first so the CLI guidance and purge plan match this repo.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "have got then checking retry" && promptAttempt === 2) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "I’ve got the schema-level references. I’m checking the user/bootstrap code and workspace helpers now so the purge order matches how default workspace/project rows are created and linked.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "have got then checking retry" && promptAttempt === 3) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Done. I updated the migration skill with the CLI workflow and the repo-specific purge order.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "two step repo") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_thought_chunk",
					content: {
						type: "text",
						text: "Inspecting repository details.",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "pending",
					title: "glob",
					toolCallId: "call_two_step_repo",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "completed",
					title: "glob",
					toolCallId: "call_two_step_repo",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Inspecting the repo entry points and metadata to summarize it accurately. ",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "Checking the mounted workspace path so I can read the repo.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text.includes("internal progress update, not the final answer for the user")) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 24_748,
					size: 1_050_000,
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "`flamingo-dashboard` is the React/TypeScript frontend for Sybill's dashboard product.",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "acp metadata sweep") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "user_message_chunk",
					messageId: "11111111-1111-1111-1111-111111111111",
					content: {
						type: "text",
						text: "user echo",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "plan",
					entries: [
						{ content: "Inspect schema", priority: "high", status: "completed" },
						{ content: "Patch skill file", priority: "high", status: "in_progress" },
					],
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: [
						{
							name: "create_plan",
							description: "Create a plan",
						},
					],
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "current_mode_update",
					currentModeId: "build",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: [
						{
							id: "thought_level",
							name: "Thought level",
							type: "select",
							currentValue: "high",
							options: {
								type: "untitled",
								items: [{ value: "medium" }, { value: "high" }],
							},
						},
					],
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "session_info_update",
					title: "Metadata Sweep",
					updatedAt: "2026-04-02T11:00:00.000Z",
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 14_000,
					size: 1_050_000,
					cost: {
						amount: 0.12,
						currency: "USD",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "22222222-2222-2222-2222-222222222222",
					content: {
						type: "text",
						text: "metadata ok",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "message id split") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
					content: {
						type: "text",
						text: "first message",
					},
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
					content: {
						type: "text",
						text: " second message",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		if (text === "tool call merge") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "call_merge",
					title: "read schema",
					status: "pending",
					kind: "read",
					locations: [{ path: "packages/app/convex/schema.ts", line: 1 }],
					content: [],
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "call_merge",
					status: "completed",
					title: "read schema",
					locations: [{ path: "packages/app/convex/schema.ts", line: 42 }],
				},
			});
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "merge ok",
					},
				},
			});
			return {
				stopReason: "end_turn",
			};
		}
		const reply = text.startsWith("cwd please")
			? `cwd(${params.sessionId})#${session.promptCount}: ${session.cwd ?? "null"}`
			: `echo(${params.sessionId})#${session.promptCount}: ${text}`;
		await this.connection.sessionUpdate({
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_thought_chunk",
				content: {
					type: "text",
					text: "Drafting a short reply.",
				},
			},
		});
		await this.connection.sessionUpdate({
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "usage_update",
				used: text === "zero usage only" ? 0 : 8_671,
				size: 1_050_000,
			},
		});
		await this.connection.sessionUpdate({
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: reply,
				},
			},
		});
		if (text === "usage reset") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 0,
					size: 1_050_000,
				},
			});
		}
		if (text === "late flush") {
			setTimeout(() => {
				void this.connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: " (tail)",
						},
					},
				});
			}, 25).unref();
			setTimeout(() => {
				void this.connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: " done",
						},
					},
				});
			}, 75).unref();
		}
		if (text === "multi burst") {
			setTimeout(() => {
				void this.connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: " first burst",
						},
					},
				});
			}, 50).unref();
			setTimeout(() => {
				void this.connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: " second burst",
						},
					},
				});
			}, 2_200).unref();
		}
		if (text === "slow active turn") {
			return await new Promise<PromptResponse>((resolve) => {
				setTimeout(() => {
					void this.connection.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: {
								type: "text",
								text: " first phase",
							},
						},
					});
				}, 25).unref();
				setTimeout(() => {
					void this.connection.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "tool_call",
							kind: "search",
							locations: [],
							rawInput: {},
							status: "completed",
							title: "late tool update",
							toolCallId: "call_slow_active_turn",
						},
					});
				}, 9_000).unref();
				setTimeout(() => {
					void this.connection.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: {
								type: "text",
								text: " final phase",
							},
						},
					});
					resolve({
						stopReason: "end_turn",
					});
				}, 10_000).unref();
			});
		}
		if (text === "noisy tool label") {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					kind: "search",
					locations: [],
					rawInput: {},
					status: "completed",
					title: "mnt/c/Users/rt0/.cursor/skills",
					toolCallId: "call_noisy_tool_label",
				},
			});
		}
		if (text === "stall") {
			return await new Promise<PromptResponse>((resolve) => {
				session.pendingPromptResolve = resolve;
			});
		}
		return {
			stopReason: "end_turn",
		};
	}

	async authenticate(): Promise<void> {}

	async cancel(params: { sessionId: SessionId }): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session?.pendingPromptResolve) {
			return;
		}
		const resolve = session.pendingPromptResolve;
		session.pendingPromptResolve = null;
		resolve({
			stopReason: "end_turn",
		});
	}
}

const stream = ndJsonStream(
	Writable.toWeb(process.stdout),
	Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
new AgentSideConnection((connection) => new MockAgent(connection), stream);
