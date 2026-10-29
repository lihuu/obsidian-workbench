import type { GitHubChecks } from "../agent/types";
import type {
	Board,
	BoardAgentConfig,
	BoardFile,
	BoardRunStateMapping,
	BoardStatusMapping,
	Column,
	Task,
} from "./types";
import { isRecord } from "./guards";

export const CURRENT_SCHEMA_VERSION = 1;
export const BOARD_ID_PATTERN = /^b_[a-z0-9]+$/;

export class BoardDataError extends Error {
	constructor(public readonly path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "BoardDataError";
	}
}

export class BoardSchemaError extends BoardDataError {
	constructor(path: string, public readonly schemaVersion: number) {
		super(path, `Board schema v${schemaVersion} is newer than this plugin supports.`);
		this.name = "BoardSchemaError";
	}
}

function readString(value: unknown, field: string, path: string): string {
	if (typeof value !== "string") throw new BoardDataError(path, `${field} must be a string.`);
	return value;
}

function readNumber(value: unknown, field: string, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new BoardDataError(path, `${field} must be a finite number.`);
	}
	return value;
}

function assertUnique(ids: string[], scope: string, path: string): void {
	if (new Set(ids).size !== ids.length) {
		throw new BoardDataError(path, `Duplicate IDs in ${scope}.`);
	}
}

function parseTaskGitHub(value: unknown, path: string): Task["github"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new BoardDataError(path, "task.github must be an object.");
	const repo = readString(value.repo, "task.github.repo", path).trim();
	const type = readString(value.type, "task.github.type", path);
	if (type !== "issue" && type !== "pull_request") {
		throw new BoardDataError(path, "task.github.type must be issue or pull_request.");
	}
	const number = readNumber(value.number, "task.github.number", path);
	if (!Number.isInteger(number) || number <= 0) {
		throw new BoardDataError(path, "task.github.number must be a positive integer.");
	}
	const labels = Array.isArray(value.labels)
		? value.labels.filter((label): label is string => typeof label === "string")
		: undefined;
	const checks: GitHubChecks | undefined = isRecord(value.checks)
		? {
				state:
					value.checks.state === "success" ||
					value.checks.state === "failure" ||
					value.checks.state === "pending" ||
					value.checks.state === "none"
						? value.checks.state
						: "none",
				total: typeof value.checks.total === "number" ? value.checks.total : 0,
				success: typeof value.checks.success === "number" ? value.checks.success : 0,
				failure: typeof value.checks.failure === "number" ? value.checks.failure : 0,
				pending: typeof value.checks.pending === "number" ? value.checks.pending : 0,
			}
		: undefined;
	return {
		repo,
		type,
		number,
		url: typeof value.url === "string" ? value.url : "",
		state: typeof value.state === "string" ? value.state : "",
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.author === "string" ? { author: value.author } : {}),
		...(labels ? { labels } : {}),
		...(typeof value.isDraft === "boolean" ? { isDraft: value.isDraft } : {}),
		...(typeof value.headRefName === "string"
			? { headRefName: value.headRefName }
			: {}),
		...(typeof value.baseRefName === "string"
			? { baseRefName: value.baseRefName }
			: {}),
		...(typeof value.reviewDecision === "string" || value.reviewDecision === null
			? { reviewDecision: value.reviewDecision }
			: {}),
		...(typeof value.mergedAt === "string" || value.mergedAt === null
			? { mergedAt: value.mergedAt }
			: {}),
		...(typeof value.closedAt === "string" || value.closedAt === null
			? { closedAt: value.closedAt }
			: {}),
		...(checks ? { checks } : {}),
		...(typeof value.descriptionHash === "string"
			? { descriptionHash: value.descriptionHash }
			: {}),
	};
}

function parseTask(value: unknown, path: string): Task {
	if (!isRecord(value)) throw new BoardDataError(path, "Task must be an object.");
	const id = readString(value.id, "task.id", path);
	const title = readString(value.title, "task.title", path);
	const description = typeof value.description === "string" ? value.description : "";
	const github = parseTaskGitHub(value.github, path);
	return {
		id,
		title,
		description,
		createdAt: readNumber(value.createdAt, "task.createdAt", path),
		updatedAt: readNumber(value.updatedAt, "task.updatedAt", path),
		...(value.source === "agent" || value.source === "github"
			? { source: value.source }
			: {}),
		...(typeof value.sourceProposalId === "string" && value.sourceProposalId.trim()
			? { sourceProposalId: value.sourceProposalId.trim() }
			: {}),
		...(typeof value.sourceRunId === "string" && value.sourceRunId.trim()
			? { sourceRunId: value.sourceRunId.trim() }
			: {}),
		...(typeof value.sourceTaskId === "string" && value.sourceTaskId.trim()
			? { sourceTaskId: value.sourceTaskId.trim() }
			: {}),
		...(github ? { github } : {}),
	};
}

function parseColumn(value: unknown, path: string): Column {
	if (!isRecord(value)) throw new BoardDataError(path, "Column must be an object.");
	const id = readString(value.id, "column.id", path);
	const name = readString(value.name, "column.name", path);
	if (!Array.isArray(value.tasks)) throw new BoardDataError(path, "column.tasks must be an array.");
	const tasks = value.tasks.map((task) => parseTask(task, path));
	assertUnique(tasks.map((task) => task.id), `column ${id}`, path);
	return { id, name, tasks };
}


function parseStatusMapping(value: unknown, path: string): BoardStatusMapping {
	if (!isRecord(value)) throw new BoardDataError(path, "agent.statusMapping must be an object.");
	const mapping: BoardStatusMapping = {};
	if (value.successColumnId !== undefined) {
		mapping.successColumnId = readString(
			value.successColumnId,
			"agent.statusMapping.successColumnId",
			path
		);
	}
	if (value.failureColumnId !== undefined) {
		mapping.failureColumnId = readString(
			value.failureColumnId,
			"agent.statusMapping.failureColumnId",
			path
		);
	}
	return mapping;
}

function parseRunStateMapping(value: unknown, path: string): BoardRunStateMapping {
	if (!isRecord(value)) throw new BoardDataError(path, "agent.runStateMapping must be an object.");
	const mapping: BoardRunStateMapping = {};
	if (value.queuedColumnId !== undefined) {
		mapping.queuedColumnId = readString(
			value.queuedColumnId,
			"agent.runStateMapping.queuedColumnId",
			path
		);
	}
	if (value.runningColumnId !== undefined) {
		mapping.runningColumnId = readString(
			value.runningColumnId,
			"agent.runStateMapping.runningColumnId",
			path
		);
	}
	return mapping;
}

function parseAgent(value: unknown, path: string): BoardAgentConfig | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new BoardDataError(path, "agent must be an object.");
	const agent: BoardAgentConfig = {};
	if (value.backend !== undefined) {
		const backend = readString(value.backend, "agent.backend", path).trim();
		if (!backend) throw new BoardDataError(path, "agent.backend is empty.");
		agent.backend = backend;
	}
	if (value.source !== undefined) {
		const source = readString(value.source, "agent.source", path);
		if (source !== "local" && source !== "github") {
			throw new BoardDataError(path, "agent.source must be local or github.");
		}
		agent.source = source;
	}
	if (value.github !== undefined) {
		if (!isRecord(value.github)) {
			throw new BoardDataError(path, "agent.github must be an object.");
		}
		const repoUrl = readString(value.github.repoUrl, "agent.github.repoUrl", path).trim();
		if (!repoUrl) throw new BoardDataError(path, "agent.github.repoUrl is empty.");
		agent.github = {
			repoUrl,
			branch:
				typeof value.github.branch === "string" ? value.github.branch.trim() : "",
		};
	}
	if (value.statusMapping !== undefined) {
		agent.statusMapping = parseStatusMapping(value.statusMapping, path);
	}
	if (value.runStateMapping !== undefined) {
		agent.runStateMapping = parseRunStateMapping(value.runStateMapping, path);
	}
	if (value.worktree !== undefined) {
		if (typeof value.worktree !== "boolean") {
			throw new BoardDataError(path, "agent.worktree must be a boolean.");
		}
		agent.worktree = value.worktree;
	}
	return agent;
}

export function parseBoard(text: string, filePath: string): Board {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new BoardDataError(filePath, "File is not valid JSON.");
	}
	if (!isRecord(raw)) throw new BoardDataError(filePath, "Board must be a JSON object.");

	const schemaVersion = raw.schemaVersion;
	if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
		throw new BoardDataError(filePath, "schemaVersion is missing or invalid.");
	}
	if (schemaVersion > CURRENT_SCHEMA_VERSION) {
		throw new BoardSchemaError(filePath, schemaVersion);
	}
	if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
		throw new BoardDataError(filePath, `Unsupported schema version ${schemaVersion}.`);
	}

	const id = readString(raw.id, "id", filePath);
	if (!BOARD_ID_PATTERN.test(id)) throw new BoardDataError(filePath, "Board id is invalid.");
	const name = readString(raw.name, "name", filePath).trim();
	if (!name) throw new BoardDataError(filePath, "Board name is empty.");
	if (!Array.isArray(raw.columns)) throw new BoardDataError(filePath, "columns must be an array.");
	const columns = raw.columns.map((column) => parseColumn(column, filePath));
	if (columns.length === 0) throw new BoardDataError(filePath, "Board must have at least one column.");
	assertUnique(columns.map((column) => column.id), "board columns", filePath);
	assertUnique(
		columns.flatMap((column) => column.tasks.map((task) => task.id)),
		"board tasks",
		filePath
	);

	const agent = parseAgent(raw.agent, filePath);
	return {
		id,
		name,
		createdAt: readNumber(raw.createdAt, "createdAt", filePath),
		updatedAt: readNumber(raw.updatedAt, "updatedAt", filePath),
		columns,
		...(agent ? { agent } : {}),
	};
}

export function serializeBoard(board: Board): string {
	const clean: BoardFile = {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		id: board.id,
		name: board.name,
		createdAt: board.createdAt,
		updatedAt: board.updatedAt,
		...(board.agent
			? {
					agent: {
						...(board.agent.backend
							? { backend: board.agent.backend }
							: {}),
						...(board.agent.source
							? { source: board.agent.source }
							: {}),
						...(board.agent.github
							? {
									github: {
										repoUrl: board.agent.github.repoUrl,
										branch: board.agent.github.branch,
									},
								}
							: {}),
						...(board.agent.statusMapping
							? { statusMapping: { ...board.agent.statusMapping } }
							: {}),
						...(board.agent.runStateMapping
							? { runStateMapping: { ...board.agent.runStateMapping } }
							: {}),
						...(board.agent.worktree !== undefined
							? { worktree: board.agent.worktree }
							: {}),
					},
				}
			: {}),
		columns: board.columns.map((column) => ({
			id: column.id,
			name: column.name,
			tasks: column.tasks
				.filter((task) => !task.isDndShadowItem)
				.map((task) => ({
					id: task.id,
					title: task.title,
					description: task.description,
					createdAt: task.createdAt,
					updatedAt: task.updatedAt,
					...(task.source ? { source: task.source } : {}),
					...(task.sourceProposalId
						? { sourceProposalId: task.sourceProposalId }
						: {}),
					...(task.sourceRunId ? { sourceRunId: task.sourceRunId } : {}),
					...(task.sourceTaskId ? { sourceTaskId: task.sourceTaskId } : {}),
					...(task.github ? { github: { ...task.github } } : {}),
				})),
		})),
	};
	return `${JSON.stringify(clean, null, 2)}\n`;
}
