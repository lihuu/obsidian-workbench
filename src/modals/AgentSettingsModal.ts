import { App, Modal, Notice, TFile } from "obsidian";
import type { AgentController } from "../agent/controller";
import type { Board, BoardAgentConfig } from "../data/types";
import type { WorkbenchStore } from "../data/store";
import { collectGitHubRefs, importGitHubItems } from "../agent/github";

type SourceKind = "local" | "github";

export class AgentSettingsModal extends Modal {
	constructor(
		app: App,
		private readonly agent: AgentController,
		private readonly store: WorkbenchStore,
		private readonly board: Board
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Workbench agent");
		this.modalEl.addClass("wb-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();

		const snapshot = this.agent.getSnapshot();
		const settings = snapshot.settings;
		const github = this.board.agent?.github;
		let source: SourceKind = github ? "github" : "local";
		let syncButton: HTMLButtonElement | undefined;

		this.contentEl.createDiv({
			cls: "wb-agent-intro",
			text: `Run agent tasks for "${this.board.name}". Board source settings sync with the board; checkout paths and runner settings stay on this device.`,
		});

		this.contentEl.createDiv({
			cls: "wb-agent-section-title",
			text: "Runner connection (global)",
		});

		const urlField = this.contentEl.createDiv({ cls: "wb-field" });
		const urlLabel = urlField.createEl("label", {
			cls: "wb-field-label",
			text: "Runner URL",
		});
		const urlInput = urlField.createEl("input", {
			cls: "wb-input",
			type: "text",
		});
		urlInput.value = settings.runnerUrl;
		urlInput.placeholder = "http://127.0.0.1:4319";
		urlInput.id = `wb-agent-url-${Date.now()}`;
		urlLabel.htmlFor = urlInput.id;

		const tokenField = this.contentEl.createDiv({ cls: "wb-field" });
		const tokenLabel = tokenField.createEl("label", {
			cls: "wb-field-label",
			text: "Runner token (optional)",
		});
		const tokenInput = tokenField.createEl("input", {
			cls: "wb-input",
			type: "password",
		});
		tokenInput.value = settings.runnerToken;
		tokenInput.placeholder = "Required for remote Runner URLs";
		tokenInput.id = `wb-agent-token-${Date.now()}`;
		tokenLabel.htmlFor = tokenInput.id;
		urlField.createDiv({
			cls: "wb-field-hint",
			text: "Desktop starts the bundled local Runner automatically. Set a remote URL/token for Cloudflare or another Runner.",
		});

		this.contentEl.createDiv({
			cls: "wb-agent-section-title",
			text: "Cloudflare Access service token (remote Runner)",
		});
		const accessIdField = this.contentEl.createDiv({ cls: "wb-field" });
		const accessIdLabel = accessIdField.createEl("label", {
			cls: "wb-field-label",
			text: "CF-Access-Client-Id",
		});
		const accessIdInput = accessIdField.createEl("input", {
			cls: "wb-input",
			type: "text",
		});
		accessIdInput.value = settings.cfAccessClientId;
		accessIdInput.placeholder = "Service token client ID";
		accessIdInput.id = `wb-agent-cf-id-${Date.now()}`;
		accessIdLabel.htmlFor = accessIdInput.id;

		const accessSecretField = this.contentEl.createDiv({ cls: "wb-field" });
		const accessSecretLabel = accessSecretField.createEl("label", {
			cls: "wb-field-label",
			text: "CF-Access-Client-Secret",
		});
		const accessSecretInput = accessSecretField.createEl("input", {
			cls: "wb-input",
			type: "password",
		});
		accessSecretInput.value = settings.cfAccessClientSecret;
		accessSecretInput.placeholder = "Service token client secret";
		accessSecretInput.id = `wb-agent-cf-secret-${Date.now()}`;
		accessSecretLabel.htmlFor = accessSecretInput.id;
		accessSecretField.createDiv({
			cls: "wb-field-hint",
			text: "Cloudflare Zero Trust → Access → Service Token. Use both fields together; remote URLs also require HTTPS and a Runner token.",
		});

		this.contentEl.createDiv({
			cls: "wb-agent-section-title",
			text: "Board workspace (this board)",
		});

		const backendField = this.contentEl.createDiv({ cls: "wb-field" });
		const backendLabel = backendField.createEl("label", {
			cls: "wb-field-label",
			text: "Execution backend",
		});
		const backendSelect = backendField.createEl("select", { cls: "wb-input" });
		backendSelect.id = `wb-agent-backend-${Date.now()}`;
		backendLabel.htmlFor = backendSelect.id;
		const fallbackCapabilities = {
			streaming: true,
			toolEvents: true,
			abort: true,
			steer: true,
			followUp: true,
			clearQueue: true,
			resume: true,
			images: true,
		};
		const knownBackends = snapshot.health.backends.length > 0
			? snapshot.health.backends
			: [
					{
						id: "pi",
						displayName: "Pi",
						binary: "",
						available: false,
						version: "",
						error: "",
						capabilities: { ...fallbackCapabilities },
					},
					{
						id: "omp",
						displayName: "OMP",
						binary: "",
						available: false,
						version: "",
						error: "",
						capabilities: { ...fallbackCapabilities, clearQueue: false },
					},
					{
						id: "opencode",
						displayName: "OpenCode",
						binary: "",
						available: false,
						version: "",
						error: "",
						capabilities: {
							...fallbackCapabilities,
							steer: false,
							followUp: false,
							clearQueue: false,
							images: false,
						},
					},
				];
		for (const backend of knownBackends) {
			backendSelect.createEl("option", {
				value: backend.id,
				text: `${backend.displayName}${backend.available ? ` · ${backend.version}` : " · unavailable"}`,
			});
		}
		const configuredBackend = this.board.agent?.backend;
		if (configuredBackend && !knownBackends.some((backend) => backend.id === configuredBackend)) {
			backendSelect.createEl("option", {
				value: configuredBackend,
				text: `${configuredBackend} · not reported by Runner`,
			});
		}
		backendSelect.value =
			configuredBackend || snapshot.health.defaultBackend || knownBackends[0]?.id || "pi";
		backendField.createDiv({
			cls: "wb-field-hint",
			text: "The Runner launches this local agent CLI. Backend binaries stay in Runner configuration, not in the board.",
		});

		const sourceField = this.contentEl.createDiv({ cls: "wb-field" });
		const sourceLabel = sourceField.createEl("label", {
			cls: "wb-field-label",
			text: "Board source",
		});
		const sourceSelect = sourceField.createEl("select", { cls: "wb-input" });
		sourceSelect.id = `wb-agent-source-${Date.now()}`;
		sourceLabel.htmlFor = sourceSelect.id;
		sourceSelect.createEl("option", { value: "local", text: "Local folder" });
		sourceSelect.createEl("option", { value: "github", text: "GitHub repository" });
		sourceSelect.value = source;

		const localField = this.contentEl.createDiv({ cls: "wb-field" });
		const localLabel = localField.createEl("label", {
			cls: "wb-field-label",
			text: "Local workspace",
		});
		const localInput = localField.createEl("input", {
			cls: "wb-input",
			type: "text",
		});
		localInput.value = settings.workspaces[this.board.id] ?? "";
		localInput.placeholder = "~/Obsidian/obsidian-workbench";
		localInput.id = `wb-agent-local-${Date.now()}`;
		localLabel.htmlFor = localInput.id;
		localField.createDiv({
			cls: "wb-field-hint",
			text: "The Runner validates this folder. Leave empty to clear it.",
		});

		const githubField = this.contentEl.createDiv({ cls: "wb-field" });
		const repoLabel = githubField.createEl("label", {
			cls: "wb-field-label",
			text: "GitHub repository",
		});
		const repoInput = githubField.createEl("input", {
			cls: "wb-input",
			type: "text",
		});
		repoInput.value = github?.repoUrl ?? "";
		repoInput.placeholder = "https://github.com/owner/repo.git";
		repoInput.id = `wb-agent-repo-${Date.now()}`;
		repoLabel.htmlFor = repoInput.id;

		const branchLabel = githubField.createEl("label", {
			cls: "wb-field-label",
			text: "Branch (optional)",
		});
		const branchInput = githubField.createEl("input", {
			cls: "wb-input",
			type: "text",
		});
		branchInput.value = github?.branch ?? "";
		branchInput.placeholder = "main";
		branchLabel.htmlFor = branchInput.id;
		githubField.createDiv({
			cls: "wb-field-hint",
			text: "Saving clones into the Runner's workspaces directory. Sync imports open issues and pull requests into Inbox/Backlog using the local gh CLI.",
		});
		githubField.createDiv({
			cls: "wb-field-hint",
			text: "System git credentials/SSH are used; no token is stored in the board.",
		});

		const checkoutEl = this.contentEl.createDiv({
			cls: "wb-agent-checkout",
		});
		const updateCheckout = () => {
			const path = this.agent.getSnapshot().settings.workspaces[this.board.id];
			checkoutEl.setText(path ? `Current checkout: ${path}` : "No checkout yet.");
		};
		updateCheckout();

		const updateVisibility = () => {
			localField.hidden = source !== "local";
			githubField.hidden = source !== "github";
			if (syncButton) syncButton.hidden = source !== "github";
		};
		sourceSelect.addEventListener("change", () => {
			source = sourceSelect.value === "github" ? "github" : "local";
			updateVisibility();
		});
		updateVisibility();

		this.contentEl.createDiv({
			cls: "wb-agent-section-title",
			text: "Execution columns",
		});
		const runStateField = this.contentEl.createDiv({ cls: "wb-field" });
		runStateField.createDiv({ cls: "wb-field-label", text: "Execution columns" });
		const runStateRow = runStateField.createDiv({ cls: "wb-field-row" });
		const makeColumnSelect = (labelText: string, value: string | undefined, idPrefix: string) => {
			const label = runStateRow.createEl("label", {
				cls: "wb-field-hint",
				text: labelText,
			});
			const select = runStateRow.createEl("select", { cls: "wb-input" });
			select.createEl("option", { value: "", text: "Do not move" });
			for (const column of this.board.columns) {
				select.createEl("option", { value: column.id, text: column.name });
			}
			select.value = this.board.columns.some((column) => column.id === value)
				? (value ?? "")
				: "";
			label.htmlFor = select.id = `wb-agent-${idPrefix}-${Date.now()}`;
			return select;
		};
		const queuedSelect = makeColumnSelect(
			"Queue",
			this.board.agent?.runStateMapping?.queuedColumnId,
			"queued"
		);
		const runningSelect = makeColumnSelect(
			"Running",
			this.board.agent?.runStateMapping?.runningColumnId,
			"running"
		);
		runStateField.createDiv({
			cls: "wb-field-hint",
			text: "Drop a task into the queue column to enqueue it. Running is updated by the Runner; the Runner queue remains authoritative.",
		});

		const mappingField = this.contentEl.createDiv({ cls: "wb-field" });
		mappingField.createDiv({ cls: "wb-field-label", text: "Automatic column move" });
		const mappingRow = mappingField.createDiv({ cls: "wb-field-row" });
		const successLabel = mappingRow.createEl("label", {
			cls: "wb-field-hint",
			text: "On success",
		});
		const successSelect = mappingRow.createEl("select", { cls: "wb-input" });
		successSelect.createEl("option", { value: "", text: "Do not move" });
		for (const column of this.board.columns) {
			successSelect.createEl("option", { value: column.id, text: column.name });
		}
		const successValue = this.board.agent?.statusMapping?.successColumnId;
		successSelect.value = this.board.columns.some((column) => column.id === successValue)
			? (successValue ?? "")
			: "";
		successLabel.htmlFor = successSelect.id = `wb-agent-success-${Date.now()}`;

		const failureLabel = mappingRow.createEl("label", {
			cls: "wb-field-hint",
			text: "On failure",
		});
		const failureSelect = mappingRow.createEl("select", { cls: "wb-input" });
		failureSelect.createEl("option", { value: "", text: "Do not move" });
		for (const column of this.board.columns) {
			failureSelect.createEl("option", { value: column.id, text: column.name });
		}
		const failureValue = this.board.agent?.statusMapping?.failureColumnId;
		failureSelect.value = this.board.columns.some((column) => column.id === failureValue)
			? (failureValue ?? "")
			: "";
		failureLabel.htmlFor = failureSelect.id = `wb-agent-failure-${Date.now()}`;
		mappingField.createDiv({
			cls: "wb-field-hint",
			text: "Off by default. Cancelled runs are never moved.",
		});

		this.contentEl.createDiv({
			cls: "wb-agent-section-title",
			text: "Run isolation",
		});
		const worktreeField = this.contentEl.createDiv({ cls: "wb-field wb-checkbox-field" });
		const worktreeLabel = worktreeField.createEl("label", {
			cls: "wb-checkbox-label",
		});
		const worktreeInput = worktreeLabel.createEl("input", { type: "checkbox" });
		worktreeInput.checked = this.board.agent?.worktree === true;
		worktreeLabel.createSpan({ text: "Use a git worktree for each run" });
		worktreeField.createDiv({
			cls: "wb-field-hint",
			text: "Requires a clean git workspace. Creates branch wb/<runId> under the Runner's worktrees directory and enables parallel runs.",
		});

		const statusEl = this.contentEl.createDiv({ cls: "wb-agent-status" });
		const statusDot = statusEl.createSpan({ cls: "wb-agent-dot" });
		const statusText = statusEl.createSpan();
		const errorEl = this.contentEl.createDiv({ cls: "wb-form-error" });
		errorEl.hide();

		const setStatus = (text: string, state: "ok" | "error" | "checking") => {
			statusDot.className = `wb-agent-dot wb-agent-dot--${state}`;
			statusText.setText(text);
		};

		const showHealth = (health: typeof snapshot.health) => {
			if (health.status === "online") {
				const backendText = health.backends.length > 0
					? health.backends
							.map((backend) =>
								backend.available
									? `${backend.displayName} ${backend.version || "ready"}`
									: `${backend.displayName} unavailable`
							)
							.join(" · ")
					: "No execution backends";
				const ghText = health.gh
					? health.gh.available
						? ` · gh ${health.gh.version}`
						: " · gh unavailable"
					: "";
				setStatus(
					`Runner ${health.version || "online"} · ${backendText}${ghText}`,
					health.backends.some((backend) => backend.available) ? "ok" : "error"
				);
			} else {
				setStatus(health.error || "Runner offline", "error");
			}
		};
		showHealth(snapshot.health);
		if (snapshot.health.status === "unknown") {
			void this.agent.refreshHealth().then(() => showHealth(this.agent.getSnapshot().health));
		}

		const footer = this.contentEl.createDiv({ cls: "wb-modal-footer" });
		const helpButton = footer.createEl("button", {
			cls: "wb-button wb-button--ghost",
			text: "Help",
		});
		const testButton = footer.createEl("button", {
			cls: "wb-button",
			text: "Test connection",
		});
		const syncButtonEl = footer.createEl("button", {
			cls: "wb-button wb-button--ghost",
			text: "Sync GitHub",
		});
		syncButton = syncButtonEl;
		updateVisibility();
		const clearButton = footer.createEl("button", {
			cls: "wb-button wb-button--ghost",
			text: "Clear workspace",
		});
		footer.createDiv({ cls: "wb-spacer" });
		const cancelButton = footer.createEl("button", { cls: "wb-button", text: "Cancel" });
		const saveButton = footer.createEl("button", {
			cls: "wb-button wb-button--primary",
			text: "Save",
		});

		const setBusy = (busy: boolean) => {
			testButton.disabled = busy;
			syncButtonEl.disabled = busy;
			saveButton.disabled = busy;
			clearButton.disabled = busy;
		};
		const showError = (error: unknown) => {
			errorEl.setText(error instanceof Error ? error.message : String(error));
			errorEl.show();
		};

		helpButton.addEventListener("click", () => {
			const guide = this.app.vault.getAbstractFileByPath("Workbench/README.md");
			if (guide instanceof TFile) {
				void this.app.workspace.getLeaf("tab").openFile(guide);
				window.setTimeout(() => this.close(), 100);
			} else {
				new Notice("Workbench/README.md not found.");
			}
		});

		testButton.addEventListener("click", () => {
			errorEl.hide();
			setBusy(true);
			setStatus("Checking Runner…", "checking");
			void this.agent
				.checkConnection({
					runnerUrl: urlInput.value,
					runnerToken: tokenInput.value,
					cfAccessClientId: accessIdInput.value,
					cfAccessClientSecret: accessSecretInput.value,
					workspacePath: source === "local" ? localInput.value : undefined,
				})
				.then(({ health, workspace }) => {
					const backendText = health.backends
						.map((backend) =>
							backend.available
								? `${backend.displayName} ${backend.version || "ready"}`
								: `${backend.displayName} unavailable`
						)
						.join(" · ");
					const detail = workspace
						? ` · ${workspace.isGit ? `git:${workspace.branch || "detached"}` : "not a git repository"}`
						: "";
					const ghText = health.gh
						? health.gh.available
							? ` · gh ${health.gh.version}`
							: " · gh unavailable"
						: "";
					setStatus(
						`Runner ${health.version} · ${backendText}${ghText}${detail}`,
						health.backends.some((backend) => backend.available) ? "ok" : "error"
					);
					setBusy(false);
				})
				.catch((error) => {
					setStatus("Connection failed", "error");
					showError(error);
					setBusy(false);
				});
		});

		syncButton.addEventListener("click", () => {
			errorEl.hide();
			setBusy(true);
			setStatus("Syncing GitHub…", "checking");
			void (async () => {
				const repoUrl = repoInput.value.trim();
				if (!repoUrl) throw new Error("GitHub repository URL can't be empty.");
				const current = this.store
					.getSnapshot()
					.boards.find((candidate) => candidate.id === this.board.id);
				if (!current) throw new Error("The board is no longer available.");
				const result = await this.agent.syncGitHub(
					repoUrl,
					collectGitHubRefs(current)
				);
				const summary = importGitHubItems(this.store, current, result);
				await this.store.flush();
				const parts = [
					summary.imported > 0 ? `imported ${summary.imported}` : "",
					summary.updated > 0 ? `updated ${summary.updated}` : "",
					summary.moved > 0 ? `moved ${summary.moved} to Done` : "",
				].filter(Boolean);
				setStatus(
					parts.length > 0
						? `Synced ${result.repo}: ${parts.join(", ")}.`
						: `Synced ${result.repo}: already up to date.`,
					"ok"
				);
				new Notice(
					parts.length > 0
						? `GitHub sync: ${parts.join(", ")}.`
						: "GitHub sync: no changes."
				);
				setBusy(false);
			})().catch((error) => {
				setStatus("GitHub sync failed", "error");
				showError(error);
				setBusy(false);
			});
		});

		clearButton.addEventListener("click", () => {
			void this.agent
				.clearWorkspace(this.board.id)
				.then(() => {
					localInput.value = "";
					updateCheckout();
					checkoutEl.setText("Workspace cleared.");
				})
				.catch(showError);
		});

		cancelButton.addEventListener("click", () => this.close());
		saveButton.addEventListener("click", () => {
			errorEl.hide();
			setBusy(true);
			void (async () => {
				await this.agent.saveConnection({
					runnerUrl: urlInput.value,
					runnerToken: tokenInput.value,
					cfAccessClientId: accessIdInput.value,
					cfAccessClientSecret: accessSecretInput.value,
				});

				if (source === "local") {
					const path = localInput.value.trim();
					if (path) {
						await this.agent.bindWorkspace(this.board.id, path);
					} else {
						await this.agent.clearWorkspace(this.board.id);
					}
				} else {
					const repoUrl = repoInput.value.trim();
					if (!repoUrl) throw new Error("GitHub repository URL can't be empty.");
					await this.agent.cloneGithubWorkspace(
						this.board.id,
						repoUrl,
						branchInput.value
					);
				}

				const queuedColumnId = queuedSelect.value;
				const runningColumnId = runningSelect.value;
				if (queuedColumnId && queuedColumnId === runningColumnId) {
					throw new Error("Queue and Running columns must be different.");
				}

				const agentConfig: BoardAgentConfig = {};
				if (backendSelect.value) agentConfig.backend = backendSelect.value;
				if (source === "github") {
					agentConfig.github = {
						repoUrl: repoInput.value.trim(),
						branch: branchInput.value.trim(),
					};
				}
				const successColumnId = successSelect.value;
				const failureColumnId = failureSelect.value;
				if (successColumnId || failureColumnId) {
					agentConfig.statusMapping = {
						...(successColumnId ? { successColumnId } : {}),
						...(failureColumnId ? { failureColumnId } : {}),
					};
				}
				if (queuedColumnId || runningColumnId) {
					agentConfig.runStateMapping = {
						...(queuedColumnId ? { queuedColumnId } : {}),
						...(runningColumnId ? { runningColumnId } : {}),
					};
				}
				if (worktreeInput.checked) agentConfig.worktree = true;
				this.store.setBoardAgent(
					this.board.id,
					Object.keys(agentConfig).length > 0 ? agentConfig : undefined
				);
				new Notice(
					source === "github"
						? "GitHub workspace cloned and board agent settings saved."
						: "Board agent settings saved."
				);
				this.close();
			})().catch((error) => {
				showError(error);
				setBusy(false);
			});
		});
	}
}
