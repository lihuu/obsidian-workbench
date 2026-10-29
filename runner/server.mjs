import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJsonlDecoder } from "./protocol.mjs";
import { RunSession, isTerminalStatus } from "./run-state.mjs";
import { parseGitHubRepo, checkoutPath, expandHome } from "./workspace.mjs";
import { checkGh, closeGitHub, commentGitHub, syncGitHub } from "./github.mjs";
import { branchForRun, isCleanStatus, worktreePath } from "./worktree.mjs";
import { pickNextQueued, reorderPending } from "./queue.mjs";
import { createBackendRegistry } from "./backends/index.mjs";
import { ProposalStore } from "./proposals.mjs";
import { buildAgentEnv } from "./run-env.mjs";

const execFileAsync = promisify(execFile);
const RUNNER_VERSION = "0.1.0";
const HOST = process.env.WORKBENCH_RUNNER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WORKBENCH_RUNNER_PORT ?? 4319);
const backends = createBackendRegistry();
const proposalStore = new ProposalStore();
/** @type {Map<string, string>} run id → scoped proposal token */
const runTokens = new Map();
const TOKEN = process.env.WORKBENCH_RUNNER_TOKEN ?? "";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK_HOSTS.has(HOST) && !TOKEN) {
	console.error(
		`[workbench-runner] refusing to listen on ${HOST} without WORKBENCH_RUNNER_TOKEN`
	);
	process.exit(1);
}
const ALLOWED_ORIGINS = new Set(
	(process.env.WORKBENCH_ALLOWED_ORIGINS ?? "app://obsidian.md,capacitor://localhost")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean)
);
const ALLOWED_ROOTS = (process.env.WORKBENCH_ALLOWED_ROOTS ?? "")
	.split(",")
	.map((root) => root.trim())
	.filter(Boolean)
	.map((root) => {
		const resolved = path.resolve(expandHome(root));
		try {
			return fs.realpathSync.native(resolved);
		} catch {
			return resolved;
		}
	});
const RUNS_DIR =
	process.env.WORKBENCH_RUNS_DIR ?? path.join(os.homedir(), ".workbench", "runs");
const RUN_TIMEOUT_MS = Number(process.env.WORKBENCH_RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_PROMPT_CHARS = 200_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const SESSIONS_DIR =
	process.env.WORKBENCH_SESSIONS_DIR ?? path.join(os.homedir(), ".workbench", "sessions");
const WORKSPACES_DIR =
	process.env.WORKBENCH_WORKSPACES_DIR ??
	path.join(os.homedir(), "Workbench", "workspaces");
const GIT_TIMEOUT_MS = Number(process.env.WORKBENCH_GIT_TIMEOUT_MS ?? 120_000);
const WORKTREES_DIR =
	process.env.WORKBENCH_WORKTREES_DIR ??
	path.join(os.homedir(), "Workbench", "worktrees");
const MAX_CONCURRENT_RUNS = Math.max(
	1,
	Number(process.env.WORKBENCH_MAX_CONCURRENT_RUNS ?? 2)
);
const MAX_QUEUED_RUNS = Math.max(
	0,
	Number(process.env.WORKBENCH_MAX_QUEUED_RUNS ?? 20)
);

/** @type {Map<string, RunSession>} */
const runs = new Map();
/** @type {Map<string, { child: import("node:child_process").ChildProcess, session: RunSession, backend: import("./backends/pi-compatible.mjs").PiCompatibleBackend, log?: fs.WriteStream, killTimer?: NodeJS.Timeout, timeoutTimer?: NodeJS.Timeout, settled: boolean, writeCommand: (command: object) => boolean, closeInputAfterSettle: () => void }>} */
const processes = new Map();
/** @type {Array<{ session: RunSession, backend: import("./backends/pi-compatible.mjs").PiCompatibleBackend, prompt: string, images: any[], baseCwd: string, worktree: boolean, proposalToken: string, log?: fs.WriteStream }>} */
const pending = [];
let draining = false;
let drainRequested = false;
let shuttingDown = false;

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function fail(res, status, message) {
	json(res, status, { error: message });
}

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!isRecord(parsed)) throw new Error("Body must be a JSON object.");
		return parsed;
	} catch (error) {
		throw new HttpError(400, `Invalid JSON: ${error instanceof Error ? error.message : error}`);
	}
}

function readString(value, field, maxLength = 200) {
	if (typeof value !== "string" || !value.trim()) {
		throw new HttpError(400, `${field} must be a non-empty string.`);
	}
	if (value.length > maxLength) {
		throw new HttpError(400, `${field} is too long.`);
	}
	return value;
}

function githubError(error) {
	const message =
		error && typeof error === "object" && typeof error.stderr === "string"
			? error.stderr.trim()
			: error instanceof Error
				? error.message
				: String(error);
	return message.slice(0, 2_000);
}

function resolveExistingAncestors(input) {
	let current = path.resolve(input);
	const tail = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		tail.unshift(path.basename(current));
		current = parent;
	}
	const base = fs.existsSync(current) ? fs.realpathSync.native(current) : current;
	return path.resolve(base, ...tail);
}

function assertAllowedRoot(candidate) {
	if (ALLOWED_ROOTS.length === 0) return;
	const realPath = resolveExistingAncestors(candidate);
	const allowed = ALLOWED_ROOTS.some(
		(root) => realPath === root || realPath.startsWith(`${root}${path.sep}`)
	);
	if (!allowed) throw new HttpError(403, `Workspace is outside WORKBENCH_ALLOWED_ROOTS: ${realPath}`);
}


async function gitInfo(cwd) {
	try {
		const top = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
		});
		const topLevel = top.stdout.trim();
		if (!topLevel) return { isGit: false, branch: "", topLevel: "" };

		let branch = "";
		try {
			const result = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
			});
			branch = result.stdout.trim();
		} catch {
			// Detached HEAD or a git version that does not support --show-current.
		}
		if (!branch) {
			try {
				const result = await execFileAsync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
					encoding: "utf8",
					timeout: 5_000,
					maxBuffer: 1024 * 1024,
				});
				branch = result.stdout.trim();
			} catch {
				branch = "";
			}
		}
		return { isGit: true, branch, topLevel };
	} catch {
		return { isGit: false, branch: "", topLevel: "" };
	}
}

async function validateWorkspace(rawPath) {
	const input = readString(rawPath, "path", 4_096);
	const expanded = path.resolve(expandHome(input));
	let stats;
	try {
		stats = await fsp.stat(expanded);
	} catch {
		throw new HttpError(400, `Workspace does not exist: ${expanded}`);
	}
	if (!stats.isDirectory()) throw new HttpError(400, `Workspace is not a directory: ${expanded}`);
	try {
		await fsp.access(expanded, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		throw new HttpError(400, `Workspace is not readable and writable: ${expanded}`);
	}
	const realPath = await fsp.realpath(expanded);
	assertAllowedRoot(realPath);
	const git = await gitInfo(realPath);
	return {
		path: realPath,
		name: path.basename(realPath),
		...git,
	};
}

function validateBranchName(value) {
	const branch = typeof value === "string" ? value.trim() : "";
	if (!branch) return "";
	if (
		branch.startsWith("-") ||
		branch.includes("..") ||
		branch.includes("\\") ||
		/\s/.test(branch) ||
		!/^[A-Za-z0-9._/-]+$/.test(branch)
	) {
		throw new HttpError(400, "Branch name is invalid.");
	}
	return branch;
}

async function gitRun(args, cwd) {
	return execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
}

function gitError(error) {
	if (error && typeof error === "object") {
		const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
		const message = "message" in error && typeof error.message === "string" ? error.message : "";
		return (stderr || message || "git failed").slice(0, 4_000);
	}
	return String(error);
}

async function cloneGitHub(body) {
	const boardId = readString(body.boardId, "boardId", 200);
	const repoUrl = readString(body.repoUrl, "repoUrl", 2_000).trim();
	const branch = validateBranchName(body.branch);
	const parsed = parseGitHubRepo(repoUrl);
	if (!parsed) {
		throw new HttpError(400, "Only GitHub HTTPS or SSH repository URLs are supported.");
	}

	const target = path.resolve(checkoutPath(WORKSPACES_DIR, boardId, parsed.repo));
	assertAllowedRoot(target);
	await fsp.mkdir(path.dirname(target), { recursive: true });

	const existing = await fsp.stat(target).catch(() => null);
	let cloned = false;
	if (existing) {
		if (!existing.isDirectory()) throw new HttpError(409, "Checkout path is not a directory.");
		const gitDir = await fsp.stat(path.join(target, ".git")).catch(() => null);
		if (!gitDir) throw new HttpError(409, "Checkout path already exists and is not a git repository.");
		let remote = "";
		try {
			remote = (await gitRun(["-C", target, "remote", "get-url", "origin"])).stdout.trim();
		} catch (error) {
			throw new HttpError(409, `Could not inspect the existing checkout: ${gitError(error)}`);
		}
		const existingRepo = parseGitHubRepo(remote);
		if (!existingRepo || existingRepo.owner !== parsed.owner || existingRepo.repo !== parsed.repo) {
			throw new HttpError(409, "Checkout path belongs to a different repository.");
		}
		try {
			await gitRun(["-C", target, "fetch", "--prune", "--quiet"]);
			if (branch) await gitRun(["-C", target, "checkout", branch]);
		} catch (error) {
			throw new HttpError(409, `Could not update the existing checkout: ${gitError(error)}`);
		}
	} else {
		const args = ["clone", "--quiet"];
		if (branch) args.push("--branch", branch);
		args.push(repoUrl, target);
		try {
			await gitRun(args);
			cloned = true;
		} catch (error) {
			await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
			throw new HttpError(400, `Git clone failed: ${gitError(error)}`);
		}
	}

	const info = await validateWorkspace(target);
	return { ...info, cloned };
}

function parseImages(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new HttpError(400, "images must be an array.");
	if (value.length > MAX_IMAGES) {
		throw new HttpError(400, `At most ${MAX_IMAGES} images are supported.`);
	}
	let total = 0;
	const images = [];
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) throw new HttpError(400, `images[${index}] must be an object.`);
		const mimeType = readString(item.mimeType, `images[${index}].mimeType`, 100);
		if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) {
			throw new HttpError(400, `images[${index}] has an unsupported MIME type.`);
		}
		const data = readString(item.data, `images[${index}].data`, 8 * 1024 * 1024);
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new HttpError(400, `images[${index}] is not valid base64.`);
		}
		const bytes = Buffer.from(data, "base64").byteLength;
		if (bytes > MAX_IMAGE_BYTES) {
			throw new HttpError(413, `images[${index}] is larger than 5 MB.`);
		}
		total += bytes;
		if (total > MAX_TOTAL_IMAGE_BYTES) {
			throw new HttpError(413, "Attached images exceed the 15 MB total limit.");
		}
		images.push({ type: "image", data, mimeType });
	}
	return images;
}

function persistRun(session) {
	try {
		const runDir = path.join(RUNS_DIR, session.id);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "run.json"),
			`${JSON.stringify({ schemaVersion: 1, snapshot: session.snapshot(), events: session.events }, null, 2)}\n`
		);
	} catch {
		// History is best-effort and must not fail the run.
	}
}

async function loadHistory() {
	await fsp.mkdir(RUNS_DIR, { recursive: true });
	const entries = await fsp.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let raw;
		try {
			raw = JSON.parse(await fsp.readFile(path.join(RUNS_DIR, entry.name, "run.json"), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(raw) || !isRecord(raw.snapshot)) continue;
		const session = RunSession.restore(raw.snapshot, Array.isArray(raw.events) ? raw.events : []);
		if (!session.backendId || !session.backendName || Object.keys(session.capabilities).length === 0) {
			try {
				session.setBackend(backends.get(session.backendId || backends.defaultId));
			} catch {
				// Keep the snapshot usable even if its backend was removed.
			}
		}
		if (!isTerminalStatus(session.status)) {
			session.error = "Runner restarted before this run finished.";
			session.finish("failed");
			persistRun(session);
		}
		runs.set(session.id, session);
	}
}

function makeRunId() {
	return `r_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function appendRaw(context, record) {
	if (!context.log) return;
	try {
		context.log.write(`${JSON.stringify(record)}\n`);
	} catch {
		// Local diagnostics are best-effort.
	}
}

function writeCommand(context, command) {
	const stdin = context.child.stdin;
	if (!stdin || stdin.destroyed) return false;
	try {
		stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	} catch {
		return false;
	}
}

function stopProcess(context, signal = "SIGTERM") {
	const child = context.child;
	if (!child || child.killed || child.exitCode !== null) return;
	try {
		child.kill(signal);
	} catch {
		// Already gone.
	}
}

function scheduleKill(context, delay) {
	clearTimeout(context.killTimer);
	context.killTimer = setTimeout(() => stopProcess(context), delay);
	context.killTimer.unref?.();
}

function closeInputAfterSettle(context) {
	context.settled = true;
	const stdin = context.child.stdin;
	if (stdin && !stdin.destroyed) {
		stdin.end();
	}
	scheduleKill(context, 2_000);
}

function finalize(context, code, signal) {
	clearTimeout(context.killTimer);
	clearTimeout(context.timeoutTimer);
	let emitted = [];
	if (!isTerminalStatus(context.session.status)) {
		if (context.backend.settleOnExit && !context.session.aborting && code === 0) {
			emitted = context.session.finish("succeeded");
		} else {
			emitted = context.session.finishFromProcess(code, signal);
		}
	}
	if (emitted.length > 0) appendRaw(context, { type: "runner_exit", code, signal, events: emitted });
	try {
		context.log?.end();
	} catch {
		// Ignore log teardown errors.
	}
	persistRun(context.session);
	processes.delete(context.session.id);
	runTokens.delete(context.session.id);
	scheduleDrain();
}

async function prepareWorktree(baseCwd, boardId, runId) {
	let baseRepo;
	try {
		const top = await gitRun(["-C", baseCwd, "rev-parse", "--show-toplevel"]);
		baseRepo = await fsp.realpath(top.stdout.trim());
	} catch (error) {
		throw new HttpError(400, `Worktree mode requires a Git workspace: ${gitError(error)}`);
	}
	const status = await gitRun(["-C", baseRepo, "status", "--porcelain"]);
	if (!isCleanStatus(status.stdout)) {
		throw new HttpError(
			409,
			"Base workspace has uncommitted changes. Commit or stash them before using worktree mode."
		);
	}
	const target = path.resolve(worktreePath(WORKTREES_DIR, boardId, runId));
	assertAllowedRoot(target);
	if (await fsp.stat(target).catch(() => null)) {
		throw new HttpError(409, "Worktree path already exists.");
	}
	await fsp.mkdir(path.dirname(target), { recursive: true });
	const branch = branchForRun(runId);
	try {
		await gitRun(["-C", baseRepo, "worktree", "add", "-b", branch, target, "HEAD"]);
	} catch (error) {
		await gitRun(["-C", baseRepo, "worktree", "remove", "--force", target]).catch(() => undefined);
		await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
		throw new HttpError(409, `Could not create worktree: ${gitError(error)}`);
	}

	const baseModules = path.join(baseRepo, "node_modules");
	const worktreeModules = path.join(target, "node_modules");
	if (
		(await fsp.stat(baseModules).catch(() => null)) &&
		!(await fsp.stat(worktreeModules).catch(() => null))
	) {
		try {
			fs.symlinkSync(baseModules, worktreeModules, "junction");
		} catch {
			// Dependencies can still be installed inside the worktree.
		}
	}

	return { path: target, branch, baseRepo };
}

function activeRunRefs() {
	return [...processes.values()].map(({ session }) => ({
		boardId: session.boardId,
		taskId: session.taskId,
		worktreeRequested: session.worktreeRequested,
	}));
}

function scheduleDrain() {
	if (shuttingDown) return;
	if (draining) {
		drainRequested = true;
		return;
	}
	void drainQueue();
}

async function drainQueue() {
	if (draining || shuttingDown) return;
	draining = true;
	try {
		while (!shuttingDown && processes.size < MAX_CONCURRENT_RUNS) {
			const job = pickNextQueued(pending, activeRunRefs());
			if (!job) break;
			const index = pending.indexOf(job);
			if (index < 0) break;
			pending.splice(index, 1);
			await startQueuedRun(job);
		}
	} finally {
		draining = false;
		if (drainRequested) {
			drainRequested = false;
			scheduleDrain();
		}
	}
}

async function startQueuedRun(job) {
	const { session, backend, prompt, images, baseCwd, worktree, resumeSessionFile, proposalToken, log } = job;
	try {
		if (worktree && !session.worktreeRemoved) {
			const created = await prepareWorktree(baseCwd, session.boardId, session.id);
			session.cwd = created.path;
			session.baseRepo = created.baseRepo;
			session.worktreePath = created.path;
			session.branch = created.branch;
		}
		persistRun(session);
	} catch (error) {
		session.error = error instanceof Error ? error.message : String(error);
		session.emit("error", session.error);
		session.finish("failed");
		try {
			log?.end();
		} catch {
			// Ignore log teardown errors.
		}
		persistRun(session);
		runTokens.delete(session.id);
		return;
	}

	const args = [
		...backend.buildArgs({ sessionFile: resumeSessionFile, sessionsDir: SESSIONS_DIR }),
		...(backend.promptMode === "arg" ? backend.promptArgs(prompt, images) : []),
	];
	let child;
	try {
		child = spawn(backend.binary, args, {
			cwd: session.cwd,
			env: buildAgentEnv({
				cwd: session.cwd,
				runnerUrl: `http://127.0.0.1:${PORT}`,
				runId: session.id,
				boardId: session.boardId,
				taskId: session.taskId,
				proposalToken,
			}),
			stdio:
				backend.promptMode === "arg"
					? ["ignore", "pipe", "pipe"]
					: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		session.error = `Could not start ${backend.displayName}: ${error instanceof Error ? error.message : String(error)}`;
		session.emit("error", session.error);
		session.finish("failed");
		try {
			log?.end();
		} catch {
			// Ignore log teardown errors.
		}
		persistRun(session);
		runTokens.delete(session.id);
		return;
	}
	const context = {
		child,
		session,
		backend,
		log,
		settled: false,
		writeCommand: (command) => writeCommand(context, command),
		closeInputAfterSettle: () => closeInputAfterSettle(context),
	};
	processes.set(session.id, context);
	session.markRunning();

	const decoder = createJsonlDecoder(
		(record) => {
			appendRaw(context, record);
			backend.handleRecord(context, record);
		},
		(error, line) => {
			session.emit(
				"error",
				`Could not parse ${backend.displayName} output: ${error instanceof Error ? error.message : error} (${line.slice(0, 200)})`
			);
		}
	);

	child.stdout?.on("data", (chunk) => decoder.push(chunk));
	child.stdout?.on("end", () => decoder.end());
	child.stderr?.on("data", (chunk) => {
		const text = chunk.toString("utf8").trim();
		if (text) session.emit("log", text.slice(0, 4_000));
	});
	child.stdin?.on("error", () => {
		// EPIPE after an abort or a crash is expected.
	});
	child.on("error", (error) => {
		session.error = `Could not start ${backend.displayName}: ${error.message}`;
		session.finish("failed");
		finalize(context, null, null);
	});
	child.on("close", (code, signal) => {
		decoder.end();
		finalize(context, code, signal);
	});

	context.timeoutTimer = setTimeout(() => {
		session.error = `Run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)} seconds.`;
		session.finish("failed");
		scheduleKill(context, 0);
	}, RUN_TIMEOUT_MS);
	context.timeoutTimer.unref?.();

	if (backend.promptMode !== "arg") {
		const accepted = writeCommand(context, backend.promptCommand(prompt, images));
		if (!accepted) {
			session.error = `${backend.displayName} stdin is not available.`;
			session.finish("failed");
			stopProcess(context);
			finalize(context, null, null);
		}
	}
}

async function enqueueRun(body, options = {}) {
	const boardId = readString(body.boardId, "boardId", 200);
	const taskId = readString(body.taskId, "taskId", 200);
	const title = typeof body.title === "string" ? body.title.slice(0, 300) : "Untitled task";
	const prompt = readString(body.prompt, "prompt", MAX_PROMPT_CHARS);
	const cwdInput = readString(body.cwd, "cwd", 4_096);
	const images = parseImages(body.images);
	const parent = options.parent;
	const useWorktree = parent ? parent.worktreeRequested : body.worktree === true;
	const backendId = parent
		? parent.backendId || backends.defaultId
		: body.backend === undefined
			? backends.defaultId
			: readString(body.backend, "backend", 40).trim();
	const backend = backends.get(backendId);
	if (images.length > 0 && !backend.capabilities.images) {
		throw new HttpError(400, `${backend.displayName} does not support image attachments.`);
	}

	const stats = await fsp.stat(path.resolve(expandHome(cwdInput))).catch(() => null);
	if (!stats?.isDirectory()) throw new HttpError(400, "Workspace does not exist or is not a directory.");
	const baseCwd = await fsp.realpath(path.resolve(expandHome(cwdInput)));
	assertAllowedRoot(baseCwd);

	if ([...runs.values()].some((run) => !isTerminalStatus(run.status) && run.boardId === boardId && run.taskId === taskId)) {
		throw new HttpError(409, "This task already has an active or queued run.");
	}
	if (pending.length >= MAX_QUEUED_RUNS) {
		throw new HttpError(429, `Runner queue is full (${MAX_QUEUED_RUNS}).`);
	}

	const id = makeRunId();
	const proposalToken = randomBytes(24).toString("hex");
	runTokens.set(id, proposalToken);
	const session = new RunSession({ id, boardId, taskId, title, cwd: baseCwd });
	session.setBackend(backend);
	session.imageCount = images.length;
	session.worktreeRequested = useWorktree;
	if (parent) {
		session.parentRunId = parent.id;
		session.cwd = parent.cwd;
		session.sessionFile = parent.sessionFile;
		session.sessionId = parent.sessionId;
		session.worktreePath = parent.worktreePath;
		session.branch = parent.branch;
		session.baseRepo = parent.baseRepo;
		session.worktreeRemoved = parent.worktreeRemoved;
	}
	const runDir = path.join(RUNS_DIR, id);
	let log;
	try {
		await fsp.mkdir(runDir, { recursive: true });
		const logPath = path.join(runDir, "events.jsonl");
		log = fs.createWriteStream(logPath, { flags: "a" });
		log.on("error", () => {
			// A broken diagnostics file must not kill the run.
		});
		session.setLogPath(logPath);
	} catch {
		session.emit("log", "Runner could not create a local log file.");
	}
	session.emit("log", pending.length === 0 ? "Queued." : `Queued behind ${pending.length} run(s).`);
	persistRun(session);
	runs.set(id, session);
	pending.push({
		session,
		backend,
		prompt,
		images,
		baseCwd,
		worktree: parent ? false : useWorktree,
		resumeSessionFile: parent?.sessionFile ?? "",
		proposalToken,
		log,
	});
	scheduleDrain();
	return session;
}

function findRun(id) {
	const run = runs.get(id);
	if (!run) throw new HttpError(404, "Run not found.");
	return run;
}

async function handleRequest(req, res) {
	const origin = req.headers.origin;
	if (origin && !ALLOWED_ORIGINS.has(origin)) {
		res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Origin not allowed.");
		return;
	}
	if (origin) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
	}
	res.setHeader(
		"Access-Control-Allow-Headers",
		"Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret"
	);
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
	const pathname = url.pathname;
	const proposalCreateMatch = /^\/runs\/([^/]+)\/task-proposals$/.exec(pathname);
	const isProposalCreate = req.method === "POST" && proposalCreateMatch !== null;

	if (TOKEN && !isProposalCreate) {
		const authorization = req.headers.authorization ?? "";
		if (authorization !== `Bearer ${TOKEN}`) {
			fail(res, 401, "Unauthorized.");
			return;
		}
	}

	if (req.method === "GET" && pathname === "/health") {
		const activeRuns = [...runs.values()]
			.filter((run) => !isTerminalStatus(run.status))
			.map((run) => run.snapshot());
		const backendHealth = backends.health();
		const pi = backendHealth.find((backend) => backend.id === "pi") ?? null;
		json(res, 200, {
			ok: true,
			name: "workbench-runner",
			version: RUNNER_VERSION,
			backends: backendHealth,
			defaultBackend: backends.defaultId,
			gh: checkGh(),
			pi,
			activeRuns,
			runningRuns: processes.size,
			queuedRuns: pending.length,
			queuedRunIds: pending.map((job) => job.session.id),
			pendingProposals: proposalStore.size,
			runsDir: RUNS_DIR,
			sessionsDir: SESSIONS_DIR,
			workspacesDir: WORKSPACES_DIR,
			worktreesDir: WORKTREES_DIR,
			maxConcurrentRuns: MAX_CONCURRENT_RUNS,
		});
		return;
	}

	if (req.method === "POST" && pathname === "/workspace") {
		const body = await readJson(req);
		json(res, 200, await validateWorkspace(body.path));
		return;
	}

	if (req.method === "POST" && pathname === "/workspace/github") {
		const body = await readJson(req);
		json(res, 200, await cloneGitHub(body));
		return;
	}

	if (req.method === "POST" && pathname === "/github/sync") {
		const body = await readJson(req);
		const repoUrl = readString(body.repoUrl, "repoUrl", 2_000).trim();
		const parsed = parseGitHubRepo(repoUrl);
		if (!parsed) {
			throw new HttpError(400, "Only GitHub HTTPS or SSH repository URLs are supported.");
		}
		const refs = Array.isArray(body.refs)
			? body.refs.slice(0, 200).map((ref) => {
					if (!isRecord(ref)) {
						throw new HttpError(400, "refs entries must be objects.");
					}
					const type = readString(ref.type, "refs[].type", 40);
					if (type !== "issue" && type !== "pull_request") {
						throw new HttpError(400, "refs[].type must be issue or pull_request.");
					}
					if (!Number.isInteger(ref.number) || ref.number <= 0) {
						throw new HttpError(400, "refs[].number must be a positive integer.");
					}
					return { type, number: ref.number };
				})
			: [];
		try {
			const result = await syncGitHub(parsed, { refs });
			json(res, 200, result);
		} catch (error) {
			throw new HttpError(502, `GitHub CLI sync failed: ${githubError(error)}`);
		}
		return;
	}

	if (req.method === "POST" && pathname === "/github/comment") {
		const body = await readJson(req);
		const repoUrl = readString(body.repoUrl, "repoUrl", 2_000).trim();
		const parsed = parseGitHubRepo(repoUrl);
		if (!parsed) {
			throw new HttpError(400, "Only GitHub HTTPS or SSH repository URLs are supported.");
		}
		const type = readString(body.type, "type", 40);
		if (type !== "issue" && type !== "pull_request") {
			throw new HttpError(400, "type must be issue or pull_request.");
		}
		if (!Number.isInteger(body.number) || body.number <= 0) {
			throw new HttpError(400, "number must be a positive integer.");
		}
		const comment = readString(body.body, "body", 60_000);
		try {
			json(
				res,
				200,
				await commentGitHub(parsed, {
					type,
					number: body.number,
					body: comment,
				})
			);
		} catch (error) {
			throw new HttpError(502, `GitHub comment failed: ${githubError(error)}`);
		}
		return;
	}

	if (req.method === "POST" && pathname === "/github/close") {
		const body = await readJson(req);
		const repoUrl = readString(body.repoUrl, "repoUrl", 2_000).trim();
		const parsed = parseGitHubRepo(repoUrl);
		if (!parsed) {
			throw new HttpError(400, "Only GitHub HTTPS or SSH repository URLs are supported.");
		}
		const type = readString(body.type, "type", 40);
		if (type !== "issue" && type !== "pull_request") {
			throw new HttpError(400, "type must be issue or pull_request.");
		}
		if (!Number.isInteger(body.number) || body.number <= 0) {
			throw new HttpError(400, "number must be a positive integer.");
		}
		try {
			json(res, 200, await closeGitHub(parsed, { type, number: body.number }));
		} catch (error) {
			throw new HttpError(502, `GitHub close failed: ${githubError(error)}`);
		}
		return;
	}

	if (req.method === "POST" && pathname === "/queue/reorder") {
		const body = await readJson(req);
		const boardId = readString(body.boardId, "boardId", 200);
		if (!Array.isArray(body.runIds)) throw new HttpError(400, "runIds must be an array.");
		const runIds = body.runIds.map((id, index) =>
			readString(id, `runIds[${index}]`, 200)
		);
		pending.splice(0, pending.length, ...reorderPending(pending, boardId, runIds));
		json(res, 200, {
			order: pending
				.filter((job) => job.session.boardId === boardId)
				.map((job) => job.session.id),
		});
		return;
	}

	if (isProposalCreate && proposalCreateMatch) {
		const runId = decodeURIComponent(proposalCreateMatch[1] ?? "");
		const run = findRun(runId);
		const expected = runTokens.get(runId);
		const authorization = req.headers.authorization ?? "";
		if (!expected || authorization !== `Bearer ${expected}`) {
			throw new HttpError(401, "Invalid run proposal token.");
		}
		const body = await readJson(req);
		const title = readString(body.title, "title", 300);
		const description =
			typeof body.description === "string" ? body.description.slice(0, 20_000) : "";
		const key = typeof body.key === "string" ? body.key.slice(0, 200) : "";
		const proposal = proposalStore.add({
			boardId: run.boardId,
			taskId: run.taskId,
			runId: run.id,
			backendName: run.backendName,
			title,
			description,
			key,
		});
		json(res, 201, { proposal });
		return;
	}

	if (req.method === "GET" && pathname === "/task-proposals") {
		const boardId = url.searchParams.get("boardId") ?? "";
		json(res, 200, { proposals: proposalStore.list({ boardId }) });
		return;
	}

	const proposalAckMatch = /^\/task-proposals\/([^/]+)\/ack$/.exec(pathname);
	if (req.method === "POST" && proposalAckMatch) {
		const proposal = proposalStore.ack(
			decodeURIComponent(proposalAckMatch[1] ?? "")
		);
		json(res, 200, { ok: true, proposal });
		return;
	}

	if (req.method === "POST" && pathname === "/runs") {
		const body = await readJson(req);
		const session = await enqueueRun(body);
		json(res, 201, session.page(0));
		return;
	}

	if (req.method === "GET" && pathname === "/runs") {
		const boardId = url.searchParams.get("boardId");
		const taskId = url.searchParams.get("taskId");
		const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
		const list = [...runs.values()]
			.filter(
				(run) =>
					(!boardId || run.boardId === boardId) &&
					(!taskId || run.taskId === taskId)
			)
			.sort((left, right) => left.createdAt - right.createdAt)
			.slice(-limit)
			.map((run) => run.snapshot());
		json(res, 200, { runs: list });
		return;
	}

	const runMatch = /^\/runs\/([^/]+)$/.exec(pathname);
	if (runMatch) {
		const run = findRun(decodeURIComponent(runMatch[1] ?? ""));
		if (req.method === "GET") {
			const after = Number(url.searchParams.get("after") ?? 0);
			json(res, 200, run.page(Number.isFinite(after) && after >= 0 ? after : 0));
			return;
		}
		if (req.method === "POST") {
			throw new HttpError(405, "Use POST /runs/:id/abort.");
		}
	}

	const abortMatch = /^\/runs\/([^/]+)\/abort$/.exec(pathname);
	if (req.method === "POST" && abortMatch) {
		const run = findRun(decodeURIComponent(abortMatch[1] ?? ""));
		if (!isTerminalStatus(run.status)) {
			const queuedIndex = pending.findIndex((job) => job.session.id === run.id);
			if (queuedIndex >= 0) {
				pending.splice(queuedIndex, 1);
				run.emit("log", "Aborted while queued.");
				run.finish("cancelled");
				runTokens.delete(run.id);
				persistRun(run);
				json(res, 200, run.page(0));
				return;
			}
			const events = run.requestAbort();
			const context = processes.get(run.id);
			if (context) {
				const command = context.backend.abortCommand();
				if (command === null) {
					run.finish("cancelled");
					stopProcess(context);
				} else {
					const accepted = writeCommand(context, command);
					if (!accepted) {
						run.finish("cancelled");
						stopProcess(context);
					} else {
						scheduleKill(context, 5_000);
					}
				}
			} else {
				run.finish("cancelled");
				persistRun(run);
			}
			for (const event of events) appendRaw({ log: context?.log }, event);
		}
		json(res, 200, run.page(0));
		return;
	}

	const clearQueueMatch = /^\/runs\/([^/]+)\/clear-queue$/.exec(pathname);
	if (req.method === "POST" && clearQueueMatch) {
		const run = findRun(decodeURIComponent(clearQueueMatch[1] ?? ""));
		if (run.status !== "running") {
			throw new HttpError(409, "Only a running run can clear its queue.");
		}
		if (!run.capabilities.clearQueue) {
			throw new HttpError(409, `${run.backendName} does not support clearing queued messages.`);
		}
		const context = processes.get(run.id);
		if (!context) throw new HttpError(409, `The ${run.backendName} process is not available.`);
		const accepted = writeCommand(context, context.backend.clearQueueCommand());
		if (!accepted) throw new HttpError(409, `${run.backendName} is not accepting commands.`);
		run.emit("log", "Requested clearing queued messages.");
		json(res, 202, { ok: true });
		return;
	}

	const continueMatch = /^\/runs\/([^/]+)\/continue$/.exec(pathname);
	if (req.method === "POST" && continueMatch) {
		const parent = findRun(decodeURIComponent(continueMatch[1] ?? ""));
		if (!isTerminalStatus(parent.status)) {
			throw new HttpError(409, "Only a finished run can be continued.");
		}
		if (!parent.capabilities.resume) {
			throw new HttpError(409, `${parent.backendName} does not support continuing sessions.`);
		}
		if (!parent.sessionFile) {
			throw new HttpError(400, `This run has no saved ${parent.backendName} session.`);
		}
		if (parent.worktreeRequested) {
			if (parent.worktreeRemoved) {
				throw new HttpError(409, "The worktree was removed; start a new run instead.");
			}
			const exists = await fsp.stat(parent.cwd).catch(() => null);
			if (!exists?.isDirectory()) {
				throw new HttpError(409, "The worktree is no longer available.");
			}
		}
		const body = await readJson(req);
		const message = readString(body.message, "message", 20_000);
		const session = await enqueueRun(
			{
				boardId: parent.boardId,
				taskId: parent.taskId,
				title: `${parent.title} · continue`,
				prompt: message,
				cwd: parent.cwd,
			},
			{ parent }
		);
		json(res, 201, session.page(0));
		return;
	}

	const messageMatch = /^\/runs\/([^/]+)\/message$/.exec(pathname);
	if (req.method === "POST" && messageMatch) {
		const run = findRun(decodeURIComponent(messageMatch[1] ?? ""));
		if (run.status !== "running") {
			throw new HttpError(409, "Messages can only be sent to a running run.");
		}
		const context = processes.get(run.id);
		if (!context) throw new HttpError(409, `The ${run.backendName} process is not available.`);
		const body = await readJson(req);
		const message = readString(body.message, "message", 20_000);
		const mode = body.mode === "steer" ? "steer" : "follow_up";
		if (mode === "steer" && !run.capabilities.steer) {
			throw new HttpError(409, `${run.backendName} does not support steer messages.`);
		}
		if (mode === "follow_up" && !run.capabilities.followUp) {
			throw new HttpError(409, `${run.backendName} does not support follow-up messages.`);
		}
		const accepted = writeCommand(context, context.backend.messageCommand(mode, message));
		if (!accepted) throw new HttpError(409, `${run.backendName} is not accepting messages.`);
		run.emit("user", message, { mode });
		json(res, 202, { ok: true, run: run.snapshot() });
		return;
	}

	const cleanupMatch = /^\/runs\/([^/]+)\/cleanup$/.exec(pathname);
	if (req.method === "POST" && cleanupMatch) {
		const run = findRun(decodeURIComponent(cleanupMatch[1] ?? ""));
		if (!isTerminalStatus(run.status)) {
			throw new HttpError(409, "Stop the run before removing its worktree.");
		}
		if (run.parentRunId) {
			throw new HttpError(409, "This run reuses its parent worktree; clean the parent run instead.");
		}
		if (!run.worktreePath || run.worktreeRemoved) {
			throw new HttpError(400, "This run has no removable worktree.");
		}
		const status = await gitRun(["-C", run.worktreePath, "status", "--porcelain"]).catch(
			(error) => {
				throw new HttpError(409, `Could not inspect worktree: ${gitError(error)}`);
			}
		);
		if (!isCleanStatus(status.stdout)) {
			throw new HttpError(409, "Worktree has uncommitted changes. Review or commit them first.");
		}
		try {
			await gitRun(["-C", run.baseRepo, "worktree", "remove", run.worktreePath]);
		} catch (error) {
			throw new HttpError(409, `Could not remove worktree: ${gitError(error)}`);
		}
		run.worktreeRemoved = true;
		persistRun(run);
		json(res, 200, run.page(0));
		return;
	}

	throw new HttpError(404, "Not found.");
}

const server = http.createServer((req, res) => {
	handleRequest(req, res).catch((error) => {
		if (error instanceof HttpError) {
			fail(res, error.status, error.message);
			return;
		}
		if (error && typeof error === "object" && typeof error.status === "number") {
			fail(res, error.status, error.message);
			return;
		}
		fail(res, 500, error instanceof Error ? error.message : String(error));
	});
});

let startPromise = null;

export function startRunner() {
	if (startPromise) return startPromise;
	shuttingDown = false;
	startPromise = (async () => {
		await fsp.mkdir(SESSIONS_DIR, { recursive: true }).catch(() => undefined);
		await fsp.mkdir(WORKSPACES_DIR, { recursive: true }).catch(() => undefined);
		await loadHistory();
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(PORT, HOST);
		});
		console.log(`[workbench-runner] listening on http://${HOST}:${PORT}`);
		for (const health of backends.health()) {
			console.log(
				health.available
					? `[workbench-runner] ${health.id} ${health.version} (${health.binary})`
					: `[workbench-runner] ${health.id} unavailable: ${health.error}`
			);
		}
		console.log(`[workbench-runner] default backend: ${backends.defaultId}`);
	})();
	startPromise.catch((error) => {
		startPromise = null;
		console.error("[workbench-runner] start failed:", error);
	});
	return startPromise;
}

export function getRunnerState() {
	return {
		started: startPromise !== null,
		shuttingDown,
		listening: server.listening,
		address: server.address(),
	};
}

export async function stopEmbeddedRunner() {
	const runner = globalThis.__workbenchRunner;
	if (runner?.stopRunner) await runner.stopRunner();
}

export async function stopRunner() {
	shuttingDown = true;
	console.log(`[workbench-runner] stopping ${processes.size} run(s).`);
	for (const context of processes.values()) {
		stopProcess(context, "SIGTERM");
	}
	if (server.listening) {
		await new Promise((resolve) => server.close(() => resolve()));
	}
	startPromise = null;
	shuttingDown = false;
}

function shutdown(signal) {
	if (shuttingDown) {
		process.exit(0);
		return;
	}
	console.log(`[workbench-runner] ${signal}; stopping.`);
	void stopRunner().finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 2_000).unref();
}

if (process.env.WORKBENCH_RUNNER_EMBEDDED === "1") {
	globalThis.__workbenchRunner = { startRunner, stopRunner };
} else {
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void startRunner();
