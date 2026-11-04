import { Notice, Plugin, TFile } from "obsidian";
import { PluginDeviceState } from "./data/device-state";
import { VaultBoardRepository } from "./data/repository";
import { WorkbenchStore } from "./data/store";
import { VIEW_TYPE_WORKBENCH, WorkbenchView } from "./view/WorkbenchView";
import { AgentController } from "./agent/controller";
import { LocalRunnerManager } from "./agent/local-runner";
import {
	CLI_FLAGS_CREATE,
	CLI_FLAGS_LIST,
	CLI_FLAGS_GET,
	CLI_FLAGS_UPDATE,
	CLI_FLAGS_MOVE,
	CLI_FLAGS_DELETE,
	handleCreateTask,
	handleListTasks,
	handleGetTask,
	handleUpdateTask,
	handleMoveTask,
	handleDeleteTask,
} from "./cli/handlers";

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
			const ensureStore = () => {
				if (!this.store) throw new Error("Workbench is not loaded.");
				return this.store;
			};
			this.registerCliHandler(
				"workbench:create-task",
				"Create a Workbench task",
				CLI_FLAGS_CREATE,
				(params) => handleCreateTask(ensureStore(), params)
			);
			this.registerCliHandler(
				"workbench:list-tasks",
				"List Workbench tasks",
				CLI_FLAGS_LIST,
				(params) => handleListTasks(ensureStore(), params)
			);
			this.registerCliHandler(
				"workbench:get-task",
				"Get details for a Workbench task",
				CLI_FLAGS_GET,
				(params) => handleGetTask(ensureStore(), params)
			);
			this.registerCliHandler(
				"workbench:update-task",
				"Update a Workbench task's title, description, backend, or column (status)",
				CLI_FLAGS_UPDATE,
				(params) => handleUpdateTask(ensureStore(), params)
			);
			this.registerCliHandler(
				"workbench:move-task",
				"Move a Workbench task to another column",
				CLI_FLAGS_MOVE,
				(params) => handleMoveTask(ensureStore(), params)
			);
			this.registerCliHandler(
				"workbench:delete-task",
				"Delete a Workbench task",
				CLI_FLAGS_DELETE,
				(params) => handleDeleteTask(ensureStore(), params)
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
