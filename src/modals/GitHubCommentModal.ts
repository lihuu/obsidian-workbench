import { App, Modal, Notice } from "obsidian";
import type { TaskGitHubLink } from "../data/types";

export class GitHubCommentModal extends Modal {
	private readonly link: TaskGitHubLink;
	private readonly onSubmit: (body: string) => Promise<void>;
	private textarea: HTMLTextAreaElement | undefined;
	private errorEl: HTMLElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private sending = false;

	constructor(
		app: App,
		link: TaskGitHubLink,
		onSubmit: (body: string) => Promise<void>
	) {
		super(app);
		this.link = link;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle(
			`Comment on ${this.link.type === "pull_request" ? "PR" : "issue"} #${this.link.number}`
		);
		this.modalEl.addClass("wb-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "wb-field-hint",
			text: `${this.link.repo} · posted with your local gh login`,
		});
		const field = this.contentEl.createDiv({ cls: "wb-field" });
		const label = field.createEl("label", {
			cls: "wb-field-label",
			text: "Comment",
		});
		const textarea = field.createEl("textarea", {
			cls: "wb-input wb-textarea wb-github-comment-input",
			attr: { placeholder: "Write a comment…" },
		});
		textarea.id = `wb-github-comment-${Date.now()}`;
		label.htmlFor = textarea.id;
		this.textarea = textarea;
		this.errorEl = this.contentEl.createDiv({ cls: "wb-form-error" });
		this.errorEl.hide();

		const footer = this.contentEl.createDiv({ cls: "wb-modal-footer" });
		footer.createDiv({ cls: "wb-spacer" });
		const cancel = footer.createEl("button", { cls: "wb-button", text: "Cancel" });
		this.sendButton = footer.createEl("button", {
			cls: "wb-button wb-button--primary",
			text: "Comment",
		});
		cancel.addEventListener("click", () => this.close());
		this.sendButton.addEventListener("click", () => void this.submit());
		textarea.addEventListener("keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				event.preventDefault();
				void this.submit();
			}
		});
		window.setTimeout(() => textarea.focus(), 0);
	}

	private async submit(): Promise<void> {
		if (this.sending || !this.textarea || !this.sendButton) return;
		const body = this.textarea.value.trim();
		if (!body) {
			this.errorEl?.setText("Comment can't be empty.");
			this.errorEl?.show();
			return;
		}
		this.sending = true;
		this.sendButton.disabled = true;
		this.errorEl?.hide();
		try {
			await this.onSubmit(body);
			new Notice("GitHub comment posted.");
			this.close();
		} catch (error) {
			this.errorEl?.setText(error instanceof Error ? error.message : String(error));
			this.errorEl?.show();
		} finally {
			this.sending = false;
			this.sendButton.disabled = false;
		}
	}
}
