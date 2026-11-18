import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { once } from "events";
import { readFile, rename, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { setTimeout as sleep } from "timers/promises";
import { CLI_STOPPED, commandFailure, containerCommand, deadlineAfter, remainingMs } from "../cli.ts";
import {
	type CleanupOutcome,
	type CommandOutcome,
	DATA_PATH,
	type HotSandbox,
	type Inspection,
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
	isObject,
	KEEPALIVE_COMMAND,
	labelOf,
	launcher,
	limitMebibytes,
	parseOomKillCount,
	ROOT_LABEL,
	SCRUB_SCRIPT,
	SESSION_LABEL,
	START_ENDED,
	TMP_PATH,
	WORK_PATH,
	workVolumeName,
} from "./shared.ts";

export const SANDBOX_LABEL = "polar-sandbox";
export const ROOT_HASH_LABEL = "polar-root-hash";
export const DEFAULT_SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const VALID_K8S_SESSION_ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;
export const NETPROBE_PYTHON = [
	"import os, socket, sys",
	"try:",
	'    p = "/work/.polar-probe"',
	'    with open(p, "wb") as f:',
	'        f.write(b"ok")',
	"    os.unlink(p)",
	"except OSError:",
	"    sys.exit(2)",
	"try:",
	"    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1.5)",
	"    s.close()",
	"except socket.gaierror:",
	"    sys.exit(3)",
	"except OSError:",
	"    sys.exit(0)",
	"sys.exit(1)",
].join("\n");

const STDERR_TRAILER_HOLD_BYTES = 64;
const K8S_POLL_MS = 25;
const FATAL_WAITING_REASONS = new Set([
	"ErrImagePull",
	"ImagePullBackOff",
	"CreateContainerConfigError",
	"CreateContainerError",
	"InvalidImageName",
	"RunContainerError",
	"CrashLoopBackOff",
]);

const K8S_POD_SECURITY_CONTEXT = {
	runAsUser: 1000,
	runAsGroup: 1000,
	runAsNonRoot: true,
	fsGroup: 1000,
	fsGroupChangePolicy: "OnRootMismatch",
	seccompProfile: {
		type: "RuntimeDefault",
	},
};

const K8S_CONTAINER_SECURITY_CONTEXT = {
	runAsNonRoot: true,
	runAsUser: 1000,
	runAsGroup: 1000,
	allowPrivilegeEscalation: false,
	readOnlyRootFilesystem: true,
	capabilities: {
		drop: ["ALL"],
	},
	seccompProfile: {
		type: "RuntimeDefault",
	},
};

export interface K8sPodSummary {
	name: string;
	uid?: string;
	labels: Record<string, unknown>;
	annotations: Record<string, unknown>;
	phase?: string;
	running: boolean;
	terminatedReason?: string;
	terminatedExitCode?: number;
	waitingReason?: string;
	waitingMessage?: string;
}

export interface K8sPodManifestOptions {
	name: string;
	namespace: string;
	session: SessionPaths;
	image: string;
	runtimeClass: string;
	nodeName: string;
	ownerPodName: string;
	ownerPodUid: string;
	pvcName: string;
	memoryBytes: number;
	cpus: number;
	tmpMaxBytes: number;
}

export interface K8sDriverOptions {
	serviceAccountDir?: string;
}

export function kubectlEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (!("KUBECONFIG" in environment)) return environment;
	const { KUBECONFIG: _ignored, ...env } = environment;
	return env;
}

function summarizeK8sPodObject(entry: unknown): K8sPodSummary | undefined {
	if (!isObject(entry)) return undefined;
	const metadata = entry.metadata;
	if (!isObject(metadata) || typeof metadata.name !== "string" || metadata.name === "") return undefined;
	const uid = typeof metadata.uid === "string" && metadata.uid !== "" ? metadata.uid : undefined;
	const labels = metadata.labels === undefined || metadata.labels === null ? {} : metadata.labels;
	const annotations = metadata.annotations === undefined || metadata.annotations === null ? {} : metadata.annotations;
	if (!isObject(labels) || !isObject(annotations)) return undefined;
	const status = isObject(entry.status) ? entry.status : {};
	const phase = typeof status.phase === "string" && status.phase !== "" ? status.phase : undefined;
	const containerStatuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
	const firstContainer = isObject(containerStatuses[0]) ? containerStatuses[0] : {};
	const state = isObject(firstContainer.state) ? firstContainer.state : {};
	const terminated = isObject(state.terminated) ? state.terminated : undefined;
	const waiting = isObject(state.waiting) ? state.waiting : undefined;
	const running = isObject(state.running) && terminated === undefined;
	const terminatedReason =
		terminated !== undefined ? (typeof terminated.reason === "string" ? terminated.reason : "") : undefined;
	const terminatedExitCode =
		terminated !== undefined && typeof terminated.exitCode === "number" ? terminated.exitCode : undefined;
	const waitingReason =
		waiting !== undefined && typeof waiting.reason === "string" && waiting.reason !== "" ? waiting.reason : undefined;
	const waitingMessage =
		waiting !== undefined && typeof waiting.message === "string" && waiting.message !== ""
			? waiting.message
			: undefined;
	return {
		name: metadata.name,
		uid,
		labels,
		annotations,
		phase,
		running,
		terminatedReason,
		terminatedExitCode,
		waitingReason,
		waitingMessage,
	};
}

export function parseK8sPod(text: string): K8sPodSummary | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return summarizeK8sPodObject(parsed);
}

export function parseK8sPods(text: string): K8sPodSummary[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || !Array.isArray(parsed.items)) return undefined;
	const pods: K8sPodSummary[] = [];
	for (const item of parsed.items) {
		const summary = summarizeK8sPodObject(item);
		if (summary === undefined) return undefined;
		pods.push(summary);
	}
	return pods;
}

export function isK8sNotFound(stderr: string): boolean {
	return /Error from server \(NotFound\)|pods? ".+" not found/i.test(stderr);
}

export async function cleanupK8sPod(
	runtime: SandboxDriverContext,
	kubectlPrefix: string[],
	name: string,
	deadlineAt: number,
): Promise<CleanupOutcome> {
	runtime.owned.add(name);
	const confirmed = () => {
		runtime.owned.delete(name);
		return { removed: true } as const;
	};
	if (remainingMs(deadlineAt) === 0) return { removed: false, error: { container: name, message: "no time left" } };
	const env = kubectlEnv(runtime.environment);
	const deleted = await containerCommand(
		runtime,
		[...kubectlPrefix, "delete", "pod", name, "--wait=true"],
		remainingMs(deadlineAt),
		undefined,
		undefined,
		env,
	);
	if (deleted.code === 0 || (!deleted.timedOut && isK8sNotFound(deleted.stderr))) return confirmed();
	let message = `delete: ${commandFailure(deleted)}`;
	if (remainingMs(deadlineAt) > 0) {
		const got = await containerCommand(
			runtime,
			[...kubectlPrefix, "get", "pod", name, "-o", "json"],
			remainingMs(deadlineAt),
			undefined,
			undefined,
			env,
		);
		if (!got.timedOut && isK8sNotFound(got.stderr)) return confirmed();
		const pod = got.code === 0 ? parseK8sPod(got.stdout) : undefined;
		message +=
			pod === undefined ? `; list: ${got.code === 0 ? "unreadable" : commandFailure(got)}` : "; still listed";
	} else {
		message += "; no time left to list";
	}
	return { removed: false, error: { container: name, message } };
}

export function rootHash(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function k8sPodName(name: string): string {
	return name.toLowerCase().replaceAll(/[_.]/g, "-");
}

// Strip the "command terminated with exit code N\n" trailer appended by kubectl exec -i to stderr on non-zero exit.
export function stripKubectlExecTrailer(stderr: Buffer, exitCode: number | null): Buffer {
	if (exitCode === null || exitCode === 0) return stderr;
	const trailer = Buffer.from(`command terminated with exit code ${exitCode}\n`, "utf8");
	if (stderr.length >= trailer.length && stderr.subarray(stderr.length - trailer.length).equals(trailer)) {
		return stderr.subarray(0, stderr.length - trailer.length);
	}
	return stderr;
}

export function k8sExecArguments(
	kubeconfig: string,
	namespace: string,
	name: string,
	language: SandboxLanguage,
	workMaxBytes: number,
	processMax: number,
): string[] {
	return [
		"--kubeconfig",
		kubeconfig,
		"-n",
		namespace,
		"exec",
		"-i",
		name,
		"--",
		"bash",
		"-c",
		launcher(language, { workMaxBytes, processMax }),
	];
}

export function k8sInspectionOf(inspected: CommandOutcome, name: string): Inspection {
	if (inspected.code === 0) {
		const pod = parseK8sPod(inspected.stdout);
		if (
			pod === undefined ||
			pod.name !== name ||
			(pod.phase === undefined && !pod.running && pod.terminatedReason === undefined)
		) {
			return { state: "unknown", detail: "unreadable answer" };
		}
		return { state: pod.running ? "present" : "stopped" };
	}
	if (isK8sNotFound(inspected.stderr)) return { state: "absent" };
	return { state: "unknown", detail: commandFailure(inspected) };
}

export function k8sSandboxPodManifest(options: K8sPodManifestOptions): Record<string, unknown> {
	const root = artifactsRootOf(options.session);
	const sessionId = options.session.sessionId;
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: options.name,
			namespace: options.namespace,
			labels: {
				[SANDBOX_LABEL]: "true",
				[SESSION_LABEL]: sessionId,
				[ROOT_HASH_LABEL]: rootHash(root),
			},
			annotations: {
				[ROOT_LABEL]: root,
			},
			ownerReferences: [
				{
					apiVersion: "v1",
					kind: "Pod",
					name: options.ownerPodName,
					uid: options.ownerPodUid,
				},
			],
		},
		spec: {
			runtimeClassName: options.runtimeClass,
			nodeSelector: {
				"kubernetes.io/hostname": options.nodeName,
			},
			restartPolicy: "Never",
			terminationGracePeriodSeconds: 1,
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			securityContext: K8S_POD_SECURITY_CONTEXT,
			containers: [
				{
					name: "sandbox",
					image: options.image,
					command: ["bash", "-c", KEEPALIVE_COMMAND],
					stdin: true,
					workingDir: WORK_PATH,
					env: [
						{ name: "HOME", value: WORK_PATH },
						{ name: "TMPDIR", value: TMP_PATH },
					],
					securityContext: K8S_CONTAINER_SECURITY_CONTEXT,
					resources: {
						requests: {
							cpu: "100m",
							memory: "256Mi",
						},
						limits: {
							cpu: String(options.cpus),
							memory: `${limitMebibytes(options.memoryBytes)}Mi`,
						},
					},
					volumeMounts: [
						{
							name: "shared",
							mountPath: DATA_PATH,
							subPath: `artifacts/${sessionId}`,
							readOnly: true,
						},
						{
							name: "shared",
							mountPath: WORK_PATH,
							subPath: `work/${sessionId}`,
						},
						{
							name: "tmp",
							mountPath: TMP_PATH,
						},
					],
				},
			],
			volumes: [
				{
					name: "shared",
					persistentVolumeClaim: {
						claimName: options.pvcName,
					},
				},
				{
					name: "tmp",
					emptyDir: {
						medium: "Memory",
						sizeLimit: `${limitMebibytes(options.tmpMaxBytes)}Mi`,
					},
				},
			],
		},
	};
}

export class K8sHotSandbox implements HotSandbox {
	readonly name: string;
	private readonly runtime: SandboxDriverContext;
	private readonly driver: K8sDriver;
	private oomBaseline = 0;
	private tainted = false;
	private destroyed = false;
	private killing: Promise<CleanupOutcome> | undefined;

	constructor(name: string, runtime: SandboxDriverContext, driver: K8sDriver) {
		this.name = name;
		this.runtime = runtime;
		this.driver = driver;
	}

	async inspect(deadlineAt: number): Promise<Inspection> {
		if (remainingMs(deadlineAt) === 0) return { state: "unknown", detail: "timed out" };
		const inspected = await this.driver.kubectl(["get", "pod", this.name, "-o", "json"], remainingMs(deadlineAt));
		return k8sInspectionOf(inspected, this.name);
	}

	async spawnCall(language: SandboxLanguage): Promise<SpawnCallOutcome> {
		if (this.destroyed || this.tainted) {
			return { gone: "sandbox is not running" };
		}
		const events = await this.driver.kubectl([
			"exec",
			this.name,
			"--",
			"bash",
			"-c",
			"cat /sys/fs/cgroup/memory.events 2>/dev/null || true",
		]);
		if (events.code !== 0) {
			return { gone: commandFailure(events) };
		}
		this.oomBaseline = parseOomKillCount(events.stdout) ?? 0;
		if (this.destroyed || this.tainted) {
			return { gone: "sandbox is not running" };
		}
		const args = k8sExecArguments(
			this.driver.kubeconfigPath,
			this.driver.namespace,
			this.name,
			language,
			this.runtime.limits.workMaxBytes,
			this.runtime.limits.processMax,
		);
		const child = spawn(this.runtime.containerCommand, args, {
			cwd: tmpdir(),
			env: kubectlEnv(this.runtime.environment),
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (child.pid === undefined) {
			const [error] = await once(child, "error");
			return { gone: (error as Error).message };
		}
		this.runtime.children.set(child, "run");
		const stderrOut = new PassThrough();
		let stderrTail: Buffer = Buffer.alloc(0);
		child.stderr.on("data", (chunk: Buffer) => {
			const combined = Buffer.concat([stderrTail, chunk]);
			if (combined.length > STDERR_TRAILER_HOLD_BYTES) {
				const flushLen = combined.length - STDERR_TRAILER_HOLD_BYTES;
				stderrOut.write(combined.subarray(0, flushLen));
				stderrTail = combined.subarray(flushLen);
			} else {
				stderrTail = combined;
			}
		});
		let graceTimer: NodeJS.Timeout | undefined;
		const closed = new Promise<number | null>((resolve) => {
			child.once("close", (code) => {
				clearTimeout(graceTimer);
				this.runtime.children.delete(child);
				const remaining = stripKubectlExecTrailer(stderrTail, code);
				if (remaining.length > 0) {
					stderrOut.write(remaining);
				}
				stderrOut.end();
				resolve(code);
			});
		});
		return {
			spawned: {
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: stderrOut,
				closed,
				kill: () => {
					if (this.tainted) return;
					this.tainted = true;
					this.killing = this.driver.deleteSandbox(this.name, deadlineAfter(this.runtime));
					graceTimer = setTimeout(() => {
						child.kill("SIGKILL");
					}, this.runtime.limits.killGraceMs);
				},
			},
		};
	}

	async checkOom(deadlineAt: number): Promise<string | undefined> {
		if (remainingMs(deadlineAt) === 0) return undefined;
		const initial = await this.driver.kubectl(["get", "pod", this.name, "-o", "json"], remainingMs(deadlineAt));
		if (initial.code === 0) {
			const pod = parseK8sPod(initial.stdout);
			if (pod?.terminatedReason !== undefined) {
				return pod.terminatedReason === "OOMKilled" ? "pod state.terminated.reason is OOMKilled" : undefined;
			}
		}
		if (remainingMs(deadlineAt) === 0) return undefined;
		const events = await this.driver.kubectl(
			["exec", this.name, "--", "bash", "-c", "cat /sys/fs/cgroup/memory.events 2>/dev/null || true"],
			remainingMs(deadlineAt),
		);
		if (events.code === 0) {
			const count = parseOomKillCount(events.stdout);
			if (count !== undefined && count > this.oomBaseline) {
				this.oomBaseline = count;
				return `oom_kill ${count} in /sys/fs/cgroup/memory.events`;
			}
			return undefined;
		}
		while (remainingMs(deadlineAt) > 0) {
			const got = await this.driver.kubectl(["get", "pod", this.name, "-o", "json"], remainingMs(deadlineAt));
			if (got.code !== 0) {
				if (isK8sNotFound(got.stderr)) return undefined;
			} else {
				const pod = parseK8sPod(got.stdout);
				if (pod?.terminatedReason !== undefined) {
					return pod.terminatedReason === "OOMKilled" ? "pod state.terminated.reason is OOMKilled" : undefined;
				}
			}
			if (remainingMs(deadlineAt) === 0) break;
			await sleep(Math.min(K8S_POLL_MS, remainingMs(deadlineAt)));
		}
		return undefined;
	}

	async scrubAfterCall(deadlineAt: number): Promise<boolean> {
		if (this.destroyed || this.tainted || remainingMs(deadlineAt) === 0) return false;
		const scrubbed = await this.driver.kubectl(
			["exec", this.name, "--", "bash", "-c", SCRUB_SCRIPT],
			remainingMs(deadlineAt),
		);
		return scrubbed.code === 0 && !scrubbed.timedOut && !this.destroyed && !this.tainted;
	}

	async destroy(deadlineAt: number): Promise<CleanupOutcome> {
		this.destroyed = true;
		if (this.killing !== undefined) {
			const outcome = await this.killing;
			if (outcome.removed) return outcome;
		}
		return this.driver.deleteSandbox(this.name, deadlineAt);
	}
}

export class K8sDriver implements SandboxDriver {
	readonly name = "k8s" as const;
	private readonly runtime: SandboxDriverContext;
	private readonly serviceAccountDir: string;
	private kubeconfigFile: string | undefined;
	private namespaceValue = "polar";

	constructor(runtime: SandboxDriverContext, options: K8sDriverOptions = {}) {
		this.runtime = runtime;
		this.serviceAccountDir = options.serviceAccountDir ?? DEFAULT_SERVICE_ACCOUNT_DIR;
	}

	get pvcName(): string {
		return (this.runtime.environment.POLAR_SANDBOX_K8S_PVC ?? "").trim();
	}

	get runtimeClass(): string {
		return (this.runtime.environment.POLAR_SANDBOX_K8S_RUNTIME_CLASS ?? "").trim();
	}

	get podName(): string {
		return (this.runtime.environment.POLAR_SANDBOX_K8S_POD_NAME ?? "").trim();
	}

	get podUid(): string {
		return (this.runtime.environment.POLAR_SANDBOX_K8S_POD_UID ?? "").trim();
	}

	get nodeName(): string {
		return (this.runtime.environment.POLAR_SANDBOX_K8S_NODE_NAME ?? "").trim();
	}

	get serviceHost(): string {
		return (this.runtime.environment.KUBERNETES_SERVICE_HOST ?? "").trim();
	}

	get servicePort(): string {
		const port = (this.runtime.environment.KUBERNETES_SERVICE_PORT ?? "").trim();
		return port === "" ? "443" : port;
	}

	get namespace(): string {
		return this.namespaceValue;
	}

	get kubeconfigPath(): string {
		return this.kubeconfigFile ?? "";
	}

	get boundaryDescription(): string {
		return `k8s (${this.runtimeClass || "unknown"})`;
	}

	kubectlPrefix(): string[] {
		return ["--kubeconfig", this.kubeconfigPath, "-n", this.namespace];
	}

	async kubectl(
		args: string[],
		timeoutMs = this.runtime.limits.commandTimeoutMs,
		signal?: AbortSignal,
	): Promise<CommandOutcome> {
		if (this.kubeconfigFile === undefined) {
			const kc = await this.ensureKubeconfig();
			if (!kc.ok) return { code: 1, stdout: "", stderr: kc.reason, timedOut: false };
		}
		return containerCommand(
			this.runtime,
			[...this.kubectlPrefix(), ...args],
			timeoutMs,
			signal,
			undefined,
			kubectlEnv(this.runtime.environment),
		);
	}

	async checkRuntime(deadlineAt: number): Promise<{ ready: true } | { ready: false; reason: string }> {
		const required: [string, string][] = [
			["POLAR_SANDBOX_K8S_PVC", this.pvcName],
			["POLAR_SANDBOX_K8S_RUNTIME_CLASS", this.runtimeClass],
			[
				"POLAR_SANDBOX_K8S_IMAGE",
				this.runtime.customImage
					? this.runtime.image
					: (this.runtime.environment.POLAR_SANDBOX_K8S_IMAGE ?? "").trim(),
			],
			["POLAR_SANDBOX_K8S_POD_NAME", this.podName],
			["POLAR_SANDBOX_K8S_POD_UID", this.podUid],
			["POLAR_SANDBOX_K8S_NODE_NAME", this.nodeName],
			["KUBERNETES_SERVICE_HOST", this.serviceHost],
		];
		for (const [key, value] of required) {
			if (value === "") return { ready: false, reason: `${key} is not set` };
		}
		const sessionId = this.runtime.handle.paths.sessionId;
		if (!VALID_K8S_SESSION_ID.test(sessionId)) {
			return { ready: false, reason: `invalid sessionId "${sessionId}" for k8s sandbox` };
		}
		const kc = await this.ensureKubeconfig();
		if (!kc.ok) return { ready: false, reason: kc.reason };

		const selfPod = await this.kubectl(["get", "pod", this.podName, "-o", "json"], remainingMs(deadlineAt));
		if (selfPod.code !== 0) {
			return { ready: false, reason: `kubectl get pod ${this.podName} failed: ${commandFailure(selfPod)}` };
		}
		const parsedSelf = parseK8sPod(selfPod.stdout);
		if (parsedSelf?.uid === undefined) {
			return { ready: false, reason: `kubectl get pod ${this.podName} returned unreadable JSON` };
		}
		if (parsedSelf.uid !== this.podUid) {
			return {
				ready: false,
				reason: `pod UID mismatch for ${this.podName}: expected ${this.podUid}, got ${parsedSelf.uid}`,
			};
		}
		return { ready: true };
	}

	inspectImage(_image: string, _deadlineAt: number): Promise<{ found: true } | { found: false; reason: string }> {
		return Promise.resolve({ found: true });
	}

	pullImage(_image: string, _signal?: AbortSignal): Promise<CommandOutcome> {
		return Promise.resolve({
			code: 1,
			stdout: "",
			stderr: "image pull is not supported in k8s driver",
			timedOut: false,
		});
	}

	buildImage(_image: string, _contextDir: string, _signal?: AbortSignal): Promise<CommandOutcome> {
		return Promise.resolve({
			code: 1,
			stdout: "",
			stderr: "image build is not supported in k8s driver",
			timedOut: false,
		});
	}

	async listSandboxes(root: string, deadlineAt: number): Promise<OwnedResource[]> {
		const selector = `${SANDBOX_LABEL}=true,${ROOT_HASH_LABEL}=${rootHash(root)}`;
		const listed = await this.kubectl(["get", "pods", "-l", selector, "-o", "json"], remainingMs(deadlineAt));
		if (listed.code !== 0) throw new Error(commandFailure(listed));
		const pods = parseK8sPods(listed.stdout);
		if (pods === undefined) throw new Error("unreadable listing");
		const owned: OwnedResource[] = [];
		for (const pod of pods) {
			if (labelOf(pod.annotations, ROOT_LABEL) !== root) continue;
			const sessionId = labelOf(pod.labels, SESSION_LABEL);
			if (sessionId !== undefined && sessionId !== "") {
				owned.push({ name: pod.name, sessionId });
			}
		}
		return owned;
	}

	async deleteSandbox(name: string, deadlineAt: number): Promise<CleanupOutcome> {
		const podName = k8sPodName(name);
		if (this.kubeconfigFile === undefined) {
			const kc = await this.ensureKubeconfig();
			if (!kc.ok) {
				this.runtime.owned.add(podName);
				return { removed: false, error: { container: podName, message: kc.reason } };
			}
		}
		return cleanupK8sPod(this.runtime, this.kubectlPrefix(), podName, deadlineAt);
	}

	manualDeleteCommand(names: string[]): string {
		return `kubectl -n ${this.namespace} delete pod --wait=true ${names.join(" ")}`;
	}

	async listWorkVolumes(_root: string, deadlineAt: number): Promise<OwnedResource[]> {
		if (remainingMs(deadlineAt) === 0 || this.runtime.cliStopped) return [];
		const session = this.runtime.handle.paths;
		const podName = `polar-work-ls-${k8sPodName(session.sessionId)}-${randomBytes(4).toString("hex")}`;
		this.runtime.owned.add(podName);
		const manifest = this.helperPodManifest(podName, session, ["bash", "-c", KEEPALIVE_COMMAND], {
			stdin: true,
			mountWorkRootReadOnly: true,
		});
		const created = await this.createPodFromManifest(manifest, deadlineAt);
		if (created.code !== 0) {
			await this.deleteSandbox(podName, deadlineAfter(this.runtime));
			return [];
		}
		try {
			const running = await this.waitForPodRunning(podName, deadlineAt);
			if (!running.ready || remainingMs(deadlineAt) === 0) return [];
			const listed = await this.kubectl(["exec", podName, "--", "ls", "-1", "/work-root"], remainingMs(deadlineAt));
			if (listed.code !== 0) return [];
			const volumes: OwnedResource[] = [];
			for (const raw of listed.stdout.split("\n")) {
				const sessionId = raw.trim();
				if (sessionId !== "" && VALID_K8S_SESSION_ID.test(sessionId)) {
					volumes.push({ name: workVolumeName(sessionId), sessionId });
				}
			}
			return volumes;
		} finally {
			await this.deleteSandbox(podName, deadlineAfter(this.runtime));
		}
	}

	async ensureWorkVolume(session: SessionPaths, deadlineAt: number): Promise<VolumeFailure | undefined> {
		if (this.runtime.state !== "unready") return { reason: START_ENDED };
		if (!VALID_K8S_SESSION_ID.test(session.sessionId)) {
			return { reason: `invalid sessionId "${session.sessionId}" for k8s sandbox` };
		}
		const probeName = `polar-netprobe-${k8sPodName(session.sessionId)}-${randomBytes(4).toString("hex")}`;
		this.runtime.owned.add(probeName);
		const probeManifest = this.helperPodManifest(
			probeName,
			session,
			["python3", "-c", NETPROBE_PYTHON, this.serviceHost, this.servicePort],
			{ mountSessionWork: true },
		);
		const created = await this.createPodFromManifest(probeManifest, deadlineAt);
		if (created.code !== 0) {
			const cleanup = await this.deleteSandbox(probeName, deadlineAfter(this.runtime));
			const leftover = cleanup.removed ? undefined : cleanup.error;
			return { reason: `network policy probe failed to start: ${commandFailure(created)}`, leftover };
		}
		const terminated = await this.waitForPodTerminated(probeName, deadlineAt);
		const cleanup = await this.deleteSandbox(probeName, deadlineAfter(this.runtime));
		const leftover = cleanup.removed ? undefined : cleanup.error;
		if (!terminated.terminated) {
			return { reason: `network policy probe failed: ${terminated.reason}`, leftover };
		}
		if (terminated.exitCode === 2) {
			return {
				reason: `the /work volume (PVC ${this.pvcName} subPath work/${session.sessionId}) is not writable by uid 1000`,
				leftover,
			};
		}
		if (terminated.exitCode === 3) {
			return {
				reason: `network policy probe failed: address ${this.serviceHost}:${this.servicePort} could not be resolved`,
				leftover,
			};
		}
		if (terminated.exitCode !== 0) {
			return {
				reason: `NetworkPolicy deny-all is not enforced: sandbox pod connected to ${this.serviceHost}:${this.servicePort} (exit ${terminated.exitCode})`,
				leftover,
			};
		}
		if (leftover !== undefined) {
			return {
				reason: `network policy probe pod ${probeName} could not be deleted: ${leftover.message}`,
				leftover,
			};
		}
		return undefined;
	}

	async deleteWorkVolumes(volumes: OwnedResource[], deadlineAt: number): Promise<void> {
		if (remainingMs(deadlineAt) === 0 || this.runtime.cliStopped) return;
		const sessionIds = volumes.map((v) => v.sessionId).filter((id) => VALID_K8S_SESSION_ID.test(id));
		if (sessionIds.length === 0) return;
		const session = this.runtime.handle.paths;
		const podName = `polar-work-rm-${k8sPodName(session.sessionId)}-${randomBytes(4).toString("hex")}`;
		this.runtime.owned.add(podName);
		const manifest = this.helperPodManifest(
			podName,
			session,
			[
				"bash",
				"-c",
				// Run rm -rf first and fall back to chmod -R u+rwX + rm -rf only if the directory remains so trees shrink monotonically within 30s without pods/log RBAC.
				'for s in "$@"; do target="/work-root/$s"; [ ! -e "$target" ] && continue; rm -rf -- "$target" 2>/dev/null; if [ -e "$target" ]; then chmod -R u+rwX "$target" 2>/dev/null || true; rm -rf -- "$target"; fi; done',
				"polar-work-rm",
				...sessionIds,
			],
			{ mountWorkRootWritable: true },
		);
		const created = await this.createPodFromManifest(manifest, deadlineAt);
		if (created.code !== 0) {
			await this.deleteSandbox(podName, deadlineAfter(this.runtime));
			return;
		}
		try {
			await this.waitForPodTerminated(podName, deadlineAt);
		} finally {
			await this.deleteSandbox(podName, deadlineAfter(this.runtime));
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
		if (!VALID_K8S_SESSION_ID.test(session.sessionId)) {
			return { failed: `invalid sessionId "${session.sessionId}" for k8s sandbox` };
		}
		const podName = k8sPodName(name);
		this.runtime.owned.add(podName);
		const manifest = k8sSandboxPodManifest({
			name: podName,
			namespace: this.namespace,
			session,
			image: this.runtime.image,
			runtimeClass: this.runtimeClass,
			nodeName: this.nodeName,
			ownerPodName: this.podName,
			ownerPodUid: this.podUid,
			pvcName: this.pvcName,
			memoryBytes: this.runtime.limits.memoryBytes,
			cpus: this.runtime.limits.cpus,
			tmpMaxBytes: this.runtime.limits.tmpMaxBytes,
		});
		const created = await this.createPodFromManifest(manifest, deadlineAt, signal);
		if (created.code !== 0) {
			const cleanup = await this.deleteSandbox(podName, deadlineAfter(this.runtime));
			return {
				failed: commandFailure(created),
				leftover: cleanup.removed ? undefined : cleanup.error,
			};
		}
		const startup = await this.waitForPodRunning(podName, deadlineAt, signal);
		if (startup.ready) {
			return { started: new K8sHotSandbox(podName, this.runtime, this) };
		}
		const cleanup = await this.deleteSandbox(podName, deadlineAfter(this.runtime));
		return {
			failed: startup.reason,
			leftover: cleanup.removed ? undefined : cleanup.error,
		};
	}

	private async ensureKubeconfig(): Promise<{ ok: true } | { ok: false; reason: string }> {
		const namespacePath = join(this.serviceAccountDir, "namespace");
		const tokenPath = join(this.serviceAccountDir, "token");
		const caPath = join(this.serviceAccountDir, "ca.crt");
		let namespaceText: string;
		let tokenText: string;
		try {
			[namespaceText, tokenText] = await Promise.all([
				readFile(namespacePath, "utf8"),
				readFile(tokenPath, "utf8"),
				stat(caPath),
			]);
		} catch (error) {
			return {
				ok: false,
				reason: `serviceaccount credentials in ${this.serviceAccountDir} could not be read: ${(error as Error).message}`,
			};
		}
		const namespace = namespaceText.trim();
		const token = tokenText.trim();
		if (namespace === "" || token === "") {
			return { ok: false, reason: `serviceaccount credentials in ${this.serviceAccountDir} are empty` };
		}
		this.namespaceValue = namespace;
		const host = this.serviceHost || "127.0.0.1";
		const serverHost = host.includes(":") ? `[${host}]` : host;
		const kubeconfig = {
			apiVersion: "v1",
			kind: "Config",
			clusters: [
				{
					name: "in-cluster",
					cluster: {
						server: `https://${serverHost}:${this.servicePort}`,
						"certificate-authority": caPath,
					},
				},
			],
			users: [
				{
					name: "serviceaccount",
					user: { tokenFile: tokenPath },
				},
			],
			contexts: [
				{
					name: "default",
					context: {
						cluster: "in-cluster",
						user: "serviceaccount",
						namespace,
					},
				},
			],
			"current-context": "default",
		};
		const dirHash = createHash("sha256").update(this.serviceAccountDir).digest("hex").slice(0, 16);
		const targetPath = join(tmpdir(), `polar-k8s-kubeconfig-${process.pid}-${dirHash}.json`);
		const tempPath = `${targetPath}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(tempPath, JSON.stringify(kubeconfig, null, 2), { mode: 0o600 });
		try {
			await rename(tempPath, targetPath);
		} catch (error) {
			await rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
		this.kubeconfigFile = targetPath;
		return { ok: true };
	}

	private helperPodManifest(
		name: string,
		session: SessionPaths,
		command: string[],
		options: {
			stdin?: boolean;
			mountSessionWork?: boolean;
			mountWorkRootReadOnly?: boolean;
			mountWorkRootWritable?: boolean;
		} = {},
	): Record<string, unknown> {
		const root = artifactsRootOf(session);
		const volumeMounts: Record<string, unknown>[] = [{ name: "tmp", mountPath: TMP_PATH }];
		const volumes: Record<string, unknown>[] = [
			{
				name: "tmp",
				emptyDir: {
					medium: "Memory",
					sizeLimit: "64Mi",
				},
			},
		];
		if (options.mountSessionWork) {
			volumeMounts.push({
				name: "shared",
				mountPath: WORK_PATH,
				subPath: `work/${session.sessionId}`,
			});
			volumes.push({
				name: "shared",
				persistentVolumeClaim: {
					claimName: this.pvcName,
				},
			});
		} else if (options.mountWorkRootReadOnly || options.mountWorkRootWritable) {
			volumeMounts.push({
				name: "shared",
				mountPath: "/work-root",
				subPath: "work",
				...(options.mountWorkRootReadOnly ? { readOnly: true } : {}),
			});
			volumes.push({
				name: "shared",
				persistentVolumeClaim: {
					claimName: this.pvcName,
				},
			});
		}
		return {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name,
				namespace: this.namespace,
				labels: {
					[SANDBOX_LABEL]: "true",
					[SESSION_LABEL]: session.sessionId,
					[ROOT_HASH_LABEL]: rootHash(root),
				},
				annotations: {
					[ROOT_LABEL]: root,
				},
				ownerReferences: [
					{
						apiVersion: "v1",
						kind: "Pod",
						name: this.podName,
						uid: this.podUid,
					},
				],
			},
			spec: {
				runtimeClassName: this.runtimeClass,
				nodeSelector: {
					"kubernetes.io/hostname": this.nodeName,
				},
				restartPolicy: "Never",
				terminationGracePeriodSeconds: 1,
				automountServiceAccountToken: false,
				enableServiceLinks: false,
				securityContext: K8S_POD_SECURITY_CONTEXT,
				containers: [
					{
						name: "sandbox",
						image: this.runtime.image,
						command,
						...(options.stdin ? { stdin: true } : {}),
						env: [
							{ name: "HOME", value: TMP_PATH },
							{ name: "TMPDIR", value: TMP_PATH },
						],
						securityContext: K8S_CONTAINER_SECURITY_CONTEXT,
						resources: {
							requests: {
								cpu: "100m",
								memory: "64Mi",
							},
							limits: {
								cpu: "1",
								memory: "256Mi",
							},
						},
						volumeMounts,
					},
				],
				volumes,
			},
		};
	}

	private async createPodFromManifest(
		manifest: Record<string, unknown>,
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<CommandOutcome> {
		if (this.kubeconfigFile === undefined) {
			const kc = await this.ensureKubeconfig();
			if (!kc.ok) return { code: 1, stdout: "", stderr: kc.reason, timedOut: false };
		}
		const manifestPath = join(tmpdir(), `polar-k8s-pod-${process.pid}-${randomBytes(4).toString("hex")}.json`);
		await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		try {
			return await this.kubectl(["create", "-f", manifestPath], remainingMs(deadlineAt), signal);
		} finally {
			await rm(manifestPath, { force: true }).catch(() => undefined);
		}
	}

	private async waitForPodRunning(
		podName: string,
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<{ ready: true } | { ready: false; reason: string }> {
		while (remainingMs(deadlineAt) > 0) {
			if (this.runtime.cliStopped) return { ready: false, reason: CLI_STOPPED };
			if (signal?.aborted) return { ready: false, reason: "cancelled" };
			const got = await this.kubectl(["get", "pod", podName, "-o", "json"], remainingMs(deadlineAt), signal);
			if (got.code !== 0) return { ready: false, reason: commandFailure(got) };
			const pod = parseK8sPod(got.stdout);
			if (pod === undefined) return { ready: false, reason: "unreadable pod status" };
			if (pod.running) return { ready: true };
			if (pod.terminatedReason !== undefined || pod.phase === "Failed" || pod.phase === "Succeeded") {
				return {
					ready: false,
					reason: `pod ${podName} terminated (${pod.terminatedReason || pod.phase || "stopped"})`,
				};
			}
			if (pod.waitingReason !== undefined && FATAL_WAITING_REASONS.has(pod.waitingReason)) {
				return {
					ready: false,
					reason: pod.waitingMessage ? `${pod.waitingReason}: ${pod.waitingMessage}` : pod.waitingReason,
				};
			}
			if (remainingMs(deadlineAt) === 0) break;
			await sleep(Math.min(K8S_POLL_MS, remainingMs(deadlineAt)));
		}
		return { ready: false, reason: signal?.aborted ? "cancelled" : "timed out" };
	}

	private async waitForPodTerminated(
		podName: string,
		deadlineAt: number,
	): Promise<{ terminated: true; exitCode: number; reason?: string } | { terminated: false; reason: string }> {
		while (remainingMs(deadlineAt) > 0) {
			if (this.runtime.cliStopped) return { terminated: false, reason: CLI_STOPPED };
			const got = await this.kubectl(["get", "pod", podName, "-o", "json"], remainingMs(deadlineAt));
			if (got.code !== 0) return { terminated: false, reason: commandFailure(got) };
			const pod = parseK8sPod(got.stdout);
			if (pod === undefined) return { terminated: false, reason: "unreadable pod status" };
			if (pod.terminatedExitCode !== undefined) {
				return { terminated: true, exitCode: pod.terminatedExitCode, reason: pod.terminatedReason };
			}
			if (pod.waitingReason !== undefined && FATAL_WAITING_REASONS.has(pod.waitingReason)) {
				return {
					terminated: false,
					reason: pod.waitingMessage ? `${pod.waitingReason}: ${pod.waitingMessage}` : pod.waitingReason,
				};
			}
			if (remainingMs(deadlineAt) === 0) break;
			await sleep(Math.min(K8S_POLL_MS, remainingMs(deadlineAt)));
		}
		return { terminated: false, reason: "timed out" };
	}
}
