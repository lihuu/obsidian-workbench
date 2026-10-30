<script lang="ts">
	import type { App } from "obsidian";
	import { dndzone, dragHandle, type DndEvent } from "svelte-dnd-action";
	import type { Column, Task } from "../data/types";
	import type { RunView } from "../agent/types";
	import { taskRunKey } from "../agent/types";
	import { icon } from "./icon";
	import TaskCard from "./TaskCard.svelte";

	let {
		app,
		column,
		boardId,
		runs,
		role,
		canDelete,
		onOpenTask,
		onAddTask,
		onRenameColumn,
		onDeleteColumn,
		onConsider,
		onFinalize,
	}: {
		app: App;
		column: Column;
		boardId: string;
		runs: Record<string, RunView>;
		role?: "queue" | "running";
		canDelete: boolean;
		onOpenTask: (task: Task) => void;
		onAddTask: (columnId: string) => void;
		onRenameColumn: (column: Column) => void;
		onDeleteColumn: (column: Column) => void;
		onConsider: (event: CustomEvent<DndEvent<Task>>) => void;
		onFinalize: (event: CustomEvent<DndEvent<Task>>) => void;
	} = $props();

	let menuOpen = $state(false);
	let menuWrapEl: HTMLDivElement | undefined = $state();

	let count = $derived(column.tasks.filter((task) => !task.isDndShadowItem).length);

	$effect(() => {
		if (!menuOpen) return;
		const doc = menuWrapEl?.doc ?? document;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!menuWrapEl?.contains(target)) menuOpen = false;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") menuOpen = false;
		};
		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("keydown", onKeydown, true);
		return () => {
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeydown, true);
		};
	});

</script>

<section class="wb-column">
	<header class="wb-column-header">
		<button
			class="wb-column-drag-handle"
			use:dragHandle
			aria-label={`Drag ${column.name} column`}
			title="Drag to reorder column"
		>
			<span use:icon={"grip-vertical"}></span>
		</button>
		<span class="wb-column-dot" aria-hidden="true"></span>
		<h2 class="wb-column-title" id={`wb-column-title-${column.id}`}>{column.name}</h2>
		{#if role}
			<span
				class={`wb-column-role wb-column-role--${role}`}
				title={role === "queue"
					? "Queue projection. Runner scheduling is FIFO; column order is visual only."
					: "Running is managed by the Runner. Dragging does not start or stop a run."}
			>
				{role === "queue" ? "Queue" : "Running"}
			</span>
		{/if}
		<span class="wb-count">{count}<span class="wb-sr-only"> tasks</span></span>
		<div class="wb-column-menu-wrap" bind:this={menuWrapEl}>
			<button
				class="wb-column-menu-btn"
				class:is-open={menuOpen}
				onclick={(event) => {
					event.stopPropagation();
					menuOpen = !menuOpen;
				}}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				title="Column options"
			>
				<span use:icon={"more-horizontal"}></span>
			</button>
			{#if menuOpen}
				<div class="wb-column-menu" role="menu" tabindex="-1">
					<button
						class="wb-column-menu-item"
						role="menuitem"
						onclick={() => {
							menuOpen = false;
							onRenameColumn(column);
						}}
					>
						Rename…
					</button>
					<button
						class="wb-column-menu-item wb-column-menu-item--danger"
						role="menuitem"
						disabled={!canDelete}
						title={canDelete ? "" : "A board needs at least one column"}
						onclick={() => {
							if (!canDelete) return;
							menuOpen = false;
							onDeleteColumn(column);
						}}
					>
						Delete…
					</button>
				</div>
			{/if}
		</div>
	</header>

	<div
		class="wb-task-list"
		use:dndzone={{
			items: column.tasks,
			type: "wb-task",
			flipDurationMs: 160,
			delayTouchStart: 180,
			dropTargetClasses: ["wb-drop-target"],
		}}
		onconsider={onConsider}
		onfinalize={onFinalize}
		aria-labelledby={`wb-column-title-${column.id}`}
	>
		{#each column.tasks as task (task.id)}
			<TaskCard
				{app}
				{task}
				run={runs[taskRunKey(boardId, task.id)]}
				shadow={!!task.isDndShadowItem}
				onclick={() => onOpenTask(task)}
			/>
		{/each}
	</div>

	<button class="wb-add-task" onclick={() => onAddTask(column.id)}>
		<span class="wb-add-icon" use:icon={"plus"}></span>
		<span>Add task</span>
	</button>
</section>
