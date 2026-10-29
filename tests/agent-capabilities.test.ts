import { describe, expect, it } from "vitest";
import {
	canClearQueue,
	canContinueRun,
	canFollowUp,
	canSteer,
} from "../src/agent/capabilities";
import type { BackendCapabilities, RunView } from "../src/agent/types";

function makeRun(overrides: Partial<RunView> = {}): RunView {
	const capabilities: BackendCapabilities = {
		streaming: true,
		toolEvents: true,
		abort: true,
		steer: true,
		followUp: true,
		clearQueue: true,
		resume: true,
		images: true,
	};
	return {
		id: "r_test",
		boardId: "b_board",
		taskId: "t_task",
		title: "Task",
		cwd: "/tmp/work",
		status: "running",
		createdAt: 1,
		startedAt: 2,
		endedAt: null,
		summary: "",
		error: "",
		aborting: false,
		logPath: null,
		backendId: "omp",
		backendName: "OMP",
		capabilities,
		sessionFile: "/tmp/session.jsonl",
		sessionId: "s1",
		imageCount: 0,
		worktreeRequested: false,
		worktreePath: "",
		branch: "",
		baseRepo: "",
		worktreeRemoved: false,
		parentRunId: "",
		logs: [],
		nextCursor: 0,
		pollError: "",
		...overrides,
	};
}

describe("run capability gates", () => {
	it("enables live controls for a running backend", () => {
		const run = makeRun();
		expect(canFollowUp(run)).toBe(true);
		expect(canSteer(run)).toBe(true);
		expect(canClearQueue(run)).toBe(true);
		expect(canContinueRun(run)).toBe(false);
	});

	it("hides controls the backend does not support", () => {
		const run = makeRun({
			capabilities: {
				...makeRun().capabilities,
				followUp: false,
				steer: false,
				clearQueue: false,
			},
		});
		expect(canFollowUp(run)).toBe(false);
		expect(canSteer(run)).toBe(false);
		expect(canClearQueue(run)).toBe(false);
	});

	it("hides all live controls while aborting", () => {
		const run = makeRun({ aborting: true });
		expect(canFollowUp(run)).toBe(false);
		expect(canSteer(run)).toBe(false);
		expect(canClearQueue(run)).toBe(false);
	});

	it("offers Continue only for terminal sessions with resume support", () => {
		const run = makeRun({ status: "succeeded", endedAt: 3 });
		expect(canContinueRun(run)).toBe(true);
		expect(
			canContinueRun({
				...run,
				capabilities: { ...run.capabilities, resume: false },
			})
		).toBe(false);
		expect(canContinueRun({ ...run, sessionFile: "" })).toBe(false);
		expect(
			canContinueRun({
				...run,
				worktreeRequested: true,
				worktreeRemoved: true,
			})
		).toBe(false);
		expect(canContinueRun(undefined)).toBe(false);
	});
});
