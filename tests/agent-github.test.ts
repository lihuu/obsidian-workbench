import { describe, expect, it } from "vitest";
import { buildGitHubDescription, importGitHubItems } from "../src/agent/github";
import type { Board, Task } from "../src/data/types";
import type { GitHubSyncItem, GitHubSyncResult } from "../src/agent/types";

function makeItem(overrides: Partial<GitHubSyncItem> = {}): GitHubSyncItem {
	return {
		number: 12,
		title: "Fix the importer",
		body: "Issue body.",
		url: "https://github.com/acme/repo/issues/12",
		state: "OPEN",
		updatedAt: "2026-10-29T00:00:00Z",
		createdAt: "2026-10-28T00:00:00Z",
		labels: ["bug"],
		author: "octocat",
		...overrides,
	};
}

function makeBoard(): Board {
	return {
		id: "b_board",
		name: "Board",
		createdAt: 1,
		updatedAt: 1,
		columns: [{ id: "c_backlog", name: "Backlog", tasks: [] }],
	};
}

function makeStore() {
	const tasks: Task[] = [];
	return {
		tasks,
		addTask(_boardId: string, _columnId: string, title: string): Task {
			const task: Task = {
				id: `t_${tasks.length + 1}`,
				title,
				description: "",
				createdAt: 1,
				updatedAt: 1,
			};
			tasks.push(task);
			return task;
		},
		updateTask(_boardId: string, taskId: string, patch: Partial<Task>): void {
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (task) Object.assign(task, patch, { updatedAt: 2 });
		},
	};
}

describe("importGitHubItems", () => {
	it("imports issues and pull requests into Inbox/Backlog with metadata", () => {
		const board = makeBoard();
		const store = makeStore();
		const result: GitHubSyncResult = {
			repo: "acme/repo",
			issues: [makeItem()],
			pullRequests: [
				makeItem({
					number: 13,
					title: "Add tests",
					isDraft: false,
					headRefName: "feature/tests",
					baseRefName: "main",
				}),
			],
		};

		expect(importGitHubItems(store, board, result)).toBe(2);
		expect(store.tasks).toHaveLength(2);
		expect(store.tasks[0]).toMatchObject({
			title: "Fix the importer",
			source: "github",
			github: {
				repo: "acme/repo",
				type: "issue",
				number: 12,
			},
		});
		expect(store.tasks[0].description).toContain("GitHub issue acme/repo#12");
		expect(store.tasks[1].description).toContain("GitHub pull request acme/repo#13");
		expect(store.tasks[1].description).toContain("Head: feature/tests");
	});

	it("deduplicates by repo, type, and number", () => {
		const board = makeBoard();
		const store = makeStore();
		const result: GitHubSyncResult = {
			repo: "acme/repo",
			issues: [makeItem()],
			pullRequests: [],
		};

		expect(importGitHubItems(store, board, result)).toBe(1);
		board.columns[0].tasks = [...store.tasks];
		expect(importGitHubItems(store, board, result)).toBe(0);
		expect(store.tasks).toHaveLength(1);
	});

	it("builds a bounded description", () => {
		const description = buildGitHubDescription("acme/repo", "issue", makeItem());
		expect(description).toContain("Imported from GitHub issue acme/repo#12.");
		expect(description).toContain("Author: @octocat");
		expect(description).toContain("Labels: bug");
		expect(description).toContain("Issue body.");
	});
});
