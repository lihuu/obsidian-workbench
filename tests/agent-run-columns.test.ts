import { describe, expect, it } from "vitest";
import {
	isTaskAutoRunnable,
	targetColumnIdForStatus,
	tasksEnteringColumn,
	tasksLeavingColumn,
} from "../src/agent/run-columns";
import type { Board, BoardAgentConfig, Column } from "../src/data/types";

function makeBoard(): Board {
	return {
		id: "b_board",
		name: "Board",
		createdAt: 1,
		updatedAt: 1,
		agent: {
			runStateMapping: {
				queuedColumnId: "c_queue",
				runningColumnId: "c_running",
			},
			statusMapping: {
				successColumnId: "c_review",
				failureColumnId: "c_backlog",
			},
		},
		columns: [
			{ id: "c_backlog", name: "Backlog", tasks: [] },
			{ id: "c_queue", name: "Queue", tasks: [] },
			{ id: "c_running", name: "Running", tasks: [] },
			{ id: "c_review", name: "Review", tasks: [] },
		],
	};
}

function task(id: string, title = id) {
	return { id, title, description: "", createdAt: 1, updatedAt: 1 };
}

describe("targetColumnIdForStatus", () => {
	const agent: BoardAgentConfig = makeBoard().agent ?? {};

	it("maps queued and running to their configured columns", () => {
		expect(targetColumnIdForStatus(agent, "queued")).toBe("c_queue");
		expect(targetColumnIdForStatus(agent, "running")).toBe("c_running");
	});

	it("maps terminal states through the existing mapping", () => {
		expect(targetColumnIdForStatus(agent, "succeeded")).toBe("c_review");
		expect(targetColumnIdForStatus(agent, "failed")).toBe("c_backlog");
		expect(targetColumnIdForStatus(agent, "cancelled")).toBeUndefined();
	});

	it("returns undefined when no mapping exists", () => {
		expect(targetColumnIdForStatus({}, "queued")).toBeUndefined();
	});
});

describe("tasksEnteringColumn", () => {
	it("returns tasks that were not in the target column before", () => {
		const before = makeBoard();
		before.columns[0].tasks = [task("t_old")];
		before.columns[1].tasks = [task("t_queue")];

		const after: Column[] = before.columns.map((column) => ({
			...column,
			tasks:
				column.id === "c_backlog"
					? []
					: column.id === "c_queue"
						? [task("t_queue"), task("t_old")]
						: column.tasks,
		}));

		expect(tasksEnteringColumn(before, after, "c_queue").map((t) => t.id)).toEqual([
			"t_old",
		]);
	});

	it("ignores tasks already in the target column and drag shadows", () => {
		const before = makeBoard();
		before.columns[1].tasks = [task("t_queue")];
		const after = before.columns.map((column) => ({
			...column,
			tasks:
				column.id === "c_queue"
					? [task("t_queue"), { ...task("t_shadow"), isDndShadowItem: true }]
					: column.tasks,
		}));

		expect(tasksEnteringColumn(before, after, "c_queue")).toEqual([]);
	});
});

describe("tasksLeavingColumn", () => {
	it("returns tasks removed from the target column", () => {
		const before = makeBoard();
		before.columns[2].tasks = [task("t_run")];
		const after = before.columns.map((column) => ({
			...column,
			tasks: column.id === "c_running" ? [] : column.tasks,
		}));

		expect(tasksLeavingColumn(before, after, "c_running")).toEqual([
			task("t_run"),
		]);
	});
});

describe("isTaskAutoRunnable", () => {
	it("rejects empty or whitespace-only titles", () => {
		expect(isTaskAutoRunnable({ ...task("t1"), title: "" })).toBe(false);
		expect(isTaskAutoRunnable({ ...task("t2"), title: "   " })).toBe(false);
	});

	it("rejects untitled task when description is missing or blank", () => {
		expect(isTaskAutoRunnable({ ...task("t1"), title: "Untitled task", description: "" })).toBe(false);
		expect(isTaskAutoRunnable({ ...task("t2"), title: "untitled task", description: "   " })).toBe(false);
		expect(isTaskAutoRunnable({ ...task("t3"), title: "UNTITLED TASK" })).toBe(false);
	});

	it("accepts untitled task when a non-empty description is provided", () => {
		expect(
			isTaskAutoRunnable({
				...task("t1"),
				title: "Untitled task",
				description: "Investigate crash log",
			})
		).toBe(true);
	});

	it("accepts meaningful task titles with or without description", () => {
		expect(isTaskAutoRunnable({ ...task("t1"), title: "Fix login button", description: "" })).toBe(true);
		expect(
			isTaskAutoRunnable({
				...task("t2"),
				title: "Fix login button",
				description: "details here",
			})
		).toBe(true);
	});
});

