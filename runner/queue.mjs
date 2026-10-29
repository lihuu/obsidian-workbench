/**
 * A queued job is eligible when its board has no active run, or when every
 * active run on that board is a worktree run and the queued job also uses a
 * worktree. Same-task jobs are always blocked.
 */
export function canStartQueued(job, activeRuns) {
	if (!job || !Array.isArray(activeRuns)) return false;
	const boardRuns = activeRuns.filter((run) => run.boardId === job.boardId);
	if (boardRuns.some((run) => run.taskId === job.taskId)) return false;
	if (boardRuns.length === 0) return true;
	if (!job.worktree) return false;
	return boardRuns.every((run) => run.worktreeRequested === true);
}

export function pickNextQueued(jobs, activeRuns) {
	return jobs.find((job) => canStartQueued(job, activeRuns));
}

/**
 * Reorder queued jobs for one board in place. Jobs from other boards keep
 * their positions, so reordering one board cannot starve another board.
 */
export function reorderPending(pending, boardId, orderedIds) {
	const wanted = new Set(orderedIds);
	const jobsById = new Map(
		pending
			.filter((job) => job.session.boardId === boardId && wanted.has(job.session.id))
			.map((job) => [job.session.id, job])
	);
	const ordered = orderedIds
		.map((id) => jobsById.get(id))
		.filter((job) => job !== undefined);
	const positions = [];
	for (let index = 0; index < pending.length; index++) {
		const job = pending[index];
		if (job.session.boardId === boardId && wanted.has(job.session.id)) {
			positions.push(index);
		}
	}
	const next = [...pending];
	positions.forEach((position, index) => {
		if (index < ordered.length) next[position] = ordered[index];
	});
	return next;
}
