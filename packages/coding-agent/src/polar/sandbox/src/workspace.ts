import { stat } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { getSandboxImageDir } from "../../../config.ts";
import type { SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { killProcessGroup } from "../../shared/process.ts";
import { type SessionLiveness, sessionLiveness } from "../../shared/session.ts";
import { commandFailure, deadlineAfter, describeCleanupErrors, remainingMs } from "./cli.ts";
import { artifactsRootOf, LEFTOVERS_STAYED, START_ENDED } from "./driver.ts";
import type {
	Activation,
	ChildKind,
	CleanupError,
	NotReady,
	OwnedResource,
	Readiness,
	RunningCall,
	SandboxDriverContext,
	SandboxHost,
	SandboxRuntime,
	SessionHandle,
	ShowImageOperation,
	VolumeFailure,
} from "./types.ts";

export type Recovery = { clean: true } | { leftover: CleanupError[] } | { unknown: string };

export type Warn = (message: string) => void;
export type SelectMissingImage = (title: string, options: string[]) => Promise<string | undefined>;

export const DOWNLOAD_IMAGE_OPTION = "Download prebuilt image";
export const BUILD_IMAGE_OPTION = "Build sandbox image locally (~2 min)";
export const DISABLE_SANDBOX_OPTION = "Disable sandbox for this session";

const TICKET_POLL_MS = 20;

export async function cleanupOwned(host: SandboxHost, deadlineAt: number, exclude?: string): Promise<CleanupError[]> {
	const errors: CleanupError[] = [];
	for (const name of [...host.owned]) {
		if (name === exclude) continue;
		const outcome = await host.driver.deleteSandbox(name, deadlineAt);
		if (!outcome.removed) errors.push(outcome.error);
	}
	return errors;
}

export function closeAdmission(runtime: SandboxRuntime): void {
	if (runtime.state === "closing" || runtime.state === "closed") return;
	runtime.state = "closing";
	for (const call of runtime.running) call.stop();
}

export async function closeIfDrained(runtime: SandboxRuntime): Promise<void> {
	if (runtime.state !== "closing" || runtime.inFlight.size > 0) return;
	runtime.state = "closed";
	await runtime.handle.release();
}

function off(host: SandboxHost, reason: string, leftovers: CleanupError[] = []): NotReady {
	const stayed = leftovers.length === 0 ? "" : `; ${leftoverNotice(host, leftovers)}`;
	return { ready: false, message: `sandbox is off: ${reason}${stayed}`, leftovers };
}

async function directoryMissing(root: string, sessionId: string): Promise<boolean> {
	try {
		await stat(join(root, sessionId));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function leftoverNotice(host: SandboxHost, errors: CleanupError[]): string {
	const names = errors.map((error) => error.container);
	return `${describeCleanupErrors(errors)} could not be deleted; delete them with: ${host.driver.manualDeleteCommand(names)}`;
}

export async function checkReadiness(
	host: SandboxHost,
	selectImage?: SelectMissingImage,
	showOperation?: ShowImageOperation,
): Promise<Readiness> {
	const status = await host.driver.checkRuntime(deadlineAfter(host));
	if (!status.ready) return off(host, status.reason);
	const candidates =
		!host.customImage && host.registryImage !== undefined && host.registryImage !== host.image
			? [host.registryImage, host.image]
			: [host.image];
	let lastReason = "";
	for (const candidate of candidates) {
		const inspected = await host.driver.inspectImage(candidate, deadlineAfter(host));
		if (inspected.found) return { ready: true, image: candidate };
		lastReason = inspected.reason;
	}
	if (selectImage === undefined) {
		return off(host, `image ${host.image} is not installed (${lastReason})`);
	}
	const options =
		host.registryImage !== undefined
			? [DOWNLOAD_IMAGE_OPTION, BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]
			: [BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION];
	const choice = await selectImage(`Sandbox image ${host.image} is not installed`, options);
	if (host.state !== "unready") return off(host, START_ENDED);
	if (choice === DOWNLOAD_IMAGE_OPTION && host.registryImage !== undefined) {
		const operation = showOperation?.("download");
		const pulled = await host.driver
			.pullImage(host.registryImage, undefined, operation ? (line) => operation.output(line) : undefined)
			.finally(() => operation?.end());
		if (host.state !== "unready") return off(host, START_ENDED);
		if (pulled.code !== 0) {
			return off(host, `image pull ${host.registryImage} failed: ${commandFailure(pulled)}`);
		}
		return { ready: true, image: host.registryImage };
	}
	if (choice === BUILD_IMAGE_OPTION) {
		const operation = showOperation?.("build");
		const built = await host.driver
			.buildImage(
				host.image,
				getSandboxImageDir(),
				undefined,
				operation ? (line) => operation.output(line) : undefined,
			)
			.finally(() => operation?.end());
		if (host.state !== "unready") return off(host, START_ENDED);
		if (built.code !== 0) {
			return off(host, `image build ${host.image} failed: ${commandFailure(built)}`);
		}
		return { ready: true, image: host.image };
	}
	return off(host, `image ${host.image} is not installed (${lastReason})`);
}

/** Attaches the session to the host. Takes over `handle`: a failed activation releases it. */
export async function activateRuntime(
	host: SandboxHost,
	handle: SessionHandle,
	image: string,
	warn: Warn,
): Promise<Activation> {
	const runtime: SandboxRuntime = Object.assign(host, {
		handle,
		inFlight: new Set<string>(),
		running: new Set<RunningCall>(),
		activeSandbox: {},
	});
	runtime.image = image;
	let activated = false;
	try {
		if (runtime.state !== "unready") return off(runtime, START_ENDED);
		const recovery = await recoverLeftovers(runtime, warn);
		if ("unknown" in recovery) return off(runtime, `runtime state could not be established: ${recovery.unknown}`);
		if ("leftover" in recovery) return off(runtime, LEFTOVERS_STAYED, recovery.leftover);
		const failure = await ensureWorkVolume(runtime);
		if (failure !== undefined) {
			return off(runtime, failure.reason, failure.leftover === undefined ? [] : [failure.leftover]);
		}
		activated = true;
		return { ready: true, runtime };
	} finally {
		if (!activated) await handle.release();
	}
}

export async function recoverLeftovers(runtime: SandboxRuntime, warn: Warn): Promise<Recovery> {
	const session = runtime.handle.paths;
	const root = artifactsRootOf(session);
	const deadlineAt = deadlineAfter(runtime);
	let listing: OwnedResource[];
	try {
		listing = await runtime.driver.listSandboxes(root, deadlineAt);
	} catch (error) {
		return { unknown: error instanceof Error ? error.message : String(error) };
	}
	const judged = new Map<string, SessionLiveness>();
	const errors: CleanupError[] = [];
	for (const sandbox of listing) {
		const owner = sandbox.sessionId;
		if (owner !== session.sessionId) {
			let liveness = judged.get(owner);
			if (liveness === undefined) {
				liveness = await sessionLiveness(root, owner);
				judged.set(owner, liveness);
				if (liveness === "unknown") {
					warn(`sandbox: the lock of session ${owner} could not be read; its containers and volume are kept`);
				}
			}
			if (liveness !== "ended") continue;
		}
		const outcome = await runtime.driver.deleteSandbox(sandbox.name, deadlineAt);
		if (!outcome.removed) errors.push(outcome.error);
	}
	await removeVolumesOfGoneSessions(runtime, root, deadlineAt);
	return errors.length > 0 ? { leftover: errors } : { clean: true };
}

async function removeVolumesOfGoneSessions(runtime: SandboxRuntime, root: string, deadlineAt: number): Promise<void> {
	const session = runtime.handle.paths;
	const volumes = await runtime.driver.listWorkVolumes(session, deadlineAt);
	const gone: OwnedResource[] = [];
	for (const volume of volumes) {
		const owner = volume.sessionId;
		if (owner === session.sessionId || !(await directoryMissing(root, owner))) continue;
		gone.push(volume);
	}
	if (gone.length > 0) {
		await runtime.driver.deleteWorkVolumes(gone, session, deadlineAt);
	}
}

export function ensureWorkVolume(runtime: SandboxRuntime): Promise<VolumeFailure | undefined> {
	return runtime.driver.ensureWorkVolume(runtime.handle.paths, deadlineAfter(runtime));
}

export async function shutdownRuntime(
	runtime: SandboxRuntime,
	reason: SessionShutdownEvent["reason"],
	warn: Warn,
): Promise<void> {
	const deadlineAt = Date.now() + runtime.limits.shutdownBudgetMs;
	closeAdmission(runtime);
	await waitUntil(() => runtime.inFlight.size === 0, deadlineAt);
	if (runtime.inFlight.size === 0) {
		const hot = runtime.activeSandbox.current;
		runtime.activeSandbox.current = undefined;
		if (hot !== undefined) {
			await hot.destroy(deadlineAt);
		}
		await deleteOwned(runtime, deadlineAt, warn);
	} else {
		killChildren(runtime, "run");
	}
	if (reason === "quit") stopCli(runtime);
	const programs = runtime.inFlight.size;
	if (programs > 0) warn(`sandbox: ${programs} program(s) still stopping`);
	await closeIfDrained(runtime);
}

export async function shutdownHost(
	host: SandboxHost,
	isStarting: () => boolean,
	reason: SessionShutdownEvent["reason"],
	warn: Warn,
): Promise<void> {
	const deadlineAt = Date.now() + host.limits.shutdownBudgetMs;
	host.state = "closing";
	await waitUntil(() => !isStarting(), deadlineAt);
	if (!isStarting()) await deleteOwned(host, deadlineAt, warn);
	if (reason === "quit") stopCli(host);
}

async function waitUntil(done: () => boolean, deadlineAt: number): Promise<void> {
	while (!done() && remainingMs(deadlineAt) > 0) {
		await sleep(Math.min(TICKET_POLL_MS, remainingMs(deadlineAt)));
	}
}

async function deleteOwned(host: SandboxHost, deadlineAt: number, warn: Warn): Promise<void> {
	const leftovers = await cleanupOwned(host, deadlineAt);
	if (leftovers.length > 0) warn(`sandbox: ${describeCleanupErrors(leftovers)} could not be deleted at shutdown`);
}

function stopCli(context: SandboxDriverContext): void {
	context.cliStopped = true;
	killChildren(context);
}

function killChildren(context: SandboxDriverContext, kind?: ChildKind): void {
	for (const [child, childKind] of context.children) {
		if (kind !== undefined && childKind !== kind) continue;
		// A CLI command leads its own process group. A program of a call does not, so a group signal would miss it.
		if (childKind === "service" && child.pid !== undefined) killProcessGroup(child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	}
}
