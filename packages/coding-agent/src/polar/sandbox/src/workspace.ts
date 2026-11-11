import { stat } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import type { SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { type SessionLiveness, sessionLiveness } from "../../shared/session.ts";
import { deadlineAfter, describeCleanupErrors, remainingMs } from "./cli.ts";
import { artifactsRootOf, LEFTOVERS_STAYED, START_ENDED } from "./driver.ts";
import type { ChildKind, CleanupError, OwnedResource, Readiness, SandboxRuntime, VolumeFailure } from "./types.ts";

export type Recovery = { clean: true } | { leftover: CleanupError[] } | { unknown: string };

export type Warn = (message: string) => void;

const TICKET_POLL_MS = 20;

export async function cleanupOwned(
	runtime: SandboxRuntime,
	deadlineAt: number,
	exclude?: string,
): Promise<CleanupError[]> {
	const errors: CleanupError[] = [];
	for (const name of [...runtime.owned]) {
		if (name === exclude) continue;
		const outcome = await runtime.driver.deleteSandbox(name, deadlineAt);
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
	if (runtime.state !== "closing" || runtime.starting !== undefined || runtime.inFlight.size > 0) return;
	runtime.state = "closed";
	await runtime.handle.release();
}

function off(runtime: SandboxRuntime, reason: string, leftovers: CleanupError[] = []): Readiness {
	const stayed = leftovers.length === 0 ? "" : `; ${leftoverNotice(runtime, leftovers)}`;
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

function leftoverNotice(runtime: SandboxRuntime, errors: CleanupError[]): string {
	const names = errors.map((error) => error.container);
	return `${describeCleanupErrors(errors)} could not be deleted; delete them with: ${runtime.driver.manualDeleteCommand(names)}`;
}

export async function checkReadiness(runtime: SandboxRuntime): Promise<Readiness> {
	const status = await runtime.driver.checkRuntime(deadlineAfter(runtime));
	if (!status.ready) return off(runtime, status.reason);
	const image = await runtime.driver.inspectImage(runtime.image, deadlineAfter(runtime));
	if (!image.found) {
		return off(
			runtime,
			`${image.reason}. Build the image as packages/coding-agent/src/polar/sandbox/ARCHITECTURE.md describes.`,
		);
	}
	return { ready: true };
}

export async function startRuntime(runtime: SandboxRuntime, warn: Warn): Promise<Readiness> {
	const starting = performStart(runtime, warn);
	runtime.starting = starting;
	try {
		return await starting;
	} finally {
		runtime.starting = undefined;
		await closeIfDrained(runtime);
	}
}

async function performStart(runtime: SandboxRuntime, warn: Warn): Promise<Readiness> {
	const readiness = await checkReadiness(runtime);
	if (!readiness.ready) return readiness;
	if (runtime.state !== "unready") return off(runtime, START_ENDED);
	const recovery = await recoverLeftovers(runtime, warn);
	if ("unknown" in recovery) return off(runtime, `runtime state could not be established: ${recovery.unknown}`);
	if ("leftover" in recovery) return off(runtime, LEFTOVERS_STAYED, recovery.leftover);
	const failure = await ensureWorkVolume(runtime);
	if (failure === undefined) return { ready: true };
	return off(runtime, failure.reason, failure.leftover === undefined ? [] : [failure.leftover]);
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
	const own = runtime.handle.paths.sessionId;
	const volumes = await runtime.driver.listWorkVolumes(root, deadlineAt);
	for (const volume of volumes) {
		const owner = volume.sessionId;
		if (owner === own || !(await directoryMissing(root, owner))) continue;
		await runtime.driver.deleteWorkVolume(volume.name, owner, deadlineAt);
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
	await ticketsDrained(runtime, deadlineAt);
	if (runtime.starting === undefined && runtime.inFlight.size === 0) {
		const hot = runtime.activeSandbox.current;
		runtime.activeSandbox.current = undefined;
		if (hot !== undefined) {
			await hot.destroy(deadlineAt);
		}
		const leftovers = await cleanupOwned(runtime, deadlineAt);
		if (leftovers.length > 0) warn(`sandbox: ${describeCleanupErrors(leftovers)} could not be deleted at shutdown`);
	} else {
		killChildren(runtime, "run");
	}
	if (reason === "quit") {
		runtime.cliStopped = true;
		killChildren(runtime);
	}
	const programs = runtime.inFlight.size;
	if (programs > 0) warn(`sandbox: ${programs} program(s) still stopping`);
	await closeIfDrained(runtime);
}

async function ticketsDrained(runtime: SandboxRuntime, deadlineAt: number): Promise<void> {
	while ((runtime.starting !== undefined || runtime.inFlight.size > 0) && remainingMs(deadlineAt) > 0) {
		await sleep(Math.min(TICKET_POLL_MS, remainingMs(deadlineAt)));
	}
}

function killChildren(runtime: SandboxRuntime, kind?: ChildKind): void {
	for (const [child, childKind] of runtime.children) {
		if (kind === undefined || childKind === kind) child.kill("SIGKILL");
	}
}
