import { readFileSync } from "fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import { LineSplitter } from "../src/cli.ts";
import {
	AppleContainerDriver,
	artifactsRootOf,
	K8sDriver,
	type K8sDriverOptions,
	OciDriver,
	type OciDriverOptions,
} from "../src/driver.ts";
import { formatDiagnosisWarning, probeHost } from "../src/host.ts";
import type {
	Activation,
	ImageSpec,
	RunningCall,
	SandboxDriverContext,
	SandboxHost,
	SandboxLimits,
	SandboxRuntime,
	SessionHandle,
	SessionPaths,
} from "../src/types.ts";
import { activateRuntime, type Warn } from "../src/workspace.ts";

export const FAKE_CONTAINER = fileURLToPath(new URL("./fake-container.mjs", import.meta.url));
export const FAKE_OCI = fileURLToPath(new URL("./fake-oci.mjs", import.meta.url));
export const FAKE_KUBECTL = fileURLToPath(new URL("./fake-kubectl.mjs", import.meta.url));

export const testLimits: SandboxLimits = {
	timeoutMs: 10_000,
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpus: 2,
	workMaxBytes: 4 * 1024 * 1024,
	processMax: 64,
	tmpMaxBytes: 16 * 1024 * 1024,
	fileMaxBytes: 1024 * 1024,
	sessionMaxBytes: 16 * 1024 * 1024,
	stderrMaxBytes: 64 * 1024,
	killGraceMs: 300,
	commandTimeoutMs: 5000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
	shutdownBudgetMs: 3000,
};

export interface VolumeRecord {
	name: string;
	labels: Record<string, string>;
	size: string;
}

export interface FakeState {
	directory: string;
	calls(): Promise<string[][]>;
	manifests(): Promise<Record<string, unknown>[]>;
	containers(): Promise<string[]>;
	volumes(): Promise<VolumeRecord[]>;
	addContainer(id: string, labels: Record<string, string>, annotations?: Record<string, string>): Promise<void>;
	addVolume(name: string, labels: Record<string, string>): Promise<void>;
}

export async function fakeState(): Promise<FakeState> {
	const directory = await mkdtemp(join(tmpdir(), "fake-container-"));
	const listJson = async <Entry>(subdirectory: string): Promise<Entry[]> => {
		const names = (await readdir(join(directory, subdirectory)).catch(() => [])).filter((name) =>
			name.endsWith(".json"),
		);
		return Promise.all(
			names.map(async (name) => JSON.parse(await readFile(join(directory, subdirectory, name), "utf8")) as Entry),
		);
	};
	const writeRecord = async (subdirectory: string, name: string, record: object) => {
		await mkdir(join(directory, subdirectory), { recursive: true });
		await writeFile(join(directory, subdirectory, `${name}.json`), JSON.stringify(record));
	};
	return {
		directory,
		async calls() {
			const text = await readFile(join(directory, "calls.jsonl"), "utf8").catch(() => "");
			return text
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as string[]);
		},
		async manifests() {
			const text = await readFile(join(directory, "manifests.jsonl"), "utf8").catch(() => "");
			return text
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		},
		async containers() {
			return (await listJson<{ id: string }>("containers")).map((record) => record.id).sort();
		},
		volumes() {
			return listJson<VolumeRecord>("volumes");
		},
		addContainer(id, labels, annotations = {}) {
			return writeRecord("containers", id, {
				id,
				labels,
				annotations,
				state: "stopped",
				pid: null,
				execPid: null,
				bootLog: [],
			});
		},
		addVolume(name, labels) {
			return writeRecord("volumes", name, { name, labels, size: "4M" });
		},
	};
}

export function fakeEnvironment(state: FakeState, knobs: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, FAKE_CONTAINER_STATE: state.directory };
	for (const [name, value] of Object.entries(knobs)) {
		environment[`FAKE_CONTAINER_${name}`] = value;
	}
	return environment;
}

function openRuntime(host: SandboxHost, handle: SessionHandle): SandboxRuntime {
	host.state = "open";
	return Object.assign(host, {
		handle,
		inFlight: new Set<string>(),
		running: new Set<RunningCall>(),
		activeSandbox: {},
	});
}

/** Probes the host and activates the session on it, as a session start does. */
export async function startHost(
	host: SandboxHost,
	session: Pick<SessionPaths, "sessionId" | "cwd" | "outputDirectory">,
	warn: Warn = () => {},
): Promise<Activation> {
	const diagnosis = await probeHost(host);
	if (diagnosis.kind !== "ready") {
		return { ready: false, message: formatDiagnosisWarning(diagnosis), leftovers: [] };
	}
	return activateRuntime(host, session.sessionId, session.cwd, diagnosis.image, warn, artifactsRootOf(session));
}

export async function startedRuntime(
	host: SandboxHost,
	session: Pick<SessionPaths, "sessionId" | "cwd" | "outputDirectory">,
	warn: Warn = () => {},
): Promise<SandboxRuntime> {
	const started = await startHost(host, session, warn);
	if (!started.ready) throw new Error(started.message);
	started.runtime.state = "open";
	return started.runtime;
}

export function fakeHost(
	state: FakeState,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	imageSpec: ImageSpec = { candidates: ["polar-sandbox:test"], build: "polar-sandbox:test" },
): SandboxHost {
	const context: SandboxDriverContext = {
		containerCommand: FAKE_CONTAINER,
		image: imageSpec.build,
		imageSpec,
		limits: { ...testLimits, ...limits },
		environment: fakeEnvironment(state, knobs),
		state: "unready",
		owned: new Set(),
		children: new Set(),
		cliStopped: false,
	};
	return Object.assign(context, { driver: new AppleContainerDriver(context) });
}

export function fakeRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
): SandboxRuntime {
	return openRuntime(fakeHost(state, knobs, limits), handle);
}

export function fakeOciEnvironment(state: FakeState, knobs: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, FAKE_OCI_STATE: state.directory };
	for (const [name, value] of Object.entries(knobs)) {
		environment[`FAKE_OCI_${name}`] = value;
	}
	return environment;
}

export function fakeOciHost(
	state: FakeState,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: OciDriverOptions = {},
	imageSpec: ImageSpec = { candidates: ["polar-sandbox:test"], build: "polar-sandbox:test" },
): SandboxHost {
	const context: SandboxDriverContext = {
		containerCommand: FAKE_OCI,
		image: imageSpec.build,
		imageSpec,
		limits: { ...testLimits, ...limits },
		environment: fakeOciEnvironment(state, knobs),
		state: "unready",
		owned: new Set(),
		children: new Set(),
		cliStopped: false,
	};
	return Object.assign(context, { driver: new OciDriver(context, driverOptions) });
}

export function fakeOciRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: OciDriverOptions = {},
): SandboxRuntime {
	return openRuntime(fakeOciHost(state, knobs, limits, driverOptions), handle);
}

export async function fakeServiceAccountDir(
	baseDir: string,
	values: { namespace?: string; token?: string; ca?: string } = {},
): Promise<string> {
	const saDir = join(baseDir, "serviceaccount");
	await mkdir(saDir, { recursive: true });
	await writeFile(join(saDir, "namespace"), `${values.namespace ?? "polar"}\n`);
	await writeFile(join(saDir, "token"), `${values.token ?? "test-sa-token"}\n`);
	await writeFile(
		join(saDir, "ca.crt"),
		values.ca ?? "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n",
	);
	return saDir;
}

export function fakeK8sEnvironment(state: FakeState, knobs: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		FAKE_KUBECTL_STATE: state.directory,
		POLAR_SANDBOX_K8S_PVC: "polar-shared",
		POLAR_SANDBOX_K8S_RUNTIME_CLASS: "gvisor",
		POLAR_SANDBOX_K8S_IMAGE: "registry.example/polar-sandbox@sha256:deadbeef",
		POLAR_SANDBOX_K8S_POD_NAME: "polar-0",
		POLAR_SANDBOX_K8S_POD_UID: "uid-polar-0",
		POLAR_SANDBOX_K8S_NODE_NAME: "polar-node-1",
		KUBERNETES_SERVICE_HOST: "10.43.0.1",
		KUBERNETES_SERVICE_PORT: "443",
	};
	for (const [name, value] of Object.entries(knobs)) {
		if (name.startsWith("POLAR_") || name.startsWith("KUBERNETES_")) {
			environment[name] = value;
		} else {
			environment[`FAKE_KUBECTL_${name}`] = value;
		}
	}
	return environment;
}

export function fakeK8sHost(
	state: FakeState,
	saDir: string,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: K8sDriverOptions = {},
): SandboxHost {
	const environment = fakeK8sEnvironment(state, knobs);
	const image = environment.POLAR_SANDBOX_K8S_IMAGE || "polar-sandbox:test";
	const context: SandboxDriverContext = {
		containerCommand: FAKE_KUBECTL,
		image,
		imageSpec: { candidates: [image], build: image },
		limits: { ...testLimits, ...limits },
		environment,
		state: "unready",
		owned: new Set(),
		children: new Set(),
		cliStopped: false,
	};
	return Object.assign(context, { driver: new K8sDriver(context, { serviceAccountDir: saDir, ...driverOptions }) });
}

export function fakeK8sRuntime(
	state: FakeState,
	handle: SessionHandle,
	saDir: string,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: K8sDriverOptions = {},
): SandboxRuntime {
	return openRuntime(fakeK8sHost(state, saDir, knobs, limits, driverOptions), handle);
}

export function recordedLines(name: string): string[] {
	const lines: string[] = [];
	const splitters = new Map<string, LineSplitter>();
	const recording = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
	for (const entry of recording.split("\n").filter((line) => line !== "")) {
		const chunk = JSON.parse(entry) as { stream?: string; text?: string };
		if (chunk.stream === undefined || chunk.text === undefined) continue;
		let splitter = splitters.get(chunk.stream);
		if (!splitter) {
			splitter = new LineSplitter((line) => lines.push(line));
			splitters.set(chunk.stream, splitter);
		}
		splitter.write(Buffer.from(chunk.text));
	}
	for (const splitter of splitters.values()) splitter.end();
	return lines;
}

export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("the condition did not come true in time");
		await sleep(10);
	}
}
