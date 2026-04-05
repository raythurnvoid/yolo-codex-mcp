import type { AgentTurnObserver } from "./acp_runtime.ts";

export type ProgressContext = {
	canHeartbeat: () => boolean;
	emitProgress: (force?: boolean) => void;
	emitStatus: (force?: boolean) => void;
	getProgressLabel: () => string | null;
	getProgressSummary: () => string | null;
	getUsageState: () => { hasMeaningfulUsage: boolean; progress: number; total: number };
	logMessage: (message: string) => void;
	markPromptResponseReceived: () => void;
	progressToken: string | number | null;
	setPhaseSummary: (summary: string | null) => void;
	setStepSummary: (summary: string | null) => void;
	setUsage: (usedTokens: number, totalTokens: number) => void;
};

type ProgressContextOptions = {
	initialUsage?: {
		progress: number;
		total: number;
	} | null;
	infoLog: (message: string) => void;
	sendNotification: (method: string, params: Record<string, unknown>) => void;
	value: unknown;
};

type RuntimeObserverOptions = {
	infoLog: (message: string) => void;
	progress: ProgressContext;
};

export function createProgressContext(options: ProgressContextOptions): ProgressContext {
	const meta =
		options.value && typeof options.value === "object" && !Array.isArray(options.value)
			? ((options.value as { _meta?: unknown })._meta ?? null)
			: null;
	const progressToken =
		meta && typeof meta === "object" && !Array.isArray(meta)
			? extractProgressToken((meta as { progressToken?: unknown }).progressToken)
			: null;
	const initialUsage =
		options.initialUsage &&
		typeof options.initialUsage.progress === "number" &&
		typeof options.initialUsage.total === "number" &&
		options.initialUsage.progress > 0
			? {
					progress: Math.max(0, Math.trunc(options.initialUsage.progress)),
					total: Math.max(Math.trunc(options.initialUsage.total), Math.trunc(options.initialUsage.progress), 1),
				}
			: null;
	let progress = initialUsage?.progress ?? 0;
	let total = initialUsage?.total ?? 1;
	let hasMeaningfulUsage = initialUsage !== null;
	let phaseSummary = "";
	let stepSummary = "";
	let promptResponseReceived = false;
	let lastProgressSemanticKey = "";
	let lastStatusMessage = "";
	const buildSummaryLabel = (): string | null => {
		return stepSummary || phaseSummary || null;
	};
	const buildStatusLabel = (): string | null => {
		const usageLabel = hasMeaningfulUsage
			? `${formatCompactTokenThousands(progress)}/${formatCompactTokenThousands(total)}`
			: "";
		const summary = buildSummaryLabel();
		if (summary && usageLabel) {
			return `${summary} (${usageLabel})`;
		}
		if (summary) {
			return summary;
		}
		if (usageLabel) {
			return `Usage: ${usageLabel}`;
		}
		return null;
	};

	const emitStatusLabel = (force = false) => {
		const statusLabel = buildStatusLabel();
		if (!statusLabel) {
			return;
		}
		if (!force && statusLabel === lastStatusMessage) {
			return;
		}
		lastStatusMessage = statusLabel;
		options.sendNotification("notifications/message", {
			data: statusLabel,
			level: "info",
		});
	};
	const emitProgressNotification = (force = false) => {
		if (progressToken === null || !hasMeaningfulUsage) {
			return;
		}
		const message = buildSummaryLabel();
		const semanticKey = JSON.stringify({
			baseProgress: progress,
			message,
			total,
		});
		if (!force && semanticKey === lastProgressSemanticKey) {
			return;
		}
		lastProgressSemanticKey = semanticKey;
		options.sendNotification("notifications/progress", {
			message: message ?? undefined,
			progress,
			progressToken,
			total,
		});
	};

	return {
		canHeartbeat: () => !promptResponseReceived,
		emitProgress: emitProgressNotification,
		emitStatus: (force = false) => {
			emitStatusLabel(force);
		},
		getProgressLabel: () => {
			if (!hasMeaningfulUsage) {
				return null;
			}
			return `${formatCompactTokenThousands(progress)}/${formatCompactTokenThousands(total)} tokens`;
		},
		getProgressSummary: buildSummaryLabel,
		getUsageState: () => ({
			hasMeaningfulUsage,
			progress,
			total,
		}),
		logMessage: (message: string) => {
			options.sendNotification("notifications/message", {
				data: message,
				level: "info",
			});
		},
		markPromptResponseReceived: () => {
			promptResponseReceived = true;
		},
		progressToken,
		setPhaseSummary: (summary: string | null) => {
			phaseSummary = normalizeProgressSummary(summary);
			lastStatusMessage = "";
			emitStatusLabel(true);
		},
		setStepSummary: (summary: string | null) => {
			stepSummary = normalizeProgressSummary(summary);
			lastStatusMessage = "";
			emitStatusLabel(true);
		},
		setUsage: (usedTokens: number, totalTokens: number) => {
			const nextProgress = roundTokensToThousands(usedTokens);
			const nextTotal = Math.max(roundTokensToThousands(totalTokens), nextProgress, 1);
			if (!hasMeaningfulUsage && nextProgress === 0) {
				return;
			}
			const wouldRegressToZero = hasMeaningfulUsage && nextProgress === 0 && progress > 0;
			if (wouldRegressToZero) {
				total = Math.max(total, nextTotal, progress, 1);
				options.infoLog(
					`progress usage ignored raw=${usedTokens}/${totalTokens} keep=${progress}/${total} token=${progressToken ?? "null"}`,
				);
				return;
			}
			progress = Math.max(progress, nextProgress);
			total = Math.max(total, nextTotal, progress, 1);
			hasMeaningfulUsage = progress > 0;
			options.infoLog(
				`progress usage updated raw=${usedTokens}/${totalTokens} rounded=${progress}/${total} token=${progressToken ?? "null"}`,
			);
		},
	};
}

export function createRuntimeObserver(options: RuntimeObserverOptions): AgentTurnObserver {
	let reportedThought = "";
	let reportedThoughtSummary = "";
	let reportedReplyStatus = false;
	let lastAssistantProgressBytes = 0;
	let lastAssistantProgressSummary = "";
	let lastMessagePreview = "";
	let lastMessagePreviewBytes = 0;
	let lastUsageLabel = "";
	const seenToolMessages = new Set<string>();
	return {
		onMessageChunk: ({ text, textBytes }) => {
			const preview = formatStreamingPreview(text, 120);
			if (!preview) {
				return;
			}
			const assistantProgressSummary = summarizeAssistantProgress(preview);
			if (
				assistantProgressSummary &&
				shouldPromoteAssistantProgressSummary({
					candidate: assistantProgressSummary,
					lastBytes: lastAssistantProgressBytes,
					lastSummary: lastAssistantProgressSummary,
					text,
					textBytes,
				})
			) {
				lastAssistantProgressBytes = textBytes;
				lastAssistantProgressSummary = assistantProgressSummary;
				reportedReplyStatus = true;
				options.progress.setStepSummary(assistantProgressSummary);
			} else if (!reportedThoughtSummary && !reportedReplyStatus) {
				reportedReplyStatus = true;
				options.progress.setStepSummary("Replying");
			}
			if (lastMessagePreview === "" && textBytes < 16 && !/[.!?\n]/.test(text) && !/\s/.test(text.trim())) {
				return;
			}
			const shouldReport =
				lastMessagePreview === "" ||
				(textBytes >= 160 && textBytes - lastMessagePreviewBytes >= 160) ||
				text.endsWith("\n");
			if (!shouldReport || preview === lastMessagePreview) {
				return;
			}
			lastMessagePreview = preview;
			lastMessagePreviewBytes = textBytes;
			options.progress.logMessage(`Answer: ${preview}`);
		},
		onThoughtChunk: (chunk) => {
			const trimmed = chunk.trim();
			if (!trimmed) {
				return;
			}
			reportedThought += trimmed;
			const summary = summarizeThoughtSummary(reportedThought);
			if (summary && summary !== reportedThoughtSummary) {
				reportedThoughtSummary = summary;
				options.progress.setStepSummary(summary);
			}
		},
		onToolCall: ({ status, title, toolCallId }) => {
			const label = title?.trim();
			if (!label) {
				return;
			}
			if (status === "pending" || status === "in_progress") {
				return;
			}
			if (status === "completed" && isNoisyToolLabel(label)) {
				return;
			}
			const message = status ? `Tool: ${label} (${status})` : `Tool: ${label}`;
			const dedupeKey = `${toolCallId ?? label}:${message}`;
			if (seenToolMessages.has(dedupeKey)) {
				return;
			}
			seenToolMessages.add(dedupeKey);
			options.progress.logMessage(message);
		},
		onPromptResponseReceived: () => {
			options.progress.markPromptResponseReceived();
		},
		onTranscriptUpdate: (transcript) => {
			if (reportedThoughtSummary) {
				return;
			}
			const activePlanEntry = transcript.plan?.entries.find((entry) => entry.status === "in_progress") ?? null;
			if (!activePlanEntry) {
				return;
			}
			options.progress.setStepSummary(normalizeProgressSummary(activePlanEntry.content));
		},
		onUsageUpdate: ({ size, used }) => {
			options.infoLog(`observer usage update used=${used} size=${size}`);
			options.progress.setUsage(used, size);
			const usageLabel = options.progress.getProgressLabel();
			if (usageLabel && usageLabel !== lastUsageLabel) {
				lastUsageLabel = usageLabel;
				options.progress.emitStatus();
			}
			options.progress.emitProgress();
		},
	};
}

export function startToolHeartbeat(progress: ProgressContext, initialMessage: string): { stop: () => void } {
	progress.setPhaseSummary(initialMessage);
	progress.emitProgress();
	const timer = setInterval(() => {
		if (!progress.canHeartbeat()) {
			return;
		}
		progress.emitStatus();
		progress.emitProgress();
	}, 5_000);
	timer.unref();
	let stopped = false;
	return {
		stop: () => {
			if (stopped) {
				return;
			}
			stopped = true;
			clearInterval(timer);
		},
	};
}

function extractProgressToken(value: unknown): string | number | null {
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	return null;
}

function normalizeProgressSummary(summary: string | null): string {
	if (!summary) {
		return "";
	}
	return summary.replace(/\s+/g, " ").trim();
}

function roundTokensToThousands(value: number): number {
	return Math.max(0, Math.round(value / 1000));
}

function formatCompactTokenThousands(value: number): string {
	if (value >= 1000) {
		return `${Math.round(value / 1000)}M`;
	}
	return `${value}K`;
}

function formatStreamingPreview(text: string, maxLength: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) {
		return "";
	}
	if (collapsed.length <= maxLength) {
		return collapsed;
	}
	return `${collapsed.slice(0, maxLength - 3)}...`;
}

function summarizeThoughtSummary(thought: string): string | null {
	const firstMeaningfulLine = thought
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstMeaningfulLine) {
		return null;
	}
	const summary = firstMeaningfulLine
		.replace(/^#+\s*/, "")
		.replace(/^[-*]\s*/, "")
		.replace(/^\*\*(.*?)\*\*$/, "$1")
		.replace(/\*\*/g, "")
		.replace(/^[`*_]+/, "")
		.replace(/[`*_]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.:;,!?]+$/, "");
	return summary || null;
}

function summarizeAssistantProgress(text: string): string | null {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return null;
	}
	const ongoingVerb = String.raw`checking|inspecting|looking|searching|reading|reviewing|analyzing|analysing|exploring|investigating|determining|clarifying|verifying|pulling|gathering|collecting|extracting|tracing|confirming|comparing|mapping|validating|locating|drafting`;
	const patterns = [
		new RegExp(String.raw`^(?:(?:I|We)(?:['’]m| am| are)\s+)?(?:${ongoingVerb})\b`, "i"),
		new RegExp(
			String.raw`^(?:(?:I|We)\s+)?(?:found|see|located|identified|discovered)\b.{0,220}\b(?:I(?:['’]m| am)\s+(?:now\s+)?(?:${ongoingVerb})|we are\s+(?:now\s+)?(?:${ongoingVerb})|next\s+I(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb})|then\s+I(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb}))\b`,
			"i",
		),
		new RegExp(
			String.raw`^continuing\b.{0,220}\b(?:${ongoingVerb}|discovery|investigation|verification|review|summary|writeup)\b`,
			"i",
		),
		new RegExp(String.raw`^(?:next|then)\b.{0,80}\bI(?:['’]m| am|['’]ll| will)\s+(?:${ongoingVerb})\b`, "i"),
		new RegExp(
			String.raw`^(?:The|This|That|It)\b.{0,220}\b(?:so|then)\s+I(?:['’]m| am|['’]ll| will)\s+(?:now\s+)?(?:${ongoingVerb})\b`,
			"i",
		),
		new RegExp(
			String.raw`^(?:I|We)(?:['’]ve| have)\s+(?:got|found|identified|confirmed)\b.{0,220}\bI(?:['’]m| am)\s+(?:now\s+)?(?:${ongoingVerb})\b`,
			"i",
		),
	];
	return patterns.some((pattern) => pattern.test(normalized)) ? normalized : null;
}

function shouldPromoteAssistantProgressSummary(options: {
	candidate: string;
	lastBytes: number;
	lastSummary: string;
	text: string;
	textBytes: number;
}): boolean {
	if (options.candidate === options.lastSummary) {
		return false;
	}
	const wordCount = options.candidate.split(/\s+/).filter(Boolean).length;
	const looksComplete = /[.!?\n]$/.test(options.text) || options.candidate.endsWith("...");
	if (!options.lastSummary) {
		return looksComplete || options.candidate.length >= 32 || wordCount >= 5;
	}
	if (options.textBytes < options.lastBytes) {
		return looksComplete || options.candidate.length >= 32 || wordCount >= 5;
	}
	if (options.candidate.startsWith(options.lastSummary)) {
		return looksComplete || options.textBytes - options.lastBytes >= 64;
	}
	return true;
}

function isNoisyToolLabel(label: string): boolean {
	return (
		/^[./\\]/.test(label) || /^[A-Za-z]:[\\/]/.test(label) || label.startsWith("/mnt/") || label.startsWith("mnt/")
	);
}
