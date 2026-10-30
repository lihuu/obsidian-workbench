<script lang="ts">
	import type { App } from "obsidian";
	import {
		TRIGGERS,
		dragHandleZone,
		type DndEvent,
	} from "svelte-dnd-action";
	import type { Board, Column, Task } from "../data/types";
	import type { RunView } from "../agent/types";
	import ColumnView from "./Column.svelte";
	import { icon } from "./icon";

	let {
		app,
		board,
		runs,
		dragging,
		onOpenTask,
		onAddTask,
		onAddColumn,
		onRenameColumn,
		onDeleteColumn,
		onReorderColumns,
		onConsider,
		onFinalize,
	}: {
		app: App;
		board: Board;
		runs: Record<string, RunView>;
		dragging: boolean;
		onOpenTask: (task: Task) => void;
		onAddTask: (columnId: string) => void;
		onAddColumn: () => void;
		onRenameColumn: (column: Column) => void;
		onDeleteColumn: (column: Column) => void;
		onReorderColumns: (columns: Column[]) => void;
		onConsider: (columnId: string, event: CustomEvent<DndEvent<Task>>) => void;
		onFinalize: (columnId: string, event: CustomEvent<DndEvent<Task>>) => void;
	} = $props();

	let boardEl: HTMLDivElement | undefined = $state();
	let trackEl: HTMLDivElement | undefined = $state();
	let thumbWidth = $state(0);
	let thumbLeft = $state(0);
	let hasOverflow = $state(false);
	let draftColumns = $state<Column[] | null>(null);
	let columnDragging = $state(false);

	const displayColumns = $derived(draftColumns ?? board.columns);

	function updateScrollbar() {
		if (!boardEl || !trackEl) return;
		const max = boardEl.scrollWidth - boardEl.clientWidth;
		hasOverflow = max > 1;
		if (!hasOverflow) {
			thumbWidth = 0;
			thumbLeft = 0;
			return;
		}
		const trackWidth = trackEl.clientWidth;
		thumbWidth = Math.max(24, (boardEl.clientWidth / boardEl.scrollWidth) * trackWidth);
		thumbLeft = (boardEl.scrollLeft / max) * (trackWidth - thumbWidth);
	}

	$effect(() => {
		board.id;
		displayColumns.length;
		const element = boardEl;
		if (!element) return;
		const update = () => updateScrollbar();
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	});

	function handleColumnConsider(event: CustomEvent<DndEvent<Column>>) {
		if (event.detail.info.trigger === TRIGGERS.DRAG_STARTED) columnDragging = true;
		draftColumns = event.detail.items;
	}

	function handleColumnFinalize(event: CustomEvent<DndEvent<Column>>) {
		const columns = event.detail.items.filter((column) => !column.isDndShadowItem);
		draftColumns = null;
		columnDragging = false;
		onReorderColumns(columns);
	}

	function onThumbPointerDown(event: PointerEvent) {
		if (!boardEl || !trackEl) return;
		event.preventDefault();
		const startX = event.clientX;
		const startLeft = boardEl.scrollLeft;
		const max = boardEl.scrollWidth - boardEl.clientWidth;
		const travel = trackEl.clientWidth - thumbWidth;
		if (travel <= 0) return;
		const target = event.currentTarget as HTMLElement;
		const doc = target.doc;
		const onMove = (move: PointerEvent) => {
			const ratio = (move.clientX - startX) / travel;
			boardEl!.scrollLeft = startLeft + ratio * max;
			updateScrollbar();
		};
		const onUp = () => {
			doc.removeEventListener("pointermove", onMove);
			doc.removeEventListener("pointerup", onUp);
		};
		doc.addEventListener("pointermove", onMove);
		doc.addEventListener("pointerup", onUp, { once: true });
	}
</script>

<div class="wb-board-wrap">
	<div
		class="wb-board"
		class:wb-board--dragging={dragging || columnDragging}
		bind:this={boardEl}
		onscroll={updateScrollbar}
	>
		<div
			class="wb-columns"
			use:dragHandleZone={{
				items: displayColumns,
				type: "wb-column",
				flipDurationMs: 160,
				delayTouchStart: 180,
				dropTargetClasses: ["wb-columns-drop-target"],
			}}
			onconsider={handleColumnConsider}
			onfinalize={handleColumnFinalize}
		>
			{#each displayColumns as column (column.id)}
				{#if column.isDndShadowItem}
					<div class="wb-column wb-column--shadow" aria-hidden="true"></div>
				{:else}
					<ColumnView
						{app}
						{column}
						boardId={board.id}
						runs={runs}
						role={column.id === board.agent?.runStateMapping?.queuedColumnId
							? "queue"
							: column.id === board.agent?.runStateMapping?.runningColumnId
								? "running"
								: undefined}
						canDelete={board.columns.length > 1}
						{onOpenTask}
						{onAddTask}
						{onRenameColumn}
						{onDeleteColumn}
						onConsider={(event) => onConsider(column.id, event)}
						onFinalize={(event) => onFinalize(column.id, event)}
					/>
				{/if}
			{/each}
		</div>

		<button class="wb-add-column" onclick={onAddColumn}>
			<span class="wb-add-icon" use:icon={"plus"}></span>
			<span>Add column</span>
		</button>
	</div>

	<div class="wb-scrollbar" class:is-hidden={!hasOverflow} bind:this={trackEl}>
		<button
			class="wb-scrollbar-thumb"
			style:width={`${thumbWidth}px`}
			style:transform={`translateX(${thumbLeft}px)`}
			aria-label="Scroll columns"
			onpointerdown={onThumbPointerDown}
		></button>
	</div>
</div>
