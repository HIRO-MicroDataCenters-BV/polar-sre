import { type ChildProcessByStdio, spawn } from "child_process";
import { randomBytes } from "crypto";
import { once } from "events";
import { dirname, join } from "path";
import type { Readable, Writable } from "stream";
import {
	CLI_STOPPED,
	cleanupContainer,
	commandFailure,
	containerCommand,
	deadlineAfter,
	firstLine,
	type ListedResource,
	parseContainers,
	parseVolumes,
	remainingMs,
	StreamCapture,
} from "./cli.ts";
import {
	type CleanupOutcome,
	type CommandOutcome,
	DATA_PATH,
	type HotSandbox,
	type Inspection,
	type OwnedResource,
	type SandboxDriver,
	type SandboxLanguage,
	type SandboxRuntime,
	type SandboxStartOutcome,
	type SessionPaths,
	type SpawnCallOutcome,
	type VolumeFailure,
} from "./types.ts";

export type {
	HotSandbox,
	SandboxDriver,
	SandboxProcess,
	SandboxStartOutcome,
	SpawnCallOutcome,
} from "./types.ts";

type RunProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export const SESSION_LABEL = "polar-session";
export const ROOT_LABEL = "polar-root";
export const WORK_PATH = "/work";
export const TMP_PATH = "/tmp";
export const GUEST_USER = "1000:1000";
export const KEEPALIVE_COMMAND = "echo; while read -r _; do :; done";

export const SCRUB_SCRIPT = [
	"kill -9 -1 2>/dev/null",
	"chmod -R u+rwX /tmp /dev/shm /dev/mqueue 2>/dev/null",
	"find /tmp /dev/shm /dev/mqueue -mindepth 1 -delete 2>/dev/null",
	"for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -1 2>/dev/null || break; sleep 0.02; done",
	'! kill -0 -1 2>/dev/null && [ -z "$(find /tmp /dev/shm /dev/mqueue -mindepth 1 -print -quit 2>/dev/null)" ]',
].join("\n");

const START_ENDED = "the session is shutting down";
const LEFTOVERS_STAYED = "leftovers of sandbox stayed";
const BUILD_TIMEOUT_MS = 600_000;
const KEEPALIVE_STOP_GRACE_MS = 200;
const COMMAND_STDERR_MAX_BYTES = 16 * 1024 * 1024;
const OOM_LINE_GLOBAL = /(?:Memory cgroup out of memory|Out of memory): Killed process[^\n]*/g;

const PROGRAM_FILES: Record<SandboxLanguage, string> = { python: "program.py", bash: "program.sh" };
const INTERPRETERS: Record<SandboxLanguage, string> = { python: "python3", bash: "bash" };

export function launcher(language: SandboxLanguage): string {
	const file = `"$d/${PROGRAM_FILES[language]}"`;
	return `d="\${TMPDIR:-/tmp}/.polar"; mkdir -p "$d" && cat > ${file} && exec ${INTERPRETERS[language]} ${file} </dev/null`;
}

export function workVolumeName(sessionId: string): string {
	return `polar-work-${sessionId}`;
}

export function artifactsRootOf(session: SessionPaths): string {
	return dirname(session.outputDirectory);
}

export function sessionLabels(session: SessionPaths): string[] {
	return ["--label", `${SESSION_LABEL}=${session.sessionId}`, "--label", `${ROOT_LABEL}=${artifactsRootOf(session)}`];
}

function createVolumeMebibytes(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}

function limitMebibytes(bytes: number): number {
	return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

function labelOf(labels: Record<string, unknown>, key: string): string | undefined {
	const value = labels[key];
	return typeof value === "string" ? value : undefined;
}

function ownedInRoot(resources: ListedResource[], root: string): OwnedResource[] {
	const owned: OwnedResource[] = [];
	for (const resource of resources) {
		if (labelOf(resource.labels, ROOT_LABEL) !== root) continue;
		const sessionId = labelOf(resource.labels, SESSION_LABEL);
		if (sessionId !== undefined) owned.push({ name: resource.name, sessionId });
	}
	return owned;
}

export function sandboxArguments(
	runtime: SandboxRuntime,
	name: string,
	session: SessionPaths = runtime.handle.paths,
): string[] {
	const { limits } = runtime;
	return [
		"run",
		"--progress",
		"none",
		"--network",
		"none",
		"--user",
		GUEST_USER,
		"--cap-drop",
		"ALL",
		"--read-only",
		"--tmpfs",
		`${TMP_PATH}:size=${limitMebibytes(limits.tmpMaxBytes)}M`,
		"--memory",
		`${limitMebibytes(limits.memoryBytes)}M`,
		"--cpus",
		String(limits.cpus),
		"--ulimit",
		`nproc=${limits.processMax}:${limits.processMax}`,
		"--volume",
		`${session.outputDirectory}:${DATA_PATH}:ro`,
		"--volume",
		`${workVolumeName(session.sessionId)}:${WORK_PATH}`,
		"--workdir",
		WORK_PATH,
		"--env",
		`HOME=${WORK_PATH}`,
		"--env",
		`TMPDIR=${TMP_PATH}`,
		"--name",
		name,
		...sessionLabels(session),
		"--interactive",
		runtime.image,
		"bash",
		"-c",
		KEEPALIVE_COMMAND,
	];
}

export function execArguments(name: string, language: SandboxLanguage): string[] {
	return [
		"exec",
		"--interactive",
		"--user",
		GUEST_USER,
		"--workdir",
		WORK_PATH,
		"--env",
		`HOME=${WORK_PATH}`,
		"--env",
		`TMPDIR=${TMP_PATH}`,
		name,
		"bash",
		"-c",
		launcher(language),
	];
}

export function inspectionOf(inspected: CommandOutcome, name: string): Inspection {
	if (inspected.code === 0) {
		const listed = parseContainers(inspected.stdout);
		if (listed?.some((container) => container.name === name)) return { state: "present" };
		return { state: "unknown", detail: "unreadable answer" };
	}
	if (firstLine(inspected.stderr) === `Error: container not found: ${name}`) return { state: "absent" };
	return { state: "unknown", detail: commandFailure(inspected) };
}

function oomMatches(bootLog: string): string[] {
	return [...bootLog.matchAll(OOM_LINE_GLOBAL)].map((match) => match[0].trim());
}

export class AppleHotSandbox implements HotSandbox {
	readonly name: string;
	private readonly runtime: SandboxRuntime;
	private readonly keepalive: RunProcess;
	private readonly keepaliveClosed: Promise<number | null>;
	private keepaliveExited = false;
	private oomBaseline = 0;
	private tainted = false;
	private destroyed = false;
	private killing: Promise<CommandOutcome> | undefined;

	constructor(name: string, runtime: SandboxRuntime, keepalive: RunProcess, keepaliveClosed: Promise<number | null>) {
		this.name = name;
		this.runtime = runtime;
		this.keepalive = keepalive;
		this.keepaliveClosed = keepaliveClosed.then((code) => {
			this.keepaliveExited = true;
			return code;
		});
	}

	async inspect(deadlineAt: number): Promise<Inspection> {
		if (remainingMs(deadlineAt) === 0) return { state: "unknown", detail: "timed out" };
		const inspected = await containerCommand(this.runtime, ["inspect", this.name], remainingMs(deadlineAt));
		return inspectionOf(inspected, this.name);
	}

	async spawnCall(language: SandboxLanguage): Promise<SpawnCallOutcome> {
		if (this.destroyed || this.keepaliveExited || this.keepalive.exitCode !== null) {
			return { gone: "sandbox is not running" };
		}
		const boot = await containerCommand(this.runtime, ["logs", "--boot", this.name]);
		if (boot.code !== 0) return { gone: commandFailure(boot) };
		this.oomBaseline = oomMatches(boot.stdout).length;
		if (this.destroyed || this.keepaliveExited || this.keepalive.exitCode !== null) {
			return { gone: "sandbox is not running" };
		}
		const args = execArguments(this.name, language);
		const child = spawn(this.runtime.containerCommand, args, {
			env: this.runtime.environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (child.pid === undefined) {
			const [error] = await once(child, "error");
			return { gone: (error as Error).message };
		}
		this.runtime.children.set(child, "run");
		let graceTimer: NodeJS.Timeout | undefined;
		const closed = new Promise<number | null>((resolve) => {
			child.once("close", (code) => {
				clearTimeout(graceTimer);
				this.runtime.children.delete(child);
				resolve(code);
			});
		});
		return {
			spawned: {
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: child.stderr,
				closed,
				kill: () => {
					if (this.tainted) return;
					this.tainted = true;
					this.killing = containerCommand(this.runtime, ["kill", this.name]);
					graceTimer = setTimeout(() => {
						child.kill("SIGKILL");
						this.keepalive.kill("SIGKILL");
					}, this.runtime.limits.killGraceMs);
				},
			},
		};
	}

	async checkOom(deadlineAt: number): Promise<string | undefined> {
		if (remainingMs(deadlineAt) === 0) return undefined;
		const log = await containerCommand(this.runtime, ["logs", "--boot", this.name], remainingMs(deadlineAt));
		const matches = oomMatches(log.stdout);
		if (matches.length <= this.oomBaseline) return undefined;
		this.oomBaseline = matches.length;
		return matches.at(-1);
	}

	async scrubAfterCall(deadlineAt: number): Promise<boolean> {
		if (this.destroyed || this.tainted || this.keepaliveExited || remainingMs(deadlineAt) === 0) return false;
		const scrubbed = await containerCommand(
			this.runtime,
			["exec", "--user", GUEST_USER, this.name, "bash", "-c", SCRUB_SCRIPT],
			remainingMs(deadlineAt),
		);
		return scrubbed.code === 0 && !scrubbed.timedOut && !this.keepaliveExited && this.keepalive.exitCode === null;
	}

	async destroy(deadlineAt: number): Promise<CleanupOutcome> {
		this.destroyed = true;
		this.keepalive.stdin.end();
		await this.killing;
		if (!this.keepaliveExited && this.keepalive.exitCode === null && remainingMs(deadlineAt) > 0) {
			const waitMs = Math.min(KEEPALIVE_STOP_GRACE_MS, remainingMs(deadlineAt));
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, waitMs);
				void this.keepaliveClosed.then(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		if (!this.keepaliveExited && this.keepalive.exitCode === null) {
			this.keepalive.kill("SIGKILL");
		}
		return cleanupContainer(this.runtime, this.name, deadlineAt);
	}
}

export class AppleContainerDriver implements SandboxDriver {
	readonly name = "apple-container" as const;
	readonly boundaryDescription = "apple-container (microVM)";
	private readonly runtime: SandboxRuntime;
	lastImageFailure = "";

	constructor(runtime: SandboxRuntime) {
		this.runtime = runtime;
	}

	async checkRuntime(deadlineAt: number): Promise<{ ready: true } | { ready: false; reason: string }> {
		const status = await containerCommand(this.runtime, ["system", "status"], remainingMs(deadlineAt));
		if (status.code !== 0)
			return { ready: false, reason: `container system status failed: ${commandFailure(status)}` };
		return { ready: true };
	}

	async inspectImage(image: string, deadlineAt: number): Promise<boolean> {
		const inspected = await containerCommand(this.runtime, ["image", "inspect", image], remainingMs(deadlineAt));
		if (inspected.code === 0) {
			this.lastImageFailure = "";
			return true;
		}
		this.lastImageFailure = commandFailure(inspected);
		return false;
	}

	pullImage(image: string, signal?: AbortSignal): Promise<CommandOutcome> {
		return containerCommand(this.runtime, ["image", "pull", image], this.runtime.limits.commandTimeoutMs, signal);
	}

	buildImage(image: string, contextDir: string, signal?: AbortSignal): Promise<CommandOutcome> {
		return containerCommand(
			this.runtime,
			["build", "--arch", "arm64", "--tag", image, "--file", join(contextDir, "Containerfile"), contextDir],
			BUILD_TIMEOUT_MS,
			signal,
		);
	}

	async listSandboxes(root: string, deadlineAt: number): Promise<OwnedResource[]> {
		const listed = await containerCommand(
			this.runtime,
			["list", "--all", "--format", "json"],
			remainingMs(deadlineAt),
		);
		const listing = listed.code === 0 ? parseContainers(listed.stdout) : undefined;
		if (listing === undefined) {
			throw new Error(listed.code === 0 ? "unreadable listing" : commandFailure(listed));
		}
		return ownedInRoot(listing, root);
	}

	deleteSandbox(name: string, deadlineAt: number): Promise<CleanupOutcome> {
		return cleanupContainer(this.runtime, name, deadlineAt);
	}

	async listWorkVolumes(root: string, deadlineAt: number): Promise<OwnedResource[]> {
		if (remainingMs(deadlineAt) === 0) return [];
		const listed = await containerCommand(
			this.runtime,
			["volume", "list", "--format", "json"],
			remainingMs(deadlineAt),
		);
		const volumes = listed.code === 0 ? parseVolumes(listed.stdout) : undefined;
		return ownedInRoot(volumes ?? [], root);
	}

	async ensureWorkVolume(session: SessionPaths, deadlineAt: number): Promise<VolumeFailure | undefined> {
		const root = artifactsRootOf(session);
		const name = workVolumeName(session.sessionId);
		const inspected = await containerCommand(this.runtime, ["volume", "inspect", name], remainingMs(deadlineAt));
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
			if (this.runtime.state !== "unready") return { reason: START_ENDED };
			const size = `${createVolumeMebibytes(this.runtime.limits.workMaxBytes)}M`;
			const creation = await containerCommand(this.runtime, [
				"volume",
				"create",
				"-s",
				size,
				...sessionLabels(session),
				name,
			]);
			if (creation.code !== 0) {
				return { reason: `the /work volume could not be created: ${commandFailure(creation)}` };
			}
			created = true;
		} else {
			return { reason: `the /work volume could not be inspected: ${commandFailure(inspected)}` };
		}
		const failure = await this.prepareWorkVolume(session, name);
		if (failure !== undefined && created) {
			await containerCommand(this.runtime, ["volume", "delete", name]);
		}
		return failure;
	}

	async deleteWorkVolume(name: string, _ownerSessionId: string, deadlineAt: number): Promise<void> {
		if (remainingMs(deadlineAt) === 0) return;
		await containerCommand(this.runtime, ["volume", "delete", name], remainingMs(deadlineAt));
	}

	async startSandbox(
		name: string,
		session: SessionPaths,
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<SandboxStartOutcome> {
		if (this.runtime.cliStopped) return { failed: CLI_STOPPED };
		if (signal?.aborted) return { failed: "cancelled" };
		if (remainingMs(deadlineAt) === 0) return { failed: "timed out" };
		const args = sandboxArguments(this.runtime, name, session);
		const child = spawn(this.runtime.containerCommand, args, {
			env: this.runtime.environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (child.pid === undefined) {
			const [error] = await once(child, "error");
			return { failed: (error as Error).message };
		}
		this.runtime.owned.add(name);
		this.runtime.children.set(child, "run");
		child.stdin.on("error", () => {});
		const stderr = new StreamCapture(COMMAND_STDERR_MAX_BYTES);
		child.stderr.on("data", (chunk: Buffer) => stderr.retain(chunk));
		const keepaliveClosed = new Promise<number | null>((resolve) => {
			child.once("close", (code) => {
				this.runtime.children.delete(child);
				resolve(code);
			});
		});
		const startup = await new Promise<{ ready: true } | { ready: false; reason: string }>((resolve) => {
			let settled = false;
			const finish = (outcome: { ready: true } | { ready: false; reason: string }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				child.stdout.removeListener("data", onReady);
				child.removeListener("error", onError);
				child.removeListener("close", onClose);
				resolve(outcome);
			};
			const onReady = () => finish({ ready: true });
			const onError = (error: Error) => finish({ ready: false, reason: error.message });
			const onClose = (code: number | null) =>
				finish({
					ready: false,
					reason: commandFailure({ code, stdout: "", stderr: stderr.text(), timedOut: false }),
				});
			const onAbort = () => finish({ ready: false, reason: "cancelled" });
			const timer = setTimeout(
				() =>
					finish({
						ready: false,
						reason: commandFailure({ code: null, stdout: "", stderr: stderr.text(), timedOut: true }),
					}),
				Math.max(1, remainingMs(deadlineAt)),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.once("data", onReady);
			child.once("error", onError);
			child.once("close", onClose);
		});
		if (startup.ready) {
			return { started: new AppleHotSandbox(name, this.runtime, child, keepaliveClosed) };
		}
		child.stdin.end();
		child.kill("SIGKILL");
		await keepaliveClosed;
		const cleanup = await cleanupContainer(this.runtime, name, deadlineAfter(this.runtime));
		return {
			failed: startup.reason,
			leftover: cleanup.removed ? undefined : cleanup.error,
		};
	}

	private async prepareWorkVolume(session: SessionPaths, volume: string): Promise<VolumeFailure | undefined> {
		const name = `polar-prep-${session.sessionId}-${randomBytes(4).toString("hex")}`;
		if (this.runtime.state !== "unready") return { reason: START_ENDED };
		this.runtime.owned.add(name);
		const ran = await containerCommand(this.runtime, [
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
			this.runtime.image,
			"chown",
			GUEST_USER,
			WORK_PATH,
		]);
		const cleanup = await cleanupContainer(this.runtime, name, deadlineAfter(this.runtime));
		const leftover = cleanup.removed ? undefined : cleanup.error;
		if (ran.code !== 0) return { reason: `the /work volume could not be prepared: ${commandFailure(ran)}`, leftover };
		if (leftover !== undefined) return { reason: LEFTOVERS_STAYED, leftover };
		return undefined;
	}
}
