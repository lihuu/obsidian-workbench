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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
	closeGitHub,
	commentGitHub,
	normalizeChecks,
} from "../runner/github.mjs";

describe("GitHub checks normalization", () => {
	it("classifies mixed check runs", () => {
		expect(
			normalizeChecks([
				{ conclusion: "SUCCESS" },
				{ conclusion: "SKIPPED" },
				{ conclusion: "FAILURE" },
				{ status: "IN_PROGRESS" },
			])
		).toEqual({
			state: "failure",
			total: 4,
			success: 2,
			failure: 1,
			pending: 1,
		});
	});

	it("returns none without checks", () => {
		expect(normalizeChecks(undefined)).toEqual({
			state: "none",
			total: 0,
			success: 0,
			failure: 0,
			pending: 0,
		});
	});
});

describe("GitHub CLI actions", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gh-"));
	const script = path.join(dir, "gh");
	const argsFile = path.join(dir, "args.json");
	const stdinFile = path.join(dir, "stdin.txt");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GH_ARGS_FILE, JSON.stringify(args));
fs.writeFileSync(process.env.GH_STDIN_FILE, fs.readFileSync(0, "utf8"));
process.stdout.write("https://github.com/acme/repo/issues/7#issuecomment-1\\n");
`
	);
	fs.chmodSync(script, 0o755);
	process.env.GH_ARGS_FILE = argsFile;
	process.env.GH_STDIN_FILE = stdinFile;
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("comments with stdin instead of shell interpolation", async () => {
		await commentGitHub(
			{ owner: "acme", repo: "repo" },
			{ type: "issue", number: 7, body: "Hello from Workbench" },
			{ bin: script }
		);
		expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toEqual([
			"issue",
			"comment",
			"7",
			"--repo",
			"acme/repo",
			"--body-file",
			"-",
		]);
		expect(fs.readFileSync(stdinFile, "utf8")).toBe("Hello from Workbench");
	});

	it("closes PRs with gh pr close", async () => {
		await closeGitHub(
			{ owner: "acme", repo: "repo" },
			{ type: "pull_request", number: 9 },
			{ bin: script }
		);
		expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toEqual([
			"pr",
			"close",
			"9",
			"--repo",
			"acme/repo",
		]);
	});
});
