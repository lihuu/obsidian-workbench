import { describe, expect, it } from "vitest";
import { ProposalStore } from "../runner/proposals.mjs";

function proposal(overrides = {}) {
	return {
		boardId: "b_board",
		taskId: "t_parent",
		runId: "r_run",
		backendName: "OMP",
		title: "Follow-up task",
		description: "Do the next thing.",
		key: "follow-up-1",
		...overrides,
	};
}

describe("ProposalStore", () => {
	it("adds, lists, and acknowledges a proposal", () => {
		const store = new ProposalStore();
		const created = store.add(proposal());
		expect(created).toMatchObject({
			boardId: "b_board",
			taskId: "t_parent",
			runId: "r_run",
			backendName: "OMP",
			title: "Follow-up task",
		});
		expect(store.list({ boardId: "b_board" })).toEqual([created]);
		expect(store.list({ boardId: "b_other" })).toEqual([]);
		expect(store.ack(created.id)).toEqual(created);
		expect(store.size).toBe(0);
	});

	it("deduplicates retries by key and by content", () => {
		const store = new ProposalStore();
		store.add(proposal());
		expect(() => store.add(proposal())).toThrow(/Duplicate/);
		expect(() =>
			store.add(proposal({ key: "", title: "Other", description: "Other" }))
		).not.toThrow();
	});

	it("enforces a per-run proposal limit", () => {
		const store = new ProposalStore({ limitPerRun: 1 });
		store.add(proposal());
		expect(() =>
			store.add(proposal({ key: "second", title: "Second" }))
		).toThrow(/limit/);
	});

	it("enforces the pending queue cap", () => {
		const store = new ProposalStore({ maxPending: 1 });
		store.add(proposal());
		expect(() =>
			store.add(proposal({ runId: "r_other", key: "other", title: "Other" }))
		).toThrow(/full/);
	});

	it("rejects unknown acknowledgements", () => {
		const store = new ProposalStore();
		expect(() => store.ack("p_missing")).toThrow(/not found/);
	});
});
