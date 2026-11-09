import { randomBytes } from "crypto";
import { stat } from "fs/promises";
import { dirname, join } from "path";
import { setTimeout as sleep } from "timers/promises";
import type { SessionShutdownEvent } from "../../../core/extensions/types.ts";
import { type SessionLiveness, sessionLiveness } from "../../shared/session.ts";
import {
	cleanupContainer,
	cleanupOwned,
	commandFailure,
	containerCommand,
	deadlineAfter,
	describeCleanupErrors,
	firstLine,
	type ListedResource,
	parseContainers,
	parseVolumes,
	remainingMs,
} from "./cli.ts";
import type { ChildKind, CleanupError, ExecRuntime, Readiness, SessionPaths, VolumeFailure } from "./types.ts";

export const SESSION_LABEL = "polar-session";
export const ROOT_LABEL = "polar-root";
export const WORK_PATH = "/work";
export const GUEST_USER = "1000:1000";

export type Recovery = { clean: true } | { leftover: CleanupError[] } | { unknown: string };

export type Warn = (message: string) => void;

const START_ENDED = "the session is shutting down";
const LEFTOVERS_STAYED = "leftovers of sandbox stayed";
const TICKET_POLL_MS = 20;

export function workVolumeName(sessionId: string): string {
	return `polar-work-${sessionId}`;
}

export function artifactsRootOf(session: SessionPaths): string {
	return dirname(session.outputDirectory);
}

export function sessionLabels(session: SessionPaths): string[] {
	return ["--label", `${SESSION_LABEL}=${session.sessionId}`, "--label", `${ROOT_LABEL}=${artifactsRootOf(session)}`];
}

export function closeAdmission(runtime: ExecRuntime): void {
	if (runtime.state === "closing" || runtime.state === "closed") return;
	runtime.state = "closing";
	for (const call of runtime.running) call.stop();
}

export async function closeIfDrained(runtime: ExecRuntime): Promise<void> {
	if (runtime.state !== "closing" || runtime.starting !== undefined || runtime.inFlight.size > 0) return;
	runtime.state = "closed";
	await runtime.handle.release();
}

function mebibytes(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}

function off(reason: string, leftovers: CleanupError[] = []): Readiness {
	const stayed = leftovers.length === 0 ? "" : `; ${leftoverNotice(leftovers)}`;
	return { ready: false, message: `sandbox is off: ${reason}${stayed}`, leftovers };
}

function labelOf(labels: Record<string, unknown>, key: string): string | undefined {
	const value = labels[key];
	return typeof value === "string" ? value : undefined;
}

function sessionOf(resource: ListedResource, root: string): string | undefined {
	if (labelOf(resource.labels, ROOT_LABEL) !== root) return undefined;
	return labelOf(resource.labels, SESSION_LABEL);
}

async function directoryMissing(root: string, sessionId: string): Promise<boolean> {
	try {
		await stat(join(root, sessionId));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function leftoverNotice(errors: CleanupError[]): string {
	const names = errors.map((error) => error.container).join(" ");
	return `${describeCleanupErrors(errors)} could not be deleted; delete them with: container delete --force ${names}`;
}

export async function checkReadiness(runtime: ExecRuntime): Promise<Readiness> {
	const status = await containerCommand(runtime, ["system", "status"]);
	if (status.code !== 0) return off(`container system status failed: ${commandFailure(status)}`);
	const image = await containerCommand(runtime, ["image", "inspect", runtime.image]);
	if (image.code !== 0) {
		return off(
			`container image inspect ${runtime.image} failed: ${commandFailure(image)}. Build the image as extensions/exec/ARCHITECTURE.md describes.`,
		);
	}
	return { ready: true };
}

export async function startRuntime(runtime: ExecRuntime, warn: Warn): Promise<Readiness> {
	const starting = performStart(runtime, warn);
	runtime.starting = starting;
	try {
		return await starting;
	} finally {
		runtime.starting = undefined;
		await closeIfDrained(runtime);
	}
}

async function performStart(runtime: ExecRuntime, warn: Warn): Promise<Readiness> {
	const readiness = await checkReadiness(runtime);
	if (!readiness.ready) return readiness;
	if (runtime.state !== "unready") return off(START_ENDED);
	const recovery = await recoverLeftovers(runtime, warn);
	if ("unknown" in recovery) return off(`runtime state could not be established: ${recovery.unknown}`);
	if ("leftover" in recovery) return off(LEFTOVERS_STAYED, recovery.leftover);
	const failure = await ensureWorkVolume(runtime);
	if (failure === undefined) return { ready: true };
	return off(failure.reason, failure.leftover === undefined ? [] : [failure.leftover]);
}

export async function recoverLeftovers(runtime: ExecRuntime, warn: Warn): Promise<Recovery> {
	const session = runtime.handle.paths;
	const root = artifactsRootOf(session);
	const deadlineAt = deadlineAfter(runtime);
	const listed = await containerCommand(runtime, ["list", "--all", "--format", "json"], remainingMs(deadlineAt));
	const listing = listed.code === 0 ? parseContainers(listed.stdout) : undefined;
	if (listing === undefined) return { unknown: listed.code === 0 ? "unreadable listing" : commandFailure(listed) };
	const judged = new Map<string, SessionLiveness>();
	const errors: CleanupError[] = [];
	for (const container of listing) {
		const owner = sessionOf(container, root);
		if (owner === undefined) continue;
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
		const outcome = await cleanupContainer(runtime, container.name, deadlineAt);
		if (!outcome.removed) errors.push(outcome.error);
	}
	await removeVolumesOfGoneSessions(runtime, root, deadlineAt);
	return errors.length > 0 ? { leftover: errors } : { clean: true };
}

async function removeVolumesOfGoneSessions(runtime: ExecRuntime, root: string, deadlineAt: number): Promise<void> {
	const own = runtime.handle.paths.sessionId;
	if (remainingMs(deadlineAt) === 0) return;
	const listed = await containerCommand(runtime, ["volume", "list", "--format", "json"], remainingMs(deadlineAt));
	const volumes = listed.code === 0 ? parseVolumes(listed.stdout) : undefined;
	for (const volume of volumes ?? []) {
		const owner = sessionOf(volume, root);
		if (owner === undefined || owner === own || !(await directoryMissing(root, owner))) continue;
		if (remainingMs(deadlineAt) === 0) return;
		await containerCommand(runtime, ["volume", "delete", volume.name], remainingMs(deadlineAt));
	}
}

export async function ensureWorkVolume(runtime: ExecRuntime): Promise<VolumeFailure | undefined> {
	const session = runtime.handle.paths;
	const root = artifactsRootOf(session);
	const name = workVolumeName(session.sessionId);
	const inspected = await containerCommand(runtime, ["volume", "inspect", name]);
	let created = false;
	if (inspected.code === 0) {
		const [volume] = parseVolumes(inspected.stdout) ?? [];
		if (volume === undefined) return { reason: "the /work volume could not be inspected: unreadable answer" };
		const label = labelOf(volume.labels, ROOT_LABEL);
		if (label !== root) {
			return {
				reason: `the volume ${name} is not this session's: its ${ROOT_LABEL} label is ${label ?? "missing"}, expected ${root}`,
			};
		}
	} else if (firstLine(inspected.stderr) === `Error: volume not found: ${name}`) {
		if (runtime.state !== "unready") return { reason: START_ENDED };
		const size = `${mebibytes(runtime.limits.workMaxBytes)}M`;
		const creation = await containerCommand(runtime, [
			"volume",
			"create",
			"-s",
			size,
			...sessionLabels(session),
			name,
		]);
		if (creation.code !== 0) return { reason: `the /work volume could not be created: ${commandFailure(creation)}` };
		created = true;
	} else {
		return { reason: `the /work volume could not be inspected: ${commandFailure(inspected)}` };
	}
	const failure = await prepareWorkVolume(runtime, name);
	if (failure !== undefined && created) {
		await containerCommand(runtime, ["volume", "delete", name]);
	}
	return failure;
}

async function prepareWorkVolume(runtime: ExecRuntime, volume: string): Promise<VolumeFailure | undefined> {
	const session = runtime.handle.paths;
	const name = `polar-prep-${session.sessionId}-${randomBytes(4).toString("hex")}`;
	if (runtime.state !== "unready") return { reason: START_ENDED };
	runtime.owned.add(name);
	const ran = await containerCommand(runtime, [
		"run",
		"--progress",
		"none",
		"--network",
		"none",
		"--user",
		"0:0",
		"--volume",
		`${volume}:${WORK_PATH}`,
		"--name",
		name,
		...sessionLabels(session),
		runtime.image,
		"chown",
		GUEST_USER,
		WORK_PATH,
	]);
	const cleanup = await cleanupContainer(runtime, name, deadlineAfter(runtime));
	const leftover = cleanup.removed ? undefined : cleanup.error;
	if (ran.code !== 0) return { reason: `the /work volume could not be prepared: ${commandFailure(ran)}`, leftover };
	if (leftover !== undefined) return { reason: LEFTOVERS_STAYED, leftover };
	return undefined;
}

export async function shutdownRuntime(
	runtime: ExecRuntime,
	reason: SessionShutdownEvent["reason"],
	warn: Warn,
): Promise<void> {
	const deadlineAt = Date.now() + runtime.limits.shutdownBudgetMs;
	closeAdmission(runtime);
	await ticketsDrained(runtime, deadlineAt);
	if (runtime.starting === undefined && runtime.inFlight.size === 0) {
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

async function ticketsDrained(runtime: ExecRuntime, deadlineAt: number): Promise<void> {
	while ((runtime.starting !== undefined || runtime.inFlight.size > 0) && remainingMs(deadlineAt) > 0) {
		await sleep(Math.min(TICKET_POLL_MS, remainingMs(deadlineAt)));
	}
}

function killChildren(runtime: ExecRuntime, kind?: ChildKind): void {
	for (const [child, childKind] of runtime.children) {
		if (kind === undefined || childKind === kind) child.kill("SIGKILL");
	}
}
