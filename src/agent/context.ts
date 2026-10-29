export interface LinkedNote {
	path: string;
	content: string;
}

export interface TaskPromptInput {
	boardName: string;
	taskId: string;
	taskTitle: string;
	taskDescription: string;
	workspacePath: string;
	notes: LinkedNote[];
	imageNames?: string[];
	maxNoteChars?: number;
	maxTotalChars?: number;
}

const DEFAULT_MAX_NOTE_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 60_000;

const WIKI_LINK_PATTERN = /!?\[\[([^\]\n]+?)\]\]/g;

export function extractWikiLinkTargets(markdown: string): string[] {
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
		const raw = match[1] ?? "";
		const withoutAlias = raw.split("|", 1)[0] ?? "";
		const target = withoutAlias.split("#", 1)[0]?.trim() ?? "";
		if (!target || seen.has(target)) continue;
		seen.add(target);
		targets.push(target);
	}
	return targets;
}

function truncateNote(content: string, limit: number): string {
	if (content.length <= limit) return content;
	return `${content.slice(0, limit)}\n\n[Truncated]`;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
	const maxNoteChars = input.maxNoteChars ?? DEFAULT_MAX_NOTE_CHARS;
	const maxTotalChars = input.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

	const lines: string[] = [
		"# Workbench task",
		"",
		`You are executing work from the Workbench board "${input.boardName}".`,
		"",
		"## Task",
		"",
		`- Title: ${input.taskTitle}`,
		`- Task ID: ${input.taskId}`,
		`- Workspace: ${input.workspacePath}`,
		"",
		"## Description",
		"",
		input.taskDescription.trim() || "(No description.)",
	];

	if (input.imageNames && input.imageNames.length > 0) {
		lines.push(
			"",
			"## Attached images",
			"",
			...input.imageNames.map((name) => `- ${name}`)
		);
	}

	if (input.notes.length > 0) {
		let remaining = maxTotalChars;
		const noteSections: string[] = [];
		for (const note of input.notes) {
			if (remaining <= 0) break;
			const allowed = Math.min(maxNoteChars, remaining);
			const content = truncateNote(note.content, allowed);
			noteSections.push(`### ${note.path}\n\n${content}`);
			remaining -= Math.min(note.content.length, allowed);
		}
		if (noteSections.length > 0) {
			lines.push(
				"",
				"## Linked notes",
				"",
				"These are snapshots of the notes linked from the task description.",
				"",
				noteSections.join("\n\n")
			);
		}
	}

	lines.push(
		"",
		"## Creating follow-up tasks",
		"",
		"If this task reveals separable follow-up work, create a task on the same board:",
		"",
		"```bash",
		'curl -sS -X POST "$WORKBENCH_RUNNER_URL/runs/$WORKBENCH_RUN_ID/task-proposals" \\',
		'  -H "Authorization: Bearer $WORKBENCH_RUN_TOKEN" \\',
		'  -H "Content-Type: application/json" \\',
		'  --data \'{"title":"...","description":"...","key":"stable-id"}\'',
		"```",
		"",
		"- Only create tasks that are actionable and inside the workspace.",
		"- Do not create duplicates; reuse the same `key` when retrying.",
		"- The user sees these tasks in the board's Inbox/Backlog.",
		"",
		"## Execution rules",
		"",
		"- Work only inside the workspace above.",
		"- Do not modify `Workbench/boards/` or `.obsidian/`.",
		"- You may read files and run commands needed for the task.",
		"- Run the relevant checks before finishing.",
		"- End with a concise summary: files changed, checks run, and remaining risks.",
		"- If you are blocked, explain exactly what is missing instead of guessing.",
		""
	);

	return lines.join("\n");
}
