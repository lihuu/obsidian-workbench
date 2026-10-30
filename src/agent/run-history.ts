import type { RunStatus, RunnerRun, RunView } from "./types";

export const TASK_RUN_HISTORY_LIMIT = 5;

export function summaryFirstLine(summary: string): string {
	if (typeof summary !== "string") return "";
	for (const line of summary.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

export function runHistoryLabel(
	run: Pick<RunnerRun, "summary" | "title">
): string {
	const summary = summaryFirstLine(run.summary);
	if (summary) return summary;
	const title = typeof run.title === "string" ? run.title.trim() : "";
	return title || "No summary";
}

export function runStatusLabel(status: RunStatus): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "succeeded":
			return "Succeeded";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		default:
			return status;
	}
}

export function formatRunDuration(
	startedAt: number | null | undefined,
	endedAt?: number | null | undefined
): string | null {
	if (!startedAt || !Number.isFinite(startedAt) || startedAt <= 0) return null;
	const end = endedAt && Number.isFinite(endedAt) && endedAt >= startedAt ? endedAt : Date.now();
	const diffMs = Math.max(0, end - startedAt);
	const totalSeconds = Math.floor(diffMs / 1000);
	if (totalSeconds < 1) return "< 1s";
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function compareByCreatedAtDescending(left: RunnerRun, right: RunnerRun): number {
	if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
	// Keep ties deterministic so a re-render doesn't reshuffle equal timestamps.
	if (left.id === right.id) return 0;
	return left.id < right.id ? 1 : -1;
}

/**
 * Dedupe by run id, keep the newest snapshot for each id, sort newest first,
 * and cap the list. The Runner returns ascending history; the modal wants the
 * reverse so the current run sits at the top.
 */
export function buildRunHistory(
	runs: readonly RunnerRun[],
	limit = TASK_RUN_HISTORY_LIMIT
): RunnerRun[] {
	const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
	if (max === 0) return [];
	const byId = new Map<string, RunnerRun>();
	for (const run of runs) {
		if (!run || typeof run.id !== "string" || !run.id) continue;
		const existing = byId.get(run.id);
		if (!existing || run.createdAt >= existing.createdAt) byId.set(run.id, run);
	}
	return [...byId.values()].sort(compareByCreatedAtDescending).slice(0, max);
}

/** Insert or replace one run, keeping the list sorted, deduped, and capped. */
export function mergeRunIntoHistory(
	history: readonly RunnerRun[],
	run: RunnerRun,
	limit = TASK_RUN_HISTORY_LIMIT
): RunnerRun[] {
	return buildRunHistory(
		[...history.filter((entry) => entry.id !== run.id), run],
		limit
	);
}

/** Strip the transient log/cursor fields before storing a live run in history. */
export function runSnapshotFromView(view: RunView): RunnerRun {
	return {
		id: view.id,
		boardId: view.boardId,
		taskId: view.taskId,
		title: view.title,
		cwd: view.cwd,
		status: view.status,
		createdAt: view.createdAt,
		startedAt: view.startedAt,
		endedAt: view.endedAt,
		summary: view.summary,
		error: view.error,
		aborting: view.aborting,
		logPath: view.logPath,
		backendId: view.backendId,
		backendName: view.backendName,
		capabilities: { ...view.capabilities },
		sessionFile: view.sessionFile,
		sessionId: view.sessionId,
		imageCount: view.imageCount,
		worktreeRequested: view.worktreeRequested,
		worktreePath: view.worktreePath,
		branch: view.branch,
		baseRepo: view.baseRepo,
		worktreeRemoved: view.worktreeRemoved,
		parentRunId: view.parentRunId,
	};
}

export interface RunSelectionInput {
	latest?: RunView;
	history?: readonly RunnerRun[];
	details?: Readonly<Record<string, RunView>>;
	selectedRunId?: string | null;
	loadingRunId?: string | null;
}

export interface RunSelection {
	run: RunView | undefined;
	loading: boolean;
	viewingHistory: boolean;
}

/**
 * Resolve which run the detail panel should show. With no explicit selection
 * the live latest run wins, so polling keeps updating the panel. Once the user
 * picks an older run we keep returning that run's data only; live polling of
 * the latest run cannot replace it.
 */
export function selectDisplayedRun(input: RunSelectionInput): RunSelection {
	const {
		latest,
		history = [],
		details = {},
		selectedRunId = null,
		loadingRunId = null,
	} = input;
	if (!selectedRunId) return { run: latest, loading: false, viewingHistory: false };
	if (latest?.id === selectedRunId) {
		return { run: latest, loading: false, viewingHistory: false };
	}
	const detail = details[selectedRunId];
	if (detail) return { run: detail, loading: false, viewingHistory: true };
	const entry = history.find((run) => run.id === selectedRunId);
	const placeholder: RunView | undefined = entry
		? { ...entry, logs: [], nextCursor: 0, pollError: "" }
		: undefined;
	return {
		run: placeholder,
		loading: loadingRunId === selectedRunId,
		viewingHistory: true,
	};
}

export interface ParsedToolStep {
	name: string;
	command: string;
	raw: string;
	status: "running" | "finished" | "failed";
	duration?: string;
}

export function parseToolSteps(lines: string[]): ParsedToolStep[] {
	const steps: ParsedToolStep[] = [];
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		const endMatch = /^([a-zA-Z0-9_-]+)\s+(finished|failed)(?:\s*\(([^)]+)\))?$/i.exec(line);
		if (endMatch) {
			const toolName = endMatch[1].toLowerCase();
			const status = endMatch[2].toLowerCase() === "failed" ? "failed" : "finished";
			const duration = endMatch[3];
			let matched = false;
			for (let i = steps.length - 1; i >= 0; i--) {
				if (steps[i].status === "running" && steps[i].name.toLowerCase() === toolName) {
					steps[i].status = status;
					if (duration) steps[i].duration = duration;
					matched = true;
					break;
				}
			}
			if (!matched && steps.length > 0 && steps[steps.length - 1].status === "running") {
				steps[steps.length - 1].status = status;
				if (duration) steps[steps.length - 1].duration = duration;
				matched = true;
			}
			if (!matched) {
				steps.push({
					name: endMatch[1],
					command: `${endMatch[2]}${duration ? ` (${duration})` : ""}`,
					raw: rawLine,
					status,
					duration,
				});
			}
			continue;
		}

		let name = "tool";
		let cmd = line;

		if (line.startsWith("$ ")) {
			name = "bash";
			cmd = line.slice(2).trim();
		} else if (/^([a-zA-Z0-9_-]+):\s*(.*)$/.test(line)) {
			const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
			if (m) {
				name = m[1];
				cmd = m[2].trim();
			}
		}

		// Strip repetitive worktree cd prefix:
		// e.g. "cd /.../worktrees/... && git ..." -> "git ..."
		const cdMatch = /^cd\s+([^\s&]+)\s*&&\s*(.+)$/.exec(cmd);
		if (cdMatch) {
			cmd = cdMatch[2].trim();
		}

		steps.push({
			name,
			command: cmd,
			raw: rawLine,
			status: "running",
		});
	}
	return steps;
}
