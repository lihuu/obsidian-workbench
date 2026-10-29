import { normalizeCapabilities } from "./contract.mjs";
import { PiCompatibleBackend } from "./pi-compatible.mjs";

export class PiBackend extends PiCompatibleBackend {
	constructor({ binary = "pi", model = "" } = {}) {
		super({
			id: "pi",
			displayName: "Pi",
			binary,
			model,
			autoApproveFlag: "--no-approve",
			sessionFlag: "--session",
			resumeFlag: "--session",
			settleTypes: ["agent_settled"],
			capabilities: normalizeCapabilities(),
		});
	}
}
