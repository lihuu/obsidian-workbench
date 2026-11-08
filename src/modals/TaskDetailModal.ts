import {
	App,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
	setIcon,
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
	buildRunChain,
	extractSessionUserMessages,
	formatRunDuration,
	parseToolSteps,
	runStatusLabel,
	summaryFirstLine,
} from "../agent/run-history";
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
	private isNew: boolean;
	private readonly onDiscard?: () => void;
	private saved = false;
	private deleteArmed = false;
	private deleteTimer: number | undefined;
	private allowClose = false;
	private titleInput: HTMLInputElement | undefined;
	private titleErrorEl: HTMLElement | undefined;
	private saveButton: HTMLButtonElement | undefined;
	private backendSelect: HTMLSelectElement | undefined;
	private selectedBackend: string | undefined;
	private descriptionInput: HTMLTextAreaElement | undefined;
	private errorEl: HTMLElement | undefined;
	private descFold: HTMLDetailsElement | undefined;
	private userToggledDesc = false;
	private previewEl: HTMLElement | undefined;
	private previewButton: HTMLButtonElement | undefined;
	private linkButton: HTMLButtonElement | undefined;
	private previewComponent: Component | undefined;
	private previewTimer: number | undefined;
	private previewVisible = false;
	private unsubscribeAgent: (() => void) | undefined;
	private runStatusEl: HTMLElement | undefined;
	private runTitleEl: HTMLElement | undefined;
	private runDurationEl: HTMLElement | undefined;
	private runArtifactsEl: HTMLElement | undefined;
	private runErrorEl: HTMLElement | undefined;
	private chatEl: HTMLElement | undefined;
	private chatComponent: Component | undefined;
	private chatSignature = "";
	private messageComposerEl: HTMLElement | undefined;
	private archivedBannerEl: HTMLElement | undefined;
	private messageInputEl: HTMLTextAreaElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private clearQueueButton: HTMLButtonElement | undefined;
	private messageErrorEl: HTMLElement | undefined;
	private sendingMessage = false;
	private runButton: HTMLButtonElement | undefined;
	private abortButton: HTMLButtonElement | undefined;
	private starting = false;
	private detailError = "";
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
		this.selectedBackend = task.backend;
	}

	onOpen(): void {
		this.setTitle(this.isNew ? "New task" : "Task details");
		this.modalEl.addClass("wb-modal");
		this.modalEl.addClass("wb-task-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();
		this.modalEl.querySelectorAll(".wb-modal-footer").forEach((el) => el.remove());

		const titleField = this.contentEl.createDiv({ cls: "wb-field wb-field--title" });
		const titleLabel = titleField.createEl("label", { cls: "wb-field-label", text: "Title" });
		const titleInput = titleField.createEl("input", { cls: "wb-input wb-title-input" });
		titleInput.type = "text";
		titleInput.value = this.isNew && this.task.title === "Untitled task" ? "" : this.task.title;
		titleInput.placeholder = "Task title";
		this.titleInput = titleInput;
		titleInput.id = `wb-task-title-${this.task.id}`;
		titleLabel.htmlFor = titleInput.id;

		const titleErrorEl = titleField.createDiv({ cls: "wb-form-error" });
		titleErrorEl.hide();
		this.titleErrorEl = titleErrorEl;

		titleInput.addEventListener("input", () => {
			this.updateTitleValidation();
		});

		const hasRuns =
			!!this.agent.getRun(this.board.id, this.task.id) ||
			(this.agent.getRunHistory(this.board.id, this.task.id)?.length ?? 0) > 0;
		const descFold = this.contentEl.createEl("details", { cls: "wb-task-desc-fold" });
		this.descFold = descFold;
		descFold.addEventListener("toggle", () => {
			this.userToggledDesc = true;
		});
		if (!hasRuns) {
			descFold.open = true;
		}
		const descSummary = descFold.createEl("summary", { cls: "wb-task-desc-summary" });
		const descChevron = descSummary.createSpan({ cls: "wb-task-desc-chevron" });
		setIcon(descChevron, "chevron-right");
		descSummary.createSpan({ cls: "wb-task-desc-title", text: "Description" });
		const descHint = descSummary.createSpan({
			cls: "wb-task-desc-hint",
			text: summaryFirstLine(this.task.description),
		});

		const descriptionField = descFold.createDiv({ cls: "wb-task-desc-body wb-field" });
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
			descHint.setText(summaryFirstLine(descriptionInput.value));
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

		const footer = this.modalEl.createDiv({ cls: "wb-modal-footer" });
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
		this.saveButton = saveButton;

		if (this.isNew) {
			deleteButton.style.display = "none";
			cancelButton.setText("Cancel");
			saveButton.setText("Create task");
		}

		titleInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				if (!this.updateTitleValidation()) {
					this.titleInput?.focus();
					return;
				}
				this.saved = true;
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

		cancelButton.addEventListener("click", () => {
			if (this.isNew) {
				this.onDiscard?.();
				this.allowClose = true;
				super.close();
				return;
			}
			this.close();
		});
		saveButton.addEventListener("click", () => {
			if (!this.updateTitleValidation()) {
				this.titleInput?.focus();
				return;
			}
			this.saved = true;
			this.close();
		});

		this.updateTitleValidation();

		const hasDescription = Boolean(this.task.description && this.task.description.trim().length > 0);
		this.setPreview(hasDescription, false);

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
		const headerLeft = header.createDiv({ cls: "wb-run-header-left" });
		this.runTitleEl = headerLeft.createDiv({ cls: "wb-run-title", text: "Agent" });
		this.runDurationEl = headerLeft.createDiv({
			cls: "wb-artifact-pill wb-artifact-pill--duration",
		});
		this.runDurationEl.hidden = true;
		const headerRight = header.createDiv({ cls: "wb-run-header-right" });

		const backendSelect = headerRight.createEl("select", {
			cls: "wb-input wb-run-backend-select",
			attr: { "aria-label": "Execution backend" },
		});
		this.backendSelect = backendSelect;
		backendSelect.addEventListener("change", () => {
			this.selectedBackend = backendSelect.value;
			this.task.backend = this.selectedBackend;
			this.onSave({ backend: this.selectedBackend });
			this.updateRunUi();
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

		this.runArtifactsEl = section.createDiv({ cls: "wb-run-artifacts" });
		this.runArtifactsEl.hidden = true;

		const chatBox = section.createDiv({ cls: "wb-chat-box" });

		this.chatComponent = new Component();
		this.chatComponent.load();
		this.chatEl = chatBox.createDiv({ cls: "wb-chat" });
		this.chatEl.setAttr("role", "log");
		this.chatEl.setAttr("aria-live", "polite");

		this.messageComposerEl = chatBox.createDiv({ cls: "wb-chat-composer" });
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

		this.archivedBannerEl = chatBox.createDiv({ cls: "wb-chat-archived-banner" });
		const bannerLeft = this.archivedBannerEl.createDiv({ cls: "wb-chat-archived-text" });
		const archiveIcon = bannerLeft.createSpan({ cls: "wb-chat-archived-icon" });
		setIcon(archiveIcon, "archive");
		bannerLeft.createSpan({ text: "Worktree removed · Session closed" });
		const newRunBtn = this.archivedBannerEl.createEl("button", {
			cls: "wb-button wb-button--primary wb-button--small",
			text: "Start new run",
		});
		newRunBtn.addEventListener("click", () => void this.startRun());
		this.archivedBannerEl.hidden = true;

		this.runErrorEl = section.createDiv({ cls: "wb-form-error" });
		this.runErrorEl.hidden = true;

		this.runButton.addEventListener("click", () => void this.startRun());
		this.abortButton.addEventListener("click", () => void this.abortRun());
		this.sendButton.addEventListener("click", () => void this.sendChat());
		this.clearQueueButton.addEventListener("click", () => void this.clearQueue());
		this.messageInputEl.addEventListener("input", () => {
			if (!this.messageInputEl) return;
			this.messageInputEl.style.height = "auto";
			this.messageInputEl.style.height = `${Math.min(this.messageInputEl.scrollHeight, 120)}px`;
		});
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

	private updateTitleValidation(): boolean {
		const rawTitle = this.titleInput?.value ?? "";
		const trimmedTitle = rawTitle.trim();
		const isValid = trimmedTitle.length > 0;

		if (this.saveButton) {
			this.saveButton.disabled = !isValid;
		}

		if (!isValid) {
			this.titleInput?.addClass("is-invalid");
			this.titleErrorEl?.setText("Title can't be empty.");
			this.titleErrorEl?.show();
		} else {
			this.titleInput?.removeClass("is-invalid");
			this.titleErrorEl?.setText("");
			this.titleErrorEl?.hide();
			if (this.errorEl && this.errorEl.getText() === "Title can't be empty.") {
				this.errorEl.setText("");
				this.errorEl.hide();
			}
		}

		if (this.runButton) {
			this.updateRunUi();
		}

		return isValid;
	}

	private populateBackendOptions(): void {
		if (!this.backendSelect) return;
		const health = this.agent.getSnapshot().health;
		const knownBackends =
			health.backends.length > 0
				? health.backends
				: [
						{ id: "pi", displayName: "Pi", available: true },
						{ id: "omp", displayName: "OMP", available: true },
						{ id: "opencode", displayName: "OpenCode", available: true },
					];

		const currentId = this.currentBackendId();
		const currentOptions = Array.from(this.backendSelect.options)
			.map((o) => o.value)
			.join(",");
		const targetOptions = [
			...knownBackends.map((b) => b.id),
			!knownBackends.some((b) => b.id === currentId) && currentId ? currentId : null,
		]
			.filter(Boolean)
			.join(",");

		if (currentOptions !== targetOptions) {
			this.backendSelect.empty();
			for (const backend of knownBackends) {
				const opt = this.backendSelect.createEl("option", {
					value: backend.id,
					text: backend.displayName,
				});
				if (!backend.available) {
					opt.text += " (unavailable)";
				}
			}

			if (currentId && !knownBackends.some((b) => b.id === currentId)) {
				this.backendSelect.createEl("option", {
					value: currentId,
					text: currentId.toUpperCase(),
				});
			}
		}
		this.backendSelect.value = currentId;
	}

	private selectedBackendLabel(): string {
		const id = this.currentBackendId();
		const health = this.agent.getSnapshot().health;
		const backend = health.backends.find((entry) => entry.id === id);
		return backend?.displayName || (id ? id.toUpperCase() : "Agent");
	}

	private currentBackendId(): string {
		if (this.selectedBackend) return this.selectedBackend;
		if (this.task.backend) return this.task.backend;
		const latest = this.agent.getRun(this.board.id, this.task.id);
		if (latest?.backendId) return latest.backendId;
		const health = this.agent.getSnapshot().health;
		return (
			this.board.agent?.backend ||
			health.defaultBackend ||
			"pi"
		);
	}

	private async startRun(): Promise<void> {
		if (this.starting) return;
		const title = this.titleInput?.value.trim() ?? "";
		if (!title) {
			this.updateTitleValidation();
			this.titleInput?.focus();
			return;
		}
		this.starting = true;
		this.updateRunUi();
		if (this.runErrorEl) this.runErrorEl.hidden = true;
		const description = this.currentDescription();
		const backend = this.currentBackendId();
		try {
			if (this.isNew) {
				this.saved = true;
				this.isNew = false;
			}
			const patch: TaskPatch = {};
			if (title !== this.task.title) patch.title = title;
			if (description !== this.task.description) patch.description = description;
			if (backend !== this.task.backend) patch.backend = backend;
			if (Object.keys(patch).length > 0 || this.saved) {
				this.onSave(patch);
			}
			this.task.title = title;
			this.task.description = description;
			if (backend) this.task.backend = backend;
			const latest = this.agent.getRun(this.board.id, this.task.id);
			const isSameBackend = !latest || latest.backendId === backend;
			if (latest?.status === "failed" && runCanContinue(latest) && isSameBackend) {
				const promptMsg = latest.error?.includes("timed out")
					? "The run timed out. Please resume and continue where you left off to complete the task."
					: "Please continue and complete the remaining steps of this task.";
				const run = await this.agent.continueRun(this.board.id, this.task.id, promptMsg);
				this.onRunState(run);
			} else {
				const run = await this.agent.startRun(
					this.board,
					{ ...this.task, title, description, backend }
				);
				this.onRunState(run);
			}
			this.detailError = "";
		} catch (error) {
			this.runErrorEl?.setText(error instanceof Error ? error.message : String(error));
			if (this.runErrorEl) this.runErrorEl.hidden = false;
		} finally {
			this.starting = false;
			this.updateRunUi();
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
			this.messageInputEl.style.height = "";
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
			this.messageInputEl.value = "";
			this.messageInputEl.style.height = "";
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

	private async removeWorktree(targetRunId?: string): Promise<void> {
		const displayed = this.displayedRun().run;
		if (!displayed) return;
		const chain = this.getRunChain(displayed);
		const rootRun = chain[0] ?? displayed;
		const runIdToClean = targetRunId || rootRun.id;
		new ConfirmModal(
			this.app,
			"Remove worktree",
			"Are you sure you want to remove the worktree directory? The active workspace will be deleted and this session will be archived.",
			"Remove",
			async () => {
				try {
					await this.agent.cleanupRunWorktree(runIdToClean);
					new Notice("Worktree removed.");
					this.updateRunUi();
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					new Notice(`Failed to remove worktree: ${msg}`);
					this.detailError = msg;
					this.updateRunUi();
				}
			}
		).open();
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
		try {
			await this.agent.loadTaskHistory(this.board.id, this.task.id);
		} catch {
			// History remains usable without full history fetch
		} finally {
			this.updateRunUi();
		}
	}

	private readonly loadingDetailRunIds = new Set<string>();
	private readonly sessionUserMessagesCache = new Map<string, { mtime: number; messages: string[] }>();

	private async loadRunDetailIfNeeded(runId: string): Promise<void> {
		if (this.loadingDetailRunIds.has(runId)) return;
		if (this.agent.getRunDetail(runId)) return;
		this.loadingDetailRunIds.add(runId);
		try {
			await this.agent.loadRunDetail(runId);
		} catch {
			// Handled gracefully; minimal run view or summary used
		} finally {
			this.loadingDetailRunIds.delete(runId);
		}
	}

	private getSessionUserMessages(sessionFile: string): string[] {
		if (!sessionFile) return [];
		try {
			const fs = (window as any).require ? (window as any).require("fs") : null;
			if (!fs || !fs.existsSync(sessionFile)) return [];
			const stat = fs.statSync(sessionFile);
			const cached = this.sessionUserMessagesCache.get(sessionFile);
			if (cached && cached.mtime === stat.mtimeMs) {
				return cached.messages;
			}
			const content = fs.readFileSync(sessionFile, "utf-8");
			const messages = extractSessionUserMessages(content);
			this.sessionUserMessagesCache.set(sessionFile, { mtime: stat.mtimeMs, messages });
			return messages;
		} catch {
			return [];
		}
	}

	private getRunChain(displayedRun: RunView | undefined): RunView[] {
		if (!displayedRun) return [];
		const history = this.agent.getRunHistory(this.board.id, this.task.id);
		const latest = this.agent.getRun(this.board.id, this.task.id);
		const snapshot = this.agent.getSnapshot();
		const ancestors = buildRunChain(displayedRun, history);

		return ancestors.map((ancestor) => {
			if (latest && ancestor.id === latest.id) {
				return latest;
			}
			const detail = snapshot.runDetails[ancestor.id];
			if (detail) {
				return detail;
			}
			void this.loadRunDetailIfNeeded(ancestor.id);
			return {
				...ancestor,
				logs: [],
				nextCursor: 0,
				pollError: "",
			};
		});
	}

	private displayedRun(): { run: RunView | undefined; viewingHistory: boolean } {
		return {
			run: this.agent.getRun(this.board.id, this.task.id),
			viewingHistory: false,
		};
	}

	private updateRunUi(): void {
		if (!this.runStatusEl) return;
		const workspace = this.agent.getSnapshot().settings.workspaces[this.board.id] ?? "";
		const latest = this.agent.getRun(this.board.id, this.task.id);
		const active = latest?.status === "queued" || latest?.status === "running";
		const displayed = this.displayedRun();
		const worktreeRemoved = Boolean(latest?.worktreeRequested && latest?.worktreeRemoved);
		const selectedBackendId = this.currentBackendId();
		const backendName = this.selectedBackendLabel();
		const isSameBackend = !latest || latest.backendId === selectedBackendId;

		if (this.backendSelect) {
			this.populateBackendOptions();
			this.backendSelect.value = selectedBackendId;
			this.backendSelect.disabled = active || this.starting;
			this.backendSelect.title = active
				? "Cannot change backend while task is running"
				: "Select execution backend for this task";
		}

		if (this.runTitleEl) {
			this.runTitleEl.setText(`${backendName} agent`);
		}
		if (this.runButton) {
			const hasTitle = (this.titleInput?.value.trim() ?? this.task.title).length > 0;
			const isRepeatable = (this.task as any).repeatable === true || (this.task as any).type === "recurring";
			const canRetry = latest?.status === "failed";
			const shouldShow =
				!latest ||
				this.starting ||
				!isSameBackend ||
				isRepeatable ||
				canRetry ||
				worktreeRemoved;
			this.runButton.hidden = !shouldShow;
			this.runButton.disabled = !workspace || active || this.starting || !hasTitle;
			const canResume = canRetry && runCanContinue(latest) && isSameBackend;
			this.runButton.setText(
				this.starting
					? "Starting…"
					: !isSameBackend
						? `Run with ${backendName}`
						: isRepeatable && latest
							? "Run again"
							: canResume
								? "Resume & Retry"
								: canRetry
									? "Retry"
									: worktreeRemoved
										? "Start new run"
										: `Run with ${backendName}`
			);
			this.runButton.title = !hasTitle
				? "Title can't be empty."
				: !workspace
					? "Set a local workspace in the board header first."
					: canResume
						? "Resume the previous session and continue execution"
						: "";
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


		const chain = this.getRunChain(displayed.run);
		const leafRun = chain.at(-1) ?? displayed.run;
		const rootRun = chain[0] ?? displayed.run;

		if (this.descFold && !this.userToggledDesc && leafRun) {
			this.descFold.open = false;
		}
		this.renderRunArtifacts(leafRun, rootRun);
		this.updateMessageUi(displayed.viewingHistory);
		this.updateChatUi(chain, displayed.viewingHistory);

		if (latest && latest.logs.length === 0 && !active) {
			void this.agent.refreshRunDetails(this.board.id, this.task.id);
		}
	}

	private updateMessageUi(viewingHistory = false): void {
		const latest = this.agent.getRun(this.board.id, this.task.id);
		const isWorktreeRemoved = Boolean(latest?.worktreeRequested && latest?.worktreeRemoved);

		if (this.archivedBannerEl) {
			this.archivedBannerEl.hidden = viewingHistory || !isWorktreeRemoved;
		}

		if (!this.messageComposerEl) return;

		if (isWorktreeRemoved) {
			this.messageComposerEl.hidden = true;
			return;
		}

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
			} else {
				return;
			}
			this.messageInputEl.value = "";
			this.messageInputEl.style.height = "";
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

	private renderRunArtifacts(run: RunView | undefined, rootRun?: RunView): void {
		if (this.runDurationEl) {
			this.runDurationEl.empty();
			const duration = run ? formatRunDuration(run.startedAt, run.endedAt) : "";
			if (duration) {
				const durIcon = this.runDurationEl.createSpan({ cls: "wb-artifact-icon" });
				setIcon(durIcon, "clock");
				this.runDurationEl.createSpan({ cls: "wb-artifact-label", text: duration });
				this.runDurationEl.title = run?.endedAt
					? `Run duration: ${duration}`
					: `Running for: ${duration}`;
				this.runDurationEl.hidden = false;
			} else {
				this.runDurationEl.hidden = true;
			}
		}

		if (!this.runArtifactsEl) return;
		this.runArtifactsEl.empty();
		if (!run) {
			this.runArtifactsEl.hidden = true;
			return;
		}

		let hasArtifacts = false;

		// 1. Branch Pill with Copy Button
		if (run.branch) {
			hasArtifacts = true;
			const branchPill = this.runArtifactsEl.createDiv({
				cls: "wb-artifact-pill wb-artifact-pill--branch",
				attr: { title: `Branch: ${run.branch}` },
			});
			const iconEl = branchPill.createSpan({ cls: "wb-artifact-icon" });
			setIcon(iconEl, "git-branch");
			branchPill.createSpan({ cls: "wb-artifact-label", text: run.branch });

			const copyBtn = branchPill.createEl("button", {
				cls: "wb-artifact-btn wb-artifact-btn--copy",
				attr: { "aria-label": "Copy branch name", title: "Copy branch name" },
			});
			const copyIcon = copyBtn.createSpan({ cls: "wb-artifact-btn-icon" });
			setIcon(copyIcon, "copy");

			copyBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					await navigator.clipboard.writeText(run.branch);
					copyBtn.addClass("is-copied");
					copyIcon.empty();
					setIcon(copyIcon, "check");
					copyBtn.setAttribute("title", "Copied!");
					new Notice(`Copied branch: ${run.branch}`);
					window.setTimeout(() => {
						copyBtn.removeClass("is-copied");
						copyIcon.empty();
						setIcon(copyIcon, "copy");
						copyBtn.setAttribute("title", "Copy branch name");
					}, 1500);
				} catch {
					new Notice("Failed to copy branch name.");
				}
			});
		}

		// 2. Worktree Pill & Inline Remove Action
		if (run.worktreeRequested) {
			hasArtifacts = true;
			const isRemoved = run.worktreeRemoved;
			const wtPill = this.runArtifactsEl.createDiv({
				cls: `wb-artifact-pill wb-artifact-pill--worktree ${isRemoved ? "is-removed" : "is-active"}`,
				attr: {
					title: isRemoved
						? "Worktree removed"
						: run.worktreePath || "Isolated git worktree active",
				},
			});
			const wtIcon = wtPill.createSpan({ cls: "wb-artifact-icon" });
			setIcon(wtIcon, "folder");
			wtPill.createSpan({
				cls: "wb-artifact-label",
				text: isRemoved ? "Worktree removed" : "Worktree active",
			});

			const removable =
				!isRemoved &&
				run.status !== "queued" &&
				run.status !== "running" &&
				!run.aborting;

			if (removable) {
				const removeBtn = wtPill.createEl("button", {
					cls: "wb-artifact-btn wb-artifact-btn--remove",
					attr: { "aria-label": "Remove worktree", title: "Remove worktree directory" },
				});
				const removeIcon = removeBtn.createSpan({ cls: "wb-artifact-btn-icon" });
				setIcon(removeIcon, "trash-2");
				removeBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.removeWorktree(rootRun?.id ?? run.id);
				});
			}
		}

		this.runArtifactsEl.hidden = !hasArtifacts;
	}

	private updateChatUi(chain: RunView[], viewingHistory: boolean): void {
		if (!this.chatEl) return;
		const signature = [
			chain
				.map(
					(r) =>
						`${r.id}:${r.status}:${r.error}:${r.logs?.length ?? 0}:${r.logs?.at(-1)?.seq ?? 0}`
				)
				.join(";"),
			viewingHistory ? "history" : "latest",
			this.task.title,
			this.task.description,
		].join("\n");
		if (signature === this.chatSignature) return;
		this.chatSignature = signature;
		const stick =
			this.chatEl.scrollTop + this.chatEl.clientHeight >=
			this.chatEl.scrollHeight - 24;
		this.chatEl.empty();

		if (chain.length === 0) {
			this.chatEl.createDiv({
				cls: "wb-chat-empty",
				text: "No conversation yet. Start a run to talk to the agent.",
			});
			return;
		}

		const sessionFile = chain.find((r) => r.sessionFile)?.sessionFile ?? "";
		const sessionUserMessages = sessionFile ? this.getSessionUserMessages(sessionFile) : [];

		const description = this.task.description.trim();
		const initialPrompt =
			description && description !== this.task.title
				? description.startsWith(this.task.title)
					? description
					: `${this.task.title}\n\n${description}`
				: this.task.title;

		for (let runIndex = 0; runIndex < chain.length; runIndex++) {
			const run = chain[runIndex];
			const events = run.logs ?? [];
			const isRunning = run.status === "running" || run.status === "queued";

			const firstUserEvent = events.find((e) => e.kind === "user");
			let turnPrompt = "";
			let turnUserSeq = -1;

			if (runIndex === 0) {
				turnPrompt =
					firstUserEvent?.text || run.prompt || sessionUserMessages[0] || initialPrompt;
				if (firstUserEvent) turnUserSeq = firstUserEvent.seq;
			} else {
				turnPrompt =
					firstUserEvent?.text ||
					run.prompt ||
					sessionUserMessages[runIndex] ||
					"Continued conversation";
				if (firstUserEvent) turnUserSeq = firstUserEvent.seq;
			}

			this.appendChatMessage("user", "You", turnPrompt);

			let toolLines: string[] = [];
			let lastError = "";
			const flushTools = () => {
				if (!this.chatEl || toolLines.length === 0) return;
				const steps = parseToolSteps(toolLines);
				const details = this.chatEl.createEl("details", {
					cls: "wb-chat-activity",
				});
				if (isRunning) {
					details.open = true;
				}

				const summary = details.createEl("summary", { cls: "wb-chat-activity-summary" });
				const summaryLeft = summary.createDiv({ cls: "wb-chat-activity-summary-left" });
				const chevronEl = summaryLeft.createSpan({ cls: "wb-chat-activity-chevron" });
				setIcon(chevronEl, "chevron-right");
				const iconEl = summaryLeft.createSpan({ cls: "wb-chat-activity-icon" });
				setIcon(iconEl, "terminal");

				const count = steps.length;
				const failedCount = steps.filter((s) => s.status === "failed").length;
				const isAnyRunning = steps.some((s) => s.status === "running") && isRunning;

				const titleText = isAnyRunning
					? `Running tools · ${count} step${count === 1 ? "" : "s"}`
					: `Tool activity · ${count} step${count === 1 ? "" : "s"}`;
				summaryLeft.createSpan({ cls: "wb-chat-activity-title", text: titleText });

				if (failedCount > 0) {
					summaryLeft.createSpan({
						cls: "wb-chat-activity-badge wb-chat-activity-badge--failed",
						text: `${failedCount} failed`,
					});
				}

				const summaryRight = summary.createDiv({ cls: "wb-chat-activity-summary-right" });
				if (isAnyRunning) {
					summaryRight.createSpan({
						cls: "wb-chat-activity-status is-running",
						text: "Running…",
					});
				}

				const list = details.createDiv({ cls: "wb-chat-activity-steps" });
				for (const step of steps) {
					const stepEl = list.createDiv({
						cls: `wb-tool-step wb-tool-step--${step.status}`,
					});
					const stepIconEl = stepEl.createSpan({ cls: "wb-tool-step-icon" });
					if (step.status === "failed") {
						setIcon(stepIconEl, "x");
					} else if (step.status === "running") {
						setIcon(stepIconEl, "play");
					} else {
						setIcon(stepIconEl, "check");
					}

					stepEl.createSpan({ cls: "wb-tool-step-name", text: step.name });
					stepEl.createSpan({
						cls: "wb-tool-step-cmd",
						text: step.command || step.raw,
						attr: { title: step.raw },
					});
					if (step.duration) {
						stepEl.createSpan({ cls: "wb-tool-step-duration", text: step.duration });
					}
				}

				toolLines = [];
			};

			let hasAssistantResponse = false;
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
					hasAssistantResponse = true;
					this.appendChatMessage("assistant", this.backendLabel(run), event.text, true);
				} else if (event.kind === "user") {
					if (event.seq === turnUserSeq) {
						continue;
					}
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

			if (!hasAssistantResponse && events.length === 0 && run.summary) {
				this.appendChatMessage("assistant", this.backendLabel(run), run.summary, true);
			}

			const error = run.pollError || run.error;
			if (error && error !== lastError) this.appendChatMessage("error", "Error", error);
		}
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
		const header = message.createDiv({ cls: "wb-chat-header" });
		const iconEl = header.createSpan({ cls: "wb-chat-header-icon" });
		const iconName =
			kind === "user"
				? "user"
				: kind === "assistant"
				? "bot"
				: kind === "error"
				? "alert-circle"
				: "info";
		setIcon(iconEl, iconName);
		header.createSpan({ cls: "wb-chat-header-name", text: role });

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
		const id = this.currentBackendId();
		const backend = health.backends.find((entry) => entry.id === id);
		return backend?.displayName || (id ? id.toUpperCase() : "Agent");
	}

	private setPreview(visible: boolean, focus = true): void {
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
			if (focus) {
				this.descriptionInput.focus();
			}
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
		if (this.isNew && !this.saved) {
			this.onDiscard?.();
			this.allowClose = true;
			super.close();
			return;
		}
		const title = this.titleInput?.value.trim() ?? "";
		if (!title) {
			if (this.isNew) {
				this.onDiscard?.();
			}
			this.allowClose = true;
			super.close();
			return;
		}
		const description = this.descriptionInput?.value ?? this.task.description;
		const backend = this.selectedBackend;
		const patch: TaskPatch = {};
		if (title !== this.task.title) patch.title = title;
		if (description !== this.task.description) patch.description = description;
		if (backend !== undefined && backend !== this.task.backend) patch.backend = backend;
		if (Object.keys(patch).length > 0 || (this.isNew && this.saved)) {
			this.onSave(patch);
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

