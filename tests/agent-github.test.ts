import { describe, expect, it } from "vitest";
import {
	buildGitHubDescription,
	collectGitHubRefs,
	githubRepoUrl,
	importGitHubItems,
} from "../src/agent/github";
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
		closedAt: "",
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
		columns: [
			{ id: "c_backlog", name: "Backlog", tasks: [] },
			{ id: "c_done", name: "Done", tasks: [] },
		],
	};
}

function makeStore() {
	const tasks: Task[] = [];
	const moveCalls: Array<{ taskId: string; columnId: string }> = [];
	return {
		tasks,
		moveCalls,
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
		moveTask(_boardId: string, taskId: string, columnId: string): boolean {
			moveCalls.push({ taskId, columnId });
			return true;
		},
	};
}

function snapshot(board: Board, tasks: Task[]): Board {
	board.columns[0].tasks = [...tasks];
	return board;
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
					reviewDecision: "APPROVED",
					checks: { state: "success", total: 2, success: 2, failure: 0, pending: 0 },
				}),
			],
		};

		const summary = importGitHubItems(store, board, result);
		expect(summary).toMatchObject({ imported: 2, updated: 0, moved: 0 });
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
		expect(store.tasks[1].description).toContain("Checks: 2 passed, 0 failed, 0 pending");
		expect(store.tasks[1].github).toMatchObject({
			reviewDecision: "APPROVED",
			checks: { state: "success" },
		});
	});

	it("updates existing tasks instead of creating duplicates", () => {
		const board = makeBoard();
		const store = makeStore();
		const result: GitHubSyncResult = {
			repo: "acme/repo",
			issues: [makeItem()],
			pullRequests: [],
		};

		expect(importGitHubItems(store, board, result).imported).toBe(1);
		snapshot(board, store.tasks);
		const summary = importGitHubItems(store, board, result);
		expect(summary).toMatchObject({ imported: 0, updated: 1, moved: 0 });
		expect(store.tasks).toHaveLength(1);
	});

	it("preserves local title/description edits while updating metadata", () => {
		const board = makeBoard();
		const store = makeStore();
		const open: GitHubSyncResult = {
			repo: "acme/repo",
			issues: [makeItem()],
			pullRequests: [],
		};
		importGitHubItems(store, board, open);
		snapshot(board, store.tasks);
		store.tasks[0].title = "Local title";
		store.tasks[0].description = "My notes.";

		const closed: GitHubSyncResult = {
			repo: "acme/repo",
			issues: [
				makeItem({
					title: "Remote title",
					body: "New body.",
					state: "CLOSED",
					closedAt: "2026-10-30T00:00:00Z",
				}),
			],
			pullRequests: [],
		};
		const summary = importGitHubItems(store, board, closed);
		expect(summary).toMatchObject({ imported: 0, updated: 1, moved: 1 });
		expect(store.tasks[0].title).toBe("Local title");
		expect(store.tasks[0].description).toBe("My notes.");
		expect(store.tasks[0].github).toMatchObject({
			state: "CLOSED",
			closedAt: "2026-10-30T00:00:00Z",
		});
		expect(store.moveCalls).toEqual([{ taskId: "t_1", columnId: "c_done" }]);
	});

	it("moves merged PRs to Done and stores checks/review", () => {
		const board = makeBoard();
		const store = makeStore();
		const open: GitHubSyncResult = {
			repo: "acme/repo",
			pullRequests: [
				makeItem({
					number: 13,
					url: "https://github.com/acme/repo/pull/13",
				}),
			],
			issues: [],
		};
		importGitHubItems(store, board, open);
		snapshot(board, store.tasks);

		const merged: GitHubSyncResult = {
			repo: "acme/repo",
			pullRequests: [
				makeItem({
					number: 13,
					url: "https://github.com/acme/repo/pull/13",
					state: "MERGED",
					mergedAt: "2026-10-31T00:00:00Z",
					reviewDecision: "CHANGES_REQUESTED",
					checks: { state: "failure", total: 3, success: 1, failure: 2, pending: 0 },
				}),
			],
			issues: [],
		};
		const summary = importGitHubItems(store, board, merged);
		expect(summary).toMatchObject({ imported: 0, updated: 1, moved: 1 });
		expect(store.tasks[0].github).toMatchObject({
			state: "MERGED",
			reviewDecision: "CHANGES_REQUESTED",
			mergedAt: "2026-10-31T00:00:00Z",
			checks: { state: "failure", failure: 2 },
		});
		expect(store.moveCalls).toEqual([{ taskId: "t_1", columnId: "c_done" }]);
	});

	it("builds a bounded description", () => {
		const description = buildGitHubDescription("acme/repo", "issue", makeItem());
		expect(description).toContain("Imported from GitHub issue acme/repo#12.");
		expect(description).toContain("Author: @octocat");
		expect(description).toContain("Labels: bug");
		expect(description).toContain("Issue body.");
	});

	it("maps repo slugs to clone URLs for gh actions", () => {
		expect(githubRepoUrl("acme/repo")).toBe("https://github.com/acme/repo.git");
		expect(githubRepoUrl("https://github.com/acme/repo.git")).toBe(
			"https://github.com/acme/repo.git"
		);
	});

	it("collects deduplicated linked refs for the sync refresh pass", () => {
		const board = makeBoard();
		const link = {
			repo: "acme/repo",
			type: "issue" as const,
			number: 12,
			url: "https://github.com/acme/repo/issues/12",
			state: "OPEN",
			updatedAt: "2026-10-29T00:00:00Z",
		};
		board.columns[0].tasks = [
			{
				id: "t_1",
				title: "One",
				description: "",
				createdAt: 1,
				updatedAt: 1,
				github: link,
			},
			{
				id: "t_2",
				title: "Two",
				description: "",
				createdAt: 1,
				updatedAt: 1,
				github: { ...link },
			},
		];
		board.columns[1].tasks = [
			{
				id: "t_3",
				title: "Three",
				description: "",
				createdAt: 1,
				updatedAt: 1,
				github: { ...link, type: "pull_request", number: 13 },
			},
		];
		expect(collectGitHubRefs(board)).toEqual([
			{ type: "issue", number: 12 },
			{ type: "pull_request", number: 13 },
		]);
	});
});
