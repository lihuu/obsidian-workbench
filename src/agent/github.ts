import type { Board, Task, TaskGitHubLink, TaskPatch } from "../data/types";
import type {
	GitHubChecks,
	GitHubImportResult,
	GitHubSyncItem,
	GitHubSyncRef,
	GitHubSyncResult,
} from "./types";

interface GitHubTaskStore {
	addTask(boardId: string, columnId: string, title: string): Task;
	updateTask(boardId: string, taskId: string, patch: TaskPatch): void;
	moveTask?(boardId: string, taskId: string, columnId: string): boolean;
}

interface ExistingTask {
	task: Task;
	columnId: string;
}

export function importGitHubItems(
	store: GitHubTaskStore,
	board: Board,
	result: GitHubSyncResult
): GitHubImportResult {
	const target =
		board.columns.find((column) => column.name.trim().toLowerCase() === "inbox") ??
		board.columns.find((column) => column.name.trim().toLowerCase() === "backlog") ??
		board.columns[0];
	const done =
		board.columns.find((column) => column.name.trim().toLowerCase() === "done") ??
		board.columns[board.columns.length - 1];
	if (!target) return { imported: 0, updated: 0, moved: 0, skipped: 0 };

	const existing = new Map<string, ExistingTask>();
	for (const column of board.columns) {
		for (const task of column.tasks) {
			if (!task.github) continue;
			existing.set(
				githubKey(task.github.repo, task.github.type, task.github.number),
				{ task, columnId: column.id }
			);
		}
	}

	const summary: GitHubImportResult = {
		imported: 0,
		updated: 0,
		moved: 0,
		skipped: 0,
	};
	const apply = (type: "issue" | "pull_request", item: GitHubSyncItem) => {
		const key = githubKey(result.repo, type, item.number);
		const current = existing.get(key);
		if (current) {
			summary.updated += 1;
			if (
				updateOne(
					store,
					board.id,
					current,
					result.repo,
					type,
					item,
					done?.id
				)
			) {
				summary.moved += 1;
			}
			return;
		}
		if (!isOpen(item)) {
			summary.skipped += 1;
			return;
		}
		const task = importOne(store, board.id, target.id, result.repo, type, item);
		existing.set(key, { task, columnId: target.id });
		summary.imported += 1;
	};

	for (const item of result.issues) apply("issue", item);
	for (const item of result.pullRequests) apply("pull_request", item);
	return summary;
}

function importOne(
	store: GitHubTaskStore,
	boardId: string,
	columnId: string,
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem
): Task {
	const fallback = `${type === "issue" ? "Issue" : "PR"} #${item.number}`;
	const title = item.title.trim() || fallback;
	const description = buildGitHubDescription(repo, type, item);
	const task = store.addTask(boardId, columnId, title);
	store.updateTask(boardId, task.id, {
		description,
		source: "github",
		github: toTaskGitHub(repo, type, item, description),
	});
	return { ...task, title, description };
}

function updateOne(
	store: GitHubTaskStore,
	boardId: string,
	current: ExistingTask,
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem,
	doneColumnId: string | undefined
): boolean {
	const previous = current.task.github;
	if (!previous) return false;
	const title = item.title.trim() || current.task.title;
	const description = buildGitHubDescription(repo, type, item);
	const patch: TaskPatch = {
		github: toTaskGitHub(repo, type, item, description),
	};

	// Only follow remote title changes if the local title still matches the
	// title from the previous sync. A user rename wins.
	if (previous.title && current.task.title === previous.title && title !== current.task.title) {
		patch.title = title;
	}
	// Only refresh the body when the description is the generated snapshot.
	// Local notes or edits outside the generated content are preserved.
	if (
		previous.descriptionHash &&
		hashDescription(current.task.description) === previous.descriptionHash &&
		description !== current.task.description
	) {
		patch.description = description;
	}

	store.updateTask(boardId, current.task.id, patch);
	if (
		isDone(type, item) &&
		doneColumnId &&
		current.columnId !== doneColumnId &&
		store.moveTask?.(boardId, current.task.id, doneColumnId)
	) {
		return true;
	}
	return false;
}

export function githubRepoUrl(repo: string): string {
	if (/^[a-z]+:\/\//i.test(repo) || /^git@/i.test(repo)) return repo;
	return `https://github.com/${repo.replace(/\.git$/i, "")}.git`;
}

export function collectGitHubRefs(board: Board): GitHubSyncRef[] {
	const refs: GitHubSyncRef[] = [];
	const seen = new Set<string>();
	for (const column of board.columns) {
		for (const task of column.tasks) {
			if (!task.github) continue;
			const key = `${task.github.repo}|${task.github.type}|${task.github.number}`;
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push({ type: task.github.type, number: task.github.number });
			if (refs.length >= 200) return refs;
		}
	}
	return refs;
}

export function githubChecksLabel(checks: GitHubChecks | undefined): string {
	if (!checks || checks.total === 0) return "";
	if (checks.state === "failure") return `Checks ${checks.failure} failing`;
	if (checks.state === "pending") return `Checks ${checks.pending} pending`;
	return `Checks ${checks.success} passing`;
}

export function githubReviewLabel(decision: string | null | undefined): string {
	switch (decision) {
		case "APPROVED":
			return "Approved";
		case "CHANGES_REQUESTED":
			return "Changes requested";
		case "REVIEW_REQUIRED":
			return "Review required";
		default:
			return "";
	}
}

export function githubStateLabel(state: string): string {
	switch (state.toUpperCase()) {
		case "MERGED":
			return "Merged";
		case "CLOSED":
			return "Closed";
		case "OPEN":
			return "Open";
		default:
			return state;
	}
}

export function buildGitHubDescription(
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem
): string {
	const kind = type === "issue" ? "issue" : "pull request";
	const metadata = [
		`Imported from GitHub ${kind} ${repo}#${item.number}.`,
		`URL: ${item.url || itemUrl(repo, type, item.number)}`,
		`State: ${item.state || "unknown"}`,
		item.author ? `Author: @${item.author}` : "",
		item.labels.length > 0 ? `Labels: ${item.labels.join(", ")}` : "",
		item.isDraft !== undefined ? `Draft: ${item.isDraft ? "yes" : "no"}` : "",
		item.headRefName ? `Head: ${item.headRefName}` : "",
		item.baseRefName ? `Base: ${item.baseRefName}` : "",
		item.reviewDecision ? `Review: ${item.reviewDecision}` : "",
		item.checks && item.checks.total > 0
			? `Checks: ${item.checks.success} passed, ${item.checks.failure} failed, ${item.checks.pending} pending`
			: "",
		item.mergedAt ? `Merged: ${item.mergedAt}` : "",
		item.closedAt ? `Closed: ${item.closedAt}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const body = item.body.trim().slice(0, 20_000) || "(No description.)";
	return `${metadata}\n\n---\n\n${body}`;
}

export function hashDescription(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16);
}

function toTaskGitHub(
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem,
	description: string
): TaskGitHubLink {
	return {
		repo,
		type,
		number: item.number,
		url: item.url || itemUrl(repo, type, item.number),
		state: item.state,
		updatedAt: item.updatedAt,
		title: item.title,
		author: item.author,
		labels: [...item.labels],
		...(type === "pull_request"
			? {
					isDraft: item.isDraft === true,
					headRefName: item.headRefName ?? "",
					baseRefName: item.baseRefName ?? "",
					reviewDecision: item.reviewDecision ?? null,
					mergedAt: item.mergedAt ?? null,
					checks: item.checks,
				}
			: {}),
		closedAt: item.closedAt || null,
		descriptionHash: hashDescription(description),
	};
}

function isOpen(item: GitHubSyncItem): boolean {
	return item.state.toUpperCase() === "OPEN";
}

function isDone(type: "issue" | "pull_request", item: GitHubSyncItem): boolean {
	const state = item.state.toUpperCase();
	return type === "issue" ? state === "CLOSED" : state === "MERGED";
}

function itemUrl(
	repo: string,
	type: "issue" | "pull_request",
	number: number
): string {
	return `https://github.com/${repo}/${type === "issue" ? "issues" : "pull"}/${number}`;
}

function githubKey(repo: string, type: string, number: number): string {
	return `${repo}|${type}|${number}`;
}
