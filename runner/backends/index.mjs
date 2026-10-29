import { assertBackendContract } from "./contract.mjs";
import { OmpBackend } from "./omp.mjs";
import { OpenCodeBackend } from "./opencode.mjs";
import { PiBackend } from "./pi.mjs";

export function createBackendRegistry(env = process.env) {
	const backends = new Map();
	const add = (backend) => {
		assertBackendContract(backend);
		backends.set(backend.id, backend);
	};

	add(
		new PiBackend({
			binary: env.WORKBENCH_PI_BIN?.trim() || "pi",
			model: env.WORKBENCH_PI_MODEL?.trim() || "",
		})
	);
	add(
		new OmpBackend({
			binary: env.WORKBENCH_OMP_BIN?.trim() || "omp",
			model: env.WORKBENCH_OMP_MODEL?.trim() || "",
		})
	);
	add(
		new OpenCodeBackend({
			binary: env.WORKBENCH_OPENCODE_BIN?.trim() || "opencode",
			model: env.WORKBENCH_OPENCODE_MODEL?.trim() || "",
		})
	);

	const defaultId = env.WORKBENCH_DEFAULT_BACKEND?.trim() || "pi";
	if (!backends.has(defaultId)) {
		throw new Error(`WORKBENCH_DEFAULT_BACKEND is not registered: ${defaultId}`);
	}

	return {
		defaultId,
		ids: () => [...backends.keys()],
		has: (id) => backends.has(id),
		get(id) {
			const backend = backends.get(id || defaultId);
			if (!backend) {
				const error = new Error(`Unknown execution backend: ${id}`);
				error.status = 400;
				throw error;
			}
			return backend;
		},
		list: () => [...backends.values()],
		health: () => [...backends.values()].map((backend) => backend.probe()),
	};
}
