import { describe, expect, it } from "vitest";
import { canStartQueued, pickNextQueued } from "../runner/queue.mjs";

const activeWorktree = {
	boardId: "b_one",
	taskId: "t_running",
	worktreeRequested: true,
};

describe("canStartQueued", () => {
	it("starts a run when the board has no active run", () => {
		expect(
			canStartQueued(
				{ boardId: "b_one", taskId: "t_next", worktree: false },
				[]
			)
		).toBe(true);
	});

	it("does not start a direct run behind an active run on the same board", () => {
		expect(
			canStartQueued(
				{ boardId: "b_one", taskId: "t_next", worktree: false },
				[activeWorktree]
			)
		).toBe(false);
	});

	it("allows a worktree run beside another worktree run", () => {
		expect(
			canStartQueued(
				{ boardId: "b_one", taskId: "t_next", worktree: true },
				[activeWorktree]
			)
		).toBe(true);
	});

	it("does not start a worktree run beside a direct run", () => {
		expect(
			canStartQueued(
				{ boardId: "b_one", taskId: "t_next", worktree: true },
				[{ ...activeWorktree, worktreeRequested: false }]
			)
		).toBe(false);
	});

	it("never starts a second run for the same task", () => {
		expect(
			canStartQueued(
				{ boardId: "b_one", taskId: "t_running", worktree: true },
				[activeWorktree]
			)
		).toBe(false);
	});
});

describe("pickNextQueued", () => {
	it("picks the first eligible job in FIFO order", () => {
		const jobs = [
			{ id: "q1", boardId: "b_busy", taskId: "t1", worktree: false },
			{ id: "q2", boardId: "b_free", taskId: "t2", worktree: false },
			{ id: "q3", boardId: "b_free", taskId: "t3", worktree: false },
		];
		const active = [{ ...activeWorktree, boardId: "b_busy" }];
		expect(pickNextQueued(jobs, active)?.id).toBe("q2");
	});

	it("returns undefined when every queued job is blocked", () => {
		expect(
			pickNextQueued(
				[{ id: "q1", boardId: "b_one", taskId: "t_next", worktree: false }],
				[activeWorktree]
			)
		).toBeUndefined();
	});
});

import { reorderPending } from "../runner/queue.mjs";

describe("reorderPending", () => {
	it("reorders only the selected board's jobs in place", () => {
		const job = (id, boardId) => ({
			session: { id, boardId },
		});
		const pending = [
			job("a1", "a"),
			job("b1", "b"),
			job("a2", "a"),
			job("a3", "a"),
		];

		const next = reorderPending(pending, "a", ["a3", "a1", "a2"]);
		expect(next.map((entry) => entry.session.id)).toEqual([
			"a3",
			"b1",
			"a1",
			"a2",
		]);
	});

	it("ignores ids that are no longer pending", () => {
		const job = (id) => ({ session: { id, boardId: "a" } });
		const pending = [job("a1"), job("a2")];
		const next = reorderPending(pending, "a", ["gone", "a2", "a1"]);
		expect(next.map((entry) => entry.session.id)).toEqual(["a2", "a1"]);
	});
});
