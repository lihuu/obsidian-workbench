import type { AgentSettings } from "./types";

export type RunnerConnection = Pick<
	AgentSettings,
	"runnerUrl" | "runnerToken" | "cfAccessClientId" | "cfAccessClientSecret"
>;

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isLoopbackRunnerUrl(value: string): boolean {
	try {
		return isLoopbackHost(new URL(value).hostname);
	} catch {
		return false;
	}
}

export function validateRunnerConnection(connection: RunnerConnection): void {
	const url = new URL(connection.runnerUrl);
	const loopback = isLoopbackHost(url.hostname);
	if (!loopback && url.protocol !== "https:") {
		throw new Error("Remote Runner URLs must use HTTPS.");
	}
	if (!loopback && !connection.runnerToken.trim()) {
		throw new Error("Set a Runner token before using a remote Runner URL.");
	}
	const hasClientId = connection.cfAccessClientId.trim().length > 0;
	const hasSecret = connection.cfAccessClientSecret.trim().length > 0;
	if (hasClientId !== hasSecret) {
		throw new Error("Cloudflare Access requires both a client ID and client secret.");
	}
}

export function buildRunnerHeaders(
	connection: RunnerConnection
): Record<string, string> {
	validateRunnerConnection(connection);
	const headers: Record<string, string> = {};
	if (connection.runnerToken) {
		headers.Authorization = `Bearer ${connection.runnerToken}`;
	}
	if (connection.cfAccessClientId) {
		headers["CF-Access-Client-Id"] = connection.cfAccessClientId;
		headers["CF-Access-Client-Secret"] = connection.cfAccessClientSecret;
	}
	return headers;
}
