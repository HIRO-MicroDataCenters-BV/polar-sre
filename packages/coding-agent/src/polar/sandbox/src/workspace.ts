import { stat } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import type { SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { acquireSession, type SessionLiveness, sessionLiveness } from "../../shared/session.ts";
import { deadlineAfter, describeCleanupErrors, remainingMs } from "./cli.ts";
import { artifactsRootOf, LEFTOVERS_STAYED, START_ENDED } from "./driver.ts";
import type {
	Activation,
	ChildKind,
	CleanupError,
	NotReady,
	OwnedResource,
	RunningCall,
	SandboxDriverContext,
	SandboxHost,
	SandboxRuntime,
	SessionPaths,
	VolumeFailure,
} from "./types.ts";

export type Recovery = { clean: true } | { leftover: CleanupError[] } | { unknown: string };

export type Warn = (message: string) => void;

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

/** Acquires the session lock and attaches the session to the host only after activation succeeds. */
export async function activateRuntime(
	host: SandboxHost,
	sessionId: string,
	cwd: string,
	image: string,
	warn: Warn,
	artifactsRoot?: string,
): Promise<Activation> {
	if (host.state !== "unready") return off(host, START_ENDED);
	const handle = await acquireSession(sessionId, cwd, artifactsRoot);
	let activated = false;
	try {
		if (host.state !== "unready") return off(host, START_ENDED);
		host.image = image;
		const recovery = await recoverLeftovers(host, handle.paths, warn);
		if ("unknown" in recovery) return off(host, `runtime state could not be established: ${recovery.unknown}`);
		if ("leftover" in recovery) return off(host, LEFTOVERS_STAYED, recovery.leftover);
		const failure = await ensureWorkVolume(host, handle.paths);
		if (failure !== undefined) {
			return off(host, failure.reason, failure.leftover === undefined ? [] : [failure.leftover]);
		}
		const runtime: SandboxRuntime = Object.assign(host, {
			handle,
			inFlight: new Set<string>(),
			running: new Set<RunningCall>(),
			activeSandbox: {},
		});
		activated = true;
		return { ready: true, runtime };
	} finally {
		if (!activated) await handle.release();
	}
}

export async function recoverLeftovers(host: SandboxHost, session: SessionPaths, warn: Warn): Promise<Recovery> {
	const root = artifactsRootOf(session);
	const deadlineAt = deadlineAfter(host);
	let listing: OwnedResource[];
	try {
		listing = await host.driver.listSandboxes(root, deadlineAt);
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
		const outcome = await host.driver.deleteSandbox(sandbox.name, deadlineAt);
		if (!outcome.removed) errors.push(outcome.error);
	}
	await removeVolumesOfGoneSessions(host, session, root, deadlineAt);
	return errors.length > 0 ? { leftover: errors } : { clean: true };
}

async function removeVolumesOfGoneSessions(
	host: SandboxHost,
	session: SessionPaths,
	root: string,
	deadlineAt: number,
): Promise<void> {
	const volumes = await host.driver.listWorkVolumes(session, deadlineAt);
	const gone: OwnedResource[] = [];
	for (const volume of volumes) {
		const owner = volume.sessionId;
		if (owner === session.sessionId || !(await directoryMissing(root, owner))) continue;
		gone.push(volume);
	}
	if (gone.length > 0) {
		await host.driver.deleteWorkVolumes(gone, session, deadlineAt);
	}
}

export function ensureWorkVolume(host: SandboxHost, session: SessionPaths): Promise<VolumeFailure | undefined> {
	return host.driver.ensureWorkVolume(session, deadlineAfter(host));
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
	isPending: () => boolean,
	reason: SessionShutdownEvent["reason"],
	warn: Warn,
): Promise<void> {
	const deadlineAt = Date.now() + host.limits.shutdownBudgetMs;
	const isClosed = () => host.state === "closed";
	host.state = "closing";
	await waitUntil(() => !isPending(), deadlineAt);
	if (isClosed()) return;
	if (!isPending()) await deleteOwned(host, deadlineAt, warn);
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
	for (const entry of [...context.children]) {
		if (kind !== undefined && entry.kind !== kind) continue;
		entry.kill();
	}
}
