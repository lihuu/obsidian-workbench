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
import { runStatusLabel, selectDisplayedRun } from "../agent/run-history";
import type { RunView } from "../agent/types";
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
	private runErrorEl: HTMLElement | undefined;
	private chatEl: HTMLElement | undefined;
	private chatComponent: Component | undefined;
	private chatSignature = "";
	private historySelect: HTMLSelectElement | undefined;
	private messageComposerEl: HTMLElement | undefined;
	private messageInputEl: HTMLTextAreaElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private clearQueueButton: HTMLButtonElement | undefined;
	private messageErrorEl: HTMLElement | undefined;
	private sendingMessage = false;
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
		const headerRight = header.createDiv({ cls: "wb-run-header-right" });
		this.historySelect = headerRight.createEl("select", {
			cls: "wb-input wb-chat-history",
			attr: { "aria-label": "Run history" },
		});
		this.historySelect.hidden = true;
		this.historySelect.addEventListener("change", () => {
			const value = this.historySelect?.value ?? "";
			if (!value) {
				this.selectedRunId = null;
				this.detailError = "";
				this.updateRunUi();
				return;
			}
			this.selectRun(value);
		});
		this.runStatusEl = headerRight.createDiv({ cls: "wb-run-status" });
		this.runButton = headerRight.createEl("button", {
			cls: "wb-button wb-button--primary wb-button--small",
			text: "Run with agent",
		});
		this.abortButton = headerRight.createEl("button", {
			cls: "wb-button wb-button--small",
			text: "Abort",
		});

		const details = section.createEl("details", { cls: "wb-chat-details" });
		details.createEl("summary", { text: "Run details" });
		this.runMetaEl = details.createDiv({ cls: "wb-run-meta" });
		this.runSessionEl = details.createDiv({ cls: "wb-run-session" });
		this.runWorktreeEl = details.createDiv({ cls: "wb-run-worktree" });

		this.chatComponent = new Component();
		this.chatComponent.load();
		this.chatEl = section.createDiv({ cls: "wb-chat" });
		this.chatEl.setAttr("role", "log");
		this.chatEl.setAttr("aria-live", "polite");

		this.messageComposerEl = section.createDiv({ cls: "wb-chat-composer" });
		const composerRow = this.messageComposerEl.createDiv({ cls: "wb-chat-composer-row" });
		this.messageInputEl = composerRow.createEl("textarea", {
			cls: "wb-input wb-chat-input",
			attr: { placeholder: "Message agent…" },
		});
		this.sendButton = composerRow.createEl("button", {
			cls: "wb-button wb-button--primary wb-chat-send",
			text: "Send",
		});
		const composerActions = this.messageComposerEl.createDiv({
			cls: "wb-chat-composer-actions",
		});
		this.clearQueueButton = composerActions.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Clear queue",
		});
		this.messageErrorEl = this.messageComposerEl.createDiv({ cls: "wb-form-error" });
		this.messageErrorEl.hidden = true;

		const tools = section.createDiv({ cls: "wb-chat-tools" });
		this.contextButton = tools.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Preview context",
		});
		this.cleanupButton = tools.createEl("button", {
			cls: "wb-button wb-button--ghost wb-button--small",
			text: "Remove worktree",
		});
		this.cleanupButton.hidden = true;
		this.contextEl = section.createEl("pre", { cls: "wb-run-context" });
		this.contextEl.hide();
		this.runErrorEl = section.createDiv({ cls: "wb-form-error" });
		this.runErrorEl.hidden = true;

		this.runButton.addEventListener("click", () => void this.startRun());
		this.abortButton.addEventListener("click", () => void this.abortRun());
		this.contextButton.addEventListener("click", () => void this.previewContext());
		this.cleanupButton.addEventListener("click", () => void this.removeWorktree());
		this.sendButton.addEventListener("click", () => void this.sendChat());
		this.clearQueueButton.addEventListener("click", () => void this.clearQueue());
		this.messageInputEl.addEventListener("keydown", (event) => {
			if (
				event.key === "Enter" &&
				!event.shiftKey &&
				!event.isComposing &&
				event.keyCode !== 229
			) {
				event.preventDefault();
				void this.sendChat();
			}
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

		this.updateChatUi(run, displayed.viewingHistory);

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
		const canSend = canFollow || canSteer || canContinue;
		const visible = !viewingHistory && (canSend || canClear);
		this.messageComposerEl.hidden = !visible;
		if (!visible) return;
		const busy = this.sendingMessage;
		const backendName = this.backendLabel(latest);
		if (this.messageInputEl) {
			this.messageInputEl.hidden = !canSend;
			this.messageInputEl.placeholder =
				latest?.status === "running" && latest.aborting !== true
					? canFollow
						? `Message ${backendName}…`
						: canSteer
							? `Steer ${backendName}…`
							: ""
					: `Continue this ${backendName} session…`;
		}
		if (this.sendButton) {
			this.sendButton.hidden = !canSend;
			this.sendButton.disabled = busy;
		}
		if (this.clearQueueButton) {
			this.clearQueueButton.hidden = !canClear;
			this.clearQueueButton.disabled = busy;
		}
	}

	private async sendChat(): Promise<void> {
		if (!this.messageInputEl || this.sendingMessage) return;
		const message = this.messageInputEl.value.trim();
		if (!message) return;
		const latest = this.agent.getRun(this.board.id, this.task.id);
		if (!latest) return;
		this.sendingMessage = true;
		if (this.messageErrorEl) this.messageErrorEl.hidden = true;
		this.updateMessageUi();
		try {
			if (latest.status === "running" && latest.aborting !== true) {
				const mode = runCanFollowUp(latest)
					? "follow_up"
					: runCanSteer(latest)
						? "steer"
						: null;
				if (!mode) throw new Error("This backend is not accepting messages.");
				await this.agent.sendRunMessage(
					this.board.id,
					this.task.id,
					message,
					mode
				);
			} else if (runCanContinue(latest)) {
				const run = await this.agent.continueRun(
					this.board.id,
					this.task.id,
					message
				);
				this.onRunState(run);
				this.selectedRunId = null;
			} else {
				return;
			}
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

	private updateChatUi(run: RunView | undefined, viewingHistory: boolean): void {
		if (!this.chatEl) return;
		const events = run?.logs ?? [];
		const lastSeq = events.at(-1)?.seq ?? 0;
		const signature = [
			run?.id ?? "",
			run?.status ?? "",
			run?.error ?? "",
			viewingHistory ? "history" : "latest",
			this.task.title,
			this.task.description,
			events.length,
			lastSeq,
		].join("\n");
		if (signature === this.chatSignature) return;
		this.chatSignature = signature;
		const stick =
			this.chatEl.scrollTop + this.chatEl.clientHeight >=
			this.chatEl.scrollHeight - 24;
		this.chatEl.empty();

		if (!run) {
			this.chatEl.createDiv({
				cls: "wb-chat-empty",
				text: "No conversation yet. Start a run to talk to the agent.",
			});
			return;
		}

		const description = this.task.description.trim();
		const prompt =
			description && description !== this.task.title
				? description.startsWith(this.task.title)
					? description
					: `${this.task.title}\n\n${description}`
				: this.task.title;
		this.appendChatMessage("user", "You", prompt);
		let toolLines: string[] = [];
		let lastError = "";
		const flushTools = () => {
			if (!this.chatEl || toolLines.length === 0) return;
			const details = this.chatEl.createEl("details", {
				cls: "wb-chat-activity",
			});
			details.createEl("summary", {
				text: `Tool activity · ${toolLines.length} step${
					toolLines.length === 1 ? "" : "s"
				}`,
			});
			details.createEl("pre", { text: toolLines.join("\n") });
			toolLines = [];
		};
		for (const event of events) {
			if (event.kind === "status") continue;
			if (
				event.kind === "log" &&
				/^(Turn started|Agent started|Queued|Abort requested|Succeeded|Failed|Cancelled)\.?$/.test(
					event.text.trim()
				)
			) {
				continue;
			}
			if (event.kind === "tool") {
				toolLines.push(event.text);
				continue;
			}
			flushTools();
			if (event.kind === "assistant") {
				this.appendChatMessage("assistant", this.backendLabel(run), event.text, true);
			} else if (event.kind === "user") {
				const label = event.mode === "steer" ? "You · steer" : "You";
				this.appendChatMessage("user", label, event.text);
			} else if (event.kind === "error") {
				lastError = event.text;
				this.appendChatMessage("error", "Error", event.text);
			} else if (event.kind === "log") {
				this.appendChatMessage("log", "Log", event.text);
			}
		}
		flushTools();
		const error = run.pollError || run.error;
		if (error && error !== lastError) this.appendChatMessage("error", "Error", error);
		if (stick) {
			requestAnimationFrame(() => {
				if (this.chatEl) this.chatEl.scrollTop = this.chatEl.scrollHeight;
			});
		}
	}

	private appendChatMessage(
		kind: "user" | "assistant" | "error" | "log",
		role: string,
		text: string,
		markdown = false
	): void {
		if (!this.chatEl || !text.trim()) return;
		const message = this.chatEl.createDiv({
			cls: `wb-chat-msg wb-chat-msg--${kind}`,
		});
		message.createDiv({ cls: "wb-chat-role", text: role });
		const body = message.createDiv({ cls: "wb-chat-bubble" });
		if (markdown && this.chatComponent) {
			body.addClass("markdown-rendered");
			void MarkdownRenderer.render(
				this.app,
				text,
				body,
				"",
				this.chatComponent
			);
		} else {
			body.setText(text);
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
		if (!this.historySelect) return;
		const history = this.agent.getRunHistory(this.board.id, this.task.id);
		const selectedId = this.selectedRunId ?? "";
		const signature = [
			this.historyLoading ? "loading" : "",
			this.historyError,
			selectedId,
			this.detailLoadingRunId ?? "",
			...history.map(
				(run) => `${run.id}:${run.status}:${run.createdAt}`
			),
		].join("\n");
		if (signature === this.historySignature) return;
		this.historySignature = signature;
		this.historySelect.empty();
		this.historySelect.createEl("option", { value: "", text: "Latest" });
		for (const run of history.slice(0, 20)) {
			this.historySelect.createEl("option", {
				value: run.id,
				text: `${runStatusLabel(run.status)} · ${this.runTimeFormatter.format(new Date(run.createdAt))}`,
			});
		}
		this.historySelect.value = selectedId;
		this.historySelect.hidden = history.length === 0;
		this.historySelect.title = this.historyError || "";
		if (latest && !history.some((run) => run.id === latest.id)) {
			this.historySelect.hidden = false;
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
		this.chatComponent?.unload();
		this.chatComponent = undefined;
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
	}
}

