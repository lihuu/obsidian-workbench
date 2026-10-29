import type { App } from "obsidian";
import { extractImageTargets, imageMimeType } from "./media";
import type { TaskImage } from "./types";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

/**
 * Resolve embedded images from a task description. The runner accepts a small
 * bounded set of images; inaccessible or unsupported embeds are skipped.
 */
export async function collectTaskImages(app: App, markdown: string): Promise<TaskImage[]> {
	const images: TaskImage[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;

	for (const target of extractImageTargets(markdown)) {
		if (images.length >= MAX_IMAGES || totalBytes >= MAX_TOTAL_IMAGE_BYTES) break;
		const file = app.metadataCache.getFirstLinkpathDest(target, "");
		if (!file || seen.has(file.path)) continue;
		const mimeType = imageMimeType(file.path);
		if (!mimeType) continue;
		seen.add(file.path);
		try {
			const buffer = await app.vault.readBinary(file);
			if (buffer.byteLength > MAX_IMAGE_BYTES) continue;
			if (totalBytes + buffer.byteLength > MAX_TOTAL_IMAGE_BYTES) break;
			totalBytes += buffer.byteLength;
			images.push({
				name: file.name,
				mimeType,
				data: toBase64(buffer),
			});
		} catch {
			// A missing or unreadable image is skipped.
		}
	}

	return images;
}
