import { App, FuzzySuggestModal, TFile } from "obsidian";

export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onChoose: (file: TFile) => void
	) {
		super(app);
		this.setPlaceholder("Link a note…");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.slice()
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}
