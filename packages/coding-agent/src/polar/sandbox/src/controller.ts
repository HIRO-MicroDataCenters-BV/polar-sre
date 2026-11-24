import type { ExtensionContext, SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { formatDiagnosisWarning, probeHost, SANDBOX_OFF_STATUS } from "./host.ts";
import type { SandboxHost, SandboxRuntime } from "./types.ts";
import { activateRuntime, shutdownHost, shutdownRuntime, type Warn } from "./workspace.ts";

type SessionState = "off" | "activating" | "active" | "closing" | "closed";

export class SandboxController {
	private readonly host: SandboxHost;
	private readonly registerRunCode: (runtime: SandboxRuntime) => void;
	private state: SessionState = "off";
	private pending: Promise<void> | undefined;
	private runtime: SandboxRuntime | undefined;
	private statusShown = false;
	private shutdownReason: SessionShutdownEvent["reason"] = "reload";

	constructor(host: SandboxHost, registerRunCode: (runtime: SandboxRuntime) => void) {
		this.host = host;
		this.registerRunCode = registerRunCode;
	}

	start(ctx: ExtensionContext): Promise<void> {
		if (this.state !== "off" || this.pending !== undefined) return Promise.resolve();
		return this.track(async () => {
			const diagnosis = await probeHost(this.host);
			if (this.state !== "off") return;
			if (diagnosis.kind === "ready") {
				await this.activate(diagnosis.image, ctx);
			} else {
				this.setOffStatus(ctx);
				this.notify(ctx, formatDiagnosisWarning(diagnosis), "warning");
			}
		});
	}

	async shutdown(reason: SessionShutdownEvent["reason"], ctx: ExtensionContext): Promise<void> {
		if (this.state === "closing" || this.state === "closed") return;
		this.state = "closing";
		this.shutdownReason = reason;
		const warn = this.shutdownWarn(ctx);
		if (this.runtime !== undefined) await shutdownRuntime(this.runtime, reason, warn);
		else await shutdownHost(this.host, () => this.pending !== undefined, reason, warn);
		this.state = "closed";
	}

	private isAlive(): boolean {
		return this.state !== "closing" && this.state !== "closed";
	}

	private track(operation: () => Promise<void>): Promise<void> {
		const running = operation().finally(() => {
			if (this.pending === running) this.pending = undefined;
		});
		this.pending = running;
		return running;
	}

	private notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
		if (this.isAlive()) ctx.ui.notify(message, level);
	}

	private setOffStatus(ctx: ExtensionContext): void {
		if (!this.isAlive()) return;
		this.statusShown = true;
		ctx.ui.setStatus("sandbox", SANDBOX_OFF_STATUS);
	}

	private clearStatus(ctx: ExtensionContext): void {
		if (!this.isAlive() || !this.statusShown) return;
		this.statusShown = false;
		ctx.ui.setStatus("sandbox", undefined);
	}

	private shutdownWarn(ctx: ExtensionContext): Warn {
		return (message) => {
			if (this.state !== "closed") ctx.ui.notify(message, "warning");
		};
	}

	private async activate(image: string, ctx: ExtensionContext): Promise<void> {
		const warn = (message: string) => this.notify(ctx, message, "warning");
		this.state = "activating";
		try {
			const activation = await activateRuntime(this.host, ctx.sessionManager.getSessionId(), ctx.cwd, image, warn);
			if (this.state !== "activating") {
				// The session began to shut down meanwhile: close the late runtime and register nothing.
				if (activation.ready) {
					await shutdownRuntime(activation.runtime, this.shutdownReason, this.shutdownWarn(ctx));
				}
				return;
			}
			if (!activation.ready) {
				this.setOffStatus(ctx);
				warn(activation.message);
				return;
			}
			const { runtime } = activation;
			runtime.state = "open";
			this.runtime = runtime;
			this.state = "active";
			if (runtime.driver.name === "oci" || runtime.driver.name === "k8s") {
				this.notify(ctx, `sandbox: ${runtime.driver.boundaryDescription}`, "info");
			}
			if (this.isAlive()) this.registerRunCode(runtime);
			this.clearStatus(ctx);
		} finally {
			if (this.state === "activating") this.state = "off";
		}
	}
}
