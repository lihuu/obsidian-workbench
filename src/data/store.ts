import { App, TAbstractFile, TFile, type EventRef } from "obsidian";
import { get, writable, type Readable } from "svelte/store";
import { createId } from "../util/id";
import { PluginDeviceState } from "./device-state";
import { BoardConflictError, VaultBoardRepository } from "./repository";
import { parseBoard, serializeBoard } from "./schema";
import type {
	Board,
	BoardAgentConfig,
	Column,
	Task,
	TaskPatch,
} from "./types";

export type LoadState = "idle" | "loading" | "ready" | "error";
export type SaveState = "idle" | "saving" | "saved" | "error";

export interface CorruptBoard {
	path: string;
	message: string;
}

export interface WorkbenchSnapshot {
	boards: Board[];
	activeBoardId: string | null;
	loadState: LoadState;
	loadError: string | null;
	corruptBoards: CorruptBoard[];
	saveState: SaveState;
	saveError: string | null;
	conflictBoardIds: string[];
}

export function createInitialSnapshot(): WorkbenchSnapshot {
	return {
		boards: [],
		activeBoardId: null,
		loadState: "idle",
		loadError: null,
		corruptBoards: [],
		saveState: "idle",
		saveError: null,
		conflictBoardIds: [],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class WorkbenchStore implements Readable<WorkbenchSnapshot> {
	private readonly state = writable<WorkbenchSnapshot>(createInitialSnapshot());
	readonly subscribe = this.state.subscribe;

	private readonly knownTexts = new Map<string, string>();
	private readonly pendingTimers = new Map<string, number>();
	private readonly dirty = new Set<string>();
	private readonly saving = new Set<string>();
	private readonly pendingSaves = new Set<string>();
	private readonly refs: EventRef[] = [];
	private loadPromise: Promise<void> | null = null;
	private refreshTimer: number | undefined;
	private closeFlagTimer: number | undefined;
	private quitting = false;
	private disposed = false;

	constructor(
		private readonly app: App,
		private readonly repository: VaultBoardRepository,
		private readonly deviceState: PluginDeviceState
	) {
		this.refs.push(
			app.vault.on("modify", (file) => {
				void this.onVaultModify(file);
			})
		);
		this.refs.push(
			app.vault.on("create", (file) => {
				this.onVaultStructureChange(file);
			})
		);
		this.refs.push(
			app.vault.on("delete", (file) => {
				this.onVaultDelete(file);
			})
		);
		this.refs.push(
			app.vault.on("rename", (file) => {
				this.onVaultStructureChange(file);
			})
		);
	}

	getSnapshot(): WorkbenchSnapshot {
		return get(this.state);
	}

	load(): Promise<void> {
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.doLoad();
		return this.loadPromise;
	}

	retryLoad(): Promise<void> {
		this.loadPromise = null;
		return this.load();
	}

	private async doLoad(): Promise<void> {
		this.patch({ loadState: "loading", loadError: null });
		try {
			const entries = await this.repository.listBoards();
			const boards: Board[] = [];
			const corruptBoards: CorruptBoard[] = [];
			this.knownTexts.clear();

			for (const entry of entries) {
				if (entry.board) {
					boards.push(entry.board);
					this.knownTexts.set(entry.board.id, entry.text);
				} else if (entry.error) {
					corruptBoards.push({ path: entry.path, message: entry.error });
				}
			}

			const device = await this.deviceState.load();
			const activeBoardId =
				boards.find((board) => board.id === device.lastBoardId)?.id ??
				boards[0]?.id ??
				null;

			this.patch({
				boards,
				activeBoardId,
				loadState: "ready",
				corruptBoards,
				saveState: "idle",
				saveError: null,
			});
		} catch (error) {
			this.loadPromise = null;
			this.patch({
				loadState: "error",
				loadError: errorMessage(error),
			});
		}
	}

	async createBoard(name: string): Promise<Board> {
		const board = await this.repository.createBoard(name);
		const boards = [
			...this.getSnapshot().boards.filter((candidate) => candidate.id !== board.id),
			board,
		].sort((left, right) => left.createdAt - right.createdAt);
		this.knownTexts.set(board.id, serializeBoard(board));
		this.patch({
			boards,
			activeBoardId: board.id,
			saveState: "saved",
			saveError: null,
		});
		this.persistActiveBoard(board.id);
		return board;
	}

	renameBoard(boardId: string, name: string): void {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Board name can't be empty.");
		this.updateBoard(
			boardId,
			(board) => ({ ...board, name: trimmed, updatedAt: Date.now() }),
			true
		);
	}

	async deleteBoard(boardId: string): Promise<void> {
		await this.repository.deleteBoard(boardId);
		this.clearBoardTimers(boardId);
		this.knownTexts.delete(boardId);
		this.dirty.delete(boardId);

		const boards = this.getSnapshot().boards.filter((board) => board.id !== boardId);
		const activeBoardId =
			this.getSnapshot().activeBoardId === boardId
				? (boards[0]?.id ?? null)
				: this.getSnapshot().activeBoardId;
		this.patch({ boards, activeBoardId });
		this.persistActiveBoard(activeBoardId);
	}

	setWorkbenchOpen(open: boolean): void {
		if (open && this.closeFlagTimer !== undefined) {
			window.clearTimeout(this.closeFlagTimer);
			this.closeFlagTimer = undefined;
		}
		void this.deviceState.save({ workbenchOpen: open }).catch(() => {
			// Device-local UI state is not critical.
		});
	}

	scheduleWorkbenchClosed(): void {
		if (this.closeFlagTimer !== undefined) window.clearTimeout(this.closeFlagTimer);
		this.closeFlagTimer = window.setTimeout(() => {
			this.closeFlagTimer = undefined;
			if (this.quitting) return;
			void this.deviceState.save({ workbenchOpen: false }).catch(() => {
				// Device-local UI state is not critical.
			});
		}, 1000);
	}

	markQuitting(): void {
		this.quitting = true;
		if (this.closeFlagTimer !== undefined) {
			window.clearTimeout(this.closeFlagTimer);
			this.closeFlagTimer = undefined;
		}
	}

	setActiveBoard(boardId: string | null): void {
		const snapshot = this.getSnapshot();
		const nextId =
			boardId && snapshot.boards.some((board) => board.id === boardId)
				? boardId
				: (snapshot.boards[0]?.id ?? null);
		this.patch({ activeBoardId: nextId });
		this.persistActiveBoard(nextId);
	}

	addColumn(boardId: string, name: string, beforeColumnId?: string): Column {
		const board = this.getBoard(boardId);
		if (!board) throw new Error("Board not found.");
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Column name can't be empty.");
		if (
			board.columns.some(
				(column) => column.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
			)
		) {
			throw new Error("A column with this name already exists.");
		}
		const column: Column = { id: createId("c"), name: trimmed, tasks: [] };
		this.updateBoard(
			boardId,
			(current) => {
				const before = beforeColumnId
					? current.columns.findIndex((candidate) => candidate.id === beforeColumnId)
					: -1;
				const columns = [...current.columns];
				if (before >= 0) columns.splice(before, 0, column);
				else columns.push(column);
				return {
					...current,
					updatedAt: Date.now(),
					columns,
				};
			},
			true
		);
		return column;
	}

	moveColumn(boardId: string, columnId: string, beforeColumnId: string): boolean {
		const board = this.getBoard(boardId);
		if (!board || columnId === beforeColumnId) return false;
		const column = board.columns.find((candidate) => candidate.id === columnId);
		const before = board.columns.findIndex(
			(candidate) => candidate.id === beforeColumnId
		);
		if (!column || before < 0) return false;
		const from = board.columns.findIndex((candidate) => candidate.id === columnId);
		if (from < 0) return false;
		// Already before the target: nothing to do.
		if (from < before) return false;
		this.updateBoard(
			boardId,
			(current) => {
				const next = current.columns.filter((candidate) => candidate.id !== columnId);
				const target = next.findIndex((candidate) => candidate.id === beforeColumnId);
				next.splice(target >= 0 ? target : next.length, 0, column);
				return { ...current, updatedAt: Date.now(), columns: next };
			},
			true
		);
		return true;
	}

	renameColumn(boardId: string, columnId: string, name: string): void {
		const board = this.getBoard(boardId);
		if (!board) throw new Error("Board not found.");
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Column name can't be empty.");
		if (
			board.columns.some(
				(column) =>
					column.id !== columnId &&
					column.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
			)
		) {
			throw new Error("A column with this name already exists.");
		}
		this.updateBoard(
			boardId,
			(current) => ({
				...current,
				updatedAt: Date.now(),
				columns: current.columns.map((column) =>
					column.id === columnId ? { ...column, name: trimmed } : column
				),
			}),
			true
		);
	}

	deleteColumn(boardId: string, columnId: string): void {
		const board = this.getBoard(boardId);
		if (!board) throw new Error("Board not found.");
		const column = board.columns.find((candidate) => candidate.id === columnId);
		if (!column) return;
		if (board.columns.length <= 1) {
			throw new Error("A board must keep at least one column.");
		}
		const remaining = board.columns.filter((candidate) => candidate.id !== columnId);
		const target = remaining[0];
		const now = Date.now();
		const movedTasks = column.tasks
			.filter((task) => !task.isDndShadowItem)
			.map((task) => ({ ...task, updatedAt: now }));

		this.updateBoard(
			boardId,
			(current) => ({
				...current,
				updatedAt: now,
				columns: remaining.map((candidate) =>
					candidate.id === target.id && movedTasks.length > 0
						? { ...candidate, tasks: [...candidate.tasks, ...movedTasks] }
						: candidate
				),
			}),
			true
		);
	}

	addTask(boardId: string, columnId: string, title: string): Task {
		const now = Date.now();
		const task: Task = {
			id: createId("t"),
			title: title.trim(),
			description: "",
			createdAt: now,
			updatedAt: now,
		};
		this.updateBoard(
			boardId,
			(board) => ({
				...board,
				updatedAt: now,
				columns: board.columns.map((column) =>
					column.id === columnId
						? { ...column, tasks: [...column.tasks, task] }
						: column
				),
			}),
			true
		);
		return task;
	}

	updateTask(boardId: string, taskId: string, patch: TaskPatch): void {
		const now = Date.now();
		this.updateBoard(
			boardId,
			(board) => ({
				...board,
				updatedAt: now,
				columns: board.columns.map((column) => ({
					...column,
					tasks: column.tasks.map((task) =>
						task.id === taskId ? { ...task, ...patch, updatedAt: now } : task
					),
				})),
			}),
			true
		);
	}

	setBoardAgent(boardId: string, agent: BoardAgentConfig | undefined): void {
		const now = Date.now();
		this.updateBoard(
			boardId,
			(board) => {
				const next = { ...board, updatedAt: now };
				if (agent) next.agent = agent;
				else delete next.agent;
				return next;
			},
			true
		);
	}

	moveTask(boardId: string, taskId: string, columnId: string): boolean {
		const board = this.getBoard(boardId);
		if (!board) return false;
		const source = board.columns.find((column) =>
			column.tasks.some((task) => task.id === taskId)
		);
		const target = board.columns.find((column) => column.id === columnId);
		if (!source || !target || source.id === target.id) return false;
		const task = source.tasks.find((candidate) => candidate.id === taskId);
		if (!task) return false;
		const now = Date.now();
		this.updateBoard(
			boardId,
			(current) => ({
				...current,
				updatedAt: now,
				columns: current.columns.map((column) => {
					if (column.id === source.id) {
						return {
							...column,
							tasks: column.tasks.filter((candidate) => candidate.id !== taskId),
						};
					}
					if (column.id === target.id) {
						return {
							...column,
							tasks: [...column.tasks, { ...task, updatedAt: now }],
						};
					}
					return column;
				}),
			}),
			true
		);
		return true;
	}

	deleteTask(boardId: string, taskId: string): void {
		const now = Date.now();
		this.updateBoard(
			boardId,
			(board) => ({
				...board,
				updatedAt: now,
				columns: board.columns.map((column) => ({
					...column,
					tasks: column.tasks.filter((task) => task.id !== taskId),
				})),
			}),
			true
		);
	}

	setColumns(boardId: string, columns: Column[]): void {
		const board = this.getBoard(boardId);
		if (!board) return;

		const cleanColumns = columns.map((column) => ({
			...column,
			tasks: column.tasks.filter((task) => !task.isDndShadowItem),
		}));
		const beforeIds = this.flattenTaskIds(board.columns);
		const afterIds = this.flattenTaskIds(cleanColumns);
		const beforeColumns = board.columns.map((column) => column.id).sort();
		const afterColumns = cleanColumns.map((column) => column.id).sort();

		const sameTaskSet =
			beforeIds.length === afterIds.length &&
			new Set(afterIds).size === afterIds.length &&
			beforeIds.every((id) => afterIds.includes(id));
		const sameColumns =
			beforeColumns.length === afterColumns.length &&
			beforeColumns.every((id, index) => id === afterColumns[index]);

		if (!sameTaskSet || !sameColumns) {
			this.patch({
				saveState: "error",
				saveError: "The board state was inconsistent and was not saved.",
			});
			void this.reloadBoard(boardId);
			return;
		}

		this.updateBoard(
			boardId,
			(current) => ({ ...current, updatedAt: Date.now(), columns: cleanColumns }),
			true
		);
	}

	async reloadBoard(boardId: string): Promise<void> {
		const result = await this.repository.readBoard(boardId);
		if (!result) return;
		this.knownTexts.set(boardId, result.text);
		this.patch({
			boards: this.getSnapshot().boards.map((board) =>
				board.id === boardId ? result.board : board
			),
			conflictBoardIds: this.getSnapshot().conflictBoardIds.filter(
				(id) => id !== boardId
			),
			saveState: "saved",
			saveError: null,
		});
	}

	async resolveConflictReload(boardId: string): Promise<void> {
		this.clearBoardTimers(boardId);
		this.dirty.delete(boardId);
		await this.reloadBoard(boardId);
	}

	async resolveConflictOverwrite(boardId: string): Promise<void> {
		const board = this.getBoard(boardId);
		if (!board) return;
		try {
			const text = await this.repository.overwriteBoard(board);
			this.knownTexts.set(boardId, text);
			this.dirty.delete(boardId);
			this.patch({
				conflictBoardIds: this.getSnapshot().conflictBoardIds.filter(
					(id) => id !== boardId
				),
				saveState: "saved",
				saveError: null,
			});
		} catch (error) {
			this.patch({ saveState: "error", saveError: errorMessage(error) });
		}
	}

	retrySave(): void {
		const snapshot = this.getSnapshot();
		const boardId =
			snapshot.activeBoardId ?? [...this.dirty][0] ?? snapshot.boards[0]?.id;
		if (!boardId) return;
		this.dirty.add(boardId);
		void this.saveNow(boardId);
	}

	async flush(): Promise<void> {
		for (const timer of this.pendingTimers.values()) window.clearTimeout(timer);
		this.pendingTimers.clear();

		const ids = new Set([...this.dirty, ...this.saving]);
		await Promise.all([...ids].map((id) => this.saveNow(id)));

		for (let pass = 0; pass < 3; pass++) {
			const pending = [...this.pendingSaves];
			if (pending.length === 0) break;
			this.pendingSaves.clear();
			await Promise.all(pending.map((id) => this.saveNow(id)));
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const timer of this.pendingTimers.values()) window.clearTimeout(timer);
		this.pendingTimers.clear();
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		if (this.closeFlagTimer !== undefined) window.clearTimeout(this.closeFlagTimer);
		for (const ref of this.refs) this.app.vault.offref(ref);
		this.refs.length = 0;
	}

	getBoard(boardId: string): Board | null {
		return this.getSnapshot().boards.find((board) => board.id === boardId) ?? null;
	}

	private patch(partial: Partial<WorkbenchSnapshot>): void {
		this.state.update((snapshot) => ({ ...snapshot, ...partial }));
	}

	private persistActiveBoard(boardId: string | null): void {
		void this.deviceState.save({ lastBoardId: boardId }).catch(() => {
			// Device-local UI state is not critical; board data is already in the vault.
		});
	}

	private updateBoard(
		boardId: string,
		update: (board: Board) => Board,
		immediate: boolean
	): Board | null {
		const board = this.getBoard(boardId);
		if (!board) return null;
		const next = update(board);
		this.patch({
			boards: this.getSnapshot().boards.map((candidate) =>
				candidate.id === boardId ? next : candidate
			),
		});
		this.markDirty(boardId, immediate);
		return next;
	}

	private markDirty(boardId: string, immediate: boolean): void {
		this.dirty.add(boardId);
		const existing = this.pendingTimers.get(boardId);
		if (existing !== undefined) {
			window.clearTimeout(existing);
			this.pendingTimers.delete(boardId);
		}
		if (immediate) {
			void this.saveNow(boardId);
			return;
		}
		const timer = window.setTimeout(() => {
			this.pendingTimers.delete(boardId);
			void this.saveNow(boardId);
		}, 350);
		this.pendingTimers.set(boardId, timer);
	}

	private async saveNow(boardId: string): Promise<void> {
		if (this.disposed) return;
		if (this.saving.has(boardId)) {
			this.pendingSaves.add(boardId);
			return;
		}
		const board = this.getBoard(boardId);
		if (!board) return;

		this.saving.add(boardId);
		this.patch({ saveState: "saving", saveError: null });
		try {
			const text = await this.repository.saveBoard(
				board,
				this.knownTexts.get(boardId)
			);
			this.knownTexts.set(boardId, text);
			if (!this.pendingSaves.has(boardId) && !this.pendingTimers.has(boardId)) {
				this.dirty.delete(boardId);
			}
			this.patch({ saveState: "saved", saveError: null });
		} catch (error) {
			if (error instanceof BoardConflictError) {
				this.addConflict(boardId);
			} else {
				this.patch({
					saveState: "error",
					saveError: errorMessage(error),
				});
			}
		} finally {
			this.saving.delete(boardId);
			if (this.pendingSaves.has(boardId)) {
				this.pendingSaves.delete(boardId);
				void this.saveNow(boardId);
			}
		}
	}

	private addConflict(boardId: string): void {
		const conflicts = new Set(this.getSnapshot().conflictBoardIds);
		conflicts.add(boardId);
		this.patch({
			conflictBoardIds: [...conflicts],
			saveState: "error",
			saveError: "This board changed on disk. Reload it or keep your local version.",
		});
	}

	private clearBoardTimers(boardId: string): void {
		const timer = this.pendingTimers.get(boardId);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.pendingTimers.delete(boardId);
		}
		this.pendingSaves.delete(boardId);
	}

	private async onVaultModify(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !this.repository.isBoardFile(file.path)) return;
		const boardId = this.repository.boardIdFromPath(file.path);
		if (!boardId || !this.knownTexts.has(boardId) || this.saving.has(boardId)) return;

		let text: string;
		try {
			text = await this.app.vault.read(file);
		} catch {
			return;
		}
		if (text === this.knownTexts.get(boardId)) return;

		if (this.dirty.has(boardId) || this.pendingTimers.has(boardId)) {
			this.addConflict(boardId);
			return;
		}

		try {
			const board = parseBoard(text, file.path);
			if (board.id !== boardId) throw new Error("Board id does not match its filename.");
			this.knownTexts.set(boardId, text);
			this.patch({
				boards: this.getSnapshot().boards.map((candidate) =>
					candidate.id === boardId ? board : candidate
				),
				conflictBoardIds: this.getSnapshot().conflictBoardIds.filter(
					(id) => id !== boardId
				),
			});
		} catch (error) {
			this.addCorrupt(file.path, errorMessage(error));
		}
	}

	private onVaultStructureChange(file: TAbstractFile): void {
		if (this.repository.isBoardFile(file.path)) this.scheduleRefresh();
	}

	private onVaultDelete(file: TAbstractFile): void {
		if (!this.repository.isBoardFile(file.path)) return;
		const boardId = this.repository.boardIdFromPath(file.path);
		if (!boardId) return;
		if (!this.knownTexts.has(boardId) && !this.getBoard(boardId)) return;

		this.clearBoardTimers(boardId);
		this.knownTexts.delete(boardId);
		this.dirty.delete(boardId);
		const boards = this.getSnapshot().boards.filter((board) => board.id !== boardId);
		const activeBoardId =
			this.getSnapshot().activeBoardId === boardId
				? (boards[0]?.id ?? null)
				: this.getSnapshot().activeBoardId;
		this.patch({
			boards,
			activeBoardId,
			conflictBoardIds: this.getSnapshot().conflictBoardIds.filter(
				(id) => id !== boardId
			),
		});
		this.persistActiveBoard(activeBoardId);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshBoardList();
		}, 150);
	}

	private async refreshBoardList(): Promise<void> {
		const entries = await this.repository.listBoards();
		const current = this.getSnapshot().boards;
		const currentById = new Map(current.map((board) => [board.id, board]));
		const next: Board[] = [];
		const corruptBoards: CorruptBoard[] = [];
		const seen = new Set<string>();

		for (const entry of entries) {
			if (!entry.board) {
				if (entry.error) corruptBoards.push({ path: entry.path, message: entry.error });
				continue;
			}
			const board = entry.board;
			seen.add(board.id);
			const existing = currentById.get(board.id);
			const known = this.knownTexts.get(board.id);

			if (!existing) {
				next.push(board);
				this.knownTexts.set(board.id, entry.text);
			} else if (known === entry.text) {
				next.push(existing);
			} else if (this.dirty.has(board.id) || this.saving.has(board.id)) {
				next.push(existing);
				this.addConflict(board.id);
			} else {
				next.push(board);
				this.knownTexts.set(board.id, entry.text);
			}
		}

		for (const board of current) {
			if (seen.has(board.id)) continue;
			if (this.dirty.has(board.id) || this.saving.has(board.id)) {
				next.push(board);
				this.addConflict(board.id);
			} else {
				this.knownTexts.delete(board.id);
			}
		}

		next.sort((left, right) => left.createdAt - right.createdAt);
		const activeBoardId =
			next.find((board) => board.id === this.getSnapshot().activeBoardId)?.id ??
			next[0]?.id ??
			null;
		this.patch({ boards: next, activeBoardId, corruptBoards });
		this.persistActiveBoard(activeBoardId);
	}

	private addCorrupt(path: string, message: string): void {
		const corruptBoards = this.getSnapshot().corruptBoards.filter(
			(board) => board.path !== path
		);
		corruptBoards.push({ path, message });
		this.patch({ corruptBoards });
	}

	private flattenTaskIds(columns: Column[]): string[] {
		return columns.flatMap((column) => column.tasks.map((task) => task.id));
	}
}
