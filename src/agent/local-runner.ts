import { Platform, requestUrl, type App, type Plugin } from "obsidian";
import type * as NodeModule from "node:module";
import type * as NodePath from "node:path";
import type { AgentSettings } from "./types";
import { isLoopbackRunnerUrl } from "./runner-connection";

interface NodeRequire {
	(id: string): unknown;
	resolve?: (id: string) => string;
	cache?: Record<string, unknown>;
}

interface RunnerModule {
	startRunner?: () => Promise<void>;
	stopRunner?: () => Promise<void>;
	stopEmbeddedRunner?: () => Promise<void>;
}

interface EmbeddedRunnerGlobal {
	__workbenchRunner?: unknown;
}

function isRunnerModule(value: unknown): value is RunnerModule {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	for (const key of ["startRunner", "stopRunner", "stopEmbeddedRunner"] as const) {
		if (key in candidate && typeof candidate[key] !== "function") return false;
	}
	return true;
}

const HEALTH_ATTEMPTS = 60;
const HEALTH_DELAY_MS = 250;

/**
 * Starts a desktop-only Runner from the plugin's own `runner.cjs` bundle when
 * the configured Runner is local and no standalone Runner is already running.
 * Mobile never calls this because Obsidian mobile has no Node runtime.
 */
export class LocalRunnerManager {
	private module: RunnerModule | undefined;
	private starting: Promise<void> | undefined;

	constructor(
		private readonly app: App,
		private readonly plugin: Plugin
	) {}

	async ensure(settings: AgentSettings): Promise<void> {
		if (!Platform.isDesktopApp) return;
		if (!isLoopbackRunnerUrl(settings.runnerUrl)) return;
		if (this.starting) return this.starting;
		if (!this.module) this.adoptCachedRunner();
		if (this.module) {
			if (await this.isHealthy(settings)) return;
			await this.stop();
		}

		const embedded = globalThis as EmbeddedRunnerGlobal;
		if (isRunnerModule(embedded.__workbenchRunner)) {
			// A prior plugin instance left an in-process Runner behind during a
			// reload. Stop it before starting a fresh one.
			await this.stopModule(embedded.__workbenchRunner);
			delete embedded.__workbenchRunner;
		}

		// A standalone Runner is already serving this address; don't start a
		// second one.
		if (await this.isHealthy(settings)) return;

		this.starting = this.start(settings).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		const embedded = globalThis as EmbeddedRunnerGlobal;
		const runner =
			this.module ??
			(isRunnerModule(embedded.__workbenchRunner)
				? embedded.__workbenchRunner
				: undefined);
		if (!runner) return;
		await this.stopModule(runner);
		delete embedded.__workbenchRunner;
		this.module = undefined;
	}

	private async stopModule(runner: RunnerModule): Promise<void> {
		try {
			if (runner.stopEmbeddedRunner) await runner.stopEmbeddedRunner();
			else await runner.stopRunner?.();
		} catch (error) {
			console.error("[workbench] could not stop embedded Runner", error);
		}
	}

	private adoptCachedRunner(): void {
		const nodeRequire = this.getNodeRequire();
		const basePath = this.getPluginBasePath();
		const pluginDir = this.plugin.manifest.dir;
		if (!nodeRequire || !basePath || !pluginDir) return;
		const nodePath = nodeRequire("node:path") as typeof NodePath;
		const runnerPath = nodePath.join(basePath, pluginDir, "runner.cjs");
		const nodeModule = nodeRequire("node:module") as typeof NodeModule;
		const realRequire = nodeModule.createRequire(runnerPath);
		const cached = realRequire.cache?.[runnerPath]?.exports;
		if (isRunnerModule(cached)) this.module = cached;
	}

	private async start(settings: AgentSettings): Promise<void> {
		const nodeRequire = this.getNodeRequire();
		if (!nodeRequire) {
			throw new Error("Desktop Node runtime is unavailable.");
		}
		const basePath = this.getPluginBasePath();
		const pluginDir = this.plugin.manifest.dir;
		if (!basePath || !pluginDir) {
			throw new Error("Could not resolve the plugin directory.");
		}
		const nodePath = nodeRequire("node:path") as typeof NodePath;
		const runnerPath = nodePath.join(basePath, pluginDir, "runner.cjs");

		const url = new URL(settings.runnerUrl);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		process.env.WORKBENCH_RUNNER_EMBEDDED = "1";
		process.env.WORKBENCH_RUNNER_HOST = host;
		process.env.WORKBENCH_RUNNER_PORT = port;
		process.env.WORKBENCH_RUNNER_TOKEN = settings.runnerToken.trim();
		this.augmentPath();

		const resolved = nodeRequire.resolve?.(runnerPath) ?? runnerPath;
		if (nodeRequire.cache) {
			delete nodeRequire.cache[resolved];
			delete nodeRequire.cache[runnerPath];
			for (const key of Object.keys(nodeRequire.cache)) {
				if (key.endsWith(`${nodePath.sep}runner.cjs`)) {
					delete nodeRequire.cache[key];
				}
			}
		}
		const nodeModule = nodeRequire("node:module") as typeof NodeModule;
		const realRequire = nodeModule.createRequire(runnerPath);
		if (realRequire.cache) {
			const cached = realRequire.cache[runnerPath];
			if (cached && isRunnerModule(cached.exports)) {
				await this.stopModule(cached.exports);
			}
			for (const key of Object.keys(realRequire.cache)) {
				if (key.endsWith(`${nodePath.sep}runner.cjs`)) {
					delete realRequire.cache[key];
				}
			}
		}
		const loaded: unknown = realRequire(runnerPath);
		if (!isRunnerModule(loaded)) {
			throw new Error("runner.cjs did not export a Runner module.");
		}
		this.module = loaded;
		await loaded.startRunner?.();
		if (!(await this.waitForHealth(settings))) {
			await this.stop();
			throw new Error(
				`Embedded Runner did not become ready at ${settings.runnerUrl}.`
			);
		}
	}

	private getPluginBasePath(): string | undefined {
		const adapter = this.app.vault.adapter;
		if (!("getBasePath" in adapter) || typeof adapter.getBasePath !== "function") {
			return undefined;
		}
		return adapter.getBasePath();
	}

	private getNodeRequire(): NodeRequire | undefined {
		if (typeof require !== "function") return undefined;
		return require;
	}

	private augmentPath(): void {
		const home = process.env.HOME ?? "";
		const extras = [
			home ? `${home}/.local/bin` : "",
			home ? `${home}/.pi/agent/bin` : "",
			home ? `${home}/.bun/bin` : "",
			home ? `${home}/.npm-global/bin` : "",
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
			"/usr/local/bin",
		].filter(Boolean);
		const current = process.env.PATH ?? "";
		const seen = new Set<string>();
		const parts = [...extras, ...current.split(":")].filter((entry) => {
			if (!entry || seen.has(entry)) return false;
			seen.add(entry);
			return true;
		});
		process.env.PATH = parts.join(":");
	}

	private async waitForHealth(settings: AgentSettings): Promise<boolean> {
		for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
			if (await this.isHealthy(settings)) return true;
			await new Promise<void>((resolve) =>
				window.setTimeout(resolve, HEALTH_DELAY_MS)
			);
		}
		return false;
	}

	private async isHealthy(settings: AgentSettings): Promise<boolean> {
		try {
			const headers: Record<string, string> = {};
			if (settings.runnerToken.trim()) {
				headers.Authorization = `Bearer ${settings.runnerToken.trim()}`;
			}
			const response = await requestUrl({
				url: `${settings.runnerUrl.replace(/\/+$/, "")}/health`,
				method: "GET",
				headers,
				throw: false,
			});
			return response.status >= 200 && response.status < 300;
		} catch {
			return false;
		}
	}
}
