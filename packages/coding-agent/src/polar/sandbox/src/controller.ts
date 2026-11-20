import type { ExtensionContext, SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { acquireSession } from "../../shared/session.ts";
import type { SandboxHost, SandboxRuntime, ShowImageOperation } from "./types.ts";
import {
	activateRuntime,
	checkReadiness,
	type SelectMissingImage,
	shutdownHost,
	shutdownRuntime,
} from "./workspace.ts";

type SessionState = "off" | "activating" | "active" | "closing" | "closed";

export class SandboxController {
	private readonly host: SandboxHost;
	private readonly registerRunCode: (runtime: SandboxRuntime) => void;
	private state: SessionState = "off";
	private starting = false;
	private runtime: SandboxRuntime | undefined;

	constructor(host: SandboxHost, registerRunCode: (runtime: SandboxRuntime) => void) {
		this.host = host;
		this.registerRunCode = registerRunCode;
	}

	async start(
		ctx: ExtensionContext,
		selectImage?: SelectMissingImage,
		showOperation?: ShowImageOperation,
	): Promise<void> {
		this.starting = true;
		try {
			const readiness = await checkReadiness(this.host, selectImage, showOperation);
			if (this.state !== "off") return;
			if (readiness.ready) await this.activate(readiness.image, ctx);
			else ctx.ui.notify(readiness.message, "warning");
		} finally {
			this.starting = false;
		}
	}

	async shutdown(reason: SessionShutdownEvent["reason"], ctx: ExtensionContext): Promise<void> {
		if (this.state === "closing" || this.state === "closed") return;
		this.state = "closing";
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		if (this.runtime !== undefined) await shutdownRuntime(this.runtime, reason, warn);
		else await shutdownHost(this.host, () => this.starting, reason, warn);
		this.state = "closed";
	}

	private async activate(image: string, ctx: ExtensionContext): Promise<void> {
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		this.state = "activating";
		try {
			const handle = await acquireSession(ctx.sessionManager.getSessionId(), ctx.cwd);
			const activation = await activateRuntime(this.host, handle, image, warn);
			if (this.state !== "activating") {
				// The session began to shut down meanwhile: nothing will use this runtime.
				if (activation.ready) await handle.release();
				return;
			}
			if (!activation.ready) {
				warn(activation.message);
				return;
			}
			const { runtime } = activation;
			runtime.state = "open";
			this.runtime = runtime;
			this.state = "active";
			if (runtime.driver.name === "oci" || runtime.driver.name === "k8s") {
				ctx.ui.notify(`sandbox: ${runtime.driver.boundaryDescription}`, "info");
			}
			this.registerRunCode(runtime);
		} finally {
			if (this.state === "activating") this.state = "off";
		}
	}
}
