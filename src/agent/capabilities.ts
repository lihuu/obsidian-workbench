import type { RunView } from "./types";

/**
 * Capability gates for run controls. Older persisted runs have no capability
 * snapshot; treat missing flags as enabled to preserve their behavior.
 */
export function canFollowUp(run: RunView | undefined): boolean {
	return isLive(run) && run.capabilities?.followUp !== false;
}

export function canSteer(run: RunView | undefined): boolean {
	return isLive(run) && run.capabilities?.steer !== false;
}

export function canClearQueue(run: RunView | undefined): boolean {
	return isLive(run) && run.capabilities?.clearQueue !== false;
}

export function canContinueRun(run: RunView | undefined): boolean {
	if (!run) return false;
	if (
		run.status !== "succeeded" &&
		run.status !== "failed" &&
		run.status !== "cancelled"
	) {
		return false;
	}
	if (run.capabilities?.resume === false) return false;
	if (!run.sessionFile) return false;
	if (run.worktreeRequested && run.worktreeRemoved) return false;
	return true;
}

function isLive(run: RunView | undefined): run is RunView {
	return run?.status === "running" && run.aborting !== true;
}
