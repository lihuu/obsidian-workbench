import type { Board, BoardAgentConfig, Column, Task } from "../data/types";
import type { RunStatus } from "./types";

export function targetColumnIdForStatus(
	agent: BoardAgentConfig | undefined,
	status: RunStatus
): string | undefined {
	if (!agent) return undefined;
	if (status === "queued") return agent.runStateMapping?.queuedColumnId;
	if (status === "running") return agent.runStateMapping?.runningColumnId;
	if (status === "succeeded") return agent.statusMapping?.successColumnId;
	if (status === "failed") return agent.statusMapping?.failureColumnId;
	return undefined;
}

/**
 * Return tasks that moved into a column during a drag. The before snapshot is
 * the committed board; the after snapshot is the finalized drag payload.
 */
export function tasksEnteringColumn(
	before: Board,
	after: readonly Column[],
	columnId: string
): Task[] {
	const beforeIds = new Set(
		before.columns
			.find((column) => column.id === columnId)
			?.tasks.map((task) => task.id) ?? []
	);
	const target = after.find((column) => column.id === columnId);
	if (!target) return [];
	return target.tasks.filter(
		(task) => !task.isDndShadowItem && !beforeIds.has(task.id)
	);
}

export function tasksLeavingColumn(
	before: Board,
	after: readonly Column[],
	columnId: string
): Task[] {
	const afterIds = new Set(
		after.find((column) => column.id === columnId)?.tasks.map((task) => task.id) ?? []
	);
	return (
		before.columns
			.find((column) => column.id === columnId)
			?.tasks.filter((task) => !task.isDndShadowItem && !afterIds.has(task.id)) ?? []
	);
}
