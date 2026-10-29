import { spawnSync } from "node:child_process";
import { normalizeCapabilities } from "./contract.mjs";
import { isTerminalStatus } from "../run-state.mjs";

/**
 * OpenCode is a one-shot JSON CLI: `opencode run --format json ... "prompt"`.
 * It has no live RPC stdin, so steer/follow-up/clear-queue are not advertised.
 * Session continuation uses the OpenCode session id via `--session`.
 */
export class OpenCodeBackend {
	constructor({ binary = "opencode", model = "" } = {}) {
		this.id = "opencode";
		this.displayName = "OpenCode";
		this.binary = binary;
		this.model = model;
		this.promptMode = "arg";
		this.settleOnExit = true;
		this.capabilities = normalizeCapabilities({
			steer: false,
			followUp: false,
			clearQueue: false,
			resume: true,
			images: false,
		});
	}

	probe() {
		const result = spawnSync(this.binary, ["--version"], {
			encoding: "utf8",
			timeout: 5_000,
			env: process.env,
		});
		return {
			id: this.id,
			displayName: this.displayName,
			binary: this.binary,
			available: result.status === 0,
			version: result.status === 0 ? result.stdout.trim() : "",
			error:
				result.status === 0
					? ""
					: result.error?.message ||
						result.stderr?.trim() ||
						`Could not run ${this.displayName}.`,
			capabilities: { ...this.capabilities },
		};
	}

	buildArgs({ sessionFile = "" } = {}) {
		const args = ["run", "--format", "json", "--standalone", "--auto"];
		if (this.model) args.push("--model", this.model);
		if (sessionFile) args.push("--session", sessionFile);
		return args;
	}

	promptArgs(prompt) {
		return [prompt];
	}

	promptCommand() {
		throw new Error("OpenCode uses an argument prompt, not stdin.");
	}

	messageCommand() {
		throw new Error("OpenCode does not support live messages.");
	}

	abortCommand() {
		return null;
	}

	clearQueueCommand() {
		return null;
	}

	stateCommand() {
		return null;
	}

	normalizeRecord(record) {
		return record;
	}

	handleRecord(context, record) {
		if (!isRecord(record)) return;
		const session = context.session;

		if (typeof record.sessionID === "string" && record.sessionID) {
			session.sessionId = record.sessionID;
			// OpenCode resumes by opaque session id, not a file path.
			session.sessionFile = record.sessionID;
		}

		switch (record.type) {
			case "text": {
				const part = record.part;
				const text = typeof part?.text === "string" ? part.text.trim() : "";
				if (!text) break;
				const key = typeof part?.id === "string" ? part.id : `text-${record.timestamp ?? ""}`;
				context.openCodeParts ??= new Map();
				if (context.openCodeParts.get(key) === text) break;
				context.openCodeParts.set(key, text);
				session.record({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "stop",
					},
				});
				break;
			}
			case "tool_use": {
				const part = record.part;
				const toolName = typeof part?.tool === "string" ? part.tool : "tool";
				const state = part?.state;
				const status = typeof state?.status === "string" ? state.status : "";
				session.record({
					type: "tool_execution_start",
					toolName,
					args: isRecord(state?.input) ? state.input : {},
				});
				if (status && status !== "running" && status !== "pending") {
					session.record({
						type: "tool_execution_end",
						toolName,
						isError: status === "error" || status === "failed",
					});
				}
				break;
			}
			case "error": {
				if (session.aborting || isTerminalStatus(session.status)) break;
				const message =
					typeof record.error?.message === "string" && record.error.message
						? record.error.message
						: "OpenCode reported an error.";
				session.error = message;
				session.emit("error", message);
				session.finish("failed");
				context.closeInputAfterSettle();
				break;
			}
			default:
				break;
		}
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
