import { describe, expect, it } from "vitest";
import {
	buildRunHistory,
	mergeRunIntoHistory,
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
