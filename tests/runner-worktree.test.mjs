import { describe, expect, it } from "vitest";
import {
	branchForRun,
	isCleanStatus,
	worktreePath,
} from "../runner/worktree.mjs";

describe("branchForRun", () => {
	it("creates a namespaced, safe branch", () => {
		expect(branchForRun("r_abc123")).toBe("wb/r_abc123");
		expect(branchForRun("r_a/b c")).toBe("wb/r_a-b-c");
	});

	it("rejects an empty run id", () => {
		expect(() => branchForRun("")).toThrow(/run id/i);
	});
});

describe("worktreePath", () => {
	it("creates one directory per run, outside the base checkout", () => {
		expect(worktreePath("/tmp/worktrees", "b_board", "r_run")).toBe(
			"/tmp/worktrees/b_board/r_run"
		);
	});

	it("sanitizes path segments", () => {
		expect(worktreePath("/tmp/worktrees", "b/board", "../run")).toBe(
			"/tmp/worktrees/b-board/run"
		);
	});
});

describe("isCleanStatus", () => {
	it("accepts an empty status and rejects modifications", () => {
		expect(isCleanStatus("")).toBe(true);
		expect(isCleanStatus("  \n")).toBe(true);
		expect(isCleanStatus(" M src/main.ts")).toBe(false);
	});
});
