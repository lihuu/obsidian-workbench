import type { Plugin } from "obsidian";
import { isRecord } from "./guards";
import { DEFAULT_RUNNER_URL } from "../agent/types";

export interface DeviceState {
	lastBoardId: string | null;
	workbenchOpen: boolean;
	runnerUrl: string;
	runnerToken: string;
	workspaces: Record<string, string>;
}

interface StoredDeviceData {
	lastBoardId?: unknown;
	workbenchOpen?: unknown;
	runnerUrl?: unknown;
	runnerToken?: unknown;
	workspaces?: unknown;
}

function readWorkspaces(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const workspaces: Record<string, string> = {};
	for (const [boardId, path] of Object.entries(value)) {
		if (typeof path === "string" && path.trim()) workspaces[boardId] = path;
	}
	return workspaces;
}

function readRunnerUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return DEFAULT_RUNNER_URL;
	return value.trim().replace(/\/+$/, "");
}

export class PluginDeviceState {
	private cached: DeviceState = {
		lastBoardId: null,
		workbenchOpen: false,
		runnerUrl: DEFAULT_RUNNER_URL,
		runnerToken: "",
		workspaces: {},
	};
	private saveChain: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<DeviceState> {
		try {
			const raw = (await this.plugin.loadData()) as StoredDeviceData | null;
			this.cached = {
				lastBoardId: typeof raw?.lastBoardId === "string" ? raw.lastBoardId : null,
				workbenchOpen: raw?.workbenchOpen === true,
				runnerUrl: readRunnerUrl(raw?.runnerUrl),
				runnerToken: typeof raw?.runnerToken === "string" ? raw.runnerToken : "",
				workspaces: readWorkspaces(raw?.workspaces),
			};
		} catch {
			this.cached = {
				lastBoardId: null,
				workbenchOpen: false,
				runnerUrl: DEFAULT_RUNNER_URL,
				runnerToken: "",
				workspaces: {},
			};
		}
		return this.getSnapshot();
	}

	getSnapshot(): DeviceState {
		return {
			...this.cached,
			workspaces: { ...this.cached.workspaces },
		};
	}

	async save(patch: Partial<DeviceState>): Promise<void> {
		this.cached = {
			...this.cached,
			...patch,
			workspaces: patch.workspaces
				? { ...patch.workspaces }
				: { ...this.cached.workspaces },
		};
		const data = {
			lastBoardId: this.cached.lastBoardId,
			workbenchOpen: this.cached.workbenchOpen,
			runnerUrl: this.cached.runnerUrl,
			runnerToken: this.cached.runnerToken,
			workspaces: this.cached.workspaces,
		};
		const write = this.saveChain.then(() => this.plugin.saveData(data));
		this.saveChain = write.catch(() => undefined);
		return write;
	}
}
