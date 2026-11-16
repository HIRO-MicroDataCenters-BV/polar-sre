import { mkdir, mkdtemp, readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import { AppleContainerDriver, OciDriver, type OciDriverOptions } from "../src/driver.ts";
import type { RunningCall, SandboxDriverContext, SandboxLimits, SandboxRuntime, SessionHandle } from "../src/types.ts";

export const FAKE_CONTAINER = fileURLToPath(new URL("./fake-container.mjs", import.meta.url));
export const FAKE_OCI = fileURLToPath(new URL("./fake-oci.mjs", import.meta.url));

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
	containers(): Promise<string[]>;
	volumes(): Promise<VolumeRecord[]>;
	addContainer(id: string, labels: Record<string, string>): Promise<void>;
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
		async containers() {
			return (await listJson<{ id: string }>("containers")).map((record) => record.id).sort();
		},
		volumes() {
			return listJson<VolumeRecord>("volumes");
		},
		addContainer(id, labels) {
			return writeRecord("containers", id, { id, labels, state: "stopped", pid: null, execPid: null, bootLog: [] });
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

export function fakeRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
): SandboxRuntime {
	const context: SandboxDriverContext = {
		containerCommand: FAKE_CONTAINER,
		image: "polar-sandbox:test",
		limits: { ...testLimits, ...limits },
		environment: fakeEnvironment(state, knobs),
		handle,
		state: "open",
		owned: new Set(),
		children: new Map(),
		cliStopped: false,
	};
	return Object.assign(context, {
		inFlight: new Set<string>(),
		running: new Set<RunningCall>(),
		driver: new AppleContainerDriver(context),
		activeSandbox: {},
	});
}

export function startingRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
): SandboxRuntime {
	const runtime = fakeRuntime(state, handle, knobs, limits);
	runtime.state = "unready";
	return runtime;
}

export function fakeOciEnvironment(state: FakeState, knobs: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, FAKE_OCI_STATE: state.directory };
	for (const [name, value] of Object.entries(knobs)) {
		environment[`FAKE_OCI_${name}`] = value;
	}
	return environment;
}

export function fakeOciRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: OciDriverOptions = {},
): SandboxRuntime {
	const context: SandboxDriverContext = {
		containerCommand: FAKE_OCI,
		image: "polar-sandbox:test",
		limits: { ...testLimits, ...limits },
		environment: fakeOciEnvironment(state, knobs),
		handle,
		state: "open",
		owned: new Set(),
		children: new Map(),
		cliStopped: false,
	};
	return Object.assign(context, {
		inFlight: new Set<string>(),
		running: new Set<RunningCall>(),
		driver: new OciDriver(context, driverOptions),
		activeSandbox: {},
	});
}

export function startingOciRuntime(
	state: FakeState,
	handle: SessionHandle,
	knobs: Record<string, string> = {},
	limits: Partial<SandboxLimits> = {},
	driverOptions: OciDriverOptions = {},
): SandboxRuntime {
	const runtime = fakeOciRuntime(state, handle, knobs, limits, driverOptions);
	runtime.state = "unready";
	return runtime;
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("the condition did not come true in time");
		await sleep(10);
	}
}
