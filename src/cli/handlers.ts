import type { CliData, CliFlags } from "obsidian";
import type { Board, Column, Task, TaskPatch } from "../data/types";
import type { WorkbenchSnapshot } from "../data/store";

export interface WorkbenchStoreTarget {
	load(): Promise<void>;
	getSnapshot(): WorkbenchSnapshot;
	addTask(boardId: string, columnId: string, title: string): Task;
	updateTask(boardId: string, taskId: string, patch: TaskPatch): void;
	moveTask(boardId: string, taskId: string, columnId: string): boolean;
	deleteTask(boardId: string, taskId: string): void;
	flush(): Promise<void>;
}

export function cliText(value: string | "true" | undefined): string {
	return typeof value === "string" && value !== "true" ? value : "";
}

export const CLI_FLAGS_CREATE: CliFlags = {
	title: {
		value: "<title>",
		description: "Task title",
		required: true,
	},
	board: {
		value: "<board>",
		description: "Board name or ID; defaults to the active board",
	},
	column: {
		value: "<column>",
		description: "Column name or ID; defaults to Inbox, Backlog, or the first column",
	},
	description: {
		value: "<text>",
		description: "Optional task description",
	},
	backend: {
		value: "<backend>",
		description: "Optional execution backend (e.g., pi, omp, opencode)",
	},
};

export const CLI_FLAGS_LIST: CliFlags = {
	board: {
		value: "<board>",
		description: "Board name or ID; defaults to the active board",
	},
	column: {
		value: "<column>",
		description: "Optional column name or ID filter",
	},
	format: {
		value: "<plain|json>",
		description: "Output format: 'plain' (default) or 'json'",
	},
};

export const CLI_FLAGS_GET: CliFlags = {
	id: {
		value: "<id>",
		description: "Task ID",
		required: true,
	},
	board: {
		value: "<board>",
		description: "Optional board name or ID",
	},
	format: {
		value: "<plain|json>",
		description: "Output format: 'plain' (default) or 'json'",
	},
};

export const CLI_FLAGS_UPDATE: CliFlags = {
	id: {
		value: "<id>",
		description: "Task ID",
		required: true,
	},
	column: {
		value: "<column>",
		description: "Target column name or ID (moves task to update status)",
	},
	status: {
		value: "<status>",
		description: "Alias for column",
	},
	title: {
		value: "<title>",
		description: "New task title",
	},
	description: {
		value: "<text>",
		description: "New task description",
	},
	backend: {
		value: "<backend>",
		description: "Execution backend",
	},
	board: {
		value: "<board>",
		description: "Optional board name or ID",
	},
};

export const CLI_FLAGS_MOVE: CliFlags = {
	id: {
		value: "<id>",
		description: "Task ID",
		required: true,
	},
	column: {
		value: "<column>",
		description: "Target column name or ID",
		required: true,
	},
	to: {
		value: "<column>",
		description: "Alias for column",
	},
	board: {
		value: "<board>",
		description: "Optional board name or ID",
	},
};

export const CLI_FLAGS_DELETE: CliFlags = {
	id: {
		value: "<id>",
		description: "Task ID",
		required: true,
	},
	board: {
		value: "<board>",
		description: "Optional board name or ID",
	},
};

async function ensureReady(store: WorkbenchStoreTarget): Promise<WorkbenchSnapshot> {
	await store.load();
	const snapshot = store.getSnapshot();
	if (snapshot.loadState !== "ready") {
		throw new Error(snapshot.loadError ?? "Workbench boards are not ready.");
	}
	return snapshot;
}

function resolveBoard(snapshot: WorkbenchSnapshot, requestedBoard?: string): Board {
	const trimmed = requestedBoard?.trim();
	if (trimmed) {
		const lower = trimmed.toLowerCase();
		const board = snapshot.boards.find(
			(b) => b.id === trimmed || b.name.toLowerCase() === lower
		);
		if (!board) {
			throw new Error(`Board not found: ${trimmed}`);
		}
		return board;
	}
	const fallback =
		snapshot.boards.find((b) => b.id === snapshot.activeBoardId) ??
		snapshot.boards[0];
	if (!fallback) {
		throw new Error("No Workbench board exists.");
	}
	return fallback;
}

function findTaskLocation(
	snapshot: WorkbenchSnapshot,
	taskId: string,
	requestedBoard?: string
): { board: Board; column: Column; task: Task } {
	const trimmed = requestedBoard?.trim();
	let candidateBoards = snapshot.boards;
	if (trimmed) {
		const lower = trimmed.toLowerCase();
		candidateBoards = snapshot.boards.filter(
			(b) => b.id === trimmed || b.name.toLowerCase() === lower
		);
		if (candidateBoards.length === 0) {
			throw new Error(`Board not found: ${trimmed}`);
		}
	}
	for (const b of candidateBoards) {
		for (const c of b.columns) {
			const task = c.tasks.find((t) => t.id === taskId);
			if (task) {
				return { board: b, column: c, task };
			}
		}
	}
	throw new Error(`Task not found: ${taskId}`);
}

export async function handleCreateTask(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const snapshot = await ensureReady(store);

	const title = cliText(params.title).trim();
	if (!title) throw new Error("title is required.");
	const description = cliText(params.description).slice(0, 20_000);
	const requestedBoard = cliText(params.board).trim();
	const board = resolveBoard(snapshot, requestedBoard);

	const requestedColumn = cliText(params.column).trim();
	const column = requestedColumn
		? board.columns.find(
				(candidate) =>
					candidate.id === requestedColumn ||
					candidate.name.toLowerCase() === requestedColumn.toLowerCase()
			)
		: board.columns.find(
				(candidate) => candidate.name.trim().toLowerCase() === "inbox"
			) ??
			board.columns.find(
				(candidate) => candidate.name.trim().toLowerCase() === "backlog"
			) ??
			board.columns[0];
	if (!column) {
		throw new Error(
			requestedColumn
				? `Column not found: ${requestedColumn}`
				: `Board has no columns: ${board.name}`
		);
	}

	const backend = cliText(params.backend).trim();
	const task = store.addTask(board.id, column.id, title);
	store.updateTask(board.id, task.id, {
		...(description ? { description } : {}),
		...(backend ? { backend } : {}),
		source: "agent",
	});
	await store.flush();
	return `Created task ${task.id} in ${board.name} / ${column.name}: ${task.title}`;
}

export async function handleListTasks(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const snapshot = await ensureReady(store);
	const requestedBoard = cliText(params.board).trim();
	const board = resolveBoard(snapshot, requestedBoard);

	const requestedColumn = cliText(params.column).trim();
	const targetColumn = requestedColumn
		? board.columns.find(
				(candidate) =>
					candidate.id === requestedColumn ||
					candidate.name.toLowerCase() === requestedColumn.toLowerCase()
			)
		: undefined;

	if (requestedColumn && !targetColumn) {
		throw new Error(`Column not found: ${requestedColumn}`);
	}

	const columnsToInspect = targetColumn ? [targetColumn] : board.columns;
	const format = cliText(params.format).trim().toLowerCase();

	if (format === "json") {
		const result = columnsToInspect.flatMap((col) =>
			col.tasks.map((task) => ({
				id: task.id,
				title: task.title,
				description: task.description,
				boardId: board.id,
				boardName: board.name,
				columnId: col.id,
				columnName: col.name,
				source: task.source,
				backend: task.backend,
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
			}))
		);
		return JSON.stringify(result, null, 2);
	}

	const lines: string[] = [`Board: ${board.name} (${board.id})`];
	let totalTasks = 0;
	for (const col of columnsToInspect) {
		lines.push(`\n[${col.name}] (${col.tasks.length})`);
		if (col.tasks.length === 0) {
			lines.push("  (empty)");
		} else {
			for (const task of col.tasks) {
				totalTasks++;
				const meta = [
					task.source ? `source: ${task.source}` : null,
					task.backend ? `backend: ${task.backend}` : null,
				]
					.filter(Boolean)
					.join(", ");
				lines.push(
					`  - ${task.id}: ${task.title}${meta ? ` [${meta}]` : ""}`
				);
			}
		}
	}
	lines.push(`\nTotal: ${totalTasks} task(s)`);
	return lines.join("\n");
}

export async function handleGetTask(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const snapshot = await ensureReady(store);
	const taskId = cliText(params.id).trim();
	if (!taskId) throw new Error("id is required.");

	const { board, column, task } = findTaskLocation(
		snapshot,
		taskId,
		cliText(params.board)
	);

	const format = cliText(params.format).trim().toLowerCase();
	if (format === "json") {
		return JSON.stringify(
			{
				id: task.id,
				title: task.title,
				description: task.description,
				boardId: board.id,
				boardName: board.name,
				columnId: column.id,
				columnName: column.name,
				source: task.source,
				backend: task.backend,
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
			},
			null,
			2
		);
	}

	const createdStr = new Date(task.createdAt).toLocaleString();
	const updatedStr = new Date(task.updatedAt).toLocaleString();
	const lines = [
		`Task: ${task.id}`,
		`Title: ${task.title}`,
		`Board: ${board.name} (${board.id})`,
		`Column / Status: ${column.name} (${column.id})`,
		task.source ? `Source: ${task.source}` : null,
		task.backend ? `Backend: ${task.backend}` : null,
		`Created: ${createdStr}`,
		`Updated: ${updatedStr}`,
		`Description:`,
		task.description ? task.description : "  (none)",
	].filter(Boolean) as string[];

	return lines.join("\n");
}

export async function handleUpdateTask(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const snapshot = await ensureReady(store);
	const taskId = cliText(params.id).trim();
	if (!taskId) throw new Error("id is required.");

	const { board, column, task } = findTaskLocation(
		snapshot,
		taskId,
		cliText(params.board)
	);
	const changes: string[] = [];

	// Column / Status movement
	const requestedColumn = (cliText(params.column) || cliText(params.status)).trim();
	if (requestedColumn) {
		const targetColumn = board.columns.find(
			(c) =>
				c.id === requestedColumn ||
				c.name.toLowerCase() === requestedColumn.toLowerCase()
		);
		if (!targetColumn) {
			throw new Error(
				`Column not found in board '${board.name}': ${requestedColumn}`
			);
		}
		if (targetColumn.id !== column.id) {
			const moved = store.moveTask(board.id, task.id, targetColumn.id);
			if (!moved) {
				throw new Error(
					`Failed to move task ${taskId} to column ${targetColumn.name}`
				);
			}
			changes.push(`status/column: '${column.name}' -> '${targetColumn.name}'`);
		}
	}

	// Property patch
	const patch: TaskPatch = {};
	if (params.title !== undefined) {
		const newTitle = cliText(params.title).trim();
		if (!newTitle) throw new Error("title cannot be empty.");
		patch.title = newTitle;
		changes.push(`title: '${newTitle}'`);
	}
	if (params.description !== undefined) {
		const newDesc = cliText(params.description).slice(0, 20_000);
		patch.description = newDesc;
		changes.push("description updated");
	}
	if (params.backend !== undefined) {
		const newBackend = cliText(params.backend).trim();
		patch.backend = newBackend;
		changes.push(`backend: '${newBackend}'`);
	}

	if (Object.keys(patch).length > 0) {
		store.updateTask(board.id, task.id, patch);
	}

	if (changes.length === 0) {
		return `No changes specified for task ${taskId}.`;
	}

	await store.flush();
	return `Updated task ${taskId} in board '${board.name}': ${changes.join(", ")}`;
}

export async function handleMoveTask(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const col = cliText(params.column) || cliText(params.to);
	if (!col) throw new Error("column is required.");
	return handleUpdateTask(store, { ...params, column: col });
}

export async function handleDeleteTask(
	store: WorkbenchStoreTarget,
	params: CliData
): Promise<string> {
	const snapshot = await ensureReady(store);
	const taskId = cliText(params.id).trim();
	if (!taskId) throw new Error("id is required.");

	const { board, task } = findTaskLocation(
		snapshot,
		taskId,
		cliText(params.board)
	);
	store.deleteTask(board.id, task.id);
	await store.flush();
	return `Deleted task ${taskId} (${task.title}) from board '${board.name}'.`;
}
