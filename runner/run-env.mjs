/**
 * Build the environment for an agent subprocess. The global Runner token must
 * never be visible to an agent; only the scoped per-run proposal token is.
 */
export function buildAgentEnv({
	baseEnv = process.env,
	cwd,
	runnerUrl,
	runId,
	boardId,
	taskId,
	proposalToken,
}) {
	const env = { ...baseEnv };
	delete env.WORKBENCH_RUNNER_TOKEN;
	return {
		...env,
		PWD: cwd,
		WORKBENCH_RUNNER_URL: runnerUrl,
		WORKBENCH_RUN_ID: runId,
		WORKBENCH_RUN_TOKEN: proposalToken,
		WORKBENCH_BOARD_ID: boardId,
		WORKBENCH_TASK_ID: taskId,
	};
}
