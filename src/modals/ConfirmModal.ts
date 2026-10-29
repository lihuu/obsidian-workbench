import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
	private readonly message: string;
	private readonly confirmText: string;
	private readonly onConfirm: () => Promise<void> | void;
	private confirmButton: HTMLButtonElement | undefined;

	constructor(
		app: App,
		title: string,
		message: string,
		confirmText: string,
		onConfirm: () => Promise<void> | void
	) {
		super(app);
		this.message = message;
		this.confirmText = confirmText;
		this.onConfirm = onConfirm;
		this.setTitle(title);
	}

	onOpen(): void {
		this.modalEl.addClass("wb-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();

		this.contentEl.createDiv({ cls: "wb-confirm-message", text: this.message });
		const errorEl = this.contentEl.createDiv({ cls: "wb-form-error" });
		errorEl.hide();

		const footer = this.contentEl.createDiv({ cls: "wb-modal-footer" });
		footer.createDiv({ cls: "wb-spacer" });
		const cancelButton = footer.createEl("button", { cls: "wb-button", text: "Cancel" });
		this.confirmButton = footer.createEl("button", {
			cls: "wb-button wb-button--danger",
			text: this.confirmText,
		});

		const confirm = async () => {
			errorEl.hide();
			if (this.confirmButton) this.confirmButton.disabled = true;
			try {
				await this.onConfirm();
				this.close();
			} catch (error) {
				errorEl.setText(error instanceof Error ? error.message : String(error));
				errorEl.show();
				if (this.confirmButton) this.confirmButton.disabled = false;
			}
		};

		cancelButton.addEventListener("click", () => this.close());
		this.confirmButton.addEventListener("click", () => void confirm());
		window.setTimeout(() => cancelButton.focus(), 0);
	}
}
