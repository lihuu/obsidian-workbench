const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

export function imageMimeType(path: string): string | null {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[extension] ?? null;
}

const WIKI_IMAGE_PATTERN = /!\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\)/g;

function normalizeTarget(raw: string): string {
	const withoutAlias = raw.split("|", 1)[0] ?? "";
	return withoutAlias.trim();
}

function isRemote(target: string): boolean {
	return /^(?:https?:|data:)/i.test(target);
}

export function extractImageTargets(markdown: string): string[] {
	const targets: string[] = [];
	const seen = new Set<string>();

	const add = (raw: string) => {
		const target = normalizeTarget(raw);
		if (!target || isRemote(target) || !imageMimeType(target) || seen.has(target)) return;
		seen.add(target);
		targets.push(target);
	};

	for (const match of markdown.matchAll(WIKI_IMAGE_PATTERN)) add(match[1] ?? "");
	for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
		add(match[1] ?? match[2] ?? "");
	}

	return targets;
}
