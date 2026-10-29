/**
 * Capabilities are declared by each backend so the Runner and UI can avoid
 * offering operations that the underlying agent does not implement.
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
	streaming: true,
	toolEvents: true,
	abort: true,
	steer: true,
	followUp: true,
	clearQueue: true,
	resume: true,
	images: true,
});

export const BACKEND_CAPABILITY_KEYS = Object.keys(DEFAULT_CAPABILITIES);

export function normalizeCapabilities(value = {}) {
	const capabilities = { ...DEFAULT_CAPABILITIES };
	for (const key of BACKEND_CAPABILITY_KEYS) {
		if (typeof value[key] === "boolean") capabilities[key] = value[key];
	}
	return capabilities;
}

const REQUIRED_METHODS = [
	"probe",
	"buildArgs",
	"promptCommand",
	"promptArgs",
	"messageCommand",
	"abortCommand",
	"clearQueueCommand",
	"stateCommand",
	"handleRecord",
];

/**
 * Contract shared by all execution adapters. The Runner must only depend on
 * this shape; adapter-specific protocol details stay behind it.
 */
export function assertBackendContract(backend) {
	if (!backend || typeof backend !== "object") {
		throw new Error("Backend must be an object.");
	}
	if (typeof backend.id !== "string" || !backend.id.trim()) {
		throw new Error("Backend id must be a non-empty string.");
	}
	if (typeof backend.displayName !== "string" || !backend.displayName.trim()) {
		throw new Error(`${backend.id}: displayName must be a non-empty string.`);
	}
	if (typeof backend.binary !== "string" || !backend.binary.trim()) {
		throw new Error(`${backend.id}: binary must be a non-empty string.`);
	}
	if (backend.promptMode !== "stdin" && backend.promptMode !== "arg") {
		throw new Error(`${backend.id}: promptMode must be "stdin" or "arg".`);
	}
	if (typeof backend.settleOnExit !== "boolean") {
		throw new Error(`${backend.id}: settleOnExit must be a boolean.`);
	}
	if (!backend.capabilities || typeof backend.capabilities !== "object") {
		throw new Error(`${backend.id}: capabilities must be an object.`);
	}
	for (const key of BACKEND_CAPABILITY_KEYS) {
		if (typeof backend.capabilities[key] !== "boolean") {
			throw new Error(`${backend.id}: capability ${key} must be a boolean.`);
		}
	}
	for (const method of REQUIRED_METHODS) {
		if (typeof backend[method] !== "function") {
			throw new Error(`${backend.id}: missing ${method}().`);
		}
	}
	return backend;
}
