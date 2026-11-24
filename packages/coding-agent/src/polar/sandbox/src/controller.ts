import { setTimeout as sleep } from "timers/promises";
import type { ExtensionContext, SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { formatDiagnosisWarning, probeHost, SANDBOX_OFF_STATUS } from "./host.ts";
import { showImageOperation } from "./indicator.ts";
import { readSandboxPreferences, updateSandboxPreferences } from "./preferences.ts";
import { defaultDiagnosisAction, runHostSetup, runQuickSetup, type SetupTaskResult } from "./setup.ts";
import type {
	Activation,
	HostDiagnosis,
	ImageOperation,
	ImageOperationKind,
	SandboxHost,
	SandboxRuntime,
	SetupAction,
	SetupActionId,
} from "./types.ts";
import { activateRuntime, shutdownHost, shutdownRuntime, type Warn } from "./workspace.ts";

export type SessionState = "off" | "activating" | "active" | "disabled" | "closing" | "closed";

export type RunCodeRegistrar = (runtime: SandboxRuntime, options?: { hidden?: boolean }) => void;

export type StartSetupOutcome =
	| { kind: "busy" }
	| { kind: "locked" }
	| { kind: "stale"; diagnosis: HostDiagnosis }
	| { kind: "started" }
	| { kind: "finished" };

const POLL_MS = 20;

function operationKindFor(action: SetupAction): ImageOperationKind {
	if (action.id === "pull_image") return "download";
	if (action.id === "start_service") return "service";
	return "build";
}

export class SandboxController {
	private readonly createHost: () => SandboxHost;
	private host: SandboxHost;
	private readonly registerRunCode: RunCodeRegistrar;
	private state: SessionState = "off";
	private pending: Promise<void> | undefined;
	private runtime: SandboxRuntime | undefined;
	private setupAbort: AbortController | undefined;
	private operationAbort: AbortController | undefined;
	private activeWidget: ImageOperation | undefined;
	private statusShown = false;
	private shutdownReason: SessionShutdownEvent["reason"] = "reload";

	constructor(createHost: () => SandboxHost, registerRunCode: RunCodeRegistrar) {
		this.createHost = createHost;
		this.host = createHost();
		this.registerRunCode = registerRunCode;
	}

	getState(): SessionState {
		return this.state;
	}

	getHost(): SandboxHost {
		return this.host;
	}

	isAlive(): boolean {
		return this.state !== "closing" && this.state !== "closed";
	}

	isBusy(): boolean {
		return this.pending !== undefined;
	}

	isSetupRunning(): boolean {
		return this.setupAbort !== undefined;
	}

	notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
		if (this.isAlive()) ctx.ui.notify(message, level);
	}

	setOffStatus(ctx: ExtensionContext): void {
		if (!this.isAlive()) return;
		this.statusShown = true;
		ctx.ui.setStatus("sandbox", SANDBOX_OFF_STATUS);
	}

	async probe(): Promise<HostDiagnosis> {
		let diagnosis!: HostDiagnosis;
		await this.track(async () => {
			diagnosis = await probeHost(this.host);
		});
		return diagnosis;
	}

	start(ctx: ExtensionContext): Promise<void> {
		if (this.state !== "off" || this.pending !== undefined) return Promise.resolve();
		return this.track(async () => {
			const preferences = await readSandboxPreferences();
			if (this.state !== "off") return;
			if (preferences.disabled === true) {
				this.state = "disabled";
				return;
			}
			let diagnosis = await probeHost(this.host);
			if (this.state !== "off") return;
			if (preferences.autoStartService === true && defaultDiagnosisAction(diagnosis)?.runQuick !== undefined) {
				const quickAbort = new AbortController();
				this.operationAbort = quickAbort;
				try {
					diagnosis = await runQuickSetup(this.host, diagnosis, quickAbort.signal);
				} finally {
					if (this.operationAbort === quickAbort) this.operationAbort = undefined;
				}
				if (this.state !== "off") return;
			}
			if (diagnosis.kind === "ready") {
				await this.activate(diagnosis.image, ctx, { notifyOnFailure: true, notifyOnReady: false });
			} else {
				this.setOffStatus(ctx);
				this.notify(ctx, formatDiagnosisWarning(diagnosis), "warning");
			}
		});
	}

	async isServiceAutoStartEnabled(): Promise<boolean> {
		const preferences = await readSandboxPreferences();
		return preferences.autoStartService === true;
	}

	async setServiceAutoStart(enabled: boolean, ctx: ExtensionContext): Promise<void> {
		if (!this.isAlive()) return;
		try {
			await updateSandboxPreferences({ autoStartService: enabled });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.notify(ctx, `sandbox: failed to save preferences: ${reason}`, "warning");
		}
	}

	async activateFromCommand(image: string, ctx: ExtensionContext): Promise<Activation | undefined> {
		if (this.state !== "off" || this.pending !== undefined) return undefined;
		let outcome: Activation | undefined;
		await this.track(async () => {
			outcome = await this.activate(image, ctx, { notifyOnFailure: false, notifyOnReady: true });
		});
		return outcome;
	}

	startSetup(actionId: SetupActionId, ctx: ExtensionContext): Promise<StartSetupOutcome> {
		if (!this.isAlive() || this.state === "disabled" || this.pending !== undefined) {
			return Promise.resolve({ kind: "busy" });
		}
		const abortController = new AbortController();
		this.setupAbort = abortController;
		let resolveStart!: (outcome: StartSetupOutcome) => void;
		const startPromise = new Promise<StartSetupOutcome>((resolve) => {
			resolveStart = resolve;
		});

		void this.track(async () => {
			const clearAbort = () => {
				if (this.setupAbort === abortController) this.setupAbort = undefined;
			};
			try {
				const outcome = await runHostSetup(this.host, actionId, {
					signal: abortController.signal,
					onActionStart: (action) => {
						this.mountWidget(ctx, operationKindFor(action));
						resolveStart({ kind: "started" });
					},
					onLine: (line) => {
						this.activeWidget?.output(line);
					},
					onActionEnd: () => {
						this.clearWidget();
					},
				});

				clearAbort();
				this.clearWidget();
				if (outcome.kind === "locked" || outcome.kind === "stale") {
					resolveStart(outcome);
					return;
				}
				await this.applySetupResult(outcome.result, ctx);
				resolveStart({ kind: "finished" });
			} catch (error) {
				clearAbort();
				this.clearWidget();
				const reason = error instanceof Error ? error.message : String(error);
				const prefix = this.state === "active" ? "sandbox" : "sandbox is off";
				this.notify(ctx, `${prefix}: ${reason}`, "warning");
				resolveStart({ kind: "finished" });
			}
		});

		return startPromise;
	}

	async cancelSetup(): Promise<void> {
		if (this.setupAbort === undefined) return;
		this.setupAbort.abort();
		if (this.pending !== undefined) {
			await this.pending;
		}
	}

	async disable(ctx: ExtensionContext): Promise<void> {
		if (!this.isAlive()) return;
		this.state = "disabled";
		this.abortPendingOperations();
		try {
			await updateSandboxPreferences({ disabled: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.notify(ctx, `sandbox: failed to save preferences: ${reason}`, "warning");
		}
		const runtime = await this.stopCurrent("reload", (message) => this.notify(ctx, message, "warning"));
		if (runtime !== undefined && this.isAlive()) {
			this.registerRunCode(runtime, { hidden: true });
		}
		this.clearStatus(ctx);
	}

	async enable(): Promise<void> {
		if (this.state !== "disabled" || this.pending !== undefined) return;
		await updateSandboxPreferences({ disabled: false });
		if (this.state !== "disabled" || this.pending !== undefined) return;
		this.host = this.createHost();
		this.state = "off";
	}

	async shutdown(reason: SessionShutdownEvent["reason"], ctx: ExtensionContext): Promise<void> {
		if (this.state === "closing" || this.state === "closed") return;
		this.state = "closing";
		this.shutdownReason = reason;
		await this.stopCurrent(reason, this.shutdownWarn(ctx));
		this.state = "closed";
	}

	private abortPendingOperations(): void {
		this.clearWidget();
		this.setupAbort?.abort();
		this.operationAbort?.abort();
	}

	private async stopCurrent(reason: SessionShutdownEvent["reason"], warn: Warn): Promise<SandboxRuntime | undefined> {
		this.abortPendingOperations();
		if (this.runtime !== undefined) {
			const runtime = this.runtime;
			this.runtime = undefined;
			await Promise.all([
				shutdownRuntime(runtime, reason, warn),
				this.waitForPending(runtime.limits.shutdownBudgetMs),
			]);
			return runtime;
		}
		await shutdownHost(this.host, () => this.pending !== undefined, reason, warn);
		return undefined;
	}

	private canApplySetupResult(): boolean {
		return this.isAlive() && this.state !== "disabled";
	}

	private async applySetupResult(result: SetupTaskResult, ctx: ExtensionContext): Promise<void> {
		if (!this.canApplySetupResult()) return;

		if (result.completedActions.includes("start_service")) {
			try {
				const preferences = await readSandboxPreferences();
				if (preferences.autoStartService === undefined && this.canApplySetupResult()) {
					await updateSandboxPreferences({ autoStartService: true });
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.notify(ctx, `sandbox: failed to save preferences: ${reason}`, "warning");
			}
			if (!this.canApplySetupResult()) return;
		}

		if (this.state === "off") {
			if (result.diagnosis.kind === "ready") {
				await this.activate(result.diagnosis.image, ctx, { notifyOnFailure: true, notifyOnReady: true });
				return;
			}
			this.setOffStatus(ctx);
			if (result.stopReason === "cancelled") return;
			const reason = result.reason ?? result.diagnosis.reason;
			this.notify(ctx, `sandbox is off: ${reason}`, "warning");
			return;
		}

		if (this.state === "active") {
			if (result.diagnosis.kind === "ready") {
				if (this.runtime !== undefined) {
					this.runtime.image = result.diagnosis.image;
				}
				this.notify(ctx, "sandbox: ready", "info");
				return;
			}
			if (result.stopReason === "cancelled") return;
			const reason = result.reason ?? result.diagnosis.reason;
			this.notify(ctx, `sandbox: ${reason}`, "warning");
		}
	}

	private async waitForPending(budgetMs: number): Promise<void> {
		const deadlineAt = Date.now() + budgetMs;
		while (this.pending !== undefined && Date.now() < deadlineAt) {
			await sleep(Math.min(POLL_MS, Math.max(1, deadlineAt - Date.now())));
		}
	}

	private track(operation: () => Promise<void>): Promise<void> {
		const running = operation().finally(() => {
			if (this.pending === running) this.pending = undefined;
		});
		this.pending = running;
		return running;
	}

	private mountWidget(ctx: ExtensionContext, kind: ImageOperationKind): void {
		this.clearWidget();
		if (!this.isAlive() || (ctx as { mode?: string }).mode !== "tui") return;
		this.activeWidget = showImageOperation(ctx.ui, kind);
	}

	private clearWidget(): void {
		if (this.activeWidget === undefined) return;
		const widget = this.activeWidget;
		this.activeWidget = undefined;
		widget.end();
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

	private async activate(
		image: string,
		ctx: ExtensionContext,
		options: { notifyOnFailure: boolean; notifyOnReady: boolean },
	): Promise<Activation> {
		const warn = (message: string) => this.notify(ctx, message, "warning");
		this.state = "activating";
		try {
			const activation = await activateRuntime(this.host, ctx.sessionManager.getSessionId(), ctx.cwd, image, warn);
			if (this.state !== "activating") {
				// The session began to shut down or was disabled meanwhile: close the late runtime and register nothing.
				if (activation.ready) {
					await shutdownRuntime(activation.runtime, this.shutdownReason, this.shutdownWarn(ctx));
				}
				return activation;
			}
			if (!activation.ready) {
				this.setOffStatus(ctx);
				if (options.notifyOnFailure) warn(activation.message);
				return activation;
			}
			const { runtime } = activation;
			runtime.state = "open";
			this.runtime = runtime;
			this.state = "active";
			if (runtime.driver.name === "oci" || runtime.driver.name === "k8s") {
				this.notify(ctx, `sandbox: ${runtime.driver.boundaryDescription}`, "info");
			}
			if (options.notifyOnReady) {
				this.notify(ctx, "sandbox: ready", "info");
			}
			if (this.isAlive()) this.registerRunCode(runtime);
			this.clearStatus(ctx);
			return activation;
		} finally {
			if (this.state === "activating") this.state = "off";
		}
	}
}
