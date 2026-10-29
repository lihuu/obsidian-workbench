import path from "node:path";

function safeSegment(value) {
	return (
		String(value)
			.split(/[\\/]+/)
			.filter((part) => part && part !== "." && part !== "..")
			.join("-")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "segment"
	);
}

export function branchForRun(runId) {
	const raw = String(runId).trim();
	if (!raw) throw new Error("run id is required.");
	return `wb/${safeSegment(raw)}`;
}

export function worktreePath(root, boardId, runId) {
	return path.join(root, safeSegment(boardId), safeSegment(runId));
}

export function isCleanStatus(status) {
	return !String(status).trim();
}
