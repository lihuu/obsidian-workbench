import { describe, expect, it } from "vitest";
import {
	buildRunnerHeaders,
	selectRunnerConnection,
	validateRunnerConnection,
} from "../src/agent/runner-connection";

const remote = {
	runnerUrl: "https://workbench.example.com",
	runnerToken: "runner-secret",
	cfAccessClientId: "access-id",
	cfAccessClientSecret: "access-secret",
};

describe("validateRunnerConnection", () => {
	it("allows localhost without a token", () => {
		expect(() =>
			validateRunnerConnection({
				runnerUrl: "http://127.0.0.1:4319",
				runnerToken: "",
				cfAccessClientId: "",
				cfAccessClientSecret: "",
			})
		).not.toThrow();
	});

	it("requires HTTPS for remote runners", () => {
		expect(() =>
			validateRunnerConnection({
				...remote,
				runnerUrl: "http://workbench.example.com",
			})
		).toThrow(/HTTPS/);
	});

	it("requires a Runner token for remote runners", () => {
		expect(() =>
			validateRunnerConnection({ ...remote, runnerToken: "" })
		).toThrow(/Runner token/);
	});

	it("requires both Cloudflare Access fields together", () => {
		expect(() =>
			validateRunnerConnection({ ...remote, cfAccessClientSecret: "" })
		).toThrow(/both/);
		expect(() => validateRunnerConnection(remote)).not.toThrow();
	});
});

describe("selectRunnerConnection", () => {
	const local = {
		runnerUrl: "http://127.0.0.1:4319",
		runnerToken: "",
		cfAccessClientId: "",
		cfAccessClientSecret: "",
	};

	it("drops a synced localhost endpoint on mobile", () => {
		expect(selectRunnerConnection(null, local, true).runnerUrl).toBe("");
	});

	it("keeps localhost on desktop", () => {
		expect(selectRunnerConnection(null, local, false).runnerUrl).toBe(local.runnerUrl);
	});

	it("keeps a remote endpoint on mobile", () => {
		expect(selectRunnerConnection(null, remote, true)).toEqual(remote);
	});

	it("prefers the device-local override", () => {
		expect(selectRunnerConnection(remote, local, true)).toEqual(remote);
	});
});

describe("buildRunnerHeaders", () => {
	it("sends Access service-token headers and the Runner bearer token", () => {
		expect(buildRunnerHeaders(remote)).toEqual({
			Authorization: "Bearer runner-secret",
			"CF-Access-Client-Id": "access-id",
			"CF-Access-Client-Secret": "access-secret",
		});
	});

	it("does not send Access headers when no service token is configured", () => {
		expect(
			buildRunnerHeaders({
				runnerUrl: "http://127.0.0.1:4319",
				runnerToken: "",
				cfAccessClientId: "",
				cfAccessClientSecret: "",
			})
		).toEqual({});
	});
});
