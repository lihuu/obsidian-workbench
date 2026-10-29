import { randomBytes } from "node:crypto";

export const MAX_PROPOSALS_PER_RUN = 20;
export const MAX_PENDING_PROPOSALS = 200;

/**
 * In-memory proposal queue. Agents never write board files directly; the
 * plugin polls pending proposals and creates tasks through its store.
 */
export class ProposalStore {
	constructor({
		limitPerRun = MAX_PROPOSALS_PER_RUN,
		maxPending = MAX_PENDING_PROPOSALS,
	} = {}) {
		this.limitPerRun = limitPerRun;
		this.maxPending = maxPending;
		this.pending = new Map();
		this.seenKeys = new Set();
	}

	add({ boardId, taskId, runId, backendName = "", title, description = "", key = "" }) {
		if (this.pending.size >= this.maxPending) {
			throw httpError(429, "Task proposal queue is full.");
		}
		const runCount = [...this.pending.values()].filter(
			(proposal) => proposal.runId === runId
		).length;
		if (runCount >= this.limitPerRun) {
			throw httpError(429, `This run reached its ${this.limitPerRun} proposal limit.`);
		}

		const dedupeKey = key.trim()
			? `${runId}:${key.trim()}`
			: `${runId}:${title}\n${description}`;
		if (this.seenKeys.has(dedupeKey)) {
			throw httpError(409, "Duplicate task proposal.");
		}

		const proposal = {
			id: `p_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
			boardId,
			taskId,
			runId,
			backendName,
			title: title.trim(),
			description: description.trim(),
			key: key.trim(),
			createdAt: Date.now(),
		};
		this.pending.set(proposal.id, proposal);
		this.seenKeys.add(dedupeKey);
		return proposal;
	}

	list({ boardId = "" } = {}) {
		return [...this.pending.values()]
			.filter((proposal) => !boardId || proposal.boardId === boardId)
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((proposal) => ({ ...proposal }));
	}

	ack(id) {
		const proposal = this.pending.get(id);
		if (!proposal) throw httpError(404, "Task proposal not found.");
		this.pending.delete(id);
		return proposal;
	}

	get size() {
		return this.pending.size;
	}
}

function httpError(status, message) {
	const error = new Error(message);
	error.status = status;
	return error;
}
