import { describe, expect, it } from "vitest";
import { createJsonlDecoder } from "../runner/protocol.mjs";
import { RunSession } from "../runner/run-state.mjs";

function assistantMessage(text, stopReason = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
		},
	};
}

describe("JSONL decoder", () => {
	it("decodes UTF-8 split across chunks without splitting records early", () => {
		const records = [];
		const decoder = createJsonlDecoder(
			(record) => records.push(record),
			(error) => {
				throw error;
			}
		);
		const bytes = Buffer.from('{"type":"message","text":"a😀b\\u2028c"}\n');
		for (const byte of bytes) decoder.push(Buffer.from([byte]));
		decoder.end();

		expect(records).toEqual([{ type: "message", text: "a😀b\u2028c" }]);
	});

	it("accepts CRLF and reports malformed records without stopping", () => {
		const records = [];
		const errors = [];
		const decoder = createJsonlDecoder(
			(record) => records.push(record),
			(error) => errors.push(error)
		);
		decoder.push(Buffer.from('{"ok":true}\r\nnot-json\n{"ok":false}\n'));
		decoder.end();

		expect(records).toEqual([{ ok: true }, { ok: false }]);
		expect(errors).toHaveLength(1);
	});
});

describe("RunSession", () => {
	function makeSession() {
		return new RunSession({
			id: "r_test",
			boardId: "b_board",
			taskId: "t_task",
			title: "Task",
			cwd: "/tmp/work",
		});
	}

	it("does not finish on agent_end before agent_settled", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.record({ type: "agent_end", willRetry: true });
		expect(session.snapshot().status).toBe("running");

		session.record(assistantMessage("Done."));
		session.record({ type: "agent_settled", aborted: false });

		const snapshot = session.snapshot();
		expect(snapshot.status).toBe("succeeded");
		expect(snapshot.summary).toBe("Done.");
	});

	it("marks an aborted settle as cancelled", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.record({ type: "agent_settled", aborted: true });
		expect(session.snapshot().status).toBe("cancelled");
	});

	it("marks an assistant error as failed", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.record(assistantMessage("Provider failed", "error"));
		session.record({ type: "agent_settled", aborted: false });

		const snapshot = session.snapshot();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.error).toContain("Provider failed");
	});

	it("maps tool execution to compact log events", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.record({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "npm test" },
		});
		const events = session.record({
			type: "tool_execution_end",
			toolName: "bash",
			isError: false,
			durationMs: 42,
		});

		expect(session.events.some((event) => event.text.includes("bash: npm test"))).toBe(true);
		expect(events.some((event) => event.text.includes("42ms"))).toBe(true);
	});

	it("handles process exit before settle", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.finishFromProcess(0, null);
		expect(session.snapshot().status).toBe("failed");
		expect(session.snapshot().error).toMatch(/exited/i);
	});

	it("treats process exit after abort as cancelled", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		session.requestAbort();
		session.finishFromProcess(0, null);
		expect(session.snapshot().status).toBe("cancelled");
	});

	it("pages events by sequence", () => {
		const session = makeSession();
		session.record({ type: "agent_start" });
		const page = session.page(0);
		expect(page.events.length).toBeGreaterThan(0);
		expect(page.nextCursor).toBe(page.events.at(-1).seq);
		expect(session.page(page.nextCursor).events).toEqual([]);
	});
});

describe("RunSession restore", () => {
	it("hydrates a terminal snapshot and events", () => {
		const session = new RunSession({
			id: "r_test",
			boardId: "b_board",
			taskId: "t_task",
			title: "Task",
			cwd: "/tmp/work",
		});
		session.record({ type: "agent_start" });
		session.record(assistantMessage("Finished."));
		session.record({ type: "agent_settled", aborted: false });
		const snapshot = session.snapshot();
		const events = [...session.events];

		const restored = RunSession.restore(snapshot, events);
		expect(restored.snapshot()).toMatchObject({
			id: "r_test",
			status: "succeeded",
			summary: "Finished.",
			endedAt: expect.any(Number),
		});
		expect(restored.page(0).events).toEqual(events);
		expect(restored.page(events.at(-1).seq).events).toEqual([]);
	});
});
