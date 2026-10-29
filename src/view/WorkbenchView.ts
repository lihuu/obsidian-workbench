import { ItemView, WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import type { WorkbenchStore } from "../data/store";
import type { AgentController } from "../agent/controller";
import Workbench from "../ui/Workbench.svelte";

export const VIEW_TYPE_WORKBENCH = "workbench-view";

export class WorkbenchView extends ItemView {
	private component: Record<string, unknown> | undefined;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly store: WorkbenchStore,
		private readonly agent: AgentController,
		private readonly isQuitting: () => boolean
	) {
		super(leaf);
		this.navigation = true;
		this.icon = "layout-dashboard";
	}

	getViewType(): string {
		return VIEW_TYPE_WORKBENCH;
	}

	getDisplayText(): string {
		return "Workbench";
	}

	async onOpen(): Promise<void> {
		this.store.setWorkbenchOpen(true);
		this.contentEl.empty();
		this.contentEl.addClass("workbench-view");
		this.component = mount(Workbench, {
			target: this.contentEl,
			props: { app: this.app, store: this.store, agent: this.agent },
		});
	}

	async onClose(): Promise<void> {
		await this.store.flush();
		if (this.isQuitting()) {
			this.store.markQuitting();
		} else {
			this.store.scheduleWorkbenchClosed();
		}
		if (this.component) {
			unmount(this.component);
			this.component = undefined;
		}
	}
}
