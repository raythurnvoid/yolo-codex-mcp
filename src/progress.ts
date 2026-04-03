import type { AgentTurnObserver } from "./acp_runtime.ts";

export type ProgressContext = {
	canHeartbeat: () => boolean;
	emitProgress: () => void;
	emitStatus: (force?: boolean) => void;
	getProgressLabel: () => string | null;
	logMessage: (message: string) => void;
	markPromptResponseReceived: () => void;
	progressToken: string | number | null;
	setPhaseSummary: (summary: string | null) => void;
	setStepSummary: (summary: string | null) => void;
	setUsage: (usedTokens: number, totalTokens: number) => void;
};

type ProgressContextOptions = {
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
	let progress = 0;
	let total = 1;
	let hasMeaningfulUsage = false;
	let phaseSummary = "";
	let stepSummary = "";
	let promptResponseReceived = false;
	let lastStatusMessage = "";
	const buildStatusLabel = (): string | null => {
		const usageLabel = hasMeaningfulUsage
			? `${formatCompactTokenThousands(progress)}/${formatCompactTokenThousands(total)}`
			: "";
		const summary = stepSummary || phaseSummary;
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

	return {
		canHeartbeat: () => !promptResponseReceived,
		emitProgress: () => {
			if (progressToken === null || !hasMeaningfulUsage) {
				return;
			}
			options.sendNotification("notifications/progress", {
				progress,
				progressToken,
				total,
			});
		},
		emitStatus: emitStatusLabel,
		getProgressLabel: () => {
			if (!hasMeaningfulUsage) {
				return null;
			}
			return `${formatCompactTokenThousands(progress)}/${formatCompactTokenThousands(total)} tokens`;
		},
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
			if (!reportedThoughtSummary && !reportedReplyStatus) {
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

function isNoisyToolLabel(label: string): boolean {
	return (
		/^[./\\]/.test(label) || /^[A-Za-z]:[\\/]/.test(label) || label.startsWith("/mnt/") || label.startsWith("mnt/")
	);
}
