export interface Task {
	id: string;
	title: string;
	description: string;
	createdAt: number;
	updatedAt: number;
	/** Agent-created task metadata. */
	source?: "agent";
	sourceProposalId?: string;
	sourceRunId?: string;
	sourceTaskId?: string;
	/** Added by svelte-dnd-action while a drag is in progress. */
	isDndShadowItem?: boolean;
}

export interface Column {
	id: string;
	name: string;
	tasks: Task[];
	/** Added by svelte-dnd-action while a column drag is in progress. */
	isDndShadowItem?: boolean;
}

export interface BoardAgentGitHub {
	repoUrl: string;
	branch: string;
}

export interface BoardStatusMapping {
	successColumnId?: string;
	failureColumnId?: string;
}

export interface BoardRunStateMapping {
	queuedColumnId?: string;
	runningColumnId?: string;
}

export interface BoardAgentConfig {
	/** Execution backend registered by the Runner; defaults to the Runner's backend. */
	backend?: string;
	github?: BoardAgentGitHub;
	statusMapping?: BoardStatusMapping;
	/** Execution-state projection columns; the Runner queue remains authoritative. */
	runStateMapping?: BoardRunStateMapping;
	/** Create one git worktree per run so tasks can run in parallel. */
	worktree?: boolean;
}

export interface Board {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	columns: Column[];
	/** Synced board-level agent source and optional status mapping. */
	agent?: BoardAgentConfig;
}

export interface BoardFile extends Board {
	schemaVersion: 1;
}

export type TaskPatch = Partial<
	Pick<
		Task,
		"title" | "description" | "source" | "sourceProposalId" | "sourceRunId" | "sourceTaskId"
	>
>;
