import type { App } from "obsidian";

interface WebViewerInstance {
	openUrl?: (url: string) => unknown;
}

interface InternalPluginLike {
	instance?: WebViewerInstance;
}

interface InternalPluginsLike {
	getPluginById?: (id: string) => InternalPluginLike | undefined;
}

/**
 * Obsidian's optional Web viewer core plugin exposes `openUrl` on its instance.
 * The API is not public, so treat it as best-effort and fall back to the OS
 * browser. This keeps Workbench usable when Web viewer is unavailable.
 */
export function openInObsidianBrowser(app: App, url: string): boolean {
	try {
		const internal = (app as App & { internalPlugins?: InternalPluginsLike })
			.internalPlugins;
		const instance = internal?.getPluginById?.("webviewer")?.instance;
		if (instance && typeof instance.openUrl === "function") {
			void instance.openUrl(url);
			return true;
		}
	} catch {
		// Fall through to the system browser.
	}
	return false;
}

export function openUrl(app: App, url: string): void {
	if (!url) return;
	if (openInObsidianBrowser(app, url)) return;
	window.open(url, "_blank");
}
