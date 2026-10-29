<script lang="ts">
	import type { App } from "obsidian";
	import type { Task } from "../data/types";
	import type { RunView } from "../agent/types";
	import MarkdownPreview from "./MarkdownPreview.svelte";

	let descriptionEl: HTMLDivElement | undefined = $state();
	let expanded = $state(false);
	let overflowing = $state(false);

	let {
		app,
		task,
		run,
		shadow = false,
		onclick,
	}: {
		app: App;
		task: Task;
		run?: RunView;
		shadow?: boolean;
		onclick?: () => void;
	} = $props();

	let backendName = $derived(run?.backendName || "Agent");

	$effect(() => {
		task.description;
		const element = descriptionEl;
		if (!element) return;
		const measure = () => {
			if (expanded) return;
			const markdown = element.querySelector<HTMLElement>(".wb-card-markdown");
			if (!markdown) return;
			overflowing = markdown.scrollHeight > markdown.clientHeight + 2;
		};
		const timer = window.setTimeout(measure, 50);
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			window.clearTimeout(timer);
			observer.disconnect();
		};
	});

	function toggleExpanded(event: MouseEvent | PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		expanded = !expanded;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (shadow) return;
		if (event.target !== event.currentTarget) return;
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			onclick?.();
		}
	}

	function handleClick(event: MouseEvent) {
		if (shadow) return;
		const target = event.target;
		if (target instanceof HTMLElement) {
			const link = target.closest("a.internal-link");
			if (link instanceof HTMLAnchorElement) {
				const href = link.getAttribute("data-href") ?? link.getAttribute("href");
				if (href) {
					event.preventDefault();
					event.stopPropagation();
					void app.workspace.openLinkText(href, "", true);
					return;
				}
			}
		}
		onclick?.();
	}
</script>

<div
	class="wb-card"
	class:wb-card--shadow={shadow}
	role="button"
	tabindex={shadow ? -1 : 0}
	aria-hidden={shadow ? "true" : undefined}
	onclick={handleClick}
	onkeydown={handleKeydown}
>
	<div class="wb-card-heading">
		<div class="wb-card-title">{task.title}</div>
		{#if task.source === "agent"}
			<span class="wb-agent-source" title="Created by an agent">Agent</span>
		{/if}
		{#if run}
			<span
				class={`wb-run-badge wb-run-badge--${run.status}`}
				title={run.status === "succeeded"
					? `${backendName} run succeeded`
					: run.status === "failed"
						? `${backendName} run failed`
						: run.status === "cancelled"
							? `${backendName} run cancelled`
							: `${backendName} is running`}
			>
				{run.status === "queued"
					? `${backendName} queued`
					: run.status === "running"
						? `${backendName}…`
					: run.status === "succeeded"
						? `${backendName} done`
						: run.status === "cancelled"
							? `${backendName} cancelled`
							: `${backendName} failed`}
			</span>
		{/if}
	</div>
	{#if task.description}
		<div
			class="wb-card-description"
			class:is-clamped={!expanded}
			bind:this={descriptionEl}
		>
			<MarkdownPreview {app} markdown={task.description} className="wb-card-markdown" />
		</div>
		{#if overflowing || expanded}
			<button
				class="wb-card-expand"
				type="button"
				aria-expanded={expanded}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={toggleExpanded}
			>
				{expanded ? "Show less" : "Show more"}
			</button>
		{/if}
	{/if}
</div>
