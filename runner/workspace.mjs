import os from "node:os";
import path from "node:path";

export function expandHome(input, home = os.homedir()) {
	if (input === "~") return home;
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return path.join(home, input.slice(2));
	}
	return input;
}

function validSegment(value) {
	return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

/**
 * Parse GitHub HTTPS/SSH URLs. Reject arbitrary transports so a URL cannot
 * smuggle a git ext:: command or a query-driven option into the clone.
 */
export function parseGitHubRepo(url) {
	if (typeof url !== "string") return null;
	const value = url.trim();
	if (!value || /\s/.test(value) || /[?#]/.test(value)) return null;

	if (/^git@github\.com:/i.test(value)) {
		const rest = value.slice("git@github.com:".length);
		const parts = rest.split("/");
		if (parts.length !== 2) return null;
		const repo = parts[1].replace(/\.git$/i, "");
		const owner = parts[0];
		return validSegment(owner) && validSegment(repo) ? { owner, repo } : null;
	}

	if (/^ssh:\/\//i.test(value)) {
		let parsed;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		if (parsed.hostname !== "github.com" || parsed.username !== "git") return null;
		const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
		if (parts.length !== 2) return null;
		const repo = parts[1].replace(/\.git$/i, "");
		return validSegment(parts[0]) && validSegment(repo)
			? { owner: parts[0], repo }
			: null;
	}

	if (/^https:\/\//i.test(value)) {
		let parsed;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		if (parsed.hostname !== "github.com" || parsed.search || parsed.hash) return null;
		const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
		if (parts.length !== 2) return null;
		const repo = parts[1].replace(/\.git$/i, "");
		return validSegment(parts[0]) && validSegment(repo)
			? { owner: parts[0], repo }
			: null;
	}

	return null;
}

export function checkoutPath(root, boardId, repo) {
	const safeBoard = path.basename(String(boardId)).replace(/[^A-Za-z0-9._-]/g, "") || "board";
	const safeRepo = path
		.basename(String(repo))
		.replace(/[^A-Za-z0-9._-]/g, "")
		.replace(/^\.+$/, "");
	return path.join(root, safeBoard, safeRepo || "repository");
}
