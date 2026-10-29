import { App, normalizePath, TFile, TFolder } from "obsidian";
import { createId } from "../util/id";
import { BoardDataError, parseBoard, serializeBoard } from "./schema";
import type { Board } from "./types";

export const WORKBENCH_DIR = "Workbench";
export const BOARDS_DIR = normalizePath("Workbench/boards");
const BOARD_FILE_PATTERN = /^b_[a-z0-9]+\.json$/;

export interface BoardListEntry {
	path: string;
	board: Board | null;
	text: string;
	error?: string;
}

export class BoardConflictError extends Error {
	constructor(public readonly boardId: string) {
		super("Board changed on disk.");
		this.name = "BoardConflictError";
	}
}

export class VaultBoardRepository {
	constructor(private readonly app: App) {}

	boardPath(id: string): string {
		return normalizePath(`${BOARDS_DIR}/${id}.json`);
	}

	isBoardFile(path: string): boolean {
		return BOARD_FILE_PATTERN.test(path.split("/").pop() ?? "");
	}

	boardIdFromPath(path: string): string | null {
		const fileName = path.split("/").pop() ?? "";
		if (!BOARD_FILE_PATTERN.test(fileName)) return null;
		return fileName.slice(0, -".json".length);
	}

	getBoardFile(id: string): TFile | null {
		const file = this.app.vault.getFileByPath(this.boardPath(id));
		return file instanceof TFile ? file : null;
	}

	private async ensureFolder(path: string): Promise<TFolder> {
		const existing = this.app.vault.getFolderByPath(path);
		if (existing) return existing;
		try {
			return await this.app.vault.createFolder(path);
		} catch (error) {
			const retry = this.app.vault.getFolderByPath(path);
			if (retry) return retry;
			throw error;
		}
	}

	async ensureFolders(): Promise<void> {
		await this.ensureFolder(normalizePath(WORKBENCH_DIR));
		await this.ensureFolder(BOARDS_DIR);
	}

	async listBoards(): Promise<BoardListEntry[]> {
		const folder = this.app.vault.getFolderByPath(BOARDS_DIR);
		if (!folder) return [];

		const entries: BoardListEntry[] = [];
		const seen = new Set<string>();

		for (const child of folder.children) {
			if (!(child instanceof TFile) || !BOARD_FILE_PATTERN.test(child.name)) continue;
			try {
				const text = await this.app.vault.read(child);
				const board = parseBoard(text, child.path);
				if (board.id !== child.basename) {
					throw new BoardDataError(child.path, "Board id does not match its filename.");
				}
				if (seen.has(board.id)) {
					throw new BoardDataError(child.path, "Duplicate board id.");
				}
				seen.add(board.id);
				entries.push({ path: child.path, board, text });
			} catch (error) {
				entries.push({
					path: child.path,
					board: null,
					text: "",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		entries.sort((left, right) => {
			const leftTime = left.board?.createdAt ?? Number.MAX_SAFE_INTEGER;
			const rightTime = right.board?.createdAt ?? Number.MAX_SAFE_INTEGER;
			return leftTime - rightTime || left.path.localeCompare(right.path);
		});
		return entries;
	}

	async readBoard(id: string): Promise<{ board: Board; text: string } | null> {
		const file = this.getBoardFile(id);
		if (!file) return null;
		const text = await this.app.vault.read(file);
		const board = parseBoard(text, file.path);
		if (board.id !== id) throw new BoardDataError(file.path, "Board id does not match its filename.");
		return { board, text };
	}

	async createBoard(name: string): Promise<Board> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Board name can't be empty.");
		await this.ensureFolders();

		const now = Date.now();
		const board: Board = {
			id: "",
			name: trimmed,
			createdAt: now,
			updatedAt: now,
			columns: ["Todo", "Doing", "Done"].map((columnName) => ({
				id: createId("c"),
				name: columnName,
				tasks: [],
			})),
		};

		for (let attempt = 0; attempt < 5; attempt++) {
			board.id = createId("b");
			const path = this.boardPath(board.id);
			if (this.app.vault.getAbstractFileByPath(path)) continue;
			try {
				await this.app.vault.create(path, serializeBoard(board));
				return board;
			} catch (error) {
				if (this.app.vault.getAbstractFileByPath(path)) continue;
				throw error;
			}
		}
		throw new Error("Could not allocate a unique board id.");
	}

	/**
	 * Saves only if the file still contains the text we last read. If not,
	 * the write is aborted and the caller must resolve the conflict.
	 */
	async saveBoard(board: Board, expectedText: string | undefined): Promise<string> {
		const file = this.getBoardFile(board.id);
		if (!file) throw new Error("Board file no longer exists.");
		const next = serializeBoard(board);
		let conflicted = false;

		await this.app.vault.process(file, (current) => {
			if (expectedText !== undefined && current !== expectedText) {
				conflicted = true;
				return current;
			}
			return next;
		});

		if (conflicted) throw new BoardConflictError(board.id);
		return next;
	}

	async overwriteBoard(board: Board): Promise<string> {
		const file = this.getBoardFile(board.id);
		if (!file) throw new Error("Board file no longer exists.");
		const next = serializeBoard(board);
		await this.app.vault.modify(file, next);
		return next;
	}

	async deleteBoard(id: string): Promise<void> {
		const file = this.getBoardFile(id);
		if (!file) return;
		await this.app.vault.trash(file, false);
	}
}
