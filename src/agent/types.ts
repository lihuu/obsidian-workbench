export const DEFAULT_RUNNER_URL = "http://127.0.0.1:4319";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentSettings {
	runnerUrl: string;
	runnerToken: string;
	/** Cloudflare Access service token ID, for a Runner behind Zero Trust. */
	cfAccessClientId: string;
	/** Cloudflare Access service token secret. */
	cfAccessClientSecret: string;
	workspaces: Record<string, string>;
}

export interface BackendCapabilities {
	streaming: boolean;
	toolEvents: boolean;
	abort: boolean;
	steer: boolean;
	followUp: boolean;
	clearQueue: boolean;
	resume: boolean;
	images: boolean;
}

export interface BackendHealth {
	id: string;
	displayName: string;
	binary: string;
	available: boolean;
	version: string;
	error: string;
	capabilities: BackendCapabilities;
}

export interface RunnerRun {
	id: string;
	boardId: string;
	taskId: string;
	title: string;
	cwd: string;
	status: RunStatus;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	summary: string;
	error: string;
	aborting: boolean;
	logPath: string | null;
	backendId: string;
	backendName: string;
	capabilities: BackendCapabilities;
	sessionFile: string;
	sessionId: string;
	imageCount: number;
	worktreeRequested: boolean;
	worktreePath: string;
	branch: string;
	baseRepo: string;
	worktreeRemoved: boolean;
	parentRunId: string;
}

export interface TaskProposal {
	id: string;
	boardId: string;
	taskId: string;
	runId: string;
	backendName: string;
	title: string;
	description: string;
	key: string;
	createdAt: number;
}

export interface GitHubChecks {
	state: "none" | "success" | "failure" | "pending";
	total: number;
	success: number;
	failure: number;
	pending: number;
}

export interface GitHubSyncItem {
	number: number;
	title: string;
	body: string;
	url: string;
	state: string;
	updatedAt: string;
	createdAt: string;
	closedAt: string;
	labels: string[];
	author: string;
	isDraft?: boolean;
	headRefName?: string;
	baseRefName?: string;
	reviewDecision?: string | null;
	mergedAt?: string | null;
	checks?: GitHubChecks;
}

export interface GitHubSyncRef {
	type: "issue" | "pull_request";
	number: number;
}

export interface GitHubSyncResult {
	repo: string;
	issues: GitHubSyncItem[];
	pullRequests: GitHubSyncItem[];
}

export interface GitHubImportResult {
	imported: number;
	updated: number;
	moved: number;
	skipped: number;
}

export interface GitHubActionResult {
	repo: string;
	type: "issue" | "pull_request";
	number: number;
	url: string;
}

export interface GitHubHealth {
	binary: string;
	available: boolean;
	version: string;
	error: string;
}

export interface RunEvent {
	seq: number;
	at: number;
	kind: "status" | "assistant" | "tool" | "log" | "error" | "user";
	text: string;
	status?: RunStatus;
	mode?: "steer" | "follow_up";
}

export interface RunnerPage {
	run: RunnerRun;
	events: RunEvent[];
	nextCursor: number;
}

export interface RunView extends RunnerRun {
	logs: RunEvent[];
	nextCursor: number;
	pollError: string;
}

export interface WorkspaceInfo {
	path: string;
	name: string;
	isGit: boolean;
	branch: string;
	topLevel: string;
}

export interface GitHubWorkspaceInfo extends WorkspaceInfo {
	cloned: boolean;
}

export interface TaskImage {
	name: string;
	mimeType: string;
	data: string;
}

export interface RunnerHealth {
	ok: boolean;
	name: string;
	version: string;
	pi: BackendHealth | null;
	backends: BackendHealth[];
	defaultBackend: string;
	gh?: GitHubHealth;
	activeRuns: RunnerRun[];
	runsDir: string;
	sessionsDir: string;
	workspacesDir: string;
	worktreesDir: string;
	maxConcurrentRuns: number;
	queuedRunIds?: string[];
	pendingProposals?: number;
}

export type HealthStatus = "unknown" | "checking" | "online" | "offline";

export function taskRunKey(boardId: string, taskId: string): string {
	return `${boardId}::${taskId}`;
}

export interface AgentSnapshot {
	settings: AgentSettings;
	runs: Record<string, RunView>;
	/** Recent runs per `boardId::taskId`, newest first (capped in the controller). */
	history: Record<string, RunnerRun[]>;
	/** Lazily loaded full logs for a run picked from history, keyed by run id. */
	runDetails: Record<string, RunView>;
	health: {
		status: HealthStatus;
		error: string;
		pi: BackendHealth | null;
		backends: BackendHealth[];
		defaultBackend: string;
		gh: GitHubHealth | null;
		version: string;
	};
}
