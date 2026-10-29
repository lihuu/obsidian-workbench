const MAX_EVENTS = 4_000;
const MAX_SUMMARY_CHARS = 24_000;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status);
}

function truncate(text, limit) {
	if (typeof text !== "string") return "";
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[Truncated]`;
}

export function extractMessageText(message) {
	if (!message || typeof message !== "object") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function summarizeToolArgs(toolName, args) {
	if (!args || typeof args !== "object") return toolName;
	if (toolName === "bash" && typeof args.command === "string") {
		return `bash: ${truncate(args.command, 500)}`;
	}
	if (typeof args.path === "string") return `${toolName}: ${args.path}`;
	if (typeof args.file_path === "string") return `${toolName}: ${args.file_path}`;
	return toolName;
}

export class RunSession {
	constructor({ id, boardId, taskId, title, cwd, backendId = "", backendName = "Agent", capabilities = {} }) {
		this.id = id;
		this.boardId = boardId;
		this.taskId = taskId;
		this.title = title;
		this.cwd = cwd;
		this.backendId = backendId;
		this.backendName = backendName;
		this.capabilities = { ...capabilities };
		this.status = "queued";
		this.createdAt = Date.now();
		this.startedAt = null;
		this.endedAt = null;
		this.summary = "";
		this.error = "";
		this.aborting = false;
		this.logPath = null;
		this.sessionFile = "";
		this.sessionId = "";
		this.imageCount = 0;
		this.worktreeRequested = false;
		this.worktreePath = "";
		this.branch = "";
		this.baseRepo = "";
		this.worktreeRemoved = false;
		this.parentRunId = "";
		this.events = [];
		this.seq = 0;
		this.lastAssistantText = "";
		this.lastStopReason = "";
		this.lastAssistantError = "";
	}

	setLogPath(logPath) {
		this.logPath = logPath;
	}

	setBackend(backend) {
		this.backendId = backend.id;
		this.backendName = backend.displayName;
		this.capabilities = { ...backend.capabilities };
	}

	emit(kind, text, extra = {}) {
		this.seq += 1;
		const event = {
			seq: this.seq,
			at: Date.now(),
			kind,
			text: truncate(text, 12_000),
			...extra,
		};
		this.events.push(event);
		if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
		return event;
	}

	markRunning() {
		if (this.status !== "queued") return [];
		this.status = "running";
		this.startedAt = Date.now();
		return [this.emit("status", "Agent started.", { status: "running" })];
	}

	record(event) {
		if (!event || typeof event !== "object" || isTerminalStatus(this.status)) return [];
		const type = event.type;
		const emitted = [];

		switch (type) {
			case "agent_start": {
				emitted.push(...this.markRunning());
				break;
			}
			case "turn_start": {
				emitted.push(this.emit("log", "Turn started."));
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message?.role !== "assistant") break;
				const text = extractMessageText(message);
				if (message.stopReason) this.lastStopReason = message.stopReason;
				if (text) {
					this.lastAssistantText = text;
					this.summary = truncate(text, MAX_SUMMARY_CHARS);
					emitted.push(this.emit("assistant", truncate(text, 12_000)));
				}
				if (message.stopReason === "error") {
					this.lastAssistantError =
						typeof message.errorMessage === "string" && message.errorMessage
							? message.errorMessage
							: text || "The agent reported an assistant error.";
					emitted.push(this.emit("error", this.lastAssistantError));
				}
				break;
			}
			case "tool_execution_start": {
				emitted.push(
					this.emit("tool", summarizeToolArgs(event.toolName, event.args))
				);
				break;
			}
			case "tool_execution_end": {
				const duration =
					typeof event.durationMs === "number" ? ` (${event.durationMs}ms)` : "";
				emitted.push(
					this.emit(
						"tool",
						`${event.toolName ?? "tool"} ${event.isError ? "failed" : "finished"}${duration}`
					)
				);
				break;
			}
			case "auto_retry_start": {
				emitted.push(
					this.emit(
						"log",
						`Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? ""}`
					)
				);
				break;
			}
			case "auto_retry_end": {
				if (event.success === false) {
					this.lastAssistantError = event.finalError ?? "Retry failed.";
					emitted.push(this.emit("error", this.lastAssistantError));
				}
				break;
			}
			case "compaction_start": {
				emitted.push(this.emit("log", `Compacting context (${event.reason}).`));
				break;
			}
			case "compaction_end": {
				emitted.push(
					this.emit(
						"log",
						event.errorMessage
							? `Compaction failed: ${event.errorMessage}`
							: "Compaction finished."
					)
				);
				break;
			}
			case "extension_error": {
				emitted.push(
					this.emit("error", `Extension error: ${event.error ?? "unknown error"}`)
				);
				break;
			}
			case "agent_settled": {
				const cancelled = event.aborted === true || this.aborting;
				if (cancelled) {
					emitted.push(...this.finish("cancelled"));
				} else if (this.lastStopReason === "error") {
					this.error = this.lastAssistantError || "The agent reported an assistant error.";
					emitted.push(...this.finish("failed"));
				} else {
					emitted.push(...this.finish("succeeded"));
				}
				break;
			}
			default:
				break;
		}

		return emitted;
	}

	requestAbort() {
		if (isTerminalStatus(this.status)) return [];
		this.aborting = true;
		return [this.emit("log", "Abort requested.")];
	}

	finish(status) {
		if (isTerminalStatus(this.status)) return [];
		this.status = status;
		this.endedAt = Date.now();
		if (status === "failed" && !this.error) this.error = this.lastAssistantError || "Run failed.";
		const label =
			status === "succeeded" ? "Succeeded." : status === "cancelled" ? "Cancelled." : "Failed.";
		return [this.emit("status", label, { status })];
	}

	finishFromProcess(code, signal) {
		if (isTerminalStatus(this.status)) return [];
		if (this.aborting) return this.finish("cancelled");
		const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
		this.error = `${this.backendName || "Agent"} exited before settling (${detail}).`;
		return [this.emit("error", this.error), ...this.finish("failed")];
	}

	snapshot() {
		return {
			id: this.id,
			boardId: this.boardId,
			taskId: this.taskId,
			title: this.title,
			cwd: this.cwd,
			status: this.status,
			createdAt: this.createdAt,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			summary: this.summary,
			error: this.error,
			aborting: this.aborting,
			logPath: this.logPath,
			backendId: this.backendId,
			backendName: this.backendName,
			capabilities: { ...this.capabilities },
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			imageCount: this.imageCount,
			worktreeRequested: this.worktreeRequested,
			worktreePath: this.worktreePath,
			branch: this.branch,
			baseRepo: this.baseRepo,
			worktreeRemoved: this.worktreeRemoved,
			parentRunId: this.parentRunId,
		};
	}

	static restore(snapshot, events = []) {
		const session = new RunSession({
			id: snapshot.id,
			boardId: snapshot.boardId,
			taskId: snapshot.taskId,
			title: snapshot.title,
			cwd: snapshot.cwd,
		});
		Object.assign(session, {
			status: snapshot.status,
			createdAt: snapshot.createdAt,
			startedAt: snapshot.startedAt,
			endedAt: snapshot.endedAt,
			summary: snapshot.summary ?? "",
			error: snapshot.error ?? "",
			aborting: snapshot.aborting === true,
			logPath: snapshot.logPath ?? null,
			backendId: snapshot.backendId ?? "",
			backendName: snapshot.backendName ?? "Agent",
			capabilities: snapshot.capabilities && typeof snapshot.capabilities === "object" ? { ...snapshot.capabilities } : {},
			sessionFile: snapshot.sessionFile ?? "",
			sessionId: snapshot.sessionId ?? "",
			imageCount: snapshot.imageCount ?? 0,
			worktreeRequested: snapshot.worktreeRequested === true,
			worktreePath: snapshot.worktreePath ?? "",
			branch: snapshot.branch ?? "",
			baseRepo: snapshot.baseRepo ?? "",
			worktreeRemoved: snapshot.worktreeRemoved === true,
			parentRunId: snapshot.parentRunId ?? "",
			events: Array.isArray(events) ? [...events] : [],
			lastAssistantText: snapshot.summary ?? "",
		});
		session.seq = session.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
		return session;
	}

	page(after = 0) {
		const events = this.events.filter((event) => event.seq > after);
		return {
			run: this.snapshot(),
			events,
			nextCursor: events.length > 0 ? events.at(-1).seq : after,
		};
	}
}
