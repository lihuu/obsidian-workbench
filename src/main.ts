import { Notice, Plugin, TFile } from "obsidian";
import type { CliData, CliFlags } from "obsidian";
import { PluginDeviceState } from "./data/device-state";
import { VaultBoardRepository } from "./data/repository";
import { WorkbenchStore } from "./data/store";
import { VIEW_TYPE_WORKBENCH, WorkbenchView } from "./view/WorkbenchView";
import { AgentController } from "./agent/controller";
import { LocalRunnerManager } from "./agent/local-runner";

function cliText(value: string | "true" | undefined): string {
	return typeof value === "string" && value !== "true" ? value : "";
}

const CLI_FLAGS: CliFlags = {
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
};

export default class WorkbenchPlugin extends Plugin {
	private store: WorkbenchStore | undefined;
	private agent: AgentController | undefined;
	private localRunner: LocalRunnerManager | undefined;
	private quitting = false;

	async onload(): Promise<void> {
		const repository = new VaultBoardRepository(this.app);
		const deviceState = new PluginDeviceState(this);
		const initialDeviceState = await deviceState.load();
		const store = new WorkbenchStore(this.app, repository, deviceState);
		this.store = store;
		const agent = new AgentController(this.app, deviceState, initialDeviceState);
		this.agent = agent;
		const localRunner = new LocalRunnerManager(this.app, this);
		this.localRunner = localRunner;

		this.registerDomEvent(window, "beforeunload", () => {
			this.quitting = true;
			store.markQuitting();
		});

		this.register(() => {
			void this.localRunner?.stop();
			this.agent?.dispose();
			const store = this.store;
			if (!store) return;
			void store.flush().finally(() => store.dispose());
		});

		this.registerView(
			VIEW_TYPE_WORKBENCH,
			(leaf) => new WorkbenchView(leaf, store, agent, () => this.quitting)
		);

		this.addRibbonIcon("layout-dashboard", "Open Workbench", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open",
			name: "Open Workbench",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "create-launcher",
			name: "Create Workbench launcher note",
			callback: () => {
				void this.createLauncherNote();
			},
		});

		if (typeof this.registerCliHandler === "function") {
			this.registerCliHandler(
				"workbench:create-task",
				"Create a Workbench task",
				CLI_FLAGS,
				(params) => this.createTaskFromCli(params)
			);
		}

		this.registerObsidianProtocolHandler("workbench", () => {
			void this.activateView();
		});

		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				try {
					await localRunner.ensure(initialDeviceState);
				} catch (error) {
					console.error("[workbench] embedded Runner failed to start", error);
				}
				await agent.refreshHealth();
			})();
		});

		// Plugin reloads happen when the workspace is already laid out, so
		// onLayoutReady is not guaranteed to fire again. Start immediately as
		// well; ensure() is idempotent.
		void (async () => {
			try {
				await localRunner.ensure(initialDeviceState);
			} catch (error) {
				console.error("[workbench] embedded Runner failed to start", error);
			}
			await agent.refreshHealth();
		})();

		this.registerInterval(
			window.setInterval(() => {
				const settings = this.agent?.getSnapshot().settings ?? initialDeviceState;
				void localRunner.ensure(settings).catch((error) => {
					console.error("[workbench] embedded Runner health check failed", error);
				});
			}, 30_000)
		);

		if (initialDeviceState.workbenchOpen) {
			this.app.workspace.onLayoutReady(() => {
				// Let Obsidian finish restoring the workspace before creating the tab.
				window.setTimeout(() => {
					void this.activateView();
				}, 150);
			});
		}
	}

	onunload(): void {
		this.quitting = true;
		this.agent?.dispose();
		this.store?.markQuitting();
	}

	private async createTaskFromCli(params: CliData): Promise<string> {
		const store = this.store;
		if (!store) throw new Error("Workbench is not loaded.");
		await store.load();
		const snapshot = store.getSnapshot();
		if (snapshot.loadState !== "ready") {
			throw new Error(snapshot.loadError ?? "Workbench boards are not ready.");
		}

		const title = cliText(params.title).trim();
		if (!title) throw new Error("title is required.");
		const description = cliText(params.description).slice(0, 20_000);
		const requestedBoard = cliText(params.board).trim();
		const board = requestedBoard
			? snapshot.boards.find(
					(candidate) =>
						candidate.id === requestedBoard ||
						candidate.name.toLowerCase() === requestedBoard.toLowerCase()
				)
			: snapshot.boards.find((candidate) => candidate.id === snapshot.activeBoardId) ??
				snapshot.boards[0];
		if (!board) {
			throw new Error(
				requestedBoard
					? `Board not found: ${requestedBoard}`
					: "No Workbench board exists."
			);
		}

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

		const task = store.addTask(board.id, column.id, title);
		store.updateTask(board.id, task.id, {
			...(description ? { description } : {}),
			source: "agent",
		});
		await store.flush();
		return `Created task ${task.id} in ${board.name} / ${column.name}: ${task.title}`;
	}

	private async createLauncherNote(): Promise<void> {
		const path = "Workbench.md";
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			if (existing instanceof TFile) {
				await this.app.workspace.getLeaf("tab").openFile(existing);
				new Notice("Workbench.md already exists.");
			} else {
				new Notice("A folder named Workbench.md already exists.");
			}
			return;
		}

		const content = [
			"# Workbench",
			"",
			"[打开 Workbench](obsidian://workbench)",
			"",
			"这是一个入口笔记。Workbench 的数据保存在 `Workbench/boards/`。",
			"",
		].join("\n");
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf("tab").openFile(file);
		new Notice("Created Workbench.md.");
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH);
		const leaf = leaves[0] ?? workspace.getLeaf("tab");

		await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true });
		await workspace.revealLeaf(leaf);

		// Keep the tab in the saved workspace layout while it is open.
		workspace.requestSaveLayout();
		workspace.requestSaveLayout.run();
	}
}
