import { describe, expect, it } from "vitest";
import type { Board, Column, Task, TaskPatch } from "../src/data/types";
import type { WorkbenchSnapshot } from "../src/data/store";
import {
	handleCreateTask,
	handleListTasks,
	handleGetTask,
	handleUpdateTask,
	handleMoveTask,
	handleDeleteTask,
	type WorkbenchStoreTarget,
} from "../src/cli/handlers";

function createMockStore(initialSnapshot?: Partial<WorkbenchSnapshot>): WorkbenchStoreTarget & {
	flushed: boolean;
	snapshot: WorkbenchSnapshot;
} {
	const defaultSnapshot: WorkbenchSnapshot = {
		boards: [
			{
				id: "b_main",
				name: "Agent Integration",
				createdAt: 1000,
				updatedAt: 1000,
				columns: [
					{
						id: "c_inbox",
						name: "Inbox",
						tasks: [
							{
								id: "t_1",
								title: "Initial task",
								description: "Details 1",
								createdAt: 1000,
								updatedAt: 1000,
								source: "agent",
							},
						],
					},
					{
						id: "c_doing",
						name: "In Progress",
						tasks: [],
					},
					{
						id: "c_done",
						name: "Done",
						tasks: [],
					},
				],
			},
		],
		activeBoardId: "b_main",
		loadState: "ready",
		loadError: null,
		corruptBoards: [],
		saveState: "idle",
		saveError: null,
		conflictBoardIds: [],
	};

	const snapshot: WorkbenchSnapshot = {
		...defaultSnapshot,
		...initialSnapshot,
	};

	let flushed = false;

	return {
		snapshot,
		get flushed() {
			return flushed;
		},
		async load() {
			// already loaded
		},
		getSnapshot() {
			return snapshot;
		},
		addTask(boardId: string, columnId: string, title: string): Task {
			const board = snapshot.boards.find((b) => b.id === boardId);
			if (!board) throw new Error("Board not found");
			const column = board.columns.find((c) => c.id === columnId);
			if (!column) throw new Error("Column not found");
			const task: Task = {
				id: `t_${Date.now()}`,
				title,
				description: "",
				createdAt: 2000,
				updatedAt: 2000,
			};
			column.tasks.push(task);
			return task;
		},
		updateTask(boardId: string, taskId: string, patch: TaskPatch) {
			const board = snapshot.boards.find((b) => b.id === boardId);
			if (!board) throw new Error("Board not found");
			for (const col of board.columns) {
				const task = col.tasks.find((t) => t.id === taskId);
				if (task) {
					Object.assign(task, patch, { updatedAt: 3000 });
					return;
				}
			}
		},
		moveTask(boardId: string, taskId: string, columnId: string): boolean {
			const board = snapshot.boards.find((b) => b.id === boardId);
			if (!board) return false;
			const sourceCol = board.columns.find((c) => c.tasks.some((t) => t.id === taskId));
			const targetCol = board.columns.find((c) => c.id === columnId);
			if (!sourceCol || !targetCol || sourceCol.id === targetCol.id) return false;
			const taskIndex = sourceCol.tasks.findIndex((t) => t.id === taskId);
			const [task] = sourceCol.tasks.splice(taskIndex, 1);
			targetCol.tasks.push({ ...task, updatedAt: 3000 });
			return true;
		},
		deleteTask(boardId: string, taskId: string) {
			const board = snapshot.boards.find((b) => b.id === boardId);
			if (!board) return;
			for (const col of board.columns) {
				const idx = col.tasks.findIndex((t) => t.id === taskId);
				if (idx !== -1) {
					col.tasks.splice(idx, 1);
					return;
				}
			}
		},
		async flush() {
			flushed = true;
		},
	};
}

describe("CLI handlers", () => {
	it("createTask creates task with default column and source:agent", async () => {
		const store = createMockStore();
		const result = await handleCreateTask(store, {
			title: "New feature task",
			description: "Implement CLI features",
			backend: "opencode",
		});

		expect(result).toContain("New feature task");
		expect(store.flushed).toBe(true);

		const board = store.snapshot.boards[0];
		const created = board.columns[0].tasks.find((t) => t.title === "New feature task");
		expect(created).toBeDefined();
		expect(created?.source).toBe("agent");
		expect(created?.backend).toBe("opencode");
		expect(created?.description).toBe("Implement CLI features");
	});

	it("createTask fails when title is missing", async () => {
		const store = createMockStore();
		await expect(handleCreateTask(store, { title: "   " })).rejects.toThrow("title is required.");
	});

	it("listTasks returns human-readable text by default", async () => {
		const store = createMockStore();
		const output = await handleListTasks(store, {});
		expect(output).toContain("Board: Agent Integration");
		expect(output).toContain("[Inbox]");
		expect(output).toContain("Initial task");
	});

	it("listTasks returns json format when requested", async () => {
		const store = createMockStore();
		const output = await handleListTasks(store, { format: "json" });
		const parsed = JSON.parse(output);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0].id).toBe("t_1");
		expect(parsed[0].title).toBe("Initial task");
	});

	it("listTasks filters by column", async () => {
		const store = createMockStore();
		const output = await handleListTasks(store, { column: "Inbox" });
		expect(output).toContain("[Inbox]");
		expect(output).not.toContain("[Done]");
	});

	it("getTask retrieves task details across boards", async () => {
		const store = createMockStore();
		const output = await handleGetTask(store, { id: "t_1" });
		expect(output).toContain("Task: t_1");
		expect(output).toContain("Title: Initial task");
		expect(output).toContain("Column / Status: Inbox");
	});

	it("getTask returns json format", async () => {
		const store = createMockStore();
		const output = await handleGetTask(store, { id: "t_1", format: "json" });
		const parsed = JSON.parse(output);
		expect(parsed.id).toBe("t_1");
		expect(parsed.columnName).toBe("Inbox");
	});

	it("updateTask updates title and description", async () => {
		const store = createMockStore();
		const result = await handleUpdateTask(store, {
			id: "t_1",
			title: "Updated Title",
			description: "Updated description",
		});
		expect(result).toContain("Updated Title");
		expect(store.flushed).toBe(true);

		const task = store.snapshot.boards[0].columns[0].tasks.find((t) => t.id === "t_1");
		expect(task?.title).toBe("Updated Title");
		expect(task?.description).toBe("Updated description");
	});

	it("updateTask moves task to change status", async () => {
		const store = createMockStore();
		const result = await handleUpdateTask(store, {
			id: "t_1",
			column: "Done",
		});
		expect(result).toContain("status/column: 'Inbox' -> 'Done'");
		expect(store.flushed).toBe(true);

		const inboxTasks = store.snapshot.boards[0].columns[0].tasks;
		const doneTasks = store.snapshot.boards[0].columns[2].tasks;
		expect(inboxTasks.find((t) => t.id === "t_1")).toBeUndefined();
		expect(doneTasks.find((t) => t.id === "t_1")).toBeDefined();
	});

	it("moveTask moves task using column or to flag", async () => {
		const store = createMockStore();
		await handleMoveTask(store, {
			id: "t_1",
			to: "In Progress",
		});
		expect(store.flushed).toBe(true);

		const progressTasks = store.snapshot.boards[0].columns[1].tasks;
		expect(progressTasks.find((t) => t.id === "t_1")).toBeDefined();
	});

	it("deleteTask deletes task and flushes", async () => {
		const store = createMockStore();
		const result = await handleDeleteTask(store, { id: "t_1" });
		expect(result).toContain("Deleted task t_1");
		expect(store.flushed).toBe(true);

		const inboxTasks = store.snapshot.boards[0].columns[0].tasks;
		expect(inboxTasks.find((t) => t.id === "t_1")).toBeUndefined();
	});
});
