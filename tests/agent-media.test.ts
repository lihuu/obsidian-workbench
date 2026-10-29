import { describe, expect, it } from "vitest";
import { extractImageTargets, imageMimeType } from "../src/agent/media";

describe("extractImageTargets", () => {
	it("extracts wiki embeds, aliases, and markdown images", () => {
		const markdown = [
			"![[assets/diagram.png]]",
			"![[assets/photo.jpg|300]]",
			"![alt](assets/shot.webp)",
			"![[notes/readme.md]]",
			"![remote](https://example.com/a.png)",
			"![[assets/diagram.png]]",
		].join("\n");

		expect(extractImageTargets(markdown)).toEqual([
			"assets/diagram.png",
			"assets/photo.jpg",
			"assets/shot.webp",
		]);
	});

	it("ignores unsupported extensions and empty targets", () => {
		expect(extractImageTargets("![[a.svg]] ![[b.gif]] ![]( )")).toEqual(["b.gif"]);
	});
});

describe("imageMimeType", () => {
	it("maps supported extensions", () => {
		expect(imageMimeType("a.PNG")).toBe("image/png");
		expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
		expect(imageMimeType("a.webp")).toBe("image/webp");
		expect(imageMimeType("a.gif")).toBe("image/gif");
		expect(imageMimeType("a.svg")).toBeNull();
	});
});
