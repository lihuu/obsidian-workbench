import { Platform, requestUrl } from "obsidian";
import type {
	GitHubActionResult,
	GitHubWorkspaceInfo,
	GitHubSyncRef,
	GitHubSyncResult,
	RunnerHealth,
	RunnerPage,
	RunnerRun,
	TaskImage,
	TaskProposal,
	WorkspaceInfo,
} from "./types";
import {
	buildRunnerHeaders,
	isLoopbackRunnerUrl,
	type RunnerConnection,
} from "./runner-connection";

export function normalizeRunnerUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Runner URL can't be empty.");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Runner URL must be a valid http(s) URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Runner URL must start with http:// or https://.");
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Runner URL should only contain the scheme, host, and port.");
	}
	return url.origin;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RunnerClient {
	constructor(private readonly getConnection: () => RunnerConnection) {}

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown
	): Promise<T> {
		const connection = this.getConnection();
		const { runnerUrl } = connection;
		if (!runnerUrl.trim()) {
			throw new Error("Runner URL is not configured for this device.");
		}
		if (Platform.isMobile && isLoopbackRunnerUrl(runnerUrl)) {
			throw new Error(
				"iOS can't reach a localhost Runner. Use an HTTPS remote Runner URL."
			);
		}
		const headers = buildRunnerHeaders(connection);
		if (body !== undefined) headers["Content-Type"] = "application/json";

		let response;
		try {
			response = await requestUrl({
				url: `${runnerUrl}${path}`,
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				throw: false,
			});
		} catch (error) {
			throw new Error(`Can't reach the Workbench Runner at ${runnerUrl}: ${errorMessage(error)}`);
		}

		let payload: unknown;
		try {
			payload = response.json;
		} catch {
			payload = null;
		}

		if (response.status < 200 || response.status >= 300) {
			const message =
				payload &&
				typeof payload === "object" &&
				"error" in payload &&
				typeof payload.error === "string"
					? payload.error
					: `Runner returned HTTP ${response.status}.`;
			throw new Error(message);
		}

		return payload as T;
	}

	health(): Promise<RunnerHealth> {
		return this.request<RunnerHealth>("GET", "/health");
	}

	validateWorkspace(path: string): Promise<WorkspaceInfo> {
		return this.request<WorkspaceInfo>("POST", "/workspace", { path });
	}

	cloneGitHub(input: {
		boardId: string;
		repoUrl: string;
		branch: string;
	}): Promise<GitHubWorkspaceInfo> {
		return this.request<GitHubWorkspaceInfo>("POST", "/workspace/github", input);
	}

	syncGitHub(repoUrl: string, refs: GitHubSyncRef[] = []): Promise<GitHubSyncResult> {
		return this.request<GitHubSyncResult>("POST", "/github/sync", { repoUrl, refs });
	}

	commentGitHub(
		repoUrl: string,
		type: "issue" | "pull_request",
		number: number,
		body: string
	): Promise<GitHubActionResult> {
		return this.request<GitHubActionResult>("POST", "/github/comment", {
			repoUrl,
			type,
			number,
			body,
		});
	}

	closeGitHub(
		repoUrl: string,
		type: "issue" | "pull_request",
		number: number
	): Promise<GitHubActionResult> {
		return this.request<GitHubActionResult>("POST", "/github/close", {
			repoUrl,
			type,
			number,
		});
	}

	startRun(input: {
		boardId: string;
		taskId: string;
		title: string;
		prompt: string;
		cwd: string;
		backend?: string;
		images?: TaskImage[];
		worktree?: boolean;
	}): Promise<RunnerPage> {
		return this.request<RunnerPage>("POST", "/runs", input);
	}

	getRun(id: string, after: number): Promise<RunnerPage> {
		return this.request<RunnerPage>(
			"GET",
			`/runs/${encodeURIComponent(id)}?after=${Math.max(0, after)}`
		);
	}

	abortRun(id: string): Promise<RunnerPage> {
		return this.request<RunnerPage>(
			"POST",
			`/runs/${encodeURIComponent(id)}/abort`
		);
	}

	async sendMessage(
		id: string,
		message: string,
		mode: "steer" | "follow_up"
	): Promise<void> {
		await this.request<{ ok: boolean }>(
			"POST",
			`/runs/${encodeURIComponent(id)}/message`,
			{ message, mode }
		);
	}

	async clearQueue(id: string): Promise<void> {
		await this.request<{ ok: boolean }>(
			"POST",
			`/runs/${encodeURIComponent(id)}/clear-queue`
		);
	}

	async continueRun(id: string, message: string): Promise<RunnerPage> {
		return this.request<RunnerPage>(
			"POST",
			`/runs/${encodeURIComponent(id)}/continue`,
			{ message }
		);
	}

	async cleanupWorktree(id: string): Promise<RunnerPage> {
		return this.request<RunnerPage>(
			"POST",
			`/runs/${encodeURIComponent(id)}/cleanup`
		);
	}

	async reorderQueue(boardId: string, runIds: string[]): Promise<void> {
		await this.request<{ order: string[] }>(
			"POST",
			"/queue/reorder",
			{ boardId, runIds }
		);
	}

	async listTaskProposals(boardId: string): Promise<TaskProposal[]> {
		const result = await this.request<{ proposals: TaskProposal[] }>(
			"GET",
			`/task-proposals?boardId=${encodeURIComponent(boardId)}`
		);
		return Array.isArray(result.proposals) ? result.proposals : [];
	}

	async ackTaskProposal(id: string): Promise<void> {
		await this.request<{ ok: boolean }>(
			"POST",
			`/task-proposals/${encodeURIComponent(id)}/ack`
		);
	}

	async listRuns(boardId: string, taskId?: string, limit = 50): Promise<RunnerRun[]> {
		const query = new URLSearchParams({ boardId, limit: String(limit) });
		if (taskId) query.set("taskId", taskId);
		const result = await this.request<{ runs: RunnerRun[] }>(
			"GET",
			`/runs?${query.toString()}`
		);
		return result.runs;
	}
}
