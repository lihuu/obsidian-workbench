import { spawnSync } from "node:child_process";

/**
 * Shared adapter for the Pi RPC family. Pi and OMP use the same JSONL command
 * transport with a few CLI/event differences, so only those differences belong
 * in subclasses.
 */
export class PiCompatibleBackend {
	constructor({
		id,
		displayName,
		binary,
		model = "",
		autoApproveFlag,
		sessionFlag,
		resumeFlag,
		settleTypes,
		capabilities,
	}) {
		this.id = id;
		this.displayName = displayName;
		this.binary = binary;
		this.model = model;
		this.autoApproveFlag = autoApproveFlag;
		this.sessionFlag = sessionFlag;
		this.resumeFlag = resumeFlag;
		this.settleTypes = new Set(settleTypes);
		this.capabilities = capabilities;
		this.promptMode = "stdin";
		this.settleOnExit = false;
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

	buildArgs({ sessionFile = "", sessionsDir }) {
		const args = ["--mode", "rpc", this.autoApproveFlag];
		if (sessionFile) {
			args.push(this.resumeFlag ?? this.sessionFlag, sessionFile);
		} else {
			args.push("--session-dir", sessionsDir);
		}
		if (this.model) args.push("--model", this.model);
		return args;
	}

	promptCommand(prompt, images = []) {
		return {
			id: "prompt",
			type: "prompt",
			message: prompt,
			...(images.length > 0 ? { images } : {}),
		};
	}

	promptArgs() {
		return [];
	}

	messageCommand(mode, message) {
		return {
			id: `message-${Date.now()}`,
			type: mode,
			message,
		};
	}

	abortCommand() {
		return { id: "abort", type: "abort" };
	}

	clearQueueCommand() {
		return { id: `clear-${Date.now()}`, type: "clear_queue" };
	}

	stateCommand() {
		return { id: "state", type: "get_state" };
	}

	/**
	 * Map backend-specific event names to the normalized RunSession vocabulary.
	 * The Runner only consumes the normalized form.
	 */
	normalizeRecord(record) {
		if (!record || typeof record !== "object") return record;
		if (this.settleTypes.has(record.type)) {
			return { ...record, type: "agent_settled" };
		}
		return record;
	}

	handleRecord(context, record) {
		if (record.type === "response") {
			if (record.command === "get_state" && record.success === true && isRecord(record.data)) {
				context.session.sessionFile =
					typeof record.data.sessionFile === "string" ? record.data.sessionFile : "";
				context.session.sessionId =
					typeof record.data.sessionId === "string" ? record.data.sessionId : "";
				return;
			}
			if (record.id === "prompt" || record.command === "prompt") {
				if (record.success === false) {
					context.session.error =
						record.error ?? `${this.displayName} rejected the prompt.`;
					context.session.finish("failed");
					context.closeInputAfterSettle();
					return;
				}
				if (record.data?.disposition === "handled") {
					context.session.error = "The prompt was handled without starting a run.";
					context.session.finish("failed");
					context.closeInputAfterSettle();
				} else {
					context.writeCommand(this.stateCommand());
				}
			}
			if (record.command === "clear_queue" && record.success === true) {
				const steering = Array.isArray(record.data?.steering)
					? record.data.steering.length
					: 0;
				const followUp = Array.isArray(record.data?.followUp)
					? record.data.followUp.length
					: 0;
				context.session.emit("log", `Cleared ${steering + followUp} queued message(s).`);
				return;
			}
			if (
				(record.command === "steer" || record.command === "follow_up") &&
				record.success === false
			) {
				context.session.emit(
					"error",
					record.error ?? `${this.displayName} rejected ${record.command}.`
				);
				return;
			}
			if (
				(record.id === "abort" || record.command === "abort") &&
				record.success === false
			) {
				context.session.emit(
					"error",
					record.error ?? `${this.displayName} could not abort the run.`
				);
				context.session.finish("cancelled");
				context.closeInputAfterSettle();
			}
			return;
		}

		if (record.type === "extension_ui_request") {
			this.handleExtensionRequest(context, record);
			return;
		}

		context.session.record(this.normalizeRecord(record));
		if (context.session.status === "succeeded" ||
			context.session.status === "failed" ||
			context.session.status === "cancelled") {
			context.closeInputAfterSettle();
		}
	}

	handleExtensionRequest(context, record) {
		const method = record.method;
		if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
			context.writeCommand({
				type: "extension_ui_response",
				id: record.id,
				...(method === "confirm" ? { confirmed: false } : { cancelled: true }),
			});
			context.session.emit(
				"log",
				`Auto-cancelled extension dialog: ${record.title ?? method}`
			);
			return;
		}
		if (method === "notify" && record.message) {
			context.session.emit("log", `Extension: ${record.message}`);
		}
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
