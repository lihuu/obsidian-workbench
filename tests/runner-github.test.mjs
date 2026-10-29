import { describe, expect, it } from "vitest";
import { normalizeGhIssue, normalizeGhPullRequest } from "../runner/github.mjs";

describe("GitHub CLI normalization", () => {
	it("normalizes issue labels and author", () => {
		expect(
			normalizeGhIssue({
				number: 7,
				title: "Issue",
				body: "Body",
				url: "https://github.com/acme/repo/issues/7",
				state: "OPEN",
				updatedAt: "2026-10-29T00:00:00Z",
				createdAt: "2026-10-28T00:00:00Z",
				labels: [{ name: "bug" }, "help wanted", { name: "" }],
				author: { login: "octocat" },
			})
		).toMatchObject({
			number: 7,
			labels: ["bug", "help wanted"],
			author: "octocat",
		});
	});

	it("normalizes PR-specific fields", () => {
		expect(
			normalizeGhPullRequest({
				number: 9,
				title: "PR",
				body: "",
				url: "https://github.com/acme/repo/pull/9",
				state: "OPEN",
				isDraft: true,
				headRefName: "feature",
				baseRefName: "main",
				labels: [],
				author: { login: "octocat" },
			})
		).toMatchObject({
			number: 9,
			isDraft: true,
			headRefName: "feature",
			baseRefName: "main",
			author: "octocat",
		});
	});
});
