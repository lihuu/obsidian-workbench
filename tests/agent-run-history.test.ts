import { describe, expect, it } from "vitest";
import {
	buildRunChain,
	buildRunHistory,
	extractSessionUserMessages,
	formatRunDuration,
	mergeRunIntoHistory,
	parseToolSteps,
	runHistoryLabel,
	runSnapshotFromView,
	runStatusLabel,
	selectDisplayedRun,
	summaryFirstLine,
	TASK_RUN_HISTORY_LIMIT,
} from "../src/agent/run-history";
import type { RunnerRun, RunStatus, RunView } from "../src/agent/types";

function makeRun(
	overrides: Partial<RunnerRun> & Pick<RunnerRun, "id" | "createdAt">
): RunnerRun {
	return {
		boardId: "b_board",
		taskId: "t_task",
		title: "Task",
		cwd: "/tmp/work",
		status: "succeeded",
		startedAt: null,
		endedAt: null,
		summary: "",
		error: "",
		aborting: false,
		logPath: null,
		backendId: "pi",
		backendName: "Pi",
		capabilities: {
			streaming: true,
			toolEvents: true,
			abort: true,
			steer: true,
			followUp: true,
			clearQueue: true,
			resume: true,
			images: true,
		},
		sessionFile: "",
		sessionId: "",
		imageCount: 0,
		worktreeRequested: false,
		worktreePath: "",
		branch: "",
		baseRepo: "",
		worktreeRemoved: false,
		parentRunId: "",
		...overrides,
	};
}

describe("buildRunHistory", () => {
	it("sorts runs newest first", () => {
		const runs = [
			makeRun({ id: "r_middle", createdAt: 200 }),
			makeRun({ id: "r_oldest", createdAt: 100 }),
			makeRun({ id: "r_newest", createdAt: 300 }),
		];

		expect(buildRunHistory(runs).map((run) => run.id)).toEqual([
			"r_newest",
			"r_middle",
			"r_oldest",
		]);
	});

	it("dedupes by id and keeps the newest snapshot", () => {
		const runs = [
			makeRun({ id: "r_one", createdAt: 100, status: "running" }),
			makeRun({ id: "r_one", createdAt: 100, status: "succeeded" }),
			makeRun({ id: "r_two", createdAt: 200 }),
		];

		const history = buildRunHistory(runs);
		expect(history.map((run) => run.id)).toEqual(["r_two", "r_one"]);
		expect(history[1]?.status).toBe("succeeded");
	});

	it("caps the list at five runs by default", () => {
		const runs = Array.from({ length: 7 }, (_, index) =>
			makeRun({ id: `r_${index}`, createdAt: 100 + index })
		);

		const history = buildRunHistory(runs);
		expect(history).toHaveLength(TASK_RUN_HISTORY_LIMIT);
		expect(history.map((run) => run.id)).toEqual([
			"r_6",
			"r_5",
			"r_4",
			"r_3",
			"r_2",
		]);
	});

	it("honors a custom limit and ignores invalid limits", () => {
		const runs = [makeRun({ id: "r_a", createdAt: 1 }), makeRun({ id: "r_b", createdAt: 2 })];

		expect(buildRunHistory(runs, 1).map((run) => run.id)).toEqual(["r_b"]);
		expect(buildRunHistory(runs, 0)).toEqual([]);
		expect(buildRunHistory(runs, -3)).toEqual([]);
		expect(buildRunHistory(runs, Number.NaN)).toEqual([]);
	});
});

describe("summaryFirstLine", () => {
	it("returns the first non-empty line", () => {
		expect(summaryFirstLine("\n  \nImplemented the feature.\nDetails follow.")).toBe(
			"Implemented the feature."
		);
	});

	it("handles CRLF and trims surrounding whitespace", () => {
		expect(summaryFirstLine("  First line  \r\nSecond line")).toBe("First line");
	});

	it("returns an empty string when there is no usable summary", () => {
		expect(summaryFirstLine("")).toBe("");
		expect(summaryFirstLine("   \n\t\n")).toBe("");
	});
});

describe("runHistoryLabel", () => {
	it("prefers the summary first line", () => {
		expect(
			runHistoryLabel(
				makeRun({ id: "r_one", createdAt: 1, title: "Fallback", summary: "Summary\nMore" })
			)
		).toBe("Summary");
	});

	it("falls back to the title when the summary is empty", () => {
		expect(
			runHistoryLabel(makeRun({ id: "r_one", createdAt: 1, title: "Task title", summary: " \n" }))
		).toBe("Task title");
	});

	it("falls back to a placeholder when title and summary are empty", () => {
		expect(
			runHistoryLabel(makeRun({ id: "r_one", createdAt: 1, title: "  ", summary: "" }))
		).toBe("No summary");
	});
});

describe("mergeRunIntoHistory", () => {
	it("replaces the matching run, updates its status, and keeps newest first", () => {
		const history = [
			makeRun({ id: "r_old", createdAt: 100 }),
			makeRun({ id: "r_live", createdAt: 200, status: "running" }),
		];

		const merged = mergeRunIntoHistory(
			history,
			makeRun({ id: "r_live", createdAt: 200, status: "succeeded", summary: "Done." })
		);

		expect(merged.map((run) => run.id)).toEqual(["r_live", "r_old"]);
		expect(merged[0]?.status).toBe("succeeded");
		expect(merged[0]?.summary).toBe("Done.");
	});

	it("adds a new run and drops the oldest beyond the limit", () => {
		const history = Array.from({ length: 5 }, (_, index) =>
			makeRun({ id: `r_${index}`, createdAt: 100 + index })
		);

		const merged = mergeRunIntoHistory(
			history,
			makeRun({ id: "r_new", createdAt: 999 })
		);

		expect(merged).toHaveLength(5);
		expect(merged[0]?.id).toBe("r_new");
		expect(merged.some((run) => run.id === "r_0")).toBe(false);
	});
});

describe("runSnapshotFromView", () => {
	it("strips transient log and cursor fields", () => {
		const view: RunView = {
			...makeRun({ id: "r_one", createdAt: 1, summary: "Done." }),
			logs: [{ seq: 1, at: 1, kind: "status", text: "Succeeded." }],
			nextCursor: 1,
			pollError: "offline",
		};

		const snapshot = runSnapshotFromView(view);
		expect(snapshot).not.toHaveProperty("logs");
		expect(snapshot).not.toHaveProperty("nextCursor");
		expect(snapshot).not.toHaveProperty("pollError");
		expect(snapshot.summary).toBe("Done.");
	});
});

describe("runStatusLabel", () => {
	it("labels every run status", () => {
		expect(runStatusLabel("queued")).toBe("Queued");
		expect(runStatusLabel("running")).toBe("Running");
		expect(runStatusLabel("succeeded")).toBe("Succeeded");
		expect(runStatusLabel("failed")).toBe("Failed");
		expect(runStatusLabel("cancelled")).toBe("Cancelled");
	});
});

describe("selectDisplayedRun", () => {
	const oldRun = makeRun({
		id: "r_old",
		createdAt: 100,
		summary: "Old summary",
		sessionFile: "/sessions/old.jsonl",
	});
	const oldDetail: RunView = {
		...oldRun,
		logs: [{ seq: 1, at: 100, kind: "status", text: "Succeeded." }],
		nextCursor: 1,
		pollError: "",
	};
	function live(status: RunStatus, summary = "New summary"): RunView {
		return {
			...makeRun({ id: "r_new", createdAt: 200, status, summary }),
			logs: [],
			nextCursor: 0,
			pollError: "",
		};
	}

	it("follows the live latest run when nothing is selected", () => {
		const selection = selectDisplayedRun({
			latest: live("running"),
			history: [makeRun({ id: "r_new", createdAt: 200 }), oldRun],
		});
		expect(selection.run?.id).toBe("r_new");
		expect(selection.viewingHistory).toBe(false);
	});

	it("keeps an older selection when the live run is polled with a new state", () => {
		const input = {
			history: [makeRun({ id: "r_new", createdAt: 200 }), oldRun],
			details: { r_old: oldDetail },
			selectedRunId: "r_old",
		};

		const before = selectDisplayedRun({ ...input, latest: live("running") });
		const after = selectDisplayedRun({
			...input,
			latest: live("succeeded"),
		});

		expect(before.run?.id).toBe("r_old");
		expect(after.run?.id).toBe("r_old");
		expect(after.viewingHistory).toBe(true);
	});

	it("returns the live view when the selected id is the latest run", () => {
		const selection = selectDisplayedRun({
			latest: live("running"),
			selectedRunId: "r_new",
		});
		expect(selection.run?.id).toBe("r_new");
		expect(selection.viewingHistory).toBe(false);
	});

	it("falls back to a history placeholder while logs load", () => {
		const selection = selectDisplayedRun({
			latest: live("running"),
			history: [makeRun({ id: "r_new", createdAt: 200 }), oldRun],
			selectedRunId: "r_old",
			loadingRunId: "r_old",
		});

		expect(selection.run?.id).toBe("r_old");
		expect(selection.run?.summary).toBe("Old summary");
		expect(selection.run?.logs).toEqual([]);
		expect(selection.loading).toBe(true);
	});
});

describe("parseToolSteps", () => {
	it("parses bash command start and finished pairs", () => {
		const steps = parseToolSteps([
			"bash: cd /tmp/worktrees/wt1 && git status --short",
			"bash finished (42ms)",
		]);
		expect(steps).toHaveLength(1);
		expect(steps[0].name).toBe("bash");
		expect(steps[0].command).toBe("git status --short");
		expect(steps[0].status).toBe("finished");
		expect(steps[0].duration).toBe("42ms");
	});

	it("handles failed steps and multi-step sequences", () => {
		const steps = parseToolSteps([
			"$ npm test",
			"bash failed (120ms)",
			"readFile: src/main.ts",
			"readFile finished (5ms)",
		]);
		expect(steps).toHaveLength(2);
		expect(steps[0].name).toBe("bash");
		expect(steps[0].command).toBe("npm test");
		expect(steps[0].status).toBe("failed");
		expect(steps[0].duration).toBe("120ms");

		expect(steps[1].name).toBe("readFile");
		expect(steps[1].command).toBe("src/main.ts");
		expect(steps[1].status).toBe("finished");
		expect(steps[1].duration).toBe("5ms");
	});

	it("leaves running step when no end event is present", () => {
		const steps = parseToolSteps(["$ git push origin main"]);
		expect(steps).toHaveLength(1);
		expect(steps[0].status).toBe("running");
		expect(steps[0].duration).toBeUndefined();
	});
});

describe("formatRunDuration", () => {
	it("returns null when startedAt is missing or invalid", () => {
		expect(formatRunDuration(null)).toBeNull();
		expect(formatRunDuration(undefined)).toBeNull();
		expect(formatRunDuration(0)).toBeNull();
		expect(formatRunDuration(-10)).toBeNull();
	});

	it("formats sub-second durations as < 1s", () => {
		expect(formatRunDuration(1000, 1500)).toBe("< 1s");
	});

	it("formats seconds", () => {
		expect(formatRunDuration(1000, 46000)).toBe("45s");
	});

	it("formats minutes and seconds", () => {
		expect(formatRunDuration(1000, 125000)).toBe("2m 4s");
		expect(formatRunDuration(1000, 181000)).toBe("3m");
	});

	it("formats hours and minutes", () => {
		expect(formatRunDuration(1000, 3601000)).toBe("1h");
		expect(formatRunDuration(1000, 4801000)).toBe("1h 20m");
	});
});

describe("buildRunChain", () => {
	it("returns empty when selectedRun is undefined", () => {
		expect(buildRunChain(undefined, [])).toEqual([]);
	});

	it("returns single run when it has no parentRunId", () => {
		const r1 = makeRun({ id: "r1", createdAt: 100 });
		expect(buildRunChain(r1, [r1])).toEqual([r1]);
	});

	it("traces parentRunId chain chronologically", () => {
		const r1 = makeRun({ id: "r1", createdAt: 100, parentRunId: "" });
		const r2 = makeRun({ id: "r2", createdAt: 200, parentRunId: "r1" });
		const r3 = makeRun({ id: "r3", createdAt: 300, parentRunId: "r2" });
		const history = [r3, r2, r1];

		expect(buildRunChain(r3, history)).toEqual([r1, r2, r3]);
		expect(buildRunChain(r2, history)).toEqual([r1, r2]);
	});

	it("handles cycles or missing parent safely", () => {
		const r1 = makeRun({ id: "r1", createdAt: 100, parentRunId: "r2" });
		const r2 = makeRun({ id: "r2", createdAt: 200, parentRunId: "r1" });
		// Cycle: should not hang in infinite loop
		const chain = buildRunChain(r2, [r1, r2]);
		expect(chain.length).toBe(2);

		const orphan = makeRun({ id: "r_orphan", createdAt: 300, parentRunId: "missing_parent" });
		expect(buildRunChain(orphan, [])).toEqual([orphan]);
	});
});

describe("extractSessionUserMessages", () => {
	it("returns empty on empty content", () => {
		expect(extractSessionUserMessages("")).toEqual([]);
	});

	it("extracts string and array user messages, ignoring non-user items", () => {
		const jsonl = [
			JSON.stringify({ type: "session" }),
			JSON.stringify({ type: "message", message: { role: "system", content: "You are an agent." } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working..." }] } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "Second follow-up" } }),
			"malformed json line",
		].join("\n");

		expect(extractSessionUserMessages(jsonl)).toEqual(["First prompt", "Second follow-up"]);
	});
});
