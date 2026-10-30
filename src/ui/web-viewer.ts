import { Notice, type App } from "obsidian";

interface WebViewerInstance {
	openUrl?: (url: string) => unknown;
}

interface InternalPluginLike {
	enabled?: boolean;
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
		const plugin = internal?.getPluginById?.("webviewer");
		// The core plugin can be installed but disabled. Its instance still
		// exists in that state, and opening a leaf produces the "plugin no
		// longer active" page, so only use it when explicitly enabled.
		if (plugin?.enabled !== true) return false;
		const instance = plugin.instance;
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
	new Notice(
		"Web viewer is disabled. Enable Settings → Core plugins → Web viewer, or use the system browser."
	);
	window.open(url, "_blank");
}
