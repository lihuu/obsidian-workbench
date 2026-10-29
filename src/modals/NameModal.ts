import { App, Modal } from "obsidian";

export interface NameModalOptions {
	title: string;
	label: string;
	initialValue: string;
	submitText: string;
	placeholder?: string;
	maxLength?: number;
}

export class NameModal extends Modal {
	private readonly options: NameModalOptions;
	private readonly onSubmit: (name: string) => Promise<void> | void;
	private submitButton: HTMLButtonElement | undefined;

	constructor(
		app: App,
		options: NameModalOptions,
		onSubmit: (name: string) => Promise<void> | void
	) {
		super(app);
		this.options = options;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.modalEl.addClass("wb-modal");
		this.contentEl.addClass("wb-modal-content");
		this.contentEl.empty();

		const field = this.contentEl.createDiv({ cls: "wb-field" });
		const label = field.createEl("label", {
			cls: "wb-field-label",
			text: this.options.label,
		});
		const input = field.createEl("input", { cls: "wb-input wb-title-input" });
		input.type = "text";
		input.value = this.options.initialValue;
		input.maxLength = this.options.maxLength ?? 80;
		input.placeholder = this.options.placeholder ?? "";
		input.id = `wb-name-${Date.now()}`;
		label.htmlFor = input.id;

		const errorEl = this.contentEl.createDiv({ cls: "wb-form-error" });
		errorEl.hide();

		const footer = this.contentEl.createDiv({ cls: "wb-modal-footer" });
		footer.createDiv({ cls: "wb-spacer" });
		const cancelButton = footer.createEl("button", { cls: "wb-button", text: "Cancel" });
		this.submitButton = footer.createEl("button", {
			cls: "wb-button wb-button--primary",
			text: this.options.submitText,
		});

		const submit = async () => {
			const name = input.value.trim();
			if (!name) {
				errorEl.setText("Name can't be empty.");
				errorEl.show();
				input.focus();
				return;
			}
			errorEl.hide();
			if (this.submitButton) this.submitButton.disabled = true;
			try {
				await this.onSubmit(name);
				this.close();
			} catch (error) {
				errorEl.setText(error instanceof Error ? error.message : String(error));
				errorEl.show();
				if (this.submitButton) this.submitButton.disabled = false;
				input.focus();
			}
		};

		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				void submit();
			}
		});
		cancelButton.addEventListener("click", () => this.close());
		this.submitButton.addEventListener("click", () => void submit());

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}
}
