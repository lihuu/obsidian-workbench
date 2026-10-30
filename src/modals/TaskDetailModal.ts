import {
	App,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
} from "obsidian";
import type { Board, Task, TaskPatch } from "../data/types";
import type { AgentController } from "../agent/controller";
import {
	githubChecksLabel,
	githubRepoUrl,
	githubReviewLabel,
	githubStateLabel,
} from "../agent/github";
import {
	runHistoryLabel,
	runStatusLabel,
	selectDisplayedRun,
	summaryFirstLine,
} from "../agent/run-history";
import type { RunEvent, RunView } from "../agent/types";
import {
	canClearQueue as runCanClearQueue,
	canContinueRun as runCanContinue,
	canFollowUp as runCanFollowUp,
	canSteer as runCanSteer,
} from "../agent/capabilities";
import { ConfirmModal } from "./ConfirmModal";
import { GitHubCommentModal } from "./GitHubCommentModal";
import { NoteSuggestModal } from "./NoteSuggestModal";
import { openUrl } from "../ui/web-viewer";

export interface TaskDetailOptions {
	isNew?: boolean;
	onDiscard?: () => void;
}

export class TaskDetailModal extends Modal {
	private readonly task: Task;
	private readonly board: Board;
	private readonly agent: AgentController;
	private readonly onSave: (patch: TaskPatch) => void;
	private readonly onDelete: () => Promise<void> | void;
	private readonly onRunState: (run: RunView) => void;
	private readonly onMoveToDone: () => void;
	private readonly isNew: boolean;
	private readonly onDiscard?: () => void;
	private deleteArmed = false;
	private deleteTimer: number | undefined;
	private allowClose = false;
	private titleInput: HTMLInputElement | undefined;
	private descriptionInput: HTMLTextAreaElement | undefined;
	private errorEl: HTMLElement | undefined;
	private previewEl: HTMLElement | undefined;
	private previewButton: HTMLButtonElement | undefined;
	private linkButton: HTMLButtonElement | undefined;
	private previewComponent: Component | undefined;
	private previewTimer: number | undefined;
	private previewVisible = false;
	private unsubscribeAgent: (() => void) | undefined;
	private runStatusEl: HTMLElement | undefined;
	private runTitleEl: HTMLElement | undefined;
	private runMetaEl: HTMLElement | undefined;
	private runSessionEl: HTMLElement | undefined;
	private runWorktreeEl: HTMLElement | undefined;
	private runLogEl: HTMLPreElement | undefined;
	private runSummaryEl: HTMLPreElement | undefined;
	private runErrorEl: HTMLElement | undefined;
	private runHistoryEl: HTMLElement | undefined;
	private messageComposerEl: HTMLElement | undefined;
	private messageInputEl: HTMLTextAreaElement | undefined;
	private sendFollowUpButton: HTMLButtonElement | undefined;
	private sendSteerButton: HTMLButtonElement | undefined;
	private continueButton: HTMLButtonElement | undefined;
	private clearQueueButton: HTMLButtonElement | undefined;
	private messageErrorEl: HTMLElement | undefined;
	private sendingMessage = false;
	private runSelectionEl: HTMLElement | undefined;
	private runSelectionLabelEl: HTMLElement | undefined;
	private runButton: HTMLButtonElement | undefined;
	private abortButton: HTMLButtonElement | undefined;
	private contextButton: HTMLButtonElement | undefined;
	private cleanupButton: HTMLButtonElement | undefined;
	private contextEl: HTMLPreElement | undefined;
	private starting = false;
	private selectedRunId: string | null = null;
	private detailLoadingRunId: string | null = null;
	private detailError = "";
	private historyLoading = false;
	private historyError = "";
	private historySignature = "";
	private readonly runTimeFormatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

	constructor(
		app: App,
		task: Task,
		board: Board,
		agent: AgentController,
		onSave: (patch: TaskPatch) => void,
		onDelete: () => Promise<void> | void,
		onRunState: (run: RunView) => void,
		onMoveToDone: () => void,
		options: TaskDetailOptions = {}
	) {
		super(app);
		this.task = task;
		this.board = board;
		this.agent = agent;
		this.onSave = onSave;
		this.onDelete = onDelete;
		this.onRunState = onRunState;
		this.onMoveToDone = onMoveToDone;
		this.isNew = options.isNew === true;
		this.onDiscard = options.onDiscard;
	}

	onOpen(): void {
		this.setTitle(this.isNew ? "New task" : "Task details");
		this.modalEl.addClass("wb-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();

		const titleField = this.contentEl.createDiv({ cls: "wb-field" });
		const titleLabel = titleField.createEl("label", { cls: "wb-field-label", text: "Title" });
		const titleInput = titleField.createEl("input", { cls: "wb-input wb-title-input" });
		titleInput.type = "text";
		titleInput.value = this.task.title;
		titleInput.placeholder = "Task title";
		this.titleInput = titleInput;
		titleInput.id = `wb-task-title-${this.task.id}`;
		titleLabel.htmlFor = titleInput.id;

		const descriptionField = this.contentEl.createDiv({ cls: "wb-field" });
		const descriptionHeader = descriptionField.createDiv({ cls: "wb-field-header" });
		const descriptionLabel = descriptionHeader.createEl("label", {
			cls: "wb-field-label",
			text: "Description",
		});
		const descriptionActions = descriptionHeader.createDiv({ cls: "wb-field-actions" });
		const linkButton = descriptionActions.createEl("button", {
			cls: "wb-button wb-button--small",
			text: "Link note",
		});
		linkButton.type = "button";
		this.linkButton = linkButton;
		this.previewButton = descriptionActions.createEl("button", {
			cls: "wb-button wb-button--small",
			text: "Preview",
		});
		this.previewButton.type = "button";

		const descriptionInput = descriptionField.createEl("textarea", {
			cls: "wb-input wb-textarea",
		});
		descriptionInput.value = this.task.description;
		this.descriptionInput = descriptionInput;
		descriptionInput.id = `wb-task-description-${this.task.id}`;
		descriptionLabel.htmlFor = descriptionInput.id;

		const previewEl = descriptionField.createDiv({
			cls: "wb-markdown-preview markdown-rendered",
		});
		previewEl.hide();
		this.previewEl = previewEl;

		descriptionInput.addEventListener("input", () => {
			if (!this.previewVisible) return;
			if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
			this.previewTimer = window.setTimeout(() => this.renderPreview(), 150);
		});

		previewEl.addEventListener("click", (event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const link = target.closest("a.internal-link");
			if (!(link instanceof HTMLAnchorElement)) return;
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (!href) return;
			event.preventDefault();
			event.stopPropagation();
			void this.app.workspace.openLinkText(href, "", true);
			this.close();
		});

		linkButton.addEventListener("click", () => {
			new NoteSuggestModal(this.app, (file) => {
				if (this.previewVisible) this.setPreview(false);
				const textarea = this.descriptionInput;
				if (!textarea) return;

				const path = file.path.replace(/\.md$/i, "");
				const link = `[[${path}|${file.basename}]]`;
				const start = textarea.selectionStart ?? textarea.value.length;
				const end = textarea.selectionEnd ?? start;
				const before = textarea.value.slice(0, start);
				const after = textarea.value.slice(end);
				const prefix = before.length > 0 && !/\s$/.test(before) ? " " : "";
				const suffix = after.length > 0 && !/^\s/.test(after) ? " " : "";
				textarea.setRangeText(`${prefix}${link}${suffix}`, start, end, "end");
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
				textarea.focus();
			}).open();
		});

		this.previewButton.addEventListener("click", () => {
			this.setPreview(!this.previewVisible);
		});

		const errorEl = this.contentEl.createDiv({ cls: "wb-form-error" });
		errorEl.hide();
		this.errorEl = errorEl;

		const formatter = new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		});
		this.contentEl.createDiv({
			cls: "wb-meta",
			text: `Created ${formatter.format(new Date(this.task.createdAt))} · Updated ${formatter.format(new Date(this.task.updatedAt))}`,
		});

		this.renderGitHubSection();
		this.renderRunSection();

		const footer = this.contentEl.createDiv({ cls: "wb-modal-footer" });
		const deleteButton = footer.createEl("button", {
			cls: "wb-button wb-button--danger",
			text: "Delete",
		});
		footer.createDiv({ cls: "wb-spacer" });
		const cancelButton = footer.createEl("button", { cls: "wb-button", text: "Close" });
		const saveButton = footer.createEl("button", {
			cls: "wb-button wb-button--primary",
			text: "Save",
		});

		titleInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				this.close();
			}
		});

		deleteButton.addEventListener("click", () => {
			if (!this.deleteArmed) {
				this.deleteArmed = true;
				deleteButton.setText("Confirm delete");
				deleteButton.addClass("is-armed");
				this.deleteTimer = window.setTimeout(() => {
					this.deleteArmed = false;
					deleteButton.setText("Delete");
					deleteButton.removeClass("is-armed");
				}, 3000);
				return;
			}
			if (this.deleteTimer !== undefined) window.clearTimeout(this.deleteTimer);
			this.allowClose = true;
			void this.onDelete();
			super.close();
		});

		cancelButton.addEventListener("click", () => this.close());
		saveButton.addEventListener("click", () => {
			if (this.isNew && !(this.titleInput?.value.trim() ?? "")) {
				this.errorEl?.setText("Title can't be empty.");
				this.errorEl?.show();
				this.titleInput?.focus();
				return;
			}
			this.close();
		});

		this.setPreview(true);

		if (!Platform.isMobile) {
			window.setTimeout(() => {
				titleInput.focus();
				titleInput.select();
			}, 0);
		}
	}

	private renderGitHubSection(): void {
		const link = this.task.github;
		if (!link) return;
		const kind = link.type === "pull_request" ? "PR" : "issue";
		const section = this.contentEl.createDiv({ cls: "wb-github-section" });
		const header = section.createDiv({ cls: "wb-github-header" });
		header.createDiv({
			cls: "wb-github-title",
			text: `GitHub ${kind} #${link.number}`,
		});
		header.createSpan({
			cls: `wb-github-state wb-github-state--${link.state.toLowerCase()}`,
			text: githubStateLabel(link.state),
		});

		const meta = section.createDiv({ cls: "wb-github-meta" });
		meta.createDiv({ text: link.repo });
		if (link.author) meta.createDiv({ text: `@${link.author}` });
		if (link.labels && link.labels.length > 0) {
			meta.createDiv({ text: link.labels.join(", ") });
		}
		if (link.isDraft) meta.createDiv({ text: "Draft" });
		const checks = githubChecksLabel(link.checks);
		if (checks) meta.createDiv({ text: checks });
		const review = githubReviewLabel(link.reviewDecision);
		if (review) meta.createDiv({ text: review });
		if (link.mergedAt) meta.createDiv({ text: "Merged" });
		if (link.closedAt && link.state.toUpperCase() !== "MERGED") {
			meta.createDiv({ text: "Closed" });
		}

		const actions = section.createDiv({ cls: "wb-github-actions" });
		const openButton = actions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Open in browser",
		});
		openButton.addEventListener("click", () => openUrl(this.app, link.url));
		const commentButton = actions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Comment",
		});
		commentButton.addEventListener("click", () => {
			new GitHubCommentModal(this.app, link, async (body) => {
				await this.agent.commentGitHub(
					githubRepoUrl(link.repo),
					link.type,
					link.number,
					body
				);
			}).open();
		});
		if (link.state.toUpperCase() === "OPEN") {
			const closeButton = actions.createEl("button", {
				cls: "wb-button wb-button--danger wb-button--small",
				text: `Close ${kind}`,
			});
			closeButton.addEventListener("click", () => {
				new ConfirmModal(
					this.app,
					`Close ${kind} #${link.number}`,
					`Close ${link.repo}#${link.number} on GitHub? This uses your local gh login.`,
					"Close on GitHub",
					async () => {
						await this.agent.closeGitHub(
							githubRepoUrl(link.repo),
							link.type,
							link.number
						);
						this.onSave({
							github: {
								...link,
								state: "CLOSED",
								closedAt: new Date().toISOString(),
							},
						});
						this.onMoveToDone();
						new Notice(`Closed ${kind} #${link.number}.`);
						this.close();
					}
				).open();
			});
		}
		section.createDiv({
			cls: "wb-field-hint",
			text: "Open in browser uses Obsidian Web viewer when available; otherwise your system browser.",
		});
	}

	private renderRunSection(): void {
		const section = this.contentEl.createDiv({ cls: "wb-run-section" });
		const header = section.createDiv({ cls: "wb-run-header" });
		this.runTitleEl = header.createDiv({ cls: "wb-run-title", text: "Agent" });
		this.runStatusEl = header.createDiv({ cls: "wb-run-status" });

		const selection = section.createDiv({ cls: "wb-run-selection" });
		this.runSelectionEl = selection;
		this.runSelectionLabelEl = selection.createSpan({ cls: "wb-run-selection-label" });
		const latestButton = selection.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Back to latest",
		});
		selection.hidden = true;

		const actions = section.createDiv({ cls: "wb-run-actions" });
		this.runButton = actions.createEl("button", {
			cls: "wb-button wb-button--primary wb-button--small",
			text: "Run with agent",
		});
		this.abortButton = actions.createEl("button", {
			cls: "wb-button wb-button--small",
			text: "Abort",
		});
		this.contextButton = actions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Preview context",
		});
		this.cleanupButton = actions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Remove worktree",
		});
		this.cleanupButton.hidden = true;
		const historyHeader = section.createDiv({ cls: "wb-run-history-header" });
		historyHeader.createDiv({ cls: "wb-run-history-title", text: "Run history" });
		this.runHistoryEl = section.createDiv({ cls: "wb-run-history" });
		this.messageComposerEl = section.createDiv({ cls: "wb-run-message-composer" });
		this.messageInputEl = this.messageComposerEl.createEl("textarea", {
			cls: "wb-input wb-run-message-input",
			attr: { placeholder: "Follow up with agent…" },
		});
		const messageActions = this.messageComposerEl.createDiv({ cls: "wb-run-message-actions" });
		this.sendFollowUpButton = messageActions.createEl("button", {
			cls: "wb-button wb-button--primary wb-button--small",
			text: "Follow up",
		});
		this.sendSteerButton = messageActions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Steer",
		});
		this.continueButton = messageActions.createEl("button", {
			cls: "wb-button wb-button--primary wb-button--small",
			text: "Continue",
		});
		this.clearQueueButton = messageActions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Clear queue",
		});
		this.messageErrorEl = this.messageComposerEl.createDiv({ cls: "wb-form-error" });
		this.messageErrorEl.hidden = true;
		this.runMetaEl = section.createDiv({ cls: "wb-run-meta" });
		this.runSessionEl = section.createDiv({ cls: "wb-run-session" });
		this.runWorktreeEl = section.createDiv({ cls: "wb-run-worktree" });
		this.contextEl = section.createEl("pre", { cls: "wb-run-context" });
		this.contextEl.hide();
		this.runLogEl = section.createEl("pre", { cls: "wb-run-log" });
		this.runSummaryEl = section.createEl("pre", { cls: "wb-run-summary" });
		this.runErrorEl = section.createDiv({ cls: "wb-form-error" });

		this.runButton.addEventListener("click", () => void this.startRun());
		this.abortButton.addEventListener("click", () => void this.abortRun());
		this.contextButton.addEventListener("click", () => void this.previewContext());
		this.cleanupButton.addEventListener("click", () => void this.removeWorktree());
		this.sendFollowUpButton.addEventListener("click", () => void this.sendMessage("follow_up"));
		this.sendSteerButton.addEventListener("click", () => void this.sendMessage("steer"));
		this.continueButton.addEventListener("click", () => void this.sendContinue());
		this.clearQueueButton.addEventListener("click", () => void this.clearQueue());
		latestButton.addEventListener("click", () => {
			this.selectedRunId = null;
			this.detailError = "";
			this.updateRunUi();
		});

		this.unsubscribeAgent = this.agent.subscribe(() => this.updateRunUi());
		this.updateRunUi();
		void this.agent.refreshRunDetails(this.board.id, this.task.id);
		void this.loadTaskHistory();
	}

	private currentDescription(): string {
		return this.descriptionInput?.value ?? this.task.description;
	}

	private async startRun(): Promise<void> {
		if (this.starting) return;
		const title = this.titleInput?.value.trim() ?? this.task.title;
		if (!title) {
			this.errorEl?.setText("Title can't be empty.");
			this.errorEl?.show();
			return;
		}
		this.starting = true;
		this.updateRunUi();
		if (this.runErrorEl) this.runErrorEl.hidden = true;
		const description = this.currentDescription();
		try {
			if (title !== this.task.title || description !== this.task.description) {
				this.onSave({ title, description });
			}
			const run = await this.agent.startRun(
				this.board,
				{ ...this.task, title, description }
			);
			this.onRunState(run);
			this.selectedRunId = null;
			this.detailError = "";
		} catch (error) {
			this.runErrorEl?.setText(error instanceof Error ? error.message : String(error));
			if (this.runErrorEl) this.runErrorEl.hidden = false;
		} finally {
			this.starting = false;
			this.updateRunUi();
		}
	}

	private async previewContext(): Promise<void> {
		if (!this.titleInput || !this.contextEl) return;
		const title = this.titleInput.value.trim() || this.task.title;
		this.contextEl.hide();
		this.contextEl.setText("Building context…");
		this.contextEl.show();
		try {
			const context = await this.agent.buildContext(
				{ id: this.board.id, name: this.board.name },
				{ ...this.task, title, description: this.currentDescription() }
			);
			this.contextEl.setText(
				`${context.noteCount} linked note(s) · ${context.images.length} image(s)\n\n${context.prompt}`
			);
		} catch (error) {
			this.contextEl.setText(error instanceof Error ? error.message : String(error));
		}
	}

	private async sendMessage(mode: "steer" | "follow_up"): Promise<void> {
		if (!this.messageInputEl || this.sendingMessage) return;
		const message = this.messageInputEl.value.trim();
		if (!message) return;
		this.sendingMessage = true;
		if (this.messageErrorEl) this.messageErrorEl.hidden = true;
		this.updateMessageUi();
		try {
			await this.agent.sendRunMessage(
				this.board.id,
				this.task.id,
				message,
				mode
			);
			this.messageInputEl.value = "";
		} catch (error) {
			if (this.messageErrorEl) {
				this.messageErrorEl.setText(
					error instanceof Error ? error.message : String(error)
				);
				this.messageErrorEl.hidden = false;
			}
		} finally {
			this.sendingMessage = false;
			this.updateRunUi();
		}
	}

	private async sendContinue(): Promise<void> {
		if (!this.messageInputEl || this.sendingMessage) return;
		const message = this.messageInputEl.value.trim();
		if (!message) return;
		this.sendingMessage = true;
		if (this.messageErrorEl) this.messageErrorEl.hidden = true;
		this.updateMessageUi();
		try {
			const run = await this.agent.continueRun(
				this.board.id,
				this.task.id,
				message
			);
			this.onRunState(run);
			this.selectedRunId = null;
			this.messageInputEl.value = "";
		} catch (error) {
			if (this.messageErrorEl) {
				this.messageErrorEl.setText(
					error instanceof Error ? error.message : String(error)
				);
				this.messageErrorEl.hidden = false;
			}
		} finally {
			this.sendingMessage = false;
			this.updateRunUi();
		}
	}

	private async clearQueue(): Promise<void> {
		try {
			await this.agent.clearQueuedMessages(this.board.id, this.task.id);
		} catch (error) {
			if (this.messageErrorEl) {
				this.messageErrorEl.setText(
					error instanceof Error ? error.message : String(error)
				);
				this.messageErrorEl.hidden = false;
			}
		}
	}

	private async removeWorktree(): Promise<void> {
		const run = this.displayedRun().run;
		if (!run) return;
		if (this.cleanupButton) this.cleanupButton.disabled = true;
		try {
			await this.agent.cleanupRunWorktree(run.id);
		} catch (error) {
			this.detailError = error instanceof Error ? error.message : String(error);
			this.updateRunUi();
		}
	}

	private async abortRun(): Promise<void> {
		if (this.abortButton) this.abortButton.disabled = true;
		try {
			await this.agent.abortRun(this.board.id, this.task.id);
		} catch (error) {
			this.runErrorEl?.setText(error instanceof Error ? error.message : String(error));
			if (this.runErrorEl) this.runErrorEl.hidden = false;
		}
	}

	private async loadTaskHistory(): Promise<void> {
		this.historyLoading = true;
		this.historyError = "";
		this.updateRunUi();
		try {
			await this.agent.loadTaskHistory(this.board.id, this.task.id);
		} catch (error) {
			this.historyError = error instanceof Error ? error.message : String(error);
		} finally {
			this.historyLoading = false;
			this.updateRunUi();
		}
	}

	private selectRun(runId: string): void {
		const latest = this.agent.getRun(this.board.id, this.task.id);
		this.detailError = "";
		if (latest?.id === runId) {
			this.selectedRunId = null;
			this.updateRunUi();
			return;
		}
		this.selectedRunId = runId;
		this.updateRunUi();
		void this.loadSelectedRun(runId);
	}

	private async loadSelectedRun(runId: string): Promise<void> {
		if (this.agent.getRunDetail(runId)) return;
		this.detailLoadingRunId = runId;
		this.updateRunUi();
		try {
			await this.agent.loadRunDetail(runId);
		} catch (error) {
			this.detailError = `Couldn't load this run: ${
				error instanceof Error ? error.message : String(error)
			}`;
		} finally {
			if (this.detailLoadingRunId === runId) this.detailLoadingRunId = null;
			this.updateRunUi();
		}
	}

	private displayedRun(): ReturnType<typeof selectDisplayedRun> {
		const snapshot = this.agent.getSnapshot();
		return selectDisplayedRun({
			latest: this.agent.getRun(this.board.id, this.task.id),
			history: this.agent.getRunHistory(this.board.id, this.task.id),
			details: snapshot.runDetails,
			selectedRunId: this.selectedRunId,
			loadingRunId: this.detailLoadingRunId,
		});
	}

	private updateRunUi(): void {
		if (!this.runStatusEl) return;
		const workspace = this.agent.getSnapshot().settings.workspaces[this.board.id] ?? "";
		const latest = this.agent.getRun(this.board.id, this.task.id);
		const active = latest?.status === "queued" || latest?.status === "running";
		const displayed = this.displayedRun();
		const backendName = this.backendLabel(latest);

		if (this.runTitleEl) {
			this.runTitleEl.setText(`${backendName} agent`);
		}
		if (this.runButton) {
			this.runButton.disabled = !workspace || active || this.starting;
			this.runButton.setText(
				this.starting
					? "Starting…"
					: latest
						? "Run again"
						: `Run with ${backendName}`
			);
			this.runButton.title = workspace
				? ""
				: "Set a local workspace in the board header first.";
		}
		if (this.abortButton) {
			this.abortButton.hidden = !active;
			this.abortButton.disabled = !active || latest?.aborting === true;
			this.abortButton.setText(latest?.aborting ? "Cancelling…" : "Abort");
		}

		this.runStatusEl.className = "wb-run-status";
		if (!workspace) {
			this.runStatusEl.setText("No workspace");
			this.runStatusEl.addClass("wb-run-status--idle");
		} else if (this.starting) {
			this.runStatusEl.setText("Starting…");
			this.runStatusEl.addClass("wb-run-status--running");
		} else if (!latest) {
			this.runStatusEl.setText("Ready");
			this.runStatusEl.addClass("wb-run-status--idle");
		} else {
			this.runStatusEl.setText(
				latest.aborting && active
					? "Cancelling…"
					: latest.status === "queued"
						? "Queued…"
						: latest.status === "running"
							? "Running…"
							: latest.status === "succeeded"
								? "Succeeded"
								: latest.status === "cancelled"
									? "Cancelled"
									: "Failed"
			);
			this.runStatusEl.addClass(`wb-run-status--${latest.status}`);
		}

		if (this.runSelectionEl && this.runSelectionLabelEl) {
			const viewingEarlier =
				this.selectedRunId !== null && this.selectedRunId !== latest?.id;
			this.runSelectionEl.hidden = !viewingEarlier;
			if (viewingEarlier) {
				const selected = displayed.run;
				const when = selected
					? this.runTimeFormatter.format(new Date(selected.createdAt))
					: "an earlier run";
				const status = selected ? runStatusLabel(selected.status) : "Loading…";
				this.runSelectionLabelEl.setText(
					`Viewing earlier run · ${when} · ${status}`
				);
			}
		}

		this.updateHistoryUi(latest);

		if (this.runMetaEl) {
			this.runMetaEl.setText(
				workspace
					? workspace
					: "Set the board workspace from the header to enable runs."
			);
		}

		const run = displayed.run;
		if (this.runSessionEl) {
			const session = run?.sessionFile || run?.logPath || "";
			this.runSessionEl.hidden = !session;
			this.runSessionEl.setText(session ? `Session: ${session}` : "");
			this.runSessionEl.title = session;
		}
		if (this.runWorktreeEl) {
			const worktree = run?.worktreeRequested
				? run.worktreeRemoved
					? `Branch: ${run.branch} · worktree removed`
					: run.worktreePath
						? `Branch: ${run.branch} · ${run.worktreePath}`
						: "Worktree: created when the run starts"
				: run
					? "Direct run (no worktree)"
					: "";
			this.runWorktreeEl.hidden = !worktree;
			this.runWorktreeEl.setText(worktree);
			this.runWorktreeEl.title = run?.worktreePath ?? "";
		}
		this.updateMessageUi(displayed.viewingHistory);
		if (this.cleanupButton) {
			const removable =
				!!run?.worktreeRequested &&
				!run.worktreeRemoved &&
				!run.parentRunId &&
				run.status !== "queued" &&
				run.status !== "running" &&
				!run.aborting;
			this.cleanupButton.hidden = !removable;
			this.cleanupButton.disabled = !removable;
		}

		if (this.runLogEl) {
			const lines = run ? formatRunEvents(run.logs) : [];
			const stick =
				this.runLogEl.scrollTop + this.runLogEl.clientHeight >=
				this.runLogEl.scrollHeight - 16;
			this.runLogEl.setText(
				lines.length > 0
					? lines.join("\n")
					: displayed.loading
						? "Loading events…"
						: "No events yet."
			);
			this.runLogEl.hidden = !run;
			if (stick) this.runLogEl.scrollTop = this.runLogEl.scrollHeight;
		}

		if (this.runSummaryEl) {
			this.runSummaryEl.hidden = !run?.summary;
			this.runSummaryEl.setText(run?.summary ?? "");
		}

		if (this.runErrorEl) {
			const message =
				run?.pollError ||
				run?.error ||
				(displayed.viewingHistory ? this.detailError : "") ||
				"";
			this.runErrorEl.hidden = !message;
			this.runErrorEl.setText(message);
		}
		if (latest && latest.logs.length === 0 && !active) {
			void this.agent.refreshRunDetails(this.board.id, this.task.id);
		}
	}

	private updateMessageUi(viewingHistory = false): void {
		if (!this.messageComposerEl) return;
		const latest = this.agent.getRun(this.board.id, this.task.id);
		const canFollow = runCanFollowUp(latest);
		const canSteer = runCanSteer(latest);
		const canClear = runCanClearQueue(latest);
		const canContinue = runCanContinue(latest);
		const running = latest?.status === "running" && latest.aborting !== true;
		const visible = !viewingHistory && (canFollow || canSteer || canClear || canContinue);
		this.messageComposerEl.hidden = !visible;
		if (!visible) return;
		const busy = this.sendingMessage;
		if (this.messageInputEl) {
			const backendName = this.backendLabel(latest);
			this.messageInputEl.placeholder = running
				? canFollow
					? `Follow up with ${backendName}…`
					: canSteer
						? `Steer ${backendName}…`
						: "Clear queued messages above."
				: `Continue this ${backendName} session…`;
		}
		if (this.sendFollowUpButton) {
			this.sendFollowUpButton.hidden = !canFollow;
			this.sendFollowUpButton.disabled = busy;
		}
		if (this.sendSteerButton) {
			this.sendSteerButton.hidden = !canSteer;
			this.sendSteerButton.disabled = busy;
		}
		if (this.clearQueueButton) {
			this.clearQueueButton.hidden = !canClear;
			this.clearQueueButton.disabled = busy;
		}
		if (this.continueButton) {
			this.continueButton.hidden = !canContinue;
			this.continueButton.disabled = busy;
		}
	}

	private backendLabel(run: RunView | undefined): string {
		if (run?.backendName) return run.backendName;
		const health = this.agent.getSnapshot().health;
		const id = this.board.agent?.backend || health.defaultBackend;
		const backend = health.backends.find((entry) => entry.id === id);
		return backend?.displayName || (id ? id.toUpperCase() : "Agent");
	}

	private updateHistoryUi(latest: RunView | undefined): void {
		if (!this.runHistoryEl) return;
		const history = this.agent.getRunHistory(this.board.id, this.task.id);
		const selectedId = this.selectedRunId ?? latest?.id ?? "";
		const signature = [
			this.historyLoading ? "loading" : "",
			this.historyError,
			selectedId,
			this.detailLoadingRunId ?? "",
			...history.map(
				(run) =>
					`${run.id}:${run.status}:${run.createdAt}:${run.title}:${summaryFirstLine(run.summary)}`
			),
		].join("\n");
		if (signature === this.historySignature) return;
		this.historySignature = signature;
		this.runHistoryEl.empty();

		if (history.length === 0) {
			const empty = this.runHistoryEl.createDiv({
				cls: "wb-run-history-empty",
				text: this.historyLoading
					? "Loading runs…"
					: this.historyError
						? "Couldn't load run history."
						: "No runs yet.",
			});
			empty.title = this.historyError;
			return;
		}

		for (const run of history) {
			const selected = run.id === selectedId;
			const item = this.runHistoryEl.createEl("button", {
				cls: "wb-run-history-item",
			});
			item.type = "button";
			if (selected) item.addClass("is-selected");
			item.setAttr("aria-pressed", selected ? "true" : "false");
			const head = item.createDiv({ cls: "wb-run-history-head" });
			head.createSpan({
				cls: `wb-run-history-status wb-run-history-status--${run.status}`,
				text: runStatusLabel(run.status),
			});
			head.createSpan({
				cls: "wb-run-history-time",
				text: this.runTimeFormatter.format(new Date(run.createdAt)),
			});
			item.createDiv({
				cls: "wb-run-history-summary",
				text: runHistoryLabel(run),
			});
			item.addEventListener("click", () => this.selectRun(run.id));
		}
	}

	private setPreview(visible: boolean): void {
		if (!this.previewEl || !this.descriptionInput) return;
		this.previewVisible = visible;
		if (visible) {
			this.descriptionInput.hide();
			this.previewEl.show();
			this.previewButton?.setText("Edit");
			this.linkButton?.hide();
			this.renderPreview();
		} else {
			this.descriptionInput.show();
			this.previewEl.hide();
			this.previewButton?.setText("Preview");
			this.linkButton?.show();
			this.descriptionInput.focus();
		}
	}

	private renderPreview(): void {
		if (!this.previewEl) return;
		this.previewComponent?.unload();
		this.previewComponent = undefined;
		this.previewEl.empty();

		const markdown = this.descriptionInput?.value ?? "";
		if (!markdown.trim()) {
			this.previewEl.createDiv({
				cls: "wb-markdown-empty",
				text: "No description yet.",
			});
			return;
		}

		const component = new Component();
		component.load();
		this.previewComponent = component;
		void MarkdownRenderer.render(
			this.app,
			markdown,
			this.previewEl,
			"",
			component
		).catch(() => {
			this.previewEl?.createDiv({
				cls: "wb-form-error",
				text: "Couldn't render this description.",
			});
		});
	}

	override close(): void {
		if (this.allowClose) {
			super.close();
			return;
		}
		const title = this.titleInput?.value.trim() ?? this.task.title;
		if (!title) {
			if (this.isNew) {
				this.onDiscard?.();
				this.allowClose = true;
				super.close();
				return;
			}
			this.errorEl?.setText("Title can't be empty.");
			this.errorEl?.show();
			this.titleInput?.focus();
			return;
		}
		const description = this.descriptionInput?.value ?? this.task.description;
		if (title !== this.task.title || description !== this.task.description) {
			this.onSave({ title, description });
		}
		this.allowClose = true;
		super.close();
	}

	onClose(): void {
		if (this.deleteTimer !== undefined) {
			window.clearTimeout(this.deleteTimer);
			this.deleteTimer = undefined;
		}
		if (this.previewTimer !== undefined) {
			window.clearTimeout(this.previewTimer);
			this.previewTimer = undefined;
		}
		this.previewComponent?.unload();
		this.previewComponent = undefined;
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
	}
}

function formatRunEvents(events: RunEvent[]): string[] {
	const formatter = new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return events.slice(-300).map((event) => {
		const prefix =
			event.kind === "assistant"
				? "pi"
				: event.kind === "user"
					? `you:${event.mode ?? "follow_up"}`
					: event.kind;
		return `${formatter.format(new Date(event.at))} [${prefix}] ${event.text}`;
	});
}
