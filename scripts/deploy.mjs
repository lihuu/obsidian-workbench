import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configuredVault = process.env.OBSIDIAN_VAULT?.trim();
if (!configuredVault) {
	console.error("Set OBSIDIAN_VAULT to the target Obsidian vault before deploying.");
	process.exit(1);
}
const vault = resolve(
	configuredVault.startsWith("~/")
		? join(homedir(), configuredVault.slice(2))
		: configuredVault
);
const pluginDir = join(vault, ".obsidian", "plugins", "workbench");

await mkdir(pluginDir, { recursive: true });
for (const file of ["main.js", "runner.cjs", "manifest.json", "styles.css", "README.md"]) {
	await copyFile(file, join(pluginDir, file));
}
console.log(`Deployed Workbench to ${pluginDir}`);
