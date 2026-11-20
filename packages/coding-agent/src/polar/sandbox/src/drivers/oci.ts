import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { once } from "events";
import { tmpdir } from "os";
import { join } from "path";
import {
	CLI_STOPPED,
	commandFailure,
	containerCommand,
	deadlineAfter,
	type ListedResource,
	remainingMs,
	StreamCapture,
} from "../cli.ts";
import {
	type CleanupOutcome,
	type CommandOutcome,
	DATA_PATH,
	type HotSandbox,
	type Inspection,
	type OciEngine,
	type OciEngineChoice,
	type OwnedResource,
	type SandboxDriver,
	type SandboxDriverContext,
	type SandboxLanguage,
	type SandboxStartOutcome,
	type SessionPaths,
	type SpawnCallOutcome,
	type VolumeFailure,
} from "../types.ts";
import {
	artifactsRootOf,
	BUILD_TIMEOUT_MS,
	COMMAND_STDERR_MAX_BYTES,
	GUEST_USER,
	isObject,
	KEEPALIVE_COMMAND,
	KEEPALIVE_STOP_GRACE_MS,
	LEFTOVERS_STAYED,
	labelOf,
	launcher,
	limitMebibytes,
	ownedInRoot,
	parseOomKillCount,
	ROOT_LABEL,
	type RunProcess,
	SCRUB_SCRIPT,
	START_ENDED,
	sessionLabels,
	TMP_PATH,
	WORK_PATH,
	workVolumeName,
} from "./shared.ts";

export const ROOTLESS_DOCKER_UNSUPPORTED =
	"rootless Docker does not support unprivileged read-only bind-mount UID mapping; use rootless Podman >= 4.3 or standard Docker";

export interface OciRunOptions {
	rootless: boolean;
	guestUser: string;
	cpuDelegated: boolean;
	ociRuntime?: string;
	gvisor?: boolean;
}

export interface OciDriverOptions {
	engine?: OciEngineChoice;
	ociRuntime?: string;
	hostUid?: number;
	hostGid?: number;
}

export function parseOciNames(text: string): string[] | undefined {
	const names: string[] = [];
	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		if (/\s/.test(trimmed)) return undefined;
		names.push(trimmed);
	}
	return names;
}

export function parseOciContainers(text: string): ListedResource[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const resources: ListedResource[] = [];
	for (const entry of parsed) {
		if (!isObject(entry)) return undefined;
		const rawName = typeof entry.Name === "string" ? entry.Name.replace(/^\//, "") : entry.Id;
		if (typeof rawName !== "string" || rawName === "") return undefined;
		const config = entry.Config;
		if (!isObject(config)) return undefined;
		const rawLabels = config.Labels === undefined || config.Labels === null ? {} : config.Labels;
		if (!isObject(rawLabels)) return undefined;
		const stateObj = entry.State;
		let state: string | undefined;
		if (isObject(stateObj)) {
			if (stateObj.Running === true) state = "running";
			else if (typeof stateObj.Status === "string" && stateObj.Status !== "") state = stateObj.Status;
		}
		resources.push(
			state === undefined ? { name: rawName, labels: rawLabels } : { name: rawName, labels: rawLabels, state },
		);
	}
	return resources;
}

export function parseOciVolumes(text: string): ListedResource[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const resources: ListedResource[] = [];
	for (const entry of parsed) {
		if (!isObject(entry)) return undefined;
		const name = entry.Name;
		const rawLabels = entry.Labels === undefined || entry.Labels === null ? {} : entry.Labels;
		if (typeof name !== "string" || name === "" || !isObject(rawLabels)) return undefined;
		resources.push({ name, labels: rawLabels });
	}
	return resources;
}

export function parseOciOomKilled(text: string, name: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (!Array.isArray(parsed)) return false;
	for (const entry of parsed) {
		if (!isObject(entry)) continue;
		const rawName = typeof entry.Name === "string" ? entry.Name.replace(/^\//, "") : entry.Id;
		if (rawName !== name) continue;
		const state = entry.State;
		if (isObject(state) && state.OOMKilled === true) return true;
	}
	return false;
}

export async function cleanupOciContainer(
	runtime: SandboxDriverContext,
	name: string,
	deadlineAt: number,
): Promise<CleanupOutcome> {
	runtime.owned.add(name);
	const confirmed = () => {
		runtime.owned.delete(name);
		return { removed: true } as const;
	};
	if (remainingMs(deadlineAt) === 0) return { removed: false, error: { container: name, message: "no time left" } };
	const deleted = await containerCommand(runtime, ["rm", "--force", name], remainingMs(deadlineAt));
	if (deleted.code === 0) return confirmed();
	let message = `delete: ${commandFailure(deleted)}`;
	if (remainingMs(deadlineAt) > 0) {
		const listed = await containerCommand(runtime, ["ps", "-a", "--format", "{{.Names}}"], remainingMs(deadlineAt));
		const names = listed.code === 0 ? parseOciNames(listed.stdout) : undefined;
		if (names !== undefined && !names.includes(name)) return confirmed();
		message +=
			names === undefined
				? `; list: ${listed.code === 0 ? "unreadable" : commandFailure(listed)}`
				: "; still listed";
	} else {
		message += "; no time left to list";
	}
	return { removed: false, error: { container: name, message } };
}

export function ociSandboxArguments(
	runtime: SandboxDriverContext,
	name: string,
	options: OciRunOptions,
	session: SessionPaths,
): string[] {
	const { limits } = runtime;
	const mem = `${limitMebibytes(limits.memoryBytes)}m`;
	const tmpSize = `${limitMebibytes(limits.tmpMaxBytes)}m`;
	const args: string[] = ["run", "--network", "none"];
	if (options.ociRuntime !== undefined) {
		args.push("--runtime", options.ociRuntime);
	}
	if (options.rootless) {
		args.push("--userns=keep-id:uid=1000,gid=1000");
	}
	args.push(
		"--user",
		options.guestUser,
		"--cap-drop",
		"ALL",
		"--security-opt=no-new-privileges",
		"--security-opt",
		"label=disable",
		"--read-only",
		"--tmpfs",
		`${TMP_PATH}:rw,exec,nosuid,nodev,size=${tmpSize}`,
		"--memory",
		mem,
		"--memory-swap",
		mem,
	);
	if (options.cpuDelegated) {
		args.push("--cpus", String(limits.cpus));
	}
	// Under runsc (gVisor), cgroup --pids-limit counts internal Sentry threads, so launcher enforces ulimit -u instead.
	if (options.gvisor !== true) {
		args.push("--pids-limit", String(limits.processMax));
	}
	args.push(
		"--volume",
		`${session.outputDirectory}:${DATA_PATH}:ro`,
		"--volume",
		`${workVolumeName(session.sessionId)}:${WORK_PATH}:nocopy`,
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
	);
	return args;
}

export function ociExecArguments(
	name: string,
	language: SandboxLanguage,
	guestUser: string,
	workMaxBytes: number,
	processMax?: number,
): string[] {
	return [
		"exec",
		"--interactive",
		"--user",
		guestUser,
		"--workdir",
		WORK_PATH,
		"--env",
		`HOME=${WORK_PATH}`,
		"--env",
		`TMPDIR=${TMP_PATH}`,
		name,
		"bash",
		"-c",
		launcher(language, { workMaxBytes, processMax }),
	];
}

export function ociInspectionOf(inspected: CommandOutcome, name: string): Inspection {
	if (inspected.code === 0) {
		const container = parseOciContainers(inspected.stdout)?.find((entry) => entry.name === name);
		if (container?.state === undefined) return { state: "unknown", detail: "unreadable answer" };
		return { state: container.state === "running" ? "present" : "stopped" };
	}
	if (/no such (?:container|object)|container .+ not found/i.test(inspected.stderr)) {
		return { state: "absent" };
	}
	return { state: "unknown", detail: commandFailure(inspected) };
}

function isPodmanVersionAtLeast(version: string, minMajor: number, minMinor: number): boolean {
	const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
	if (match === null) return true;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > minMajor || (major === minMajor && minor >= minMinor);
}

function hostLinuxArch(): "arm64" | "amd64" {
	return process.arch === "x64" ? "amd64" : "arm64";
}

function isRunsc(value: unknown): boolean {
	return typeof value === "string" && (value === "runsc" || value.endsWith("/runsc"));
}

export class OciHotSandbox implements HotSandbox {
	readonly name: string;
	private readonly runtime: SandboxDriverContext;
	private readonly guestUser: string;
	private readonly keepalive: RunProcess;
	private readonly keepaliveClosed: Promise<number | null>;
	private readonly gvisor: boolean;
	private keepaliveExited = false;
	private oomBaseline = 0;
	private tainted = false;
	private destroyed = false;
	private killing: Promise<CommandOutcome> | undefined;

	constructor(
		name: string,
		runtime: SandboxDriverContext,
		guestUser: string,
		keepalive: RunProcess,
		keepaliveClosed: Promise<number | null>,
		gvisor = false,
	) {
		this.name = name;
		this.runtime = runtime;
		this.guestUser = guestUser;
		this.keepalive = keepalive;
		this.gvisor = gvisor;
		this.keepaliveClosed = keepaliveClosed.then((code) => {
			this.keepaliveExited = true;
			return code;
		});
	}

	async inspect(deadlineAt: number): Promise<Inspection> {
		if (remainingMs(deadlineAt) === 0) return { state: "unknown", detail: "timed out" };
		const inspected = await containerCommand(this.runtime, ["inspect", this.name], remainingMs(deadlineAt));
		return ociInspectionOf(inspected, this.name);
	}

	async spawnCall(language: SandboxLanguage): Promise<SpawnCallOutcome> {
		if (this.destroyed || this.keepaliveExited || this.keepalive.exitCode !== null) {
			return { gone: "sandbox is not running" };
		}
		const events = await containerCommand(this.runtime, [
			"exec",
			"--user",
			this.guestUser,
			this.name,
			"cat",
			"/sys/fs/cgroup/memory.events",
		]);
		if (events.code === 0) {
			this.oomBaseline = parseOomKillCount(events.stdout) ?? 0;
		} else {
			const state = await this.inspect(deadlineAfter(this.runtime));
			if (state.state !== "present") {
				return { gone: commandFailure(events) };
			}
			this.oomBaseline = 0;
		}
		if (this.destroyed || this.keepaliveExited || this.keepalive.exitCode !== null) {
			return { gone: "sandbox is not running" };
		}
		const args = ociExecArguments(
			this.name,
			language,
			this.guestUser,
			this.runtime.limits.workMaxBytes,
			this.gvisor ? this.runtime.limits.processMax : undefined,
		);
		const child = spawn(this.runtime.containerCommand, args, {
			cwd: tmpdir(),
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
		const events = await containerCommand(
			this.runtime,
			["exec", "--user", this.guestUser, this.name, "cat", "/sys/fs/cgroup/memory.events"],
			remainingMs(deadlineAt),
		);
		if (events.code === 0) {
			const count = parseOomKillCount(events.stdout);
			if (count !== undefined) {
				if (count <= this.oomBaseline) return undefined;
				this.oomBaseline = count;
				return `oom_kill ${count} in /sys/fs/cgroup/memory.events`;
			}
		}
		if (remainingMs(deadlineAt) === 0) return undefined;
		const inspected = await containerCommand(this.runtime, ["inspect", this.name], remainingMs(deadlineAt));
		if (inspected.code === 0 && parseOciOomKilled(inspected.stdout, this.name)) {
			return "container State.OOMKilled is true";
		}
		return undefined;
	}

	async scrubAfterCall(deadlineAt: number): Promise<boolean> {
		if (this.destroyed || this.tainted || this.keepaliveExited || remainingMs(deadlineAt) === 0) return false;
		const scrubbed = await containerCommand(
			this.runtime,
			["exec", "--user", this.guestUser, this.name, "bash", "-c", SCRUB_SCRIPT],
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
		return cleanupOciContainer(this.runtime, this.name, deadlineAt);
	}
}

export class OciDriver implements SandboxDriver {
	readonly name = "oci" as const;
	private readonly runtime: SandboxDriverContext;
	private readonly engineChoice: OciEngineChoice;
	private readonly ociRuntime: string | undefined;
	private readonly hostUid: number;
	private readonly hostGid: number;
	private readonly customCommand: string | undefined;
	private engine: OciEngine;
	private rootless: boolean;
	private cpuDelegated = true;
	private detectedRuntime: string;
	private gvisor: boolean;

	constructor(runtime: SandboxDriverContext, options: OciDriverOptions = {}) {
		this.runtime = runtime;
		this.engineChoice = options.engine ?? "auto";
		this.ociRuntime = options.ociRuntime !== undefined && options.ociRuntime !== "" ? options.ociRuntime : undefined;
		this.hostUid = options.hostUid ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
		this.hostGid = options.hostGid ?? (typeof process.getgid === "function" ? process.getgid() : 1000);
		this.engine = this.engineChoice === "docker" ? "docker" : "podman";
		this.rootless = this.engine === "podman";
		this.detectedRuntime = this.ociRuntime ?? (this.engine === "podman" ? "crun" : "runc");
		this.gvisor = isRunsc(this.ociRuntime);
		this.customCommand =
			runtime.containerCommand !== "podman" &&
			runtime.containerCommand !== "docker" &&
			runtime.containerCommand !== "container"
				? runtime.containerCommand
				: undefined;
	}

	get boundaryDescription(): string {
		const rt = this.ociRuntime ?? this.detectedRuntime;
		const isolated = this.gvisor || isRunsc(rt) || rt === "krun" || rt === "kata";
		return isolated ? `oci (${this.engine}/${rt})` : `oci (${this.engine}/${rt}, shared kernel)`;
	}

	get guestUser(): string {
		return this.rootless ? GUEST_USER : `${this.hostUid}:${this.hostGid}`;
	}

	get runOptions(): OciRunOptions {
		const rt = this.ociRuntime ?? this.detectedRuntime;
		return {
			rootless: this.rootless,
			guestUser: this.guestUser,
			cpuDelegated: this.cpuDelegated,
			ociRuntime: this.ociRuntime,
			gvisor: this.gvisor || isRunsc(rt),
		};
	}

	async checkRuntime(deadlineAt: number): Promise<{ ready: true } | { ready: false; reason: string }> {
		if (this.engineChoice !== "auto" && this.engineChoice !== "podman" && this.engineChoice !== "docker") {
			return {
				ready: false,
				reason: `invalid --sandbox-oci-engine "${String(this.engineChoice)}"; expected auto, podman, or docker`,
			};
		}
		const candidates: OciEngine[] = this.engineChoice === "auto" ? ["podman", "docker"] : [this.engineChoice];
		let lastReason = "";
		for (const candidate of candidates) {
			const command = this.customCommand ?? candidate;
			const info = await containerCommand(
				this.runtime,
				["info", "--format", "{{json .}}"],
				remainingMs(deadlineAt),
				undefined,
				command,
			);
			if (info.code !== 0) {
				if (lastReason === "" || !info.stderr.includes("ENOENT")) {
					lastReason = `${candidate} info failed: ${commandFailure(info)}`;
				}
				continue;
			}
			const checked = this.inspectEngineInfo(candidate, info.stdout);
			if (!checked.ready) return checked;
			this.engine = candidate;
			this.runtime.containerCommand = command;
			return { ready: true };
		}
		return { ready: false, reason: lastReason };
	}

	async inspectImage(image: string, deadlineAt: number): Promise<{ found: true } | { found: false; reason: string }> {
		const inspected = await containerCommand(this.runtime, ["image", "inspect", image], remainingMs(deadlineAt));
		if (inspected.code === 0) return { found: true };
		return { found: false, reason: `${this.engine} image inspect ${image} failed: ${commandFailure(inspected)}` };
	}

	pullImage(image: string, signal?: AbortSignal, onLine?: (line: string) => void): Promise<CommandOutcome> {
		return containerCommand(this.runtime, ["image", "pull", image], {
			timeoutMs: BUILD_TIMEOUT_MS,
			signal,
			onLine,
		});
	}

	buildImage(
		image: string,
		contextDir: string,
		signal?: AbortSignal,
		onLine?: (line: string) => void,
	): Promise<CommandOutcome> {
		const arch = hostLinuxArch();
		return containerCommand(
			this.runtime,
			[
				"build",
				"--build-arg",
				`TARGETARCH=${arch}`,
				"--tag",
				image,
				"--file",
				join(contextDir, "Containerfile"),
				contextDir,
			],
			{ timeoutMs: BUILD_TIMEOUT_MS, signal, onLine },
		);
	}

	async listSandboxes(root: string, deadlineAt: number): Promise<OwnedResource[]> {
		const listed = await containerCommand(
			this.runtime,
			["ps", "-a", "--filter", `label=${ROOT_LABEL}=${root}`, "--format", "{{.Names}}"],
			remainingMs(deadlineAt),
		);
		if (listed.code !== 0) throw new Error(commandFailure(listed));
		const names = parseOciNames(listed.stdout);
		if (names === undefined) throw new Error("unreadable listing");
		if (names.length === 0) return [];
		const inspected = await containerCommand(this.runtime, ["inspect", ...names], remainingMs(deadlineAt));
		const containers = inspected.code === 0 ? parseOciContainers(inspected.stdout) : undefined;
		if (containers === undefined) {
			throw new Error(inspected.code === 0 ? "unreadable listing" : commandFailure(inspected));
		}
		return ownedInRoot(containers, root);
	}

	deleteSandbox(name: string, deadlineAt: number): Promise<CleanupOutcome> {
		return cleanupOciContainer(this.runtime, name, deadlineAt);
	}

	manualDeleteCommand(names: string[]): string {
		return `${this.engine} rm --force ${names.join(" ")}`;
	}

	async listWorkVolumes(session: SessionPaths, deadlineAt: number): Promise<OwnedResource[]> {
		if (remainingMs(deadlineAt) === 0) return [];
		const root = artifactsRootOf(session);
		const listed = await containerCommand(
			this.runtime,
			["volume", "ls", "--filter", `label=${ROOT_LABEL}=${root}`, "--format", "{{.Name}}"],
			remainingMs(deadlineAt),
		);
		if (listed.code !== 0) return [];
		const names = parseOciNames(listed.stdout) ?? [];
		if (names.length === 0) return [];
		if (remainingMs(deadlineAt) === 0) return [];
		const inspected = await containerCommand(this.runtime, ["volume", "inspect", ...names], remainingMs(deadlineAt));
		const volumes = inspected.code === 0 ? parseOciVolumes(inspected.stdout) : undefined;
		return ownedInRoot(volumes ?? [], root);
	}

	async ensureWorkVolume(session: SessionPaths, deadlineAt: number): Promise<VolumeFailure | undefined> {
		const root = artifactsRootOf(session);
		const name = workVolumeName(session.sessionId);
		const inspected = await containerCommand(this.runtime, ["volume", "inspect", name], remainingMs(deadlineAt));
		let created = false;
		if (inspected.code === 0) {
			const [volume] = parseOciVolumes(inspected.stdout) ?? [];
			if (volume === undefined) return { reason: "the /work volume could not be inspected: unreadable answer" };
			const label = labelOf(volume.labels, ROOT_LABEL);
			if (label !== root) {
				return {
					reason: `the volume ${name} is not this session's: its ${ROOT_LABEL} label is ${label ?? "missing"}, expected ${root}`,
				};
			}
		} else if (/no such volume|volume .+ not found/i.test(inspected.stderr)) {
			if (this.runtime.state !== "unready") return { reason: START_ENDED };
			const creation = await containerCommand(this.runtime, ["volume", "create", ...sessionLabels(session), name]);
			if (creation.code !== 0) {
				return { reason: `the /work volume could not be created: ${commandFailure(creation)}` };
			}
			created = true;
		} else {
			return { reason: `the /work volume could not be inspected: ${commandFailure(inspected)}` };
		}
		const failure = await this.prepareWorkVolume(session, name);
		if (failure !== undefined && created) {
			await containerCommand(this.runtime, ["volume", "rm", name]);
		}
		return failure;
	}

	async deleteWorkVolumes(volumes: OwnedResource[], _session: SessionPaths, deadlineAt: number): Promise<void> {
		for (const volume of volumes) {
			if (remainingMs(deadlineAt) === 0) return;
			await containerCommand(this.runtime, ["volume", "rm", volume.name], remainingMs(deadlineAt));
		}
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
		const args = ociSandboxArguments(this.runtime, name, this.runOptions, session);
		const child = spawn(this.runtime.containerCommand, args, {
			cwd: tmpdir(),
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
			return {
				started: new OciHotSandbox(
					name,
					this.runtime,
					this.guestUser,
					child,
					keepaliveClosed,
					this.runOptions.gvisor,
				),
			};
		}
		child.stdin.end();
		child.kill("SIGKILL");
		await keepaliveClosed;
		const cleanup = await cleanupOciContainer(this.runtime, name, deadlineAfter(this.runtime));
		return {
			failed: startup.reason,
			leftover: cleanup.removed ? undefined : cleanup.error,
		};
	}

	private inspectEngineInfo(engine: OciEngine, stdout: string): { ready: true } | { ready: false; reason: string } {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return { ready: false, reason: `${engine} info returned unreadable JSON` };
		}
		if (!isObject(parsed)) {
			return { ready: false, reason: `${engine} info returned unreadable JSON` };
		}
		if (engine === "docker") {
			if (Array.isArray(parsed.ServerErrors) && parsed.ServerErrors.length > 0) {
				return { ready: false, reason: `docker info failed: ${String(parsed.ServerErrors[0])}` };
			}
			const securityOptions = Array.isArray(parsed.SecurityOptions) ? parsed.SecurityOptions : [];
			const isRootless = securityOptions.some(
				(opt) => typeof opt === "string" && (opt === "rootless" || opt.includes("name=rootless")),
			);
			if (isRootless) {
				return { ready: false, reason: ROOTLESS_DOCKER_UNSUPPORTED };
			}
			if (this.ociRuntime !== undefined && isObject(parsed.Runtimes) && !(this.ociRuntime in parsed.Runtimes)) {
				return { ready: false, reason: `OCI runtime ${this.ociRuntime} is not available in docker` };
			}
			const defaultRuntime =
				typeof parsed.DefaultRuntime === "string" && parsed.DefaultRuntime !== "" ? parsed.DefaultRuntime : "runc";
			const activeRuntime = this.ociRuntime ?? defaultRuntime;
			const runtimeEntry =
				isObject(parsed.Runtimes) && isObject(parsed.Runtimes[activeRuntime])
					? parsed.Runtimes[activeRuntime]
					: undefined;
			this.rootless = false;
			this.cpuDelegated = true;
			this.detectedRuntime = defaultRuntime;
			this.gvisor = isRunsc(activeRuntime) || isRunsc(runtimeEntry?.path);
			return { ready: true };
		}

		const host = isObject(parsed.host) ? parsed.host : {};
		const security = isObject(host.security) ? host.security : {};
		const isRootless = security.rootless !== false;
		const versionObj = isObject(parsed.version) ? parsed.version : {};
		const versionStr = typeof versionObj.Version === "string" ? versionObj.Version : undefined;
		if (isRootless && versionStr !== undefined && !isPodmanVersionAtLeast(versionStr, 4, 3)) {
			return {
				ready: false,
				reason: `rootless Podman >= 4.3 is required for keep-id UID mapping (found ${versionStr})`,
			};
		}
		const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers : undefined;
		this.rootless = isRootless;
		this.cpuDelegated = controllers === undefined || controllers.includes("cpu");
		const ociRuntimeObj = isObject(host.ociRuntime) ? host.ociRuntime : {};
		const defaultRuntime =
			typeof ociRuntimeObj.name === "string" && ociRuntimeObj.name !== "" ? ociRuntimeObj.name : "crun";
		const activeRuntime = this.ociRuntime ?? defaultRuntime;
		this.detectedRuntime = defaultRuntime;
		this.gvisor = isRunsc(activeRuntime) || (this.ociRuntime === undefined && isRunsc(ociRuntimeObj.path));
		return { ready: true };
	}

	private async prepareWorkVolume(session: SessionPaths, volume: string): Promise<VolumeFailure | undefined> {
		const name = `polar-prep-${session.sessionId}-${randomBytes(4).toString("hex")}`;
		if (this.runtime.state !== "unready") return { reason: START_ENDED };
		this.runtime.owned.add(name);
		const args: string[] = ["run", "--network", "none"];
		if (this.ociRuntime !== undefined) {
			args.push("--runtime", this.ociRuntime);
		}
		if (this.rootless) {
			args.push("--userns=keep-id:uid=1000,gid=1000");
		}
		args.push(
			"--user",
			"0:0",
			"--security-opt",
			"label=disable",
			"--volume",
			`${volume}:${WORK_PATH}:nocopy`,
			"--name",
			name,
			...sessionLabels(session),
			this.runtime.image,
			"chown",
			this.guestUser,
			WORK_PATH,
		);
		const ran = await containerCommand(this.runtime, args);
		const cleanup = await cleanupOciContainer(this.runtime, name, deadlineAfter(this.runtime));
		const leftover = cleanup.removed ? undefined : cleanup.error;
		if (ran.code !== 0) return { reason: `the /work volume could not be prepared: ${commandFailure(ran)}`, leftover };
		if (leftover !== undefined) return { reason: LEFTOVERS_STAYED, leftover };
		return undefined;
	}
}
