<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
		import { onMount, tick, untrack } from "svelte";
	import {
		TRIGGERS,
		setKeyboardDragTrigger,
		type DndEvent,
	} from "svelte-dnd-action";
	import { NameModal } from "../modals/NameModal";
	import { ConfirmModal } from "../modals/ConfirmModal";
	import { TaskDetailModal } from "../modals/TaskDetailModal";
	import { AgentSettingsModal } from "../modals/AgentSettingsModal";
	import type { AgentController } from "../agent/controller";
	import type { AgentSnapshot, RunView, TaskProposal } from "../agent/types";
	import { isLoopbackRunnerUrl } from "../agent/runner-connection";
	import {
		targetColumnIdForStatus,
		tasksEnteringColumn,
		tasksLeavingColumn,
	} from "../agent/run-columns";
	import type { Board as BoardModel, Column, Task } from "../data/types";
	import { WorkbenchStore, createInitialSnapshot, type WorkbenchSnapshot } from "../data/store";
	import BoardView from "./Board.svelte";
	import { icon } from "./icon";

	let {
		app,
		store,
		agent,
	}: { app: App; store: WorkbenchStore; agent: AgentController } = $props();

	let snapshot = $state<WorkbenchSnapshot>(createInitialSnapshot());
	let agentSnapshot = $state<AgentSnapshot>(untrack(() => agent.getSnapshot()));
	let dragging = $state(false);
	let layout = $state<"wide" | "medium" | "narrow">("wide");
	let viewWidth = $state(0);
	let shellEl: HTMLDivElement | undefined = $state();
	let dragBoard = $state<BoardModel | null>(null);
	let commitTimer: number | undefined;
	let historyLoaded = new Set<string>();
	let seenRunStatuses = new Map<string, string>();
	let queueBaselines = new Map<string, { columnId: string; ids: Set<string> }>();
	let lastQueueOrder = new Map<string, string>();
	let boardMenuOpen = $state(false);
	let menuWrapEl: HTMLDivElement | undefined = $state();
	let importedProposals = new Set<string>();
	let proposalInFlight = new Set<string>();

	const activeBoard = $derived(
		snapshot.boards.find((board) => board.id === snapshot.activeBoardId) ??
			snapshot.boards[0] ??
			null
	);
	const displayBoard = $derived(dragBoard ?? activeBoard);
	const activeWorkspace = $derived(
		activeBoard ? (agentSnapshot.settings.workspaces[activeBoard.id] ?? "") : ""
	);
	const activeConflict = $derived(
		activeBoard ? snapshot.conflictBoardIds.includes(activeBoard.id) : false
	);
	const mobileRunnerBlocked = $derived(
		Platform.isMobile &&
			(!agentSnapshot.settings.runnerUrl.trim() ||
				isLoopbackRunnerUrl(agentSnapshot.settings.runnerUrl))
	);
	const saveLabel = $derived(
		snapshot.saveState === "saving"
			? "Saving…"
			: snapshot.saveState === "error"
				? "Save failed"
				: snapshot.saveState === "saved"
					? "Saved"
					: ""
	);

	$effect(() => {
		const element = shellEl;
		if (!element) return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			viewWidth = width;
			layout = width < 640 ? "narrow" : width < 1000 ? "medium" : "wide";
		});
		observer.observe(element);
		return () => observer.disconnect();
	});

	$effect(() => {
		const boardId = snapshot.activeBoardId;
		if (!boardId || snapshot.loadState !== "ready" || historyLoaded.has(boardId)) return;
		historyLoaded.add(boardId);
		void agent.loadHistory(boardId);
	});

	$effect(() => {
		const boardId = activeBoard?.id;
		if (!boardId || snapshot.loadState !== "ready") return;
		let cancelled = false;

		const pullProposals = async () => {
			let proposals: TaskProposal[];
			try {
				proposals = await agent.listTaskProposals(boardId);
			} catch {
				return;
			}
			if (cancelled) return;
			let created = 0;
			for (const proposal of proposals) {
				if (cancelled) return;
				if (importedProposals.has(proposal.id) || proposalInFlight.has(proposal.id)) {
					continue;
				}
				const board = store
					.getSnapshot()
					.boards.find((candidate) => candidate.id === boardId);
				if (!board) return;
				const existing = board.columns.some((column) =>
					column.tasks.some((task) => task.sourceProposalId === proposal.id)
				);
				if (existing) {
					importedProposals.add(proposal.id);
					await agent.ackTaskProposal(proposal.id).catch(() => undefined);
					continue;
				}
				const target =
					board.columns.find(
						(column) => column.name.trim().toLowerCase() === "inbox"
					) ??
					board.columns.find(
						(column) => column.name.trim().toLowerCase() === "backlog"
					) ??
					board.columns[0];
				if (!target) continue;
				proposalInFlight.add(proposal.id);
				try {
					const task = store.addTask(board.id, target.id, proposal.title);
					const source = `${proposal.backendName || "Agent"} run ${proposal.runId} from task ${proposal.taskId}.`;
					store.updateTask(board.id, task.id, {
						description: proposal.description
							? `${source}\n\n${proposal.description}`
							: source,
						source: "agent",
						sourceProposalId: proposal.id,
						sourceRunId: proposal.runId,
						sourceTaskId: proposal.taskId,
					});
					importedProposals.add(proposal.id);
					created += 1;
					await agent.ackTaskProposal(proposal.id).catch(() => undefined);
				} finally {
					proposalInFlight.delete(proposal.id);
				}
			}
			if (created > 0 && !cancelled) {
				new Notice(
					created === 1
						? "Agent created 1 task."
						: `Agent created ${created} tasks.`
				);
			}
		};

		void pullProposals();
		const timer = window.setInterval(() => void pullProposals(), 2500);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	});

	$effect(() => {
		const runs = agentSnapshot.runs;
		for (const run of Object.values(runs)) {
			const previous = seenRunStatuses.get(run.id);
			seenRunStatuses.set(run.id, run.status);
			if (!previous || previous === run.status) continue;
			const board = snapshot.boards.find((candidate) => candidate.id === run.boardId);
			if (board) moveTaskForRun(board, run);
		}
	});

	$effect(() => {
		const board = activeBoard;
		if (!board) return;
		const queueColumnId = board.agent?.runStateMapping?.queuedColumnId;
		if (!queueColumnId) {
			queueBaselines.delete(board.id);
			return;
		}
		const queueColumn = board.columns.find((column) => column.id === queueColumnId);
		if (!queueColumn) return;
		const currentIds = new Set(
			queueColumn.tasks.filter((task) => !task.isDndShadowItem).map((task) => task.id)
		);
		const baseline = queueBaselines.get(board.id);
		if (!baseline || baseline.columnId !== queueColumnId) {
			queueBaselines.set(board.id, { columnId: queueColumnId, ids: currentIds });
			return;
		}
		for (const id of [...baseline.ids]) {
			if (currentIds.has(id)) continue;
			baseline.ids.delete(id);
			const run = agent.getRun(board.id, id);
			if (run?.status === "queued") {
				void agent.abortRun(board.id, id);
			}
		}
		for (const task of queueColumn.tasks) {
			if (task.isDndShadowItem || baseline.ids.has(task.id)) continue;
			baseline.ids.add(task.id);
			const existing = agent.getRun(board.id, task.id);
			if (existing && (existing.status === "queued" || existing.status === "running")) {
				continue;
			}
			void agent
				.startRun(board, task)
				.then((run) => moveTaskForRun(board, run))
				.catch((error) => {
					new Notice(
						`Couldn't enqueue "${task.title}": ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				});
		}
	});

	function warnRunningColumnMoves(board: BoardModel, columns: Column[]): void {
		const runningColumnId = board.agent?.runStateMapping?.runningColumnId;
		if (!runningColumnId) return;
		for (const task of tasksEnteringColumn(board, columns, runningColumnId)) {
			const run = agent.getRun(board.id, task.id);
			if (!run || (run.status !== "queued" && run.status !== "running")) {
				new Notice(
					"Running is managed by the Runner. Use Run or drop the task into Queue."
				);
			}
		}
		for (const task of tasksLeavingColumn(board, columns, runningColumnId)) {
			const run = agent.getRun(board.id, task.id);
			if (run?.status === "running") {
				new Notice("The run is still active. Use Abort to stop it.");
			}
		}
	}

	$effect(() => {
		agentSnapshot.runs;
		const board = activeBoard;
		if (!board) return;
		const queueColumnId = board.agent?.runStateMapping?.queuedColumnId;
		if (!queueColumnId) return;
		const queueColumn = board.columns.find((column) => column.id === queueColumnId);
		if (!queueColumn) return;
		const runIds = queueColumn.tasks
			.map((task) => agent.getRun(board.id, task.id))
			.filter((run) => run?.status === "queued")
			.map((run) => run?.id as string);
		if (runIds.length < 2) {
			lastQueueOrder.delete(board.id);
			return;
		}
		const signature = runIds.join("\n");
		if (lastQueueOrder.get(board.id) === signature) return;
		lastQueueOrder.set(board.id, signature);
		void agent.reorderQueue(board.id, runIds).catch((error) => {
			lastQueueOrder.delete(board.id);
			new Notice(
				`Couldn't reorder the queue: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		});
	});

	function moveTaskForRun(board: BoardModel, run: RunView): void {
		const target = targetColumnIdForStatus(board.agent, run.status);
		if (target && board.columns.some((column) => column.id === target)) {
			store.moveTask(board.id, run.taskId, target);
		}
	}

	onMount(() => {
		const unsubscribe = store.subscribe((value) => {
			snapshot = value;
		});
		const unsubscribeAgent = agent.subscribe((value) => {
			agentSnapshot = value;
		});
		void store.load();
		void agent.refreshHealth();
		setKeyboardDragTrigger("space");
		return () => {
			unsubscribe();
			unsubscribeAgent();
			if (commitTimer !== undefined) window.clearTimeout(commitTimer);
		};
	});

	function workspaceLabel(path: string): string {
		if (!path) return "Agent";
		return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	}

	function openAgentSettings() {
		if (!activeBoard) return;
		new AgentSettingsModal(app, agent, store, activeBoard).open();
	}

	function agentTitle(): string {
		const health = agentSnapshot.health;
		const workspace = activeWorkspace || "No workspace";
		const runner =
			health.status === "online"
				? `Runner ${health.version || "online"}`
				: health.status === "offline"
					? "Runner offline"
					: "Runner unknown";
		const available = health.backends
			.filter((backend) => backend.available)
			.map((backend) => backend.displayName)
			.join(" / ");
		return `${workspace} · ${runner}${available ? ` · ${available}` : ""}`;
	}

	function openTask(task: Task) {
		if (!activeBoard) return;
		const board = activeBoard;
		new TaskDetailModal(
			app,
			task,
			board,
			agent,
			(patch) => store.updateTask(board.id, task.id, patch),
			async () => {
				const run = agent.getRun(board.id, task.id);
				if (run && (run.status === "queued" || run.status === "running")) {
					try {
						await agent.abortRun(board.id, task.id);
					} catch (error) {
						new Notice(
							`Couldn't stop the run before deleting: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				}
				store.deleteTask(board.id, task.id);
			},
			(run) => moveTaskForRun(board, run),
			() => {
				const done =
					board.columns.find(
						(column) => column.name.trim().toLowerCase() === "done"
					) ?? board.columns[board.columns.length - 1];
				if (done) store.moveTask(board.id, task.id, done.id);
			}
		).open();
	}

	function addTask(columnId: string, title: string) {
		if (!activeBoard) return;
		store.addTask(activeBoard.id, columnId, title);
	}

	function handleConsider(columnId: string, event: CustomEvent<DndEvent<Task>>) {
		if (!activeBoard) return;
		if (event.detail.info.trigger === TRIGGERS.DRAG_STARTED) dragging = true;
		const base = dragBoard ?? activeBoard;
		dragBoard = {
			...base,
			columns: base.columns.map((column) =>
				column.id === columnId
					? { ...column, tasks: event.detail.items }
					: column
			),
		};
	}

	function handleFinalize(columnId: string, event: CustomEvent<DndEvent<Task>>) {
		const base = dragBoard ?? activeBoard;
		if (!base) return;
		dragBoard = {
			...base,
			columns: base.columns.map((column) =>
				column.id === columnId
					? {
							...column,
							tasks: event.detail.items.filter(
								(task) => !task.isDndShadowItem
							),
						}
					: column
			),
		};
		scheduleDragCommit();
	}

	function scheduleDragCommit() {
		if (commitTimer !== undefined) window.clearTimeout(commitTimer);
		commitTimer = window.setTimeout(() => {
			commitTimer = undefined;
			const board = activeBoard;
			const draft = dragBoard;
			dragBoard = null;
			dragging = false;
			if (board && draft) {
				warnRunningColumnMoves(board, draft.columns);
				store.setColumns(board.id, draft.columns);
			}
		}, 0);
	}

	function toggleBoardMenu(event: MouseEvent) {
		event.stopPropagation();
		boardMenuOpen = !boardMenuOpen;
	}

	function closeBoardMenu() {
		boardMenuOpen = false;
	}

	$effect(() => {
		if (!boardMenuOpen) return;
		const doc = menuWrapEl?.doc ?? document;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!menuWrapEl?.contains(target)) boardMenuOpen = false;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") boardMenuOpen = false;
		};
		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("keydown", onKeydown, true);
		return () => {
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeydown, true);
		};
	});


	function openCreateBoard() {
		new NameModal(
			app,
			{
				title: "Create board",
				label: "Name",
				initialValue: "",
				submitText: "Create",
				maxLength: 80,
			},
			async (name) => {
				if (
					snapshot.boards.some(
						(board) => board.name.toLocaleLowerCase() === name.toLocaleLowerCase()
					)
				) {
					throw new Error("A board with this name already exists.");
				}
				await store.createBoard(name);
			}
		).open();
	}

	function openRenameBoard() {
		const board = activeBoard;
		if (!board) return;
		new NameModal(
			app,
			{
				title: "Rename board",
				label: "Name",
				initialValue: board.name,
				submitText: "Save",
				maxLength: 80,
			},
			async (name) => {
				if (
					snapshot.boards.some(
						(candidate) =>
							candidate.id !== board.id &&
							candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase()
					)
				) {
					throw new Error("A board with this name already exists.");
				}
				store.renameBoard(board.id, name);
			}
		).open();
	}

	function openAddColumn() {
		const board = activeBoard;
		if (!board) return;
		new NameModal(
			app,
			{
				title: "Add column",
				label: "Column name",
				initialValue: "",
				submitText: "Add",
				placeholder: "e.g. Review",
				maxLength: 40,
			},
			async (name) => {
				store.addColumn(board.id, name);
				await tick();
				const boardEl = shellEl?.querySelector<HTMLElement>(".wb-board");
				if (boardEl) boardEl.scrollLeft = boardEl.scrollWidth;
			}
		).open();
	}

	function openRenameColumn(column: Column) {
		const board = activeBoard;
		if (!board) return;
		new NameModal(
			app,
			{
				title: "Rename column",
				label: "Column name",
				initialValue: column.name,
				submitText: "Save",
				maxLength: 40,
			},
			async (name) => {
				store.renameColumn(board.id, column.id, name);
			}
		).open();
	}

	function reorderColumns(columns: Column[]) {
		const board = activeBoard;
		if (!board) return;
		store.setColumns(board.id, columns);
	}

	function openDeleteColumn(column: Column) {
		const board = activeBoard;
		if (!board || board.columns.length <= 1) return;
		const remaining = board.columns.filter((candidate) => candidate.id !== column.id);
		const target = remaining[0];
		const taskCount = column.tasks.filter((task) => !task.isDndShadowItem).length;
		const message =
			taskCount > 0
				? `"${column.name}" will be deleted. Its ${taskCount} ${taskCount === 1 ? "task" : "tasks"} will move to "${target.name}".`
				: `"${column.name}" will be deleted.`;
		new ConfirmModal(app, "Delete column?", message, "Delete", async () => {
			store.deleteColumn(board.id, column.id);
		}).open();
	}

	function openDeleteBoard() {
		const board = activeBoard;
		if (!board) return;
		const taskCount = board.columns.reduce(
			(count, column) => count + column.tasks.filter((task) => !task.isDndShadowItem).length,
			0
		);
		new ConfirmModal(
			app,
			"Delete board?",
			`"${board.name}" and its ${taskCount} ${taskCount === 1 ? "task" : "tasks"} will be moved to the trash.`,
			"Delete",
			async () => {
				await store.deleteBoard(board.id);
				await agent.clearWorkspace(board.id);
			}
		).open();
	}
</script>

<div
	class="wb-shell"
	bind:this={shellEl}
	data-layout={layout}
	style={`--wb-view-width: ${viewWidth}px`}
>
	<header class="wb-header">
		<div class="wb-header-left">
			<span class="wb-logo" use:icon={"layout-dashboard"}></span>
			<div class="wb-menu-wrap" bind:this={menuWrapEl}>
				<button
					class="wb-board-menu"
					onclick={toggleBoardMenu}
					aria-haspopup="menu"
					aria-expanded={boardMenuOpen}
					title="Switch or manage boards"
				>
					<span class="wb-board-title">{activeBoard?.name ?? "Workbench"}</span>
					<span class="wb-chevron" use:icon={"chevron-down"}></span>
				</button>
				{#if boardMenuOpen}
					<div class="wb-popover" role="menu" tabindex="-1">
						{#each snapshot.boards as board (board.id)}
							<button
								class="wb-popover-item"
								class:is-active={board.id === snapshot.activeBoardId}
								role="menuitemradio"
								aria-checked={board.id === snapshot.activeBoardId}
								onclick={() => {
									store.setActiveBoard(board.id);
									closeBoardMenu();
								}}
							>
								{#if board.id === snapshot.activeBoardId}
									<span class="wb-popover-check" use:icon={"check"}></span>
								{:else}
									<span class="wb-popover-check"></span>
								{/if}
								<span class="wb-popover-label">{board.name}</span>
							</button>
						{/each}
						{#if snapshot.boards.length > 0}
							<div class="wb-popover-sep"></div>
						{/if}
						<button
							class="wb-popover-item"
							role="menuitem"
							onclick={() => {
								closeBoardMenu();
								openCreateBoard();
							}}
						>
							<span class="wb-popover-check" use:icon={"plus"}></span>
							<span class="wb-popover-label">New board…</span>
						</button>
						{#if activeBoard}
							<button
								class="wb-popover-item"
								role="menuitem"
								onclick={() => {
									closeBoardMenu();
									openRenameBoard();
								}}
							>
								<span class="wb-popover-check" use:icon={"pencil"}></span>
								<span class="wb-popover-label">Rename board…</span>
							</button>
							<button
								class="wb-popover-item wb-popover-item--danger"
								role="menuitem"
								onclick={() => {
									closeBoardMenu();
									openDeleteBoard();
								}}
							>
								<span class="wb-popover-check" use:icon={"trash-2"}></span>
								<span class="wb-popover-label">Delete board…</span>
							</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>
		<div class="wb-header-right">
			{#if activeBoard}
				<button
					class="wb-agent-button"
					class:is-online={agentSnapshot.health.status === "online"}
					class:is-offline={agentSnapshot.health.status === "offline"}
					onclick={openAgentSettings}
					title={agentTitle()}
				>
					<span class="wb-agent-icon" use:icon={"bot"}></span>
					<span class="wb-agent-label">{workspaceLabel(activeWorkspace)}</span>
					<span class="wb-agent-dot" aria-hidden="true"></span>
				</button>
			{/if}
			{#if saveLabel}
				<span
					class="wb-status"
					class:wb-status--error={snapshot.saveState === "error"}
					aria-live="polite"
					title="Saved locally. Sync is handled by your vault sync service."
				>
					{saveLabel}
				</span>
			{/if}
		</div>
	</header>

	{#if activeConflict && activeBoard}
		<div class="wb-banner wb-banner--warning" role="alert">
			<span>This board changed on disk. Your local changes have not been saved.</span>
			<div class="wb-banner-actions">
				<button
					class="wb-button wb-button--small"
					onclick={() => void store.resolveConflictReload(activeBoard.id)}
				>
					Reload from disk
				</button>
				<button
					class="wb-button wb-button--small wb-button--primary"
					onclick={() => void store.resolveConflictOverwrite(activeBoard.id)}
				>
					Keep local
				</button>
			</div>
		</div>
	{/if}

	{#if mobileRunnerBlocked && activeBoard}
		<div class="wb-banner wb-banner--warning" role="alert">
			<span>
				This iPhone can't reach a localhost Runner. Add an HTTPS remote Runner URL and
				token in the agent settings.
			</span>
			<div class="wb-banner-actions">
				<button class="wb-button wb-button--small" onclick={openAgentSettings}>
					Runner settings
				</button>
			</div>
		</div>
	{/if}

	{#if snapshot.corruptBoards.length > 0}
		<div class="wb-banner wb-banner--error" role="alert">
			<span>
				{snapshot.corruptBoards.length}
				{snapshot.corruptBoards.length === 1 ? "board file" : "board files"} could not be
				read: {snapshot.corruptBoards.map((board) => board.path).join(", ")}
			</span>
			<div class="wb-banner-actions">
				<button class="wb-button wb-button--small" onclick={() => void store.retryLoad()}>
					Retry
				</button>
			</div>
		</div>
	{/if}

	{#if snapshot.saveState === "error" && !activeConflict}
		<div class="wb-banner wb-banner--error" role="alert">
			<span>{snapshot.saveError ?? "Couldn't save changes."}</span>
			<div class="wb-banner-actions">
				<button class="wb-button wb-button--small" onclick={() => store.retrySave()}>
					Retry
				</button>
			</div>
		</div>
	{/if}

	{#if snapshot.loadState === "idle" || snapshot.loadState === "loading"}
		<div class="wb-loading" aria-label="Loading boards">
			{#each [0, 1, 2] as index (index)}
				<div class="wb-skeleton-column">
					<div class="wb-skeleton wb-skeleton--header"></div>
					{#each [0, 1, 2] as card (card)}
						<div class="wb-skeleton wb-skeleton--card"></div>
					{/each}
				</div>
			{/each}
		</div>
	{:else if snapshot.loadState === "error"}
		<div class="wb-state">
			<div class="wb-state-icon" use:icon={"alert-triangle"}></div>
			<h2>Couldn't load Workbench</h2>
			<p>{snapshot.loadError}</p>
			<button class="wb-button wb-button--primary" onclick={() => void store.retryLoad()}>
				Retry
			</button>
		</div>
	{:else if !activeBoard || !displayBoard}
		<div class="wb-state wb-empty">
			<div class="wb-state-icon" use:icon={"layout-dashboard"}></div>
			<h2>No boards yet</h2>
			<p>Create a board to start organizing tasks. Your data stays in this vault.</p>
			<button class="wb-button wb-button--primary" onclick={openCreateBoard}>
				Create board
			</button>
		</div>
	{:else}
		<BoardView
			{app}
			board={displayBoard}
			runs={agentSnapshot.runs}
			{dragging}
			onOpenTask={openTask}
			onAddTask={addTask}
			onAddColumn={openAddColumn}
			onRenameColumn={openRenameColumn}
			onDeleteColumn={openDeleteColumn}
			onReorderColumns={reorderColumns}
			onConsider={handleConsider}
			onFinalize={handleFinalize}
		/>
	{/if}
</div>
