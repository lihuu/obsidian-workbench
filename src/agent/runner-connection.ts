import type { AgentSettings } from "./types";

export type RunnerConnection = Pick<
	AgentSettings,
	"runnerUrl" | "runnerToken" | "cfAccessClientId" | "cfAccessClientSecret"
>;

function normalizeHost(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
	const host = normalizeHost(hostname);
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * RFC1918 IPv4, IPv4 link-local, and IPv6 ULA/link-local. These are reachable
 * only on a local network, so a token-protected HTTP Runner is acceptable for
 * LAN testing. Public addresses still require HTTPS.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
	const host = normalizeHost(hostname);
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = v4.slice(1).map(Number);
		if ([a, b, Number(v4[3]), Number(v4[4])].some((part) => part > 255)) return false;
		return (
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254)
		);
	}
	if (host.includes(":")) {
		return (
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe8") ||
			host.startsWith("fe9") ||
			host.startsWith("fea") ||
			host.startsWith("feb")
		);
	}
	return false;
}

export function isLoopbackRunnerUrl(value: string): boolean {
	try {
		return isLoopbackHost(new URL(value).hostname);
	} catch {
		return false;
	}
}

/**
 * Pick the connection this device should use. `local` is the device-local
 * override; `synced` is the legacy value that older versions wrote to the
 * vault. A synced loopback endpoint is meaningless on mobile, so drop it.
 */
export function selectRunnerConnection(
	local: RunnerConnection | null,
	synced: RunnerConnection,
	mobile: boolean
): RunnerConnection {
	const connection = local ?? synced;
	if (
		mobile &&
		connection.runnerUrl &&
		isLoopbackRunnerUrl(connection.runnerUrl)
	) {
		return { ...connection, runnerUrl: "" };
	}
	return connection;
}

export function validateRunnerConnection(connection: RunnerConnection): void {
	const url = new URL(connection.runnerUrl);
	const loopback = isLoopbackHost(url.hostname);
	if (
		!loopback &&
		url.protocol !== "https:" &&
		!isPrivateNetworkHost(url.hostname)
	) {
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
