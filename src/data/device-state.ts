import { Platform, type Plugin } from "obsidian";
import { isRecord } from "./guards";
import { DEFAULT_RUNNER_URL } from "../agent/types";
import {
	selectRunnerConnection,
	type RunnerConnection,
} from "../agent/runner-connection";

export interface DeviceState {
	lastBoardId: string | null;
	workbenchOpen: boolean;
	runnerUrl: string;
	runnerToken: string;
	cfAccessClientId: string;
	cfAccessClientSecret: string;
	workspaces: Record<string, string>;
}

interface StoredDeviceData {
	lastBoardId?: unknown;
	workbenchOpen?: unknown;
	runnerUrl?: unknown;
	runnerToken?: unknown;
	cfAccessClientId?: unknown;
	cfAccessClientSecret?: unknown;
	workspaces?: unknown;
}

interface LocalConnectionData {
	runnerUrl?: unknown;
	runnerToken?: unknown;
	cfAccessClientId?: unknown;
	cfAccessClientSecret?: unknown;
}

const CONNECTION_STORAGE_PREFIX = "workbench.runner-connection.v1";

function defaultRunnerUrl(): string {
	return Platform.isMobile ? "" : DEFAULT_RUNNER_URL;
}

function readWorkspaces(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const workspaces: Record<string, string> = {};
	for (const [boardId, path] of Object.entries(value)) {
		if (typeof path === "string" && path.trim()) workspaces[boardId] = path;
	}
	return workspaces;
}

function readConnection(value: LocalConnectionData, fallbackUrl: string): RunnerConnection {
	const runnerUrl =
		typeof value.runnerUrl === "string" && value.runnerUrl.trim()
			? value.runnerUrl.trim().replace(/\/+$/, "")
			: fallbackUrl;
	return {
		runnerUrl,
		runnerToken: typeof value.runnerToken === "string" ? value.runnerToken : "",
		cfAccessClientId:
			typeof value.cfAccessClientId === "string" ? value.cfAccessClientId : "",
		cfAccessClientSecret:
			typeof value.cfAccessClientSecret === "string"
				? value.cfAccessClientSecret
				: "",
	};
}

export class PluginDeviceState {
	private cached: DeviceState = {
		lastBoardId: null,
		workbenchOpen: false,
		runnerUrl: defaultRunnerUrl(),
		runnerToken: "",
		cfAccessClientId: "",
		cfAccessClientSecret: "",
		workspaces: {},
	};
	private saveChain: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<DeviceState> {
		try {
			const raw = (await this.plugin.loadData()) as StoredDeviceData | null;
			const localConnection = this.readLocalConnection();
			// Older versions wrote Runner credentials to data.json, which syncs
			// across devices. Migrate them once, then keep them device-local.
			const syncedConnection = readConnection(raw ?? {}, defaultRunnerUrl());
			const connection = selectRunnerConnection(
				localConnection,
				syncedConnection,
				Platform.isMobile
			);
			if (!localConnection) this.writeLocalConnection(connection);
			this.cached = {
				lastBoardId: typeof raw?.lastBoardId === "string" ? raw.lastBoardId : null,
				workbenchOpen: raw?.workbenchOpen === true,
				...connection,
				workspaces: readWorkspaces(raw?.workspaces),
			};
		} catch {
			this.cached = {
				lastBoardId: null,
				workbenchOpen: false,
				runnerUrl: defaultRunnerUrl(),
				runnerToken: "",
				cfAccessClientId: "",
				cfAccessClientSecret: "",
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
		// Runner connection fields deliberately stay out of data.json: that
		// file is synced, while localhost/remote endpoints are per device.
		const data = {
			lastBoardId: this.cached.lastBoardId,
			workbenchOpen: this.cached.workbenchOpen,
			workspaces: this.cached.workspaces,
		};
		const write = this.saveChain.then(() => this.plugin.saveData(data));
		this.saveChain = write.catch(() => undefined);
		return write;
	}

	async saveConnection(connection: RunnerConnection): Promise<void> {
		this.cached = { ...this.cached, ...connection };
		this.writeLocalConnection(connection);
	}

	private getConnectionStorageKey(): string {
		return `${CONNECTION_STORAGE_PREFIX}:${this.plugin.app.vault.getName()}`;
	}

	private readLocalConnection(): RunnerConnection | null {
		try {
			const raw = window.localStorage.getItem(this.getConnectionStorageKey());
			if (!raw) return null;
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed)) return null;
			const connection = readConnection(
				parsed as LocalConnectionData,
				defaultRunnerUrl()
			);
			return selectRunnerConnection(connection, connection, Platform.isMobile);
		} catch {
			return null;
		}
	}

	private writeLocalConnection(connection: RunnerConnection): void {
		try {
			window.localStorage.setItem(
				this.getConnectionStorageKey(),
				JSON.stringify(connection)
			);
		} catch {
			// localStorage can be unavailable in private/restricted webviews.
			// Keep the in-memory value so the current session still works.
		}
	}
}
