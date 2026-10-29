import { Platform } from "obsidian";
import type { execFile } from "node:child_process";

interface NodeRequire {
	(id: string): unknown;
}

export async function pickDirectory(title: string): Promise<string | null> {
	if (!Platform.isDesktopApp || !Platform.isMacOS) return null;
	if (typeof require !== "function") return null;
	const nodeRequire = require as unknown as NodeRequire;
	const { execFile: execFileFn } = nodeRequire("node:child_process") as {
		execFile: typeof execFile;
	};
	const prompt = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `POSIX path of (choose folder with prompt "${prompt}")`;
	return new Promise<string | null>((resolve, reject) => {
		execFileFn(
			"/usr/bin/osascript",
			["-e", script],
			{ encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					if (
						typeof stderr === "string" &&
						(stderr.includes("-128") || /user canceled/i.test(stderr))
					) {
						resolve(null);
						return;
					}
					reject(
						new Error(
							typeof stderr === "string" && stderr.trim()
								? stderr.trim()
								: error.message
						)
					);
					return;
				}
				const output = stdout.trim();
				const path = output === "/" ? "/" : output.replace(/\/+$/, "");
				resolve(path || null);
			}
		);
	});
}
