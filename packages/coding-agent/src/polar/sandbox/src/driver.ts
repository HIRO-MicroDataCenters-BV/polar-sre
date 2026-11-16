import { type ChildProcessByStdio, spawn } from "child_process";
import { randomBytes } from "crypto";
import { once } from "events";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Readable, Writable } from "stream";
import {
	CLI_STOPPED,
	cleanupContainer,
	cleanupOciContainer,
	commandFailure,
	containerCommand,
	deadlineAfter,
	firstLine,
	type ListedResource,
	parseContainers,
	parseOciContainers,
	parseOciNames,
	parseOciOomKilled,
	parseOciVolumes,
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
	type OciEngine,
	type OciEngineChoice,
	type OwnedResource,
	type SandboxDriver,
	type SandboxDriverContext,
	type SandboxDriverName,
	type SandboxLanguage,
	type SandboxStartOutcome,
	type SessionPaths,
	type SpawnCallOutcome,
	type VolumeFailure,
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
	"ipcrm --all 2>/dev/null",
	"chmod -R u+rwX /tmp /dev/shm /dev/mqueue 2>/dev/null",
	"find /tmp /dev/shm /dev/mqueue -mindepth 1 -delete 2>/dev/null",
	"for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -1 2>/dev/null || break; sleep 0.02; done",
	'! kill -0 -1 2>/dev/null && [ -z "$(find /tmp /dev/shm /dev/mqueue -mindepth 1 -print -quit 2>/dev/null)" ] && [ -z "$(ipcs -m -q -s 2>/dev/null | grep "^0x")" ]',
].join("\n");

export const START_ENDED = "the session is shutting down";
export const LEFTOVERS_STAYED = "leftovers of sandbox stayed";
export const WORK_LIMIT_EXIT_CODE = 199;
export const ROOTLESS_DOCKER_UNSUPPORTED =
	"rootless Docker does not support unprivileged read-only bind-mount UID mapping; use rootless Podman >= 4.3 or standard Docker";
const BUILD_TIMEOUT_MS = 600_000;
const KEEPALIVE_STOP_GRACE_MS = 200;
const COMMAND_STDERR_MAX_BYTES = 16 * 1024 * 1024;
const OOM_LINE_GLOBAL = /(?:Memory cgroup out of memory|Out of memory): Killed process[^\n]*/g;

const PROGRAM_FILES: Record<SandboxLanguage, string> = { python: "program.py", bash: "program.sh" };
const INTERPRETERS: Record<SandboxLanguage, string> = { python: "python3", bash: "bash" };

export interface LauncherOptions {
	workMaxBytes?: number;
}

export function launcher(language: SandboxLanguage, options: LauncherOptions = {}): string {
	const file = `"$d/${PROGRAM_FILES[language]}"`;
	const interpreter = INTERPRETERS[language];
	if (options.workMaxBytes === undefined) {
		return `d="\${TMPDIR:-/tmp}/.polar"; mkdir -p "$d" && cat > ${file} && exec ${interpreter} ${file} </dev/null`;
	}
	const max = options.workMaxBytes;
	return [
		`d="\${TMPDIR:-/tmp}/.polar"`,
		`w="\${POLAR_WORK_DIR:-${WORK_PATH}}"`,
		`mkdir -p "$d" && rm -f "$d/work_limit" "$d/.w" && cat > ${file} || exit 1`,
		`kb() { local v; v=$(du -sk "$w" 2>/dev/null | cut -f1); echo "\${v:-0}"; }`,
		`init=$(( $(kb) * 1024 ))`,
		`max=${max}`,
		`mkfifo "$d/.w" 2>/dev/null`,
		`set -m`,
		`${interpreter} ${file} </dev/null &`,
		`pid=$!`,
		`set +m`,
		`(`,
		`  exec 9<>"$d/.w"`,
		`  rm -f "$d/.w"`,
		`  while kill -0 "$pid" 2>/dev/null; do`,
		`    read -r -t 0.1 -u 9 || true`,
		`    kill -0 "$pid" 2>/dev/null || exit 0`,
		`    cur=$(( $(kb) * 1024 ))`,
		`    if [ "$cur" -gt "$max" ] && [ "$cur" -gt "$init" ]; then`,
		`      : > "$d/work_limit"`,
		`      kill -9 -"$pid" "$pid" 2>/dev/null`,
		`      exit 0`,
		`    fi`,
		`  done`,
		`) </dev/null >/dev/null 2>&1 &`,
		`wpid=$!`,
		`wait "$pid" 2>/dev/null`,
		`rc=$?`,
		`exec 2>/dev/null`,
		`kill -9 "$wpid"`,
		`wait "$wpid"`,
		`rm -f "$d/.w"`,
		`cur=$(( $(kb) * 1024 ))`,
		`if [ -f "$d/work_limit" ] || { [ "$cur" -gt "$max" ] && [ "$cur" -gt "$init" ]; }; then`,
		`  exit ${WORK_LIMIT_EXIT_CODE}`,
		`fi`,
		`exit "$rc"`,
	].join("\n");
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
	runtime: SandboxDriverContext,
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
		const container = parseContainers(inspected.stdout)?.find((entry) => entry.name === name);
		if (container?.state === undefined) return { state: "unknown", detail: "unreadable answer" };
		return { state: container.state === "running" ? "present" : "stopped" };
	}
	if (firstLine(inspected.stderr) === `Error: container not found: ${name}`) return { state: "absent" };
	return { state: "unknown", detail: commandFailure(inspected) };
}

function oomMatches(bootLog: string): string[] {
	return [...bootLog.matchAll(OOM_LINE_GLOBAL)].map((match) => match[0].trim());
}

export class AppleHotSandbox implements HotSandbox {
	readonly name: string;
	private readonly runtime: SandboxDriverContext;
	private readonly keepalive: RunProcess;
	private readonly keepaliveClosed: Promise<number | null>;
	private keepaliveExited = false;
	private oomBaseline = 0;
	private tainted = false;
	private destroyed = false;
	private killing: Promise<CommandOutcome> | undefined;

	constructor(
		name: string,
		runtime: SandboxDriverContext,
		keepalive: RunProcess,
		keepaliveClosed: Promise<number | null>,
	) {
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
	private readonly runtime: SandboxDriverContext;

	constructor(runtime: SandboxDriverContext) {
		this.runtime = runtime;
	}

	async checkRuntime(deadlineAt: number): Promise<{ ready: true } | { ready: false; reason: string }> {
		const status = await containerCommand(this.runtime, ["system", "status"], remainingMs(deadlineAt));
		if (status.code !== 0)
			return { ready: false, reason: `container system status failed: ${commandFailure(status)}` };
		return { ready: true };
	}

	async inspectImage(image: string, deadlineAt: number): Promise<{ found: true } | { found: false; reason: string }> {
		const inspected = await containerCommand(this.runtime, ["image", "inspect", image], remainingMs(deadlineAt));
		if (inspected.code === 0) return { found: true };
		return { found: false, reason: `container image inspect ${image} failed: ${commandFailure(inspected)}` };
	}

	pullImage(image: string, signal?: AbortSignal): Promise<CommandOutcome> {
		return containerCommand(this.runtime, ["image", "pull", image], BUILD_TIMEOUT_MS, signal);
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

	manualDeleteCommand(names: string[]): string {
		return `container delete --force ${names.join(" ")}`;
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

export interface OciRunOptions {
	rootless: boolean;
	guestUser: string;
	cpuDelegated: boolean;
	ociRuntime?: string;
}

export function ociSandboxArguments(
	runtime: SandboxDriverContext,
	name: string,
	options: OciRunOptions,
	session: SessionPaths = runtime.handle.paths,
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
	args.push(
		"--pids-limit",
		String(limits.processMax),
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
		launcher(language, { workMaxBytes }),
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

export function parseOomKillCount(text: string): number | undefined {
	const match = /^oom_kill\s+(\d+)$/m.exec(text);
	return match === null ? undefined : Number(match[1]);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export class OciHotSandbox implements HotSandbox {
	readonly name: string;
	private readonly runtime: SandboxDriverContext;
	private readonly guestUser: string;
	private readonly keepalive: RunProcess;
	private readonly keepaliveClosed: Promise<number | null>;
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
	) {
		this.name = name;
		this.runtime = runtime;
		this.guestUser = guestUser;
		this.keepalive = keepalive;
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
		const args = ociExecArguments(this.name, language, this.guestUser, this.runtime.limits.workMaxBytes);
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

export interface OciDriverOptions {
	engine?: OciEngineChoice;
	ociRuntime?: string;
	hostUid?: number;
	hostGid?: number;
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

	constructor(runtime: SandboxDriverContext, options: OciDriverOptions = {}) {
		this.runtime = runtime;
		this.engineChoice = options.engine ?? "auto";
		this.ociRuntime = options.ociRuntime !== undefined && options.ociRuntime !== "" ? options.ociRuntime : undefined;
		this.hostUid = options.hostUid ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
		this.hostGid = options.hostGid ?? (typeof process.getgid === "function" ? process.getgid() : 1000);
		this.engine = this.engineChoice === "docker" ? "docker" : "podman";
		this.rootless = this.engine === "podman";
		this.detectedRuntime = this.ociRuntime ?? (this.engine === "podman" ? "crun" : "runc");
		this.customCommand =
			runtime.containerCommand !== "podman" &&
			runtime.containerCommand !== "docker" &&
			runtime.containerCommand !== "container"
				? runtime.containerCommand
				: undefined;
	}

	get boundaryDescription(): string {
		const rt = this.ociRuntime ?? this.detectedRuntime;
		const isolated = rt === "krun" || rt === "runsc" || rt === "kata";
		return isolated ? `oci (${this.engine}/${rt})` : `oci (${this.engine}/${rt}, shared kernel)`;
	}

	get guestUser(): string {
		return this.rootless ? GUEST_USER : `${this.hostUid}:${this.hostGid}`;
	}

	get runOptions(): OciRunOptions {
		return {
			rootless: this.rootless,
			guestUser: this.guestUser,
			cpuDelegated: this.cpuDelegated,
			ociRuntime: this.ociRuntime,
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

	pullImage(image: string, signal?: AbortSignal): Promise<CommandOutcome> {
		return containerCommand(this.runtime, ["image", "pull", image], BUILD_TIMEOUT_MS, signal);
	}

	buildImage(image: string, contextDir: string, signal?: AbortSignal): Promise<CommandOutcome> {
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
			BUILD_TIMEOUT_MS,
			signal,
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

	async listWorkVolumes(root: string, deadlineAt: number): Promise<OwnedResource[]> {
		if (remainingMs(deadlineAt) === 0) return [];
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

	async deleteWorkVolume(name: string, _ownerSessionId: string, deadlineAt: number): Promise<void> {
		if (remainingMs(deadlineAt) === 0) return;
		await containerCommand(this.runtime, ["volume", "rm", name], remainingMs(deadlineAt));
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
			return { started: new OciHotSandbox(name, this.runtime, this.guestUser, child, keepaliveClosed) };
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
			this.rootless = false;
			this.cpuDelegated = true;
			this.detectedRuntime =
				typeof parsed.DefaultRuntime === "string" && parsed.DefaultRuntime !== "" ? parsed.DefaultRuntime : "runc";
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
		this.detectedRuntime =
			typeof ociRuntimeObj.name === "string" && ociRuntimeObj.name !== "" ? ociRuntimeObj.name : "crun";
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

export class UnsupportedSandboxDriver implements SandboxDriver {
	readonly name: SandboxDriverName;
	readonly boundaryDescription: string;
	private readonly reason: string;

	constructor(name: SandboxDriverName, reason: string) {
		this.name = name;
		this.boundaryDescription = name;
		this.reason = reason;
	}

	async checkRuntime(): Promise<{ ready: false; reason: string }> {
		return { ready: false, reason: this.reason };
	}

	async inspectImage(): Promise<{ found: false; reason: string }> {
		return { found: false, reason: this.reason };
	}

	async pullImage(): Promise<CommandOutcome> {
		return { code: 1, stdout: "", stderr: this.reason, timedOut: false };
	}

	async buildImage(): Promise<CommandOutcome> {
		return { code: 1, stdout: "", stderr: this.reason, timedOut: false };
	}

	async listSandboxes(): Promise<OwnedResource[]> {
		return [];
	}

	async deleteSandbox(name: string): Promise<CleanupOutcome> {
		return { removed: false, error: { container: name, message: this.reason } };
	}

	manualDeleteCommand(names: string[]): string {
		return names.join(" ");
	}

	async listWorkVolumes(): Promise<OwnedResource[]> {
		return [];
	}

	async ensureWorkVolume(): Promise<VolumeFailure | undefined> {
		return { reason: this.reason };
	}

	async deleteWorkVolume(): Promise<void> {}

	async startSandbox(): Promise<SandboxStartOutcome> {
		return { failed: this.reason };
	}
}
