import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "../runner/run-env.mjs";

describe("buildAgentEnv", () => {
	it("injects the run context and scoped proposal token", () => {
		const env = buildAgentEnv({
			baseEnv: { PATH: "/bin", WORKBENCH_RUNNER_TOKEN: "global-secret" },
			cwd: "/tmp/work",
			runnerUrl: "http://127.0.0.1:4319",
			runId: "r_1",
			boardId: "b_1",
			taskId: "t_1",
			proposalToken: "run-secret",
		});
		expect(env).toMatchObject({
			PATH: "/bin",
			PWD: "/tmp/work",
			WORKBENCH_RUNNER_URL: "http://127.0.0.1:4319",
			WORKBENCH_RUN_ID: "r_1",
			WORKBENCH_RUN_TOKEN: "run-secret",
			WORKBENCH_BOARD_ID: "b_1",
			WORKBENCH_TASK_ID: "t_1",
		});
		expect(env.WORKBENCH_RUNNER_TOKEN).toBeUndefined();
	});

	it("does not mutate the base environment", () => {
		const baseEnv = { WORKBENCH_RUNNER_TOKEN: "global-secret" };
		buildAgentEnv({
			baseEnv,
			cwd: "/tmp/work",
			runnerUrl: "http://127.0.0.1:4319",
			runId: "r_1",
			boardId: "b_1",
			taskId: "t_1",
			proposalToken: "run-secret",
		});
		expect(baseEnv.WORKBENCH_RUNNER_TOKEN).toBe("global-secret");
	});
});
