import { describe, expect, it } from "vitest";
import {
	assertBackendContract,
	DEFAULT_CAPABILITIES,
	normalizeCapabilities,
} from "../runner/backends/contract.mjs";
import { createBackendRegistry } from "../runner/backends/index.mjs";
import { OmpBackend } from "../runner/backends/omp.mjs";
import { OpenCodeBackend } from "../runner/backends/opencode.mjs";
import { PiBackend } from "../runner/backends/pi.mjs";
import { RunSession } from "../runner/run-state.mjs";

function fakeBackend(overrides = {}) {
	return {
		id: "fake",
		displayName: "Fake",
		binary: "fake-agent",
		capabilities: normalizeCapabilities(),
		promptMode: "stdin",
		settleOnExit: false,
		probe: () => ({}),
		buildArgs: () => [],
		promptCommand: () => ({}),
		promptArgs: () => [],
		messageCommand: () => ({}),
		abortCommand: () => ({}),
		clearQueueCommand: () => ({}),
		stateCommand: () => ({}),
		handleRecord: () => {},
		...overrides,
	};
}

function makeSession(backend) {
	const session = new RunSession({
		id: "r_test",
		boardId: "b_board",
		taskId: "t_task",
		title: "Task",
		cwd: "/tmp/work",
	});
	session.setBackend(backend);
	session.markRunning();
	return session;
}

function assistantMessage(text) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
		},
	};
}

describe("backend contract", () => {
	it("accepts all registered adapters and a minimal fake backend", () => {
		expect(() => assertBackendContract(new PiBackend())).not.toThrow();
		expect(() => assertBackendContract(new OmpBackend())).not.toThrow();
		expect(() => assertBackendContract(new OpenCodeBackend())).not.toThrow();
		expect(() => assertBackendContract(fakeBackend())).not.toThrow();
	});

	it("rejects a backend with a missing operation", () => {
		const backend = fakeBackend();
		delete backend.abortCommand;
		expect(() => assertBackendContract(backend)).toThrow(/abortCommand/);
	});

	it("rejects missing capability flags", () => {
		const backend = fakeBackend({ capabilities: {} });
		expect(() => assertBackendContract(backend)).toThrow(/streaming/);
	});

	it("normalizes capabilities without accepting non-booleans", () => {
		expect(
			normalizeCapabilities({ steer: false, resume: "yes" })
		).toMatchObject({
			...DEFAULT_CAPABILITIES,
			steer: false,
			resume: true,
		});
	});
});

describe("backend registry", () => {
	it("registers Pi, OMP, and OpenCode with Pi as the default", () => {
		const registry = createBackendRegistry({});
		expect(registry.ids()).toEqual(["pi", "omp", "opencode"]);
		expect(registry.get(undefined).id).toBe("pi");
		expect(registry.get("omp").displayName).toBe("OMP");
		expect(registry.get("opencode").displayName).toBe("OpenCode");
	});

	it("supports a different default backend", () => {
		const registry = createBackendRegistry({ WORKBENCH_DEFAULT_BACKEND: "omp" });
		expect(registry.defaultId).toBe("omp");
		expect(registry.get(undefined).id).toBe("omp");
	});

	it("rejects unknown backends with an HTTP-compatible status", () => {
		const registry = createBackendRegistry({});
		try {
			registry.get("nope");
			throw new Error("expected get() to throw");
		} catch (error) {
			expect(error.message).toMatch(/Unknown execution backend/);
			expect(error.status).toBe(400);
		}
	});
});

describe("Pi and OMP launch arguments", () => {
	it("keeps Pi's session and approval flags", () => {
		const backend = new PiBackend({ binary: "pi-test", model: "m" });
		expect(backend.buildArgs({ sessionsDir: "/tmp/sessions" })).toEqual([
			"--mode",
			"rpc",
			"--no-approve",
			"--session-dir",
			"/tmp/sessions",
			"--model",
			"m",
		]);
		expect(
			backend.buildArgs({ sessionFile: "/tmp/session.jsonl", sessionsDir: "/tmp/sessions" })
		).toEqual([
			"--mode",
			"rpc",
			"--no-approve",
			"--session",
			"/tmp/session.jsonl",
			"--model",
			"m",
		]);
	});

	it("uses OMP's auto-approve and resume flags", () => {
		const backend = new OmpBackend({ binary: "omp-test" });
		expect(backend.capabilities.clearQueue).toBe(false);
		expect(backend.capabilities.steer).toBe(true);
		expect(backend.capabilities.followUp).toBe(true);
		expect(backend.capabilities.resume).toBe(true);
		expect(backend.buildArgs({ sessionsDir: "/tmp/sessions" })).toEqual([
			"--mode",
			"rpc",
			"--auto-approve",
			"--session-dir",
			"/tmp/sessions",
		]);
		expect(
			backend.buildArgs({ sessionFile: "/tmp/session.jsonl", sessionsDir: "/tmp/sessions" })
		).toEqual([
			"--mode",
			"rpc",
			"--auto-approve",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("runs OpenCode as a one-shot JSON CLI and resumes by session id", () => {
		const backend = new OpenCodeBackend({ binary: "opencode-test", model: "provider/model" });
		expect(backend.promptMode).toBe("arg");
		expect(backend.settleOnExit).toBe(true);
		expect(backend.capabilities.steer).toBe(false);
		expect(backend.capabilities.followUp).toBe(false);
		expect(backend.capabilities.clearQueue).toBe(false);
		expect(backend.capabilities.resume).toBe(true);
		expect(backend.capabilities.images).toBe(false);
		expect(backend.abortCommand()).toBeNull();
		expect(backend.buildArgs({})).toEqual([
			"run",
			"--format",
			"json",
			"--standalone",
			"--auto",
			"--model",
			"provider/model",
		]);
		expect(backend.buildArgs({ sessionFile: "ses_123" })).toEqual([
			"run",
			"--format",
			"json",
			"--standalone",
			"--auto",
			"--model",
			"provider/model",
			"--session",
			"ses_123",
		]);
		expect(backend.promptArgs("hello")).toEqual(["hello"]);
	});
});

describe("backend commands", () => {
	it("builds prompt, message, abort, clear, and state commands", () => {
		const backend = new OmpBackend();
		expect(
			backend.promptCommand("hello", [{ type: "image", data: "abc", mimeType: "image/png" }])
		).toMatchObject({
			id: "prompt",
			type: "prompt",
			message: "hello",
			images: [{ type: "image", data: "abc", mimeType: "image/png" }],
		});
		expect(backend.messageCommand("steer", "stop")).toMatchObject({
			type: "steer",
			message: "stop",
		});
		expect(backend.abortCommand()).toEqual({ id: "abort", type: "abort" });
		expect(backend.clearQueueCommand()).toMatchObject({ type: "clear_queue" });
		expect(backend.stateCommand()).toEqual({ id: "state", type: "get_state" });
	});
});

describe("backend event normalization", () => {
	it("maps OMP's session_settled to the normalized settle event", () => {
		const backend = new OmpBackend();
		expect(backend.normalizeRecord({ type: "session_settled", aborted: false })).toMatchObject({
			type: "agent_settled",
			aborted: false,
		});
		expect(backend.normalizeRecord({ type: "agent_settled" })).toMatchObject({
			type: "agent_settled",
		});
	});

	it("finishes an OMP session when session_settled arrives", () => {
		const backend = new OmpBackend();
		const session = makeSession(backend);
		let closed = false;
		const commands = [];
		const context = {
			session,
			writeCommand: (command) => {
				commands.push(command);
				return true;
			},
			closeInputAfterSettle: () => {
				closed = true;
			},
		};

		backend.handleRecord(context, {
			type: "response",
			command: "prompt",
			success: true,
		});
		backend.handleRecord(context, assistantMessage("OMP_OK"));
		backend.handleRecord(context, { type: "session_settled", aborted: false });

		expect(session.status).toBe("succeeded");
		expect(session.summary).toBe("OMP_OK");
		expect(closed).toBe(true);
		expect(commands.some((command) => command.type === "get_state")).toBe(true);
	});

	it("stores the session file from get_state", () => {
		const backend = new OmpBackend();
		const session = makeSession(backend);
		backend.handleRecord(
			{
				session,
				writeCommand: () => true,
				closeInputAfterSettle: () => {},
			},
			{
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: "/tmp/omp.jsonl", sessionId: "s1" },
			}
		);
		expect(session.sessionFile).toBe("/tmp/omp.jsonl");
		expect(session.sessionId).toBe("s1");
	});

	it("preserves backend metadata through snapshot and restore", () => {
		const backend = new OmpBackend();
		const session = makeSession(backend);
		const restored = RunSession.restore(session.snapshot(), session.events);
		expect(restored.backendId).toBe("omp");
		expect(restored.backendName).toBe("OMP");
		expect(restored.capabilities.clearQueue).toBe(false);
		expect(restored.capabilities.resume).toBe(true);
	});

	it("maps OpenCode JSON text, tools, and session id", () => {
		const backend = new OpenCodeBackend();
		const session = makeSession(backend);
		let closed = false;
		const context = {
			session,
			writeCommand: () => true,
			closeInputAfterSettle: () => {
				closed = true;
			},
		};

		backend.handleRecord(context, {
			type: "text",
			sessionID: "ses_123",
			part: { id: "part-1", type: "text", text: "OPENCODE_OK" },
		});
		expect(session.sessionId).toBe("ses_123");
		expect(session.sessionFile).toBe("ses_123");
		expect(session.summary).toBe("OPENCODE_OK");

		backend.handleRecord(context, {
			type: "tool_use",
			sessionID: "ses_123",
			part: {
				id: "part-2",
				tool: "write",
				state: {
					status: "completed",
					input: { path: "/tmp/OPENCODE_OK" },
				},
			},
		});
		expect(session.events.some((event) => event.text.includes("write: /tmp/OPENCODE_OK"))).toBe(
			true
		);
		expect(session.events.some((event) => event.text.includes("write finished"))).toBe(true);

		backend.handleRecord(context, {
			type: "error",
			sessionID: "ses_123",
			error: { message: "provider failed" },
		});
		expect(session.status).toBe("failed");
		expect(session.error).toBe("provider failed");
		expect(closed).toBe(true);
	});

	it("ignores OpenCode transport errors after cancellation", () => {
		const backend = new OpenCodeBackend();
		const session = makeSession(backend);
		session.finish("cancelled");
		const count = session.events.length;
		backend.handleRecord(
			{
				session,
				writeCommand: () => true,
				closeInputAfterSettle: () => {},
			},
			{ type: "error", error: { message: "socket closed" } }
		);
		expect(session.status).toBe("cancelled");
		expect(session.events.length).toBe(count);
	});

	it("auto-cancels extension dialogs", () => {
		const backend = new OmpBackend();
		const session = makeSession(backend);
		const commands = [];
		backend.handleRecord(
			{
				session,
				writeCommand: (command) => {
					commands.push(command);
					return true;
				},
				closeInputAfterSettle: () => {},
			},
			{ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Continue?" }
		);
		expect(commands[0]).toMatchObject({
			type: "extension_ui_response",
			id: "ui-1",
			confirmed: false,
		});
		expect(session.events.some((event) => event.text.includes("Auto-cancelled"))).toBe(true);
	});
});
