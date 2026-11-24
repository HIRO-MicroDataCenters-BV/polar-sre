import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { SandboxController } from "./controller.ts";
import type { HostDiagnosis, Remedy, SetupAction } from "./types.ts";

const ENABLE_SANDBOX = "Enable sandbox";
const DISABLE_SANDBOX = "Disable sandbox";
const ENABLE_SERVICE_AUTO_START = "Enable service auto-start";
const DISABLE_SERVICE_AUTO_START = "Disable service auto-start";
const CANCEL_SETUP = "Cancel setup";
const KEEP_RUNNING = "Keep running";
const SHOW_COMMANDS = "Show commands";
const CANCEL = "Cancel";

function formatRemedyTitle(reason: string, remedy?: Remedy): string {
	if (remedy === undefined) {
		return `Sandbox is off: ${reason}`;
	}
	if (remedy.kind === "manual") {
		if (remedy.instructions.length === 0) return `Sandbox is off: ${reason}`;
		const lines = remedy.instructions.map((line) => `  ${line}`).join("\n");
		return `Sandbox is off: ${reason}\n\n${lines}`;
	}
	if (remedy.outlook.length === 0) {
		return `Sandbox is off: ${reason}`;
	}
	const steps = remedy.outlook.map((step, index) => `  ${index + 1}. ${step}`).join("\n");
	return `Sandbox is off: ${reason}\n\nSetup will:\n${steps}`;
}

function formatReadyTitle(driverName: string, boundaryDescription: string, image: string, version?: string): string {
	const lines = ["Sandbox is ready.", `Driver: ${driverName}`, `Boundary: ${boundaryDescription}`, `Image: ${image}`];
	if (version !== undefined) {
		lines.push(`Version: ${version}`);
	}
	return lines.join("\n");
}

async function presentRemedyMenu(
	controller: SandboxController,
	ctx: ExtensionContext,
	reason: string,
	remedy?: Remedy,
): Promise<HostDiagnosis | undefined> {
	if (!controller.isAlive()) return undefined;
	if (remedy === undefined || remedy.kind === "manual" || remedy.actions.length === 0) {
		const choice = await ctx.ui.select(formatRemedyTitle(reason, remedy), [DISABLE_SANDBOX, CANCEL]);
		if (!controller.isAlive()) return undefined;
		if (choice === DISABLE_SANDBOX) await controller.disable(ctx);
		return undefined;
	}

	const actionsByLabel = new Map<string, SetupAction>(remedy.actions.map((action) => [action.label, action]));
	const items = [...remedy.actions.map((action) => action.label), SHOW_COMMANDS, DISABLE_SANDBOX, CANCEL];
	const choice = await ctx.ui.select(formatRemedyTitle(reason, remedy), items);
	if (!controller.isAlive() || choice === undefined || choice === CANCEL) return undefined;
	if (choice === DISABLE_SANDBOX) {
		await controller.disable(ctx);
		return undefined;
	}
	if (choice === SHOW_COMMANDS) {
		const commands = remedy.actions.flatMap((action) => action.preview);
		controller.notify(ctx, commands.join("\n"), "info");
		return undefined;
	}

	const selected = actionsByLabel.get(choice);
	if (selected === undefined) return undefined;

	const outcome = await controller.startSetup(selected.id, ctx);
	if (!controller.isAlive()) return undefined;
	if (outcome.kind === "locked") {
		controller.notify(ctx, "sandbox: setup is already running in another session", "warning");
		return undefined;
	}
	if (outcome.kind === "stale") {
		return outcome.diagnosis;
	}
	return undefined;
}

export async function runSandboxCommand(controller: SandboxController, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const state = controller.getState();
	if (state === "closing" || state === "closed") return;

	if (controller.isSetupRunning()) {
		const choice = await ctx.ui.select("Sandbox setup is running.", [CANCEL_SETUP, KEEP_RUNNING, DISABLE_SANDBOX]);
		if (!controller.isAlive()) return;
		if (choice === CANCEL_SETUP) {
			await controller.cancelSetup();
		} else if (choice === DISABLE_SANDBOX) {
			await controller.disable(ctx);
		}
		return;
	}

	if (state === "activating" || controller.isBusy()) {
		controller.notify(ctx, "sandbox: starting...", "info");
		return;
	}

	if (state === "disabled") {
		const choice = await ctx.ui.select("Sandbox is disabled.", [ENABLE_SANDBOX, CANCEL]);
		if (!controller.isAlive()) return;
		if (choice !== ENABLE_SANDBOX) return;
		await controller.enable();
		if (!controller.isAlive() || controller.getState() !== "off") return;
	}

	let diagnosis = await controller.probe();
	while (controller.isAlive()) {
		const currentState = controller.getState();
		if (currentState === "closing" || currentState === "closed" || currentState === "disabled") return;

		if (currentState === "active") {
			if (diagnosis.kind === "ready") {
				const host = controller.getHost();
				const title = formatReadyTitle(
					host.driver.name,
					host.driver.boundaryDescription,
					host.image,
					diagnosis.version,
				);
				let toggleOption: string | undefined;
				let autoStartEnabled = false;
				if (host.driver.supportsServiceAutoStart) {
					autoStartEnabled = await controller.isServiceAutoStartEnabled();
					if (!controller.isAlive()) return;
					toggleOption = autoStartEnabled ? DISABLE_SERVICE_AUTO_START : ENABLE_SERVICE_AUTO_START;
				}
				const items =
					toggleOption !== undefined ? [toggleOption, DISABLE_SANDBOX, CANCEL] : [DISABLE_SANDBOX, CANCEL];
				const choice = await ctx.ui.select(title, items);
				if (!controller.isAlive() || choice === undefined || choice === CANCEL) return;
				if (choice === DISABLE_SANDBOX) {
					await controller.disable(ctx);
				} else if (toggleOption !== undefined && choice === toggleOption) {
					await controller.setServiceAutoStart(!autoStartEnabled, ctx);
				}
				return;
			}
			const next = await presentRemedyMenu(
				controller,
				ctx,
				diagnosis.reason,
				"remedy" in diagnosis ? diagnosis.remedy : undefined,
			);
			if (next === undefined) return;
			diagnosis = next;
			continue;
		}

		// State is "off"
		if (diagnosis.kind === "ready") {
			const activation = await controller.activateFromCommand(diagnosis.image, ctx);
			if (!controller.isAlive() || activation === undefined || activation.ready) return;
			const reason = activation.message.replace(/^sandbox is off:\s*/, "");
			const next = await presentRemedyMenu(controller, ctx, reason, diagnosis.repair);
			if (next === undefined) return;
			diagnosis = next;
			continue;
		}

		controller.setOffStatus(ctx);
		const next = await presentRemedyMenu(
			controller,
			ctx,
			diagnosis.reason,
			"remedy" in diagnosis ? diagnosis.remedy : undefined,
		);
		if (next === undefined) return;
		diagnosis = next;
	}
}
