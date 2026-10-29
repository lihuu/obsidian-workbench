<script lang="ts">
	import { Component, MarkdownRenderer, type App } from "obsidian";

	let {
		app,
		markdown,
		className = "",
	}: {
		app: App;
		markdown: string;
		className?: string;
	} = $props();

	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		const target = container;
		if (!target) return;
		const component = new Component();
		component.load();
		target.empty();
		void MarkdownRenderer.render(app, markdown, target, "", component).catch(() => {
			// Malformed content should not break the board.
		});
		return () => component.unload();
	});
</script>

<div class={`wb-markdown markdown-rendered ${className}`} bind:this={container}></div>
