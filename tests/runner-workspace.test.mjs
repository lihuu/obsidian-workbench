import { describe, expect, it } from "vitest";
import {
	checkoutPath,
	expandHome,
	parseGitHubRepo,
} from "../runner/workspace.mjs";

describe("parseGitHubRepo", () => {
	it("accepts HTTPS and SSH GitHub URLs", () => {
		expect(parseGitHubRepo("https://github.com/octocat/Hello-World.git")).toEqual({
			owner: "octocat",
			repo: "Hello-World",
		});
		expect(parseGitHubRepo("git@github.com:octocat/Hello-World.git")).toEqual({
			owner: "octocat",
			repo: "Hello-World",
		});
		expect(parseGitHubRepo("ssh://git@github.com/octocat/Hello-World.git")).toEqual({
			owner: "octocat",
			repo: "Hello-World",
		});
	});

	it("rejects non-GitHub and transport-looking URLs", () => {
		expect(parseGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
		expect(parseGitHubRepo("ext::sh -c touch% /tmp/pwn")).toBeNull();
		expect(parseGitHubRepo("https://github.com/owner/../repo")).toBeNull();
		expect(parseGitHubRepo("https://github.com/owner/repo?x=1")).toBeNull();
	});
});

describe("checkoutPath", () => {
	it("builds a sanitized board/repo path", () => {
		expect(checkoutPath("/tmp/ws", "b_abc", "Hello-World")).toBe(
			"/tmp/ws/b_abc/Hello-World"
		);
		expect(checkoutPath("/tmp/ws", "b_abc", "../repo")).toBe(
			"/tmp/ws/b_abc/repo"
		);
	});
});

describe("expandHome", () => {
	it("expands only a leading home segment", () => {
		expect(expandHome("~/Work", "/Users/me")).toBe("/Users/me/Work");
		expect(expandHome("~", "/Users/me")).toBe("/Users/me");
		expect(expandHome("/a/~/b", "/Users/me")).toBe("/a/~/b");
	});
});
