import { Platform, type App } from "obsidian";
import { get, writable, type Readable } from "svelte/store";
import type { Board, Task } from "../data/types";
import type { DeviceState, PluginDeviceState } from "../data/device-state";
import { collectLinkedNotes } from "./notes";
import { collectTaskImages } from "./media-reader";
import { buildTaskPrompt } from "./context";
import {
	RunnerClient,
	normalizeRunnerUrl,
} from "./runner-client";
import {
	isLoopbackRunnerUrl,
	validateRunnerConnection,
} from "./runner-connection";
import {
	buildRunHistory,
	mergeRunIntoHistory,
	runSnapshotFromView,
	TASK_RUN_HISTORY_LIMIT,
} from "./run-history";
import type {
	AgentSettings,
	AgentSnapshot,
	GitHubActionResult,
	GitHubSyncRef,
	GitHubSyncResult,
	RunEvent,
	RunnerHealth,
	RunnerPage,
	RunnerRun,
	RunView,
	TaskProposal,
	WorkspaceInfo,
} from "./types";
import { taskRunKey } from "./types";

const POLL_INTERVAL_MS = 700;
const MAX_POLL_ERRORS = 3;
const MAX_CACHED_RUN_DETAILS = 20;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertRunnerUrlForDevice(runnerUrl: string): void {
	if (Platform.isMobile && runnerUrl && isLoopbackRunnerUrl(runnerUrl)) {
		throw new Error(
			"iOS can't reach a localhost Runner. Use an HTTPS remote Runner URL."
		);
	}
}

function createInitialSnapshot(settings: AgentSettings): AgentSnapshot {
	return {
		settings: {
			...settings,
			workspaces: { ...settings.workspaces },
		},
		runs: {},
		history: {},
		runDetails: {},
		health: {
			status: "unknown",
			error: "",
			pi: null,
			backends: [],
			defaultBackend: "",
			gh: null,
			version: "",
		},
	};
}

function toView(page: RunnerPage, previous?: RunView): RunView {
	const logs = previous ? [...previous.logs] : [];
	for (const event of page.events) {
		if (!logs.some((existing) => existing.seq === event.seq)) logs.push(event);
	}
	return {
		...page.run,
		logs,
		nextCursor: page.nextCursor,
		pollError: "",
	};
}

export class AgentController implements Readable<AgentSnapshot> {
	private readonly state = writable<AgentSnapshot>(
		createInitialSnapshot({
			runnerUrl: "",
			runnerToken: "",
			cfAccessClientId: "",
			cfAccessClientSecret: "",
			workspaces: {},
		})
	);
	readonly subscribe = this.state.subscribe;

	private readonly client: RunnerClient;
	private readonly pollTimers = new Map<string, number>();
	private readonly pollInFlight = new Set<string>();
	private readonly pollFailures = new Map<string, number>();
	private readonly detailsLoaded = new Set<string>();
	private readonly detailLoads = new Map<string, Promise<void>>();
	private healthPromise: Promise<void> | null = null;
	private disposed = false;

	constructor(
		private readonly app: App,
		private readonly deviceState: PluginDeviceState,
		initial: DeviceState
	) {
		this.state.set(
			createInitialSnapshot({
				runnerUrl: initial.runnerUrl,
				runnerToken: initial.runnerToken,
				cfAccessClientId: initial.cfAccessClientId,
				cfAccessClientSecret: initial.cfAccessClientSecret,
				workspaces: initial.workspaces,
			})
		);
		this.client = new RunnerClient(() => {
			const settings = get(this.state).settings;
			return {
				runnerUrl: settings.runnerUrl,
				runnerToken: settings.runnerToken,
				cfAccessClientId: settings.cfAccessClientId,
				cfAccessClientSecret: settings.cfAccessClientSecret,
			};
		});
	}

	getSnapshot(): AgentSnapshot {
		return get(this.state);
	}

	getRun(boardId: string, taskId: string): RunView | undefined {
		return this.getSnapshot().runs[taskRunKey(boardId, taskId)];
	}

	getRunHistory(boardId: string, taskId: string): RunnerRun[] {
		return this.getSnapshot().history[taskRunKey(boardId, taskId)] ?? [];
	}

	getRunDetail(runId: string): RunView | undefined {
		return this.getSnapshot().runDetails[runId];
	}

	async refreshHealth(): Promise<void> {
		if (this.disposed) return;
		if (this.healthPromise) return this.healthPromise;
		if (!get(this.state).settings.runnerUrl.trim()) {
			this.patchHealth({
				status: "offline",
				error: "Runner URL is not configured for this device.",
			});
			return;
		}
		this.patchHealth({ status: "checking", error: "" });
		this.healthPromise = (async () => {
			try {
				const health = await this.client.health();
				this.patchHealth({
					status: "online",
					error: "",
					pi: health.pi,
					backends: health.backends ?? [],
					defaultBackend: health.defaultBackend ?? "pi",
					gh: health.gh ?? null,
					version: health.version,
				});
			} catch (error) {
				this.patchHealth({ status: "offline", error: errorMessage(error) });
			} finally {
				this.healthPromise = null;
			}
		})();
		return this.healthPromise;
	}

	async checkConnection(input: {
		runnerUrl: string;
		runnerToken: string;
		cfAccessClientId?: string;
		cfAccessClientSecret?: string;
		workspacePath?: string;
	}): Promise<{ health: RunnerHealth; workspace: WorkspaceInfo | null }> {
		const runnerUrl = normalizeRunnerUrl(input.runnerUrl);
		assertRunnerUrlForDevice(runnerUrl);
		const client = new RunnerClient(() => ({
			runnerUrl,
			runnerToken: input.runnerToken,
			cfAccessClientId: input.cfAccessClientId ?? "",
			cfAccessClientSecret: input.cfAccessClientSecret ?? "",
		}));
		const health = await client.health();
		const workspace = input.workspacePath?.trim()
			? await client.validateWorkspace(input.workspacePath.trim())
			: null;
		return { health, workspace };
	}

	async saveConnection(input: {
		runnerUrl: string;
		runnerToken: string;
		cfAccessClientId: string;
		cfAccessClientSecret: string;
	}): Promise<void> {
		const trimmedUrl = input.runnerUrl.trim();
		// Mobile can save board settings before a remote Runner exists. An empty
		// URL is therefore valid there; desktop still needs its local endpoint.
		if (!trimmedUrl && !Platform.isMobile) {
			throw new Error("Runner URL can't be empty.");
		}
		const runnerUrl = trimmedUrl ? normalizeRunnerUrl(trimmedUrl) : "";
		assertRunnerUrlForDevice(runnerUrl);
		const runnerToken = input.runnerToken.trim();
		const cfAccessClientId = input.cfAccessClientId.trim();
		const cfAccessClientSecret = input.cfAccessClientSecret.trim();
		if (runnerUrl) {
			validateRunnerConnection({
				runnerUrl,
				runnerToken,
				cfAccessClientId,
				cfAccessClientSecret,
			});
		}
		const current = get(this.state).settings;
		this.patch({
			settings: {
				...current,
				runnerUrl,
				runnerToken,
				cfAccessClientId,
				cfAccessClientSecret,
			},
		});
		await this.deviceState.saveConnection({
			runnerUrl,
			runnerToken,
			cfAccessClientId,
			cfAccessClientSecret,
		});
		await this.refreshHealth();
	}

	async bindWorkspace(boardId: string, path: string): Promise<WorkspaceInfo> {
		const workspace = await this.client.validateWorkspace(path);
		await this.setWorkspace(boardId, workspace.path);
		return workspace;
	}

	async inspectWorkspace(path: string): Promise<WorkspaceInfo> {
		return this.client.validateWorkspace(path);
	}

	async cloneGithubWorkspace(
		boardId: string,
		repoUrl: string,
		branch: string
	): Promise<WorkspaceInfo> {
		const workspace = await this.client.cloneGitHub({ boardId, repoUrl, branch });
		await this.setWorkspace(boardId, workspace.path);
		return workspace;
	}

	async syncGitHub(
		repoUrl: string,
		refs: GitHubSyncRef[] = []
	): Promise<GitHubSyncResult> {
		return this.client.syncGitHub(repoUrl, refs);
	}

	async commentGitHub(
		repoUrl: string,
		type: "issue" | "pull_request",
		number: number,
		body: string
	): Promise<GitHubActionResult> {
		return this.client.commentGitHub(repoUrl, type, number, body);
	}

	async closeGitHub(
		repoUrl: string,
		type: "issue" | "pull_request",
		number: number
	): Promise<GitHubActionResult> {
		return this.client.closeGitHub(repoUrl, type, number);
	}

	async setWorkspace(boardId: string, path: string): Promise<void> {
		const current = get(this.state).settings;
		const workspaces = { ...current.workspaces, [boardId]: path };
		this.patch({ settings: { ...current, workspaces } });
		await this.deviceState.save({ workspaces });
	}

	async refreshRunDetails(boardId: string, taskId: string): Promise<void> {
		const key = taskRunKey(boardId, taskId);
		const run = get(this.state).runs[key];
		if (!run || run.logs.length > 0 || this.detailsLoaded.has(run.id)) return;
		this.detailsLoaded.add(run.id);
		try {
			const page = await this.client.getRun(run.id, 0);
			const latest = get(this.state).runs[key];
			if (!latest || latest.id !== page.run.id) return;
			this.patchRun(key, toView(page, latest));
		} catch {
			this.detailsLoaded.delete(run.id);
			// History summaries remain usable without full logs.
		}
	}

	async loadTaskHistory(boardId: string, taskId: string): Promise<void> {
		const key = taskRunKey(boardId, taskId);
		const runs = await this.client.listRuns(
			boardId,
			taskId,
			TASK_RUN_HISTORY_LIMIT
		);
		const latest = get(this.state).runs[key];
		const merged = latest
			? mergeRunIntoHistory(runs, runSnapshotFromView(latest))
			: buildRunHistory(runs);
		this.state.update((snapshot) => ({
			...snapshot,
			history: { ...snapshot.history, [key]: merged },
		}));
		this.seedLiveRun(key, merged);
	}

	loadRunDetail(runId: string): Promise<void> {
		if (this.getSnapshot().runDetails[runId]) return Promise.resolve();
		const inFlight = this.detailLoads.get(runId);
		if (inFlight) return inFlight;
		const load = (async () => {
			try {
				const page = await this.client.getRun(runId, 0);
				const view = toView(page);
				this.state.update((snapshot) => {
					const history = { ...snapshot.history };
					for (const [key, list] of Object.entries(history)) {
						if (!list.some((run) => run.id === runId)) continue;
						history[key] = list.map((run) =>
							run.id === runId
								? { ...run, ...runSnapshotFromView(view) }
								: run
						);
					}
					const runDetails = {
						...snapshot.runDetails,
						[runId]: view,
					};
					const cachedIds = Object.keys(runDetails);
					for (const staleId of cachedIds.slice(
						0,
						Math.max(0, cachedIds.length - MAX_CACHED_RUN_DETAILS)
					)) {
						delete runDetails[staleId];
					}
					return {
						...snapshot,
						history,
						runDetails,
					};
				});
			} finally {
				this.detailLoads.delete(runId);
			}
		})();
		this.detailLoads.set(runId, load);
		return load;
	}

	async loadHistory(boardId: string): Promise<void> {
		try {
			const runsFromServer = await this.client.listRuns(boardId, undefined, 100);
			if (runsFromServer.length === 0) return;
			const next = { ...get(this.state).runs };
			const grouped = new Map<string, RunnerRun[]>();
			for (const run of runsFromServer) {
				const key = taskRunKey(boardId, run.taskId);
				const existing = next[key];
				if (!existing || existing.createdAt <= run.createdAt) {
					const sameRun = existing?.id === run.id;
					next[key] = {
						...run,
						logs: sameRun ? existing.logs : [],
						nextCursor: sameRun ? existing.nextCursor : 0,
						pollError: "",
					};
				}
				const list = grouped.get(key);
				if (list) list.push(run);
				else grouped.set(key, [run]);
			}

			const history = { ...get(this.state).history };
			for (const [key, list] of grouped) {
				const live = next[key];
				history[key] = live
					? mergeRunIntoHistory(list, runSnapshotFromView(live))
					: buildRunHistory(list);
			}

			this.state.update((snapshot) => ({ ...snapshot, runs: next, history }));
			for (const run of runsFromServer) {
				if (run.status === "queued" || run.status === "running") {
					this.startPolling(taskRunKey(boardId, run.taskId));
				}
			}
		} catch {
			// Runner not running yet is not an error for the board UI.
		}
	}

	private seedLiveRun(key: string, history: RunnerRun[]): void {
		const newest = history[0];
		if (!newest) return;
		const current = get(this.state).runs[key];
		if (current) {
			if (current.id !== newest.id && current.createdAt > newest.createdAt) return;
			if (current.id === newest.id) {
				if (current.status === "queued" || current.status === "running") {
					this.startPolling(key);
				}
				return;
			}
		}
		this.state.update((snapshot) => ({
			...snapshot,
			runs: {
				...snapshot.runs,
				[key]: { ...newest, logs: [], nextCursor: 0, pollError: "" },
			},
		}));
		if (newest.status === "queued" || newest.status === "running") {
			this.startPolling(key);
		}
	}

	async sendRunMessage(
		boardId: string,
		taskId: string,
		message: string,
		mode: "steer" | "follow_up"
	): Promise<void> {
		const key = taskRunKey(boardId, taskId);
		const run = get(this.state).runs[key];
		if (!run || run.status !== "running") {
			throw new Error("The task is not running.");
		}
		await this.client.sendMessage(run.id, message, mode);
	}

	async reorderQueue(boardId: string, runIds: string[]): Promise<void> {
		await this.client.reorderQueue(boardId, runIds);
	}

	async listTaskProposals(boardId: string): Promise<TaskProposal[]> {
		return this.client.listTaskProposals(boardId);
	}

	async ackTaskProposal(id: string): Promise<void> {
		await this.client.ackTaskProposal(id);
	}

	async clearQueuedMessages(boardId: string, taskId: string): Promise<void> {
		const run = this.getRun(boardId, taskId);
		if (!run || run.status !== "running") {
			throw new Error("Queued messages can only be cleared while running.");
		}
		await this.client.clearQueue(run.id);
	}

	async continueRun(
		boardId: string,
		taskId: string,
		message: string
	): Promise<RunView> {
		const key = taskRunKey(boardId, taskId);
		const current = get(this.state).runs[key];
		if (!current) throw new Error("No run to continue.");
		if (
			current.status !== "succeeded" &&
			current.status !== "failed" &&
			current.status !== "cancelled"
		) {
			throw new Error("Wait for the current run to finish before continuing.");
		}
		if (!current.sessionFile) throw new Error("This run has no saved session.");
		if (current.capabilities && !current.capabilities.resume) {
			throw new Error(`${current.backendName} does not support continuing sessions.`);
		}
		if (current.worktreeRequested && current.worktreeRemoved) {
			throw new Error("The worktree was removed; start a new run instead.");
		}
		const page = await this.client.continueRun(current.id, message);
		const view = toView(page);
		const latest = get(this.state).runs[key];
		if (!latest || latest.id !== current.id) {
			throw new Error("The run changed before it could be continued.");
		}
		this.state.update((snapshot) => ({
			...snapshot,
			runs: { ...snapshot.runs, [key]: view },
			history: {
				...snapshot.history,
				[key]: mergeRunIntoHistory(
					snapshot.history[key] ?? [],
					runSnapshotFromView(view)
				),
			},
		}));
		this.startPolling(key);
		return get(this.state).runs[key] as RunView;
	}

	async cleanupRunWorktree(runId: string): Promise<void> {
		const page = await this.client.cleanupWorktree(runId);
		const view = toView(page);
		this.state.update((snapshot) => {
			const runs = { ...snapshot.runs };
			for (const [key, run] of Object.entries(runs)) {
				if (run.id === runId) runs[key] = { ...run, ...view };
			}
			const history = { ...snapshot.history };
			for (const [key, list] of Object.entries(history)) {
				if (!list.some((run) => run.id === runId)) continue;
				history[key] = list.map((run) =>
					run.id === runId ? runSnapshotFromView(view) : run
				);
			}
			return {
				...snapshot,
				runs,
				history,
				runDetails: { ...snapshot.runDetails, [runId]: view },
			};
		});
	}

	async clearWorkspace(boardId: string): Promise<void> {
		const current = get(this.state).settings;
		if (!(boardId in current.workspaces)) return;
		const workspaces = { ...current.workspaces };
		delete workspaces[boardId];
		this.patch({ settings: { ...current, workspaces } });
		await this.deviceState.save({ workspaces });
	}

	private async ensureWorkspace(
		board: Pick<Board, "id" | "name" | "agent">
	): Promise<string> {
		const existing = get(this.state).settings.workspaces[board.id];
		if (existing) return existing;
		const github = board.agent?.github;
		if (github?.repoUrl) {
			const workspace = await this.cloneGithubWorkspace(
				board.id,
				github.repoUrl,
				github.branch
			);
			return workspace.path;
		}
		throw new Error(
			"Set a local workspace or choose a GitHub repository for this board before running a task."
		);
	}

	async buildContext(
		board: Pick<Board, "id" | "name" | "agent">,
		task: Task
	): Promise<{ prompt: string; images: Awaited<ReturnType<typeof collectTaskImages>>; noteCount: number }> {
		const workspace = await this.ensureWorkspace(board);
		const [notes, images] = await Promise.all([
			collectLinkedNotes(this.app, task.description),
			collectTaskImages(this.app, task.description),
		]);
		return {
			prompt: buildTaskPrompt({
				boardName: board.name,
				taskId: task.id,
				taskTitle: task.title,
				taskDescription: task.description,
				workspacePath: workspace,
				notes,
				imageNames: images.map((image) => image.name),
				github: task.github,
			}),
			images,
			noteCount: notes.length,
		};
	}

	async startRun(
		board: Pick<Board, "id" | "name" | "agent">,
		task: Task
	): Promise<RunView> {
		const workspace = await this.ensureWorkspace(board);
		const key = taskRunKey(board.id, task.id);
		const existing = get(this.state).runs[key];
		if (existing && (existing.status === "queued" || existing.status === "running")) {
			throw new Error("This task is already running.");
		}

		const context = await this.buildContext(board, task);
		const page = await this.client.startRun({
			boardId: board.id,
			taskId: task.id,
			title: task.title,
			prompt: context.prompt,
			cwd: workspace,
			backend: board.agent?.backend,
			images: context.images,
			worktree: board.agent?.worktree === true,
		});

		this.patchHealth({ status: "online", error: "" });
		const view = toView(page);
		this.state.update((snapshot) => ({
			...snapshot,
			runs: {
				...snapshot.runs,
				[key]: view,
			},
			history: {
				...snapshot.history,
				[key]: mergeRunIntoHistory(
					snapshot.history[key] ?? [],
					runSnapshotFromView(view)
				),
			},
		}));
		this.startPolling(key);
		return get(this.state).runs[key] as RunView;
	}

	async abortRun(boardId: string, taskId: string): Promise<void> {
		const key = taskRunKey(boardId, taskId);
		const run = get(this.state).runs[key];
		if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
			return;
		}
		try {
			const page = await this.client.abortRun(run.id);
			this.patchRun(key, toView(page, run));
		} catch (error) {
			this.patchRun(key, { pollError: errorMessage(error) });
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const timer of this.pollTimers.values()) window.clearInterval(timer);
		this.pollTimers.clear();
		this.pollInFlight.clear();
		this.detailLoads.clear();
	}

	private startPolling(key: string): void {
		this.stopPolling(key);
		this.pollFailures.set(key, 0);
		void this.poll(key);
		const timer = window.setInterval(() => {
			void this.poll(key);
		}, POLL_INTERVAL_MS);
		this.pollTimers.set(key, timer);
	}

	private stopPolling(key: string): void {
		const timer = this.pollTimers.get(key);
		window.clearInterval(timer);
		this.pollTimers.delete(key);
	}

	private async poll(key: string): Promise<void> {
		if (this.disposed || this.pollInFlight.has(key)) return;
		const current = get(this.state).runs[key];
		if (!current) {
			this.stopPolling(key);
			return;
		}
		if (
			current.status === "succeeded" ||
			current.status === "failed" ||
			current.status === "cancelled"
		) {
			this.stopPolling(key);
			return;
		}

		this.pollInFlight.add(key);
		try {
			const page = await this.client.getRun(current.id, current.nextCursor);
			const latest = get(this.state).runs[key];
			if (!latest || latest.id !== page.run.id) return;
			this.pollFailures.set(key, 0);
			this.patchRun(key, toView(page, latest));
			if (
				page.run.status === "succeeded" ||
				page.run.status === "failed" ||
				page.run.status === "cancelled"
			) {
				this.stopPolling(key);
			}
			this.patchHealth({ status: "online", error: "" });
		} catch (error) {
			const failures = (this.pollFailures.get(key) ?? 0) + 1;
			this.pollFailures.set(key, failures);
			this.patchRun(key, {
				pollError:
					failures >= MAX_POLL_ERRORS
						? `Lost contact with the Runner: ${errorMessage(error)}`
						: errorMessage(error),
			});
		} finally {
			this.pollInFlight.delete(key);
		}
	}

	private patchHealth(patch: Partial<AgentSnapshot["health"]>): void {
		this.state.update((snapshot) => ({
			...snapshot,
			health: { ...snapshot.health, ...patch },
		}));
	}

	private patchRun(key: string, patch: Partial<RunView>): void {
		this.state.update((snapshot) => {
			const existing = snapshot.runs[key];
			if (!existing) return snapshot;
			const updated = { ...existing, ...patch };
			const history = snapshot.history[key];
			const tracksRun = history?.some((run) => run.id === updated.id) ?? false;
			return {
				...snapshot,
				runs: {
					...snapshot.runs,
					[key]: updated,
				},
				history: tracksRun
					? {
							...snapshot.history,
							[key]: mergeRunIntoHistory(
								history ?? [],
								runSnapshotFromView(updated)
							),
						}
					: snapshot.history,
			};
		});
	}

	private patch(partial: Partial<AgentSnapshot>): void {
		this.state.update((snapshot) => ({ ...snapshot, ...partial }));
	}
}
