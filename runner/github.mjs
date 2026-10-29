import { spawn, spawnSync } from "node:child_process";

const ISSUE_FIELDS =
	"number,title,body,url,state,updatedAt,createdAt,closedAt,labels,author";
const PR_FIELDS =
	"number,title,body,url,state,updatedAt,createdAt,closedAt,labels,author,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,mergedAt";
const LIST_LIMIT = 100;
const REF_LIMIT = 200;

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

function stringOrEmpty(value) {
	return typeof value === "string" ? value : "";
}

export function normalizeChecks(rollup) {
	const checks = {
		state: "none",
		total: 0,
		success: 0,
		failure: 0,
		pending: 0,
	};
	if (!Array.isArray(rollup)) return checks;
	for (const check of rollup) {
		const raw = String(
			check?.conclusion || check?.state || check?.status || ""
		).toUpperCase();
		if (!raw) continue;
		checks.total += 1;
		if (raw === "SUCCESS" || raw === "NEUTRAL" || raw === "SKIPPED") {
			checks.success += 1;
		} else if (
			raw === "PENDING" ||
			raw === "QUEUED" ||
			raw === "IN_PROGRESS" ||
			raw === "WAITING" ||
			raw === "EXPECTED" ||
			raw === "REQUESTED"
		) {
			checks.pending += 1;
		} else {
			checks.failure += 1;
		}
	}
	if (checks.failure > 0) checks.state = "failure";
	else if (checks.pending > 0) checks.state = "pending";
	else if (checks.success > 0) checks.state = "success";
	return checks;
}

export function normalizeGhIssue(item) {
	return {
		number: Number(item.number),
		title: typeof item.title === "string" ? item.title : "",
		body: typeof item.body === "string" ? item.body : "",
		url: typeof item.url === "string" ? item.url : "",
		state: typeof item.state === "string" ? item.state : "OPEN",
		updatedAt: stringOrEmpty(item.updatedAt),
		createdAt: stringOrEmpty(item.createdAt),
		closedAt: stringOrEmpty(item.closedAt),
		labels: labelNames(item.labels),
		author: authorLogin(item.author),
	};
}

export function normalizeGhPullRequest(item) {
	const checks = normalizeChecks(item.statusCheckRollup);
	return {
		...normalizeGhIssue(item),
		isDraft: item.isDraft === true,
		headRefName: stringOrEmpty(item.headRefName),
		baseRefName: stringOrEmpty(item.baseRefName),
		reviewDecision:
			typeof item.reviewDecision === "string" ? item.reviewDecision : null,
		mergedAt: stringOrEmpty(item.mergedAt),
		checks,
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

function runGh(bin, args, { input, timeout = 30_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			env: { ...process.env, GH_PROMPT_DISABLED: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve(value);
		};
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`gh timed out after ${Math.round(timeout / 1000)} seconds.`));
		}, timeout);
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) {
				finish(null, { stdout, stderr });
				return;
			}
			const error = new Error(
				stderr.trim() || `gh exited with code ${String(code)}.`
			);
			error.code = code;
			error.stderr = stderr;
			error.stdout = stdout;
			finish(error);
		});
		child.stdin.end(typeof input === "string" ? input : "");
	});
}

/**
 * Read GitHub issues and pull requests through the user's authenticated gh CLI.
 * The list pass imports open items. `refs` are linked tasks; missing refs are
 * fetched individually so closed/merged tasks can still be updated.
 */
export async function syncGitHub(
	repo,
	{ bin = process.env.WORKBENCH_GH_BIN ?? "gh", refs = [] } = {}
) {
	const qualified = `${repo.owner}/${repo.repo}`;
	const [issuesResult, prsResult] = await Promise.all([
		runGh(bin, [
			"issue",
			"list",
			"--repo",
			qualified,
			"--state",
			"open",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			ISSUE_FIELDS,
		]),
		runGh(bin, [
			"pr",
			"list",
			"--repo",
			qualified,
			"--state",
			"open",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			PR_FIELDS,
		]),
	]);

	const issues = JSON.parse(issuesResult.stdout).map(normalizeGhIssue);
	const pullRequests = JSON.parse(prsResult.stdout).map(normalizeGhPullRequest);
	const issueByNumber = new Map(issues.map((item) => [item.number, item]));
	const prByNumber = new Map(pullRequests.map((item) => [item.number, item]));

	const missing = refs
		.filter(
			(ref) =>
				ref &&
				Number.isInteger(ref.number) &&
				ref.number > 0 &&
				(ref.type === "issue"
					? !issueByNumber.has(ref.number)
					: ref.type === "pull_request" && !prByNumber.has(ref.number))
		)
		.slice(0, REF_LIMIT);
	if (missing.length > 0) {
		const views = await Promise.allSettled(
			missing.map(async (ref) => {
				const isIssue = ref.type === "issue";
				const result = await runGh(bin, [
					isIssue ? "issue" : "pr",
					"view",
					String(ref.number),
					"--repo",
					qualified,
					"--json",
					isIssue ? ISSUE_FIELDS : PR_FIELDS,
				]);
				const item = isIssue
					? normalizeGhIssue(JSON.parse(result.stdout))
					: normalizeGhPullRequest(JSON.parse(result.stdout));
				return { ref, item };
			})
		);
		for (const view of views) {
			if (view.status !== "fulfilled") continue;
			if (view.value.ref.type === "issue") {
				issues.push(view.value.item);
				issueByNumber.set(view.value.item.number, view.value.item);
			} else {
				pullRequests.push(view.value.item);
				prByNumber.set(view.value.item.number, view.value.item);
			}
		}
	}

	return { repo: qualified, issues, pullRequests };
}

function validateRef(repo, type, number) {
	const qualified = `${repo.owner}/${repo.repo}`;
	if (type !== "issue" && type !== "pull_request") {
		throw new Error("type must be issue or pull_request.");
	}
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error("number must be a positive integer.");
	}
	return qualified;
}

function itemUrl(repo, type, number) {
	return `https://github.com/${repo}/${type === "issue" ? "issues" : "pull"}/${number}`;
}

export async function commentGitHub(
	repo,
	{ type, number, body },
	{ bin = process.env.WORKBENCH_GH_BIN ?? "gh" } = {}
) {
	const qualified = validateRef(repo, type, number);
	const text = typeof body === "string" ? body : "";
	if (!text.trim()) throw new Error("Comment body can't be empty.");
	if (text.length > 60_000) throw new Error("Comment body is too long.");
	await runGh(bin, [
		type === "issue" ? "issue" : "pr",
		"comment",
		String(number),
		"--repo",
		qualified,
		"--body-file",
		"-",
	], { input: text });
	return { repo: qualified, type, number, url: itemUrl(qualified, type, number) };
}

export async function closeGitHub(
	repo,
	{ type, number },
	{ bin = process.env.WORKBENCH_GH_BIN ?? "gh" } = {}
) {
	const qualified = validateRef(repo, type, number);
	await runGh(bin, [
		type === "issue" ? "issue" : "pr",
		"close",
		String(number),
		"--repo",
		qualified,
	]);
	return { repo: qualified, type, number, url: itemUrl(qualified, type, number) };
}
