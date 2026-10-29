import type { Board, Task, TaskPatch } from "../data/types";
import type { GitHubSyncItem, GitHubSyncResult } from "./types";

interface GitHubTaskStore {
	addTask(boardId: string, columnId: string, title: string): Task;
	updateTask(boardId: string, taskId: string, patch: TaskPatch): void;
}

export function importGitHubItems(
	store: GitHubTaskStore,
	board: Board,
	result: GitHubSyncResult
): number {
	const target =
		board.columns.find((column) => column.name.trim().toLowerCase() === "inbox") ??
		board.columns.find((column) => column.name.trim().toLowerCase() === "backlog") ??
		board.columns[0];
	if (!target) return 0;

	const existing = new Set(
		board.columns
			.flatMap((column) => column.tasks)
			.filter((task) => task.github)
			.map((task) => githubKey(task.github!.repo, task.github!.type, task.github!.number))
	);
	let imported = 0;
	for (const item of result.issues) {
		if (importOne(store, board.id, target.id, result.repo, "issue", item, existing)) {
			imported += 1;
		}
	}
	for (const item of result.pullRequests) {
		if (
			importOne(
				store,
				board.id,
				target.id,
				result.repo,
				"pull_request",
				item,
				existing
			)
		) {
			imported += 1;
		}
	}
	return imported;
}

function importOne(
	store: GitHubTaskStore,
	boardId: string,
	columnId: string,
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem,
	existing: Set<string>
): boolean {
	const key = githubKey(repo, type, item.number);
	if (existing.has(key)) return false;
	existing.add(key);
	const fallback = `${type === "issue" ? "Issue" : "PR"} #${item.number}`;
	const task = store.addTask(boardId, columnId, item.title.trim() || fallback);
	store.updateTask(boardId, task.id, {
		description: buildGitHubDescription(repo, type, item),
		source: "github",
		github: {
			repo,
			type,
			number: item.number,
			url: item.url,
			state: item.state,
			updatedAt: item.updatedAt,
		},
	});
	return true;
}

export function buildGitHubDescription(
	repo: string,
	type: "issue" | "pull_request",
	item: GitHubSyncItem
): string {
	const kind = type === "issue" ? "issue" : "pull request";
	const lines = [
		`Imported from GitHub ${kind} ${repo}#${item.number}.`,
		"",
		`URL: ${item.url || `https://github.com/${repo}/${type === "issue" ? "issues" : "pull"}/${item.number}`}`,
		`State: ${item.state || "unknown"}`,
		item.author ? `Author: @${item.author}` : "",
		item.labels.length > 0 ? `Labels: ${item.labels.join(", ")}` : "",
		item.isDraft !== undefined ? `Draft: ${item.isDraft ? "yes" : "no"}` : "",
		item.headRefName ? `Head: ${item.headRefName}` : "",
		item.baseRefName ? `Base: ${item.baseRefName}` : "",
		"",
		"---",
		"",
		item.body.trim().slice(0, 20_000) || "(No description.)",
	];
	return lines.filter((line, index) => line || index < 2).join("\n").trim();
}

function githubKey(repo: string, type: string, number: number): string {
	return `${repo}|${type}|${number}`;
}
