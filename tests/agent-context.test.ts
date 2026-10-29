import { describe, expect, it } from "vitest";
import {
	buildTaskPrompt,
	extractWikiLinkTargets,
} from "../src/agent/context";

describe("extractWikiLinkTargets", () => {
	it("extracts unique targets, aliases, and headings", () => {
		const markdown = [
			"Read [[AI/Workbench Pi Agent 集成调研|research]] first.",
			"Then [[Notes/Plan#Phase A]] and ![[image.png]].",
			"Duplicate [[Notes/Plan]] should be ignored.",
		].join("\n");

		expect(extractWikiLinkTargets(markdown)).toEqual([
			"AI/Workbench Pi Agent 集成调研",
			"Notes/Plan",
			"image.png",
		]);
	});

	it("ignores empty and malformed links", () => {
		expect(extractWikiLinkTargets("[[#Heading]] [[|alias]] [[unclosed")).toEqual([]);
	});
});

describe("buildTaskPrompt", () => {
	const base = {
		boardName: "Agent Integration",
		taskId: "t_runner",
		taskTitle: "Runner RPC spike",
		taskDescription: "Spawn Pi and read JSONL events.",
		workspacePath: "/Users/me/obsidian-workbench",
	};

	it("includes the task, workspace, and linked note snapshot", () => {
		const prompt = buildTaskPrompt({
			...base,
			notes: [{ path: "AI/Research.md", content: "Use RPC mode." }],
		});

		expect(prompt).toContain("# Workbench task");
		expect(prompt).toContain("Agent Integration");
		expect(prompt).toContain("Runner RPC spike");
		expect(prompt).toContain("Spawn Pi and read JSONL events.");
		expect(prompt).toContain("/Users/me/obsidian-workbench");
		expect(prompt).toContain("### AI/Research.md");
		expect(prompt).toContain("Use RPC mode.");
		expect(prompt).toContain("Do not modify `Workbench/boards/`");
		expect(prompt).toContain("task-proposals");
		expect(prompt).toContain("$WORKBENCH_RUN_TOKEN");
	});

	it("omits the notes section when no notes are linked", () => {
		const prompt = buildTaskPrompt({ ...base, notes: [] });
		expect(prompt).not.toContain("## Linked notes");
	});

	it("truncates a long note and the total context", () => {
		const prompt = buildTaskPrompt({
			...base,
			notes: [
				{ path: "A.md", content: "a".repeat(20) },
				{ path: "B.md", content: "b".repeat(20) },
				{ path: "C.md", content: "c".repeat(20) },
			],
			maxNoteChars: 10,
			maxTotalChars: 18,
		});

		expect(prompt).toContain("aaaaaaaaaa");
		expect(prompt).toContain("bbbbbbbb");
		expect(prompt).toContain("[Truncated]");
		expect(prompt).not.toContain("cccccccccc");
	});
});
