import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ISSUE_FIELDS =
	"number,title,body,url,state,updatedAt,createdAt,labels,author";
const PR_FIELDS =
	"number,title,body,url,state,updatedAt,createdAt,labels,author,isDraft,headRefName,baseRefName";

function labelNames(labels) {
	if (!Array.isArray(labels)) return [];
	return labels
		.map((label) => (typeof label === "string" ? label : label?.name))
		.filter((name) => typeof name === "string" && name.trim())
		.map((name) => name.trim());
}

function authorLogin(author) {
	return typeof author?.login === "string" ? author.login : "";
}

export function normalizeGhIssue(item) {
	return {
		number: Number(item.number),
		title: typeof item.title === "string" ? item.title : "",
		body: typeof item.body === "string" ? item.body : "",
		url: typeof item.url === "string" ? item.url : "",
		state: typeof item.state === "string" ? item.state : "OPEN",
		updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
		createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
		labels: labelNames(item.labels),
		author: authorLogin(item.author),
	};
}

export function normalizeGhPullRequest(item) {
	return {
		...normalizeGhIssue(item),
		isDraft: item.isDraft === true,
		headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
		baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
	};
}

export function checkGh(bin = process.env.WORKBENCH_GH_BIN ?? "gh") {
	const result = spawnSync(bin, ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
		env: process.env,
	});
	return {
		binary: bin,
		available: result.status === 0,
		version: result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] ?? "" : "",
		error:
			result.status === 0
				? ""
				: result.error?.message ||
					result.stderr?.trim() ||
					"Could not run gh.",
	};
}

/**
 * Read-only initial import. Uses the user's already-authenticated gh CLI, so
 * no GitHub token is stored by the plugin.
 */
export async function syncGitHub(repo, { bin = process.env.WORKBENCH_GH_BIN ?? "gh" } = {}) {
	const qualified = `${repo.owner}/${repo.repo}`;
	const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
	const [issuesResult, prsResult] = await Promise.all([
		execFileAsync(
			bin,
			[
				"issue",
				"list",
				"--repo",
				qualified,
				"--state",
				"open",
				"--limit",
				"100",
				"--json",
				ISSUE_FIELDS,
			],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 20 * 1024 * 1024, env }
		),
		execFileAsync(
			bin,
			[
				"pr",
				"list",
				"--repo",
				qualified,
				"--state",
				"open",
				"--limit",
				"100",
				"--json",
				PR_FIELDS,
			],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 20 * 1024 * 1024, env }
		),
	]);

	const issues = JSON.parse(issuesResult.stdout).map(normalizeGhIssue);
	const pullRequests = JSON.parse(prsResult.stdout).map(normalizeGhPullRequest);
	return { repo: qualified, issues, pullRequests };
}
