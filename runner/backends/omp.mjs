import { normalizeCapabilities } from "./contract.mjs";
import { PiCompatibleBackend } from "./pi-compatible.mjs";

export class OmpBackend extends PiCompatibleBackend {
	constructor({ binary = "omp", model = "" } = {}) {
		super({
			id: "omp",
			displayName: "OMP",
			binary,
			model,
			autoApproveFlag: "--auto-approve",
			sessionFlag: "--session",
			resumeFlag: "--resume",
			settleTypes: ["agent_settled", "session_settled"],
			capabilities: normalizeCapabilities({ clearQueue: false }),
		});
	}
}
