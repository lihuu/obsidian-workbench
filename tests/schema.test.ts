import { describe, expect, it } from "vitest";
import {
	BoardDataError,
	BoardSchemaError,
	parseBoard,
	serializeBoard,
} from "../src/data/schema";
import type { Board } from "../src/data/types";

function makeBoard(): Board {
	return {
		id: "b_abc123",
		name: "Work",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_100,
		columns: [
			{
				id: "c_todo",
				name: "Todo",
				tasks: [
					{
						id: "t_one",
						title: "First task",
						description: "Details",
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_100,
					},
				],
			},
			{ id: "c_doing", name: "Doing", tasks: [] },
			{ id: "c_done", name: "Done", tasks: [] },
		],
	};
}

describe("board schema", () => {
	it("round-trips a valid board", () => {
		const board = makeBoard();
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("round-trips agent-created task metadata", () => {
		const board = makeBoard();
		board.columns[0].tasks[0] = {
			...board.columns[0].tasks[0],
			source: "agent",
			sourceProposalId: "p_123",
			sourceRunId: "r_456",
			sourceTaskId: "t_parent",
		};
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("round-trips imported GitHub task metadata", () => {
		const board = makeBoard();
		board.columns[0].tasks[0] = {
			...board.columns[0].tasks[0],
			source: "github",
			github: {
				repo: "acme/repo",
				type: "pull_request",
				number: 42,
				url: "https://github.com/acme/repo/pull/42",
				state: "MERGED",
				updatedAt: "2026-10-29T00:00:00Z",
				title: "Add sync",
				author: "octocat",
				labels: ["enhancement"],
				isDraft: false,
				headRefName: "feature/sync",
				baseRefName: "main",
				reviewDecision: "APPROVED",
				mergedAt: "2026-10-30T00:00:00Z",
				closedAt: "2026-10-30T00:00:00Z",
				checks: { state: "success", total: 2, success: 2, failure: 0, pending: 0 },
				descriptionHash: "abc123",
			},
		};
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("strips transient drag state when serializing", () => {
		const board = makeBoard();
		board.columns[0].tasks.push({
			id: "t_shadow",
			title: "Shadow",
			description: "",
			createdAt: 1,
			updatedAt: 1,
			isDndShadowItem: true,
		});
		const text = serializeBoard(board);
		expect(text).not.toContain("isDndShadowItem");
		expect(parseBoard(text, "Workbench/boards/b_abc123.json").columns[0].tasks).toHaveLength(1);
	});

	it("defaults a missing description to an empty string", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		delete raw.columns[0].tasks[0].description;
		const parsed = parseBoard(JSON.stringify(raw), "board.json");
		expect(parsed.columns[0].tasks[0].description).toBe("");
	});

	it("rejects malformed JSON", () => {
		expect(() => parseBoard("{", "board.json")).toThrow(BoardDataError);
	});

	it("rejects an unknown newer schema without touching it", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.schemaVersion = 2;
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(BoardSchemaError);
	});

	it("rejects duplicate task ids", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.columns[0].tasks.push({ ...raw.columns[0].tasks[0] });
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/Duplicate IDs/);
	});

	it("rejects duplicate task ids across columns", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.columns[1].tasks.push({ ...raw.columns[0].tasks[0] });
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/Duplicate IDs/);
	});

	it("rejects a board with no columns", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.columns = [];
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/at least one column/);
	});

	it("accepts an arbitrary number of columns", () => {
		const board = makeBoard();
		board.columns.push({ id: "c_review", name: "Review", tasks: [] });
		board.columns.push({ id: "c_due", name: "Due", tasks: [] });
		const parsed = parseBoard(serializeBoard(board), "board.json");
		expect(parsed.columns.map((column) => column.name)).toEqual([
			"Todo",
			"Doing",
			"Done",
			"Review",
			"Due",
		]);
	});

	it("accepts a single column", () => {
		const board = makeBoard();
		board.columns = [board.columns[0]];
		const parsed = parseBoard(serializeBoard(board), "board.json");
		expect(parsed.columns).toHaveLength(1);
	});

	it("rejects duplicate column ids", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.columns[1].id = raw.columns[0].id;
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/Duplicate IDs/);
	});

	it("rejects a board without columns", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		delete raw.columns;
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(BoardDataError);
	});

	it("rejects an empty board name", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.name = "   ";
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(BoardDataError);
	});
});

describe("board agent config", () => {
	it("round-trips a GitHub source and status mapping", () => {
		const board = makeBoard();
		board.agent = {
			github: {
				repoUrl: "https://github.com/owner/repo.git",
				branch: "main",
			},
			statusMapping: {
				successColumnId: "c_done",
				failureColumnId: "c_todo",
			},
		};
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("round-trips a local board with a GitHub sync remote", () => {
		const board = makeBoard();
		board.agent = {
			source: "local",
			github: {
				repoUrl: "https://github.com/owner/repo.git",
				branch: "",
			},
		};
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("rejects an invalid board source", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { source: "remote" };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/agent.source/);
	});

	it("keeps boards without agent config unchanged", () => {
		const text = serializeBoard(makeBoard());
		expect(JSON.parse(text).agent).toBeUndefined();
		expect(parseBoard(text, "board.json").agent).toBeUndefined();
	});

	it("rejects malformed agent config", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { github: { repoUrl: "", branch: "main" } };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/repoUrl/);
	});

	it("rejects non-string status mapping IDs", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { statusMapping: { successColumnId: 42 } };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(BoardDataError);
	});
});

describe("backend board setting", () => {
	it("round-trips the optional execution backend", () => {
		const board = makeBoard();
		board.agent = { backend: "omp", worktree: true };
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("rejects an empty backend id", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { backend: "  " };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/backend/);
	});
});

describe("worktree board setting", () => {
	it("round-trips the optional worktree flag", () => {
		const board = makeBoard();
		board.agent = { worktree: true };
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("rejects a non-boolean worktree flag", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { worktree: "yes" };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(/worktree/);
	});
});

describe("run state column mapping", () => {
	it("round-trips queued/running column ids", () => {
		const board = makeBoard();
		board.agent = {
			runStateMapping: {
				queuedColumnId: "c_queue",
				runningColumnId: "c_doing",
			},
		};
		const parsed = parseBoard(serializeBoard(board), "Workbench/boards/b_abc123.json");
		expect(parsed).toEqual(board);
	});

	it("rejects non-string run state column ids", () => {
		const raw = JSON.parse(serializeBoard(makeBoard()));
		raw.agent = { runStateMapping: { queuedColumnId: 42 } };
		expect(() => parseBoard(JSON.stringify(raw), "board.json")).toThrow(BoardDataError);
	});
});
