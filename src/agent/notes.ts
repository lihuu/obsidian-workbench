import { App } from "obsidian";
import {
	extractWikiLinkTargets,
	type LinkedNote,
} from "./context";

const MAX_LINKED_NOTES = 20;

/**
 * Read a snapshot of the notes linked from a task description. Missing notes
 * and non-markdown embeds are skipped rather than failing the run.
 */
export async function collectLinkedNotes(app: App, markdown: string): Promise<LinkedNote[]> {
	const notes: LinkedNote[] = [];
	const seen = new Set<string>();

	for (const target of extractWikiLinkTargets(markdown)) {
		if (notes.length >= MAX_LINKED_NOTES) break;
		const file = app.metadataCache.getFirstLinkpathDest(target, "");
		if (!file) continue;
		if (file.extension.toLowerCase() !== "md" || seen.has(file.path)) continue;
		seen.add(file.path);
		try {
			const content = await app.vault.cachedRead(file);
			notes.push({ path: file.path, content });
		} catch {
			// A note that disappeared between resolution and read is skipped.
		}
	}

	return notes;
}
