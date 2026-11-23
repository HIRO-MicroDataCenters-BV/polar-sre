import { spawnSync } from "child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSandboxImageDir } from "../../../config.ts";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { createHost, DEFAULT_IMAGE } from "../index.ts";
import { containerCommand } from "../src/cli.ts";
import { SandboxController } from "../src/controller.ts";
import { admitCall } from "../src/runner.ts";
import type { SandboxDriver, SandboxRuntime, SessionPaths } from "../src/types.ts";
import {
	activateRuntime,
	BUILD_IMAGE_OPTION,
	checkReadiness,
	DISABLE_SANDBOX_OPTION,
	DOWNLOAD_IMAGE_OPTION,
	ensureWorkVolume,
	recoverLeftovers,
	shutdownHost,
	shutdownRuntime,
} from "../src/workspace.ts";
import {
	FAKE_CONTAINER,
	type FakeState,
	fakeEnvironment,
	fakeHost,
	fakeRuntime,
	fakeState,
	processExists,
	testLimits,
	until,
} from "./fixtures.ts";

let root: string;
let handle: SessionHandle;
let session: SessionPaths;
let state: FakeState;
let notices: string[];
const warn = (message: string) => notices.push(message);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-workspace-"));
	handle = await acquireSession("current", root, artifactsRoot());
	session = handle.paths;
	state = await fakeState();
	notices = [];
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
	await rm(state.directory, { recursive: true, force: true });
});

function artifactsRoot(): string {
	return join(root, "artifacts");
}

function ownLabels(sessionId: string, rootPath = artifactsRoot()): Record<string, string> {
	return { "polar-session": sessionId, "polar-root": rootPath };
}

async function otherSession(sessionId: string, pid: number): Promise<string> {
	const directory = join(artifactsRoot(), sessionId);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "lock"), `${pid}\n`);
	return directory;
}

function lockOf(paths: SessionPaths): string {
	return join(paths.outputDirectory, "lock");
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function callsOf(...commands: string[]): Promise<string[][]> {
	return (await state.calls()).filter((call) => commands.includes(call[0]));
}

async function volumeCalls(subcommand: string): Promise<string[][]> {
	return (await state.calls()).filter((call) => call[0] === "volume" && call[1] === subcommand);
}

async function sessionFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory).catch(() => [])).filter((name) => name !== "lock").sort();
}

function startCall(runtime: SandboxRuntime, code: string) {
	const call = admitCall(runtime, { language: "bash", code }, undefined, "call-1");
	if (call === undefined) throw new Error("the call was not admitted");
	return call.run().finally(() => call.dispose());
}

function runChildren(runtime: SandboxRuntime) {
	return [...runtime.children].filter((child) => child.kind === "run");
}

describe("start", () => {
	it("offers run_code only with a running runtime and the image", async () => {
		expect(await checkReadiness(fakeHost(state))).toEqual({ ready: true, image: "polar-sandbox:test" });
		expect(await checkReadiness(fakeHost(state, { STATUS_EXIT: "1" }))).toEqual({
			ready: false,
			message: "sandbox is off: container system status failed: exit 1",
			leftovers: [],
		});
		expect(await checkReadiness(fakeHost(state, { IMAGE_MISSING: "1" }))).toEqual({
			ready: false,
			message:
				"sandbox is off: image polar-sandbox:test is not installed (container image inspect polar-sandbox:test failed: Error: image polar-sandbox:test not found)",
			leftovers: [],
		});
	});

	it("checks host.imageSpec.candidates in order and prompts from host.imageSpec only when UI is present", async () => {
		const registry = "registry.example/polar-sandbox@sha256:deadbeef";
		const local = "polar-sandbox:0.2";

		// 1. Single candidate in imageSpec is checked alone even if pull is set
		const custom = fakeHost(
			state,
			{ IMAGE_PRESENT: "custom:1" },
			{},
			{ candidates: ["custom:1"], pull: registry, build: "custom:1" },
		);
		expect(await checkReadiness(custom)).toEqual({ ready: true, image: "custom:1" });
		expect(await callsOf("image")).toEqual([["image", "inspect", "custom:1"]]);

		// 2. Default image with registryImage present in cache uses registryImage without checking local tag
		state = await fakeState();
		const cachedRegistry = fakeHost(
			state,
			{ IMAGE_PRESENT: registry },
			{},
			{ candidates: [registry, local], pull: registry, build: local },
		);
		expect(await checkReadiness(cachedRegistry)).toEqual({ ready: true, image: registry });
		expect(await callsOf("image")).toEqual([["image", "inspect", registry]]);

		// 3. Default image with registryImage absent falls back to local tag in cache without prompting
		state = await fakeState();
		const cachedLocal = fakeHost(
			state,
			{ IMAGE_PRESENT: local },
			{},
			{ candidates: [registry, local], pull: registry, build: local },
		);
		let prompted = false;
		expect(
			await checkReadiness(cachedLocal, async () => {
				prompted = true;
				return undefined;
			}),
		).toEqual({ ready: true, image: local });
		expect(prompted).toBe(false);
		expect(await callsOf("image")).toEqual([
			["image", "inspect", registry],
			["image", "inspect", local],
		]);

		// 4. Missing image with UI and no registryImage offers Build and Disable (no Download)
		state = await fakeState();
		const buildHost = fakeHost(state, { IMAGE_MISSING: "1" }, {}, { candidates: [local], build: local });
		let seenOptions: string[] = [];
		expect(
			await checkReadiness(buildHost, async (_title, options) => {
				seenOptions = options;
				return BUILD_IMAGE_OPTION;
			}),
		).toEqual({ ready: true, image: local });
		expect(seenOptions).toEqual([BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]);
		const imageDir = getSandboxImageDir();
		expect(await callsOf("build")).toEqual([
			["build", "--arch", "arm64", "--tag", local, "--file", join(imageDir, "Containerfile"), imageDir],
		]);

		// 5. Missing image with UI and registryImage offers Download, Build, and Disable
		state = await fakeState();
		const pullHost = fakeHost(
			state,
			{ IMAGE_MISSING: "1" },
			{},
			{ candidates: [registry, local], pull: registry, build: local },
		);
		expect(
			await checkReadiness(pullHost, async (_title, options) => {
				seenOptions = options;
				return DOWNLOAD_IMAGE_OPTION;
			}),
		).toEqual({ ready: true, image: registry });
		expect(seenOptions).toEqual([DOWNLOAD_IMAGE_OPTION, BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]);
		expect(pullHost.image).toBe(local);
		expect((await callsOf("image")).at(-1)).toEqual(["image", "pull", "--arch", "arm64", registry]);

		// 5a. Forwards pull output lines to showOperation and calls end()
		state = await fakeState();
		const shownHost = fakeHost(
			state,
			{ IMAGE_MISSING: "1" },
			{},
			{ candidates: [registry, local], pull: registry, build: local },
		);
		const shown: string[] = [];
		expect(
			await checkReadiness(
				shownHost,
				async () => DOWNLOAD_IMAGE_OPTION,
				(kind) => {
					shown.push(`start ${kind}`);
					return { output: (line) => shown.push(line), end: () => shown.push("end") };
				},
			),
		).toEqual({ ready: true, image: registry });
		expect(shown).toEqual(["start download", `pulled ${registry}`, "end"]);

		// 6. Selecting Disable turns off sandbox
		state = await fakeState();
		const disabled = fakeHost(state, { IMAGE_MISSING: "1" }, {}, { candidates: [local], build: local });
		expect(await checkReadiness(disabled, async () => DISABLE_SANDBOX_OPTION)).toEqual({
			ready: false,
			message:
				"sandbox is off: image polar-sandbox:0.2 is not installed (container image inspect polar-sandbox:0.2 failed: Error: image polar-sandbox:0.2 not found)",
			leftovers: [],
		});
	});

	it("treats an unknown listing as not established", async () => {
		await state.addContainer("polar-sandbox-current-3-aaaaaaaa", ownLabels("current"));
		const forms: [string, string, string][] = [
			["LIST_FAIL", "1", "Error: list failed"],
			["LIST_GARBAGE", "1", "unreadable listing"],
			["LIST_JSON", "[{}]", "unreadable listing"],
			["LIST_JSON", "[null]", "unreadable listing"],
			["LIST_JSON", "{}", "unreadable listing"],
		];
		for (const [knob, value, said] of forms) {
			const host = fakeHost(state, { [knob]: value });
			expect(
				await activateRuntime(host, "current", root, host.image, warn, artifactsRoot()),
				`${knob}=${value}`,
			).toEqual({
				ready: false,
				message: `sandbox is off: runtime state could not be established: ${said}`,
				leftovers: [],
			});
			expect(host.state).toBe("unready");
			expect(host.owned.size).toBe(0);
		}
		expect(await callsOf("delete", "run", "volume")).toEqual([]);
		expect(await state.containers()).toEqual(["polar-sandbox-current-3-aaaaaaaa"]);
		expect(notices).toEqual([]);
	});

	it("judges other sessions by their lock", async () => {
		const otherRoot = join(root, "other-artifacts");
		await otherSession("live", process.ppid);
		const exited = spawnSync(process.execPath, ["-e", ""]).pid;
		const ended = await otherSession("ended", exited);
		await writeFile(join(ended, "k8s_logs-1.txt"), "kept\n");
		const locked = await otherSession("locked", process.pid);
		await chmod(join(locked, "lock"), 0o000);
		await mkdir(join(otherRoot, "elsewhere"), { recursive: true });

		await state.addContainer("polar-sandbox-current-3-aaaaaaaa", ownLabels("current"));
		await state.addContainer("polar-sandbox-live-1-bbbbbbbb", ownLabels("live"));
		await state.addContainer("polar-sandbox-ended-1-cccccccc", ownLabels("ended"));
		await state.addContainer("polar-sandbox-gone-1-dddddddd", ownLabels("gone"));
		await state.addContainer("polar-sandbox-locked-1-eeeeeeee", ownLabels("locked"));
		await state.addContainer("polar-prep-locked-eeeeeeee", ownLabels("locked"));
		await state.addContainer("polar-sandbox-elsewhere-1-ffffffff", ownLabels("elsewhere", otherRoot));
		await state.addContainer("polar-sandbox-foreign-1-11111111", ownLabels("foreign", otherRoot));
		await state.addContainer("unlabeled", {});
		await state.addContainer("rootless", { "polar-session": "rootless" });
		await state.addVolume("polar-work-current", ownLabels("current"));
		await state.addVolume("polar-work-live", ownLabels("live"));
		await state.addVolume("polar-work-ended", ownLabels("ended"));
		await state.addVolume("polar-work-gone", ownLabels("gone"));
		await state.addVolume("polar-work-locked", ownLabels("locked"));
		await state.addVolume("polar-work-elsewhere", ownLabels("elsewhere", otherRoot));
		await state.addVolume("polar-work-foreign", ownLabels("foreign", otherRoot));
		await state.addVolume("polar-work-busy", ownLabels("busy"));
		await state.addVolume("unlabeled", {});

		const host = fakeHost(state, { VOLUME_IN_USE: "polar-work-busy" });
		expect(await recoverLeftovers(host, session, warn)).toEqual({ clean: true });

		expect(await state.containers()).toEqual([
			"polar-prep-locked-eeeeeeee",
			"polar-sandbox-elsewhere-1-ffffffff",
			"polar-sandbox-foreign-1-11111111",
			"polar-sandbox-live-1-bbbbbbbb",
			"polar-sandbox-locked-1-eeeeeeee",
			"rootless",
			"unlabeled",
		]);
		expect((await state.volumes()).map((volume) => volume.name).sort()).toEqual([
			"polar-work-busy",
			"polar-work-current",
			"polar-work-elsewhere",
			"polar-work-ended",
			"polar-work-foreign",
			"polar-work-live",
			"polar-work-locked",
			"unlabeled",
		]);
		expect(notices).toEqual([
			"sandbox: the lock of session locked could not be read; its containers and volume are kept",
		]);
		expect((await callsOf("delete")).map((call) => call.at(-1)).sort()).toEqual([
			"polar-sandbox-current-3-aaaaaaaa",
			"polar-sandbox-ended-1-cccccccc",
			"polar-sandbox-gone-1-dddddddd",
		]);
		expect((await volumeCalls("delete")).map((call) => call.at(-1)).sort()).toEqual([
			"polar-work-busy",
			"polar-work-gone",
		]);
		expect(await readFile(join(ended, "k8s_logs-1.txt"), "utf8")).toBe("kept\n");
		expect(host.owned.size).toBe(0);
	});

	it("refuses a volume with a foreign or missing root label", async () => {
		const cases: [Record<string, string>, string][] = [
			[ownLabels("current", "/elsewhere"), "/elsewhere"],
			[{}, "missing"],
		];
		for (const [labels, actual] of cases) {
			await state.addVolume("polar-work-current", labels);
			const host = fakeHost(state);
			expect(await activateRuntime(host, "current", root, host.image, warn, artifactsRoot())).toEqual({
				ready: false,
				message: `sandbox is off: the volume polar-work-current is not this session's: its polar-root label is ${actual}, expected ${artifactsRoot()}`,
				leftovers: [],
			});
			expect(await state.volumes()).toEqual([{ name: "polar-work-current", labels, size: "4M" }]);
		}
		expect(await volumeCalls("create")).toEqual([]);
		expect(await volumeCalls("delete")).toEqual([]);
		expect(await callsOf("run")).toEqual([]);
	});

	it("creates the work volume once and prepares it at every start", async () => {
		const host = fakeHost(state);
		expect(await ensureWorkVolume(host, session)).toBeUndefined();
		expect(await state.volumes()).toEqual([{ name: "polar-work-current", labels: ownLabels("current"), size: "4M" }]);
		const calls = await state.calls();
		expect(calls).toContainEqual([
			"volume",
			"create",
			"-s",
			"4M",
			"--label",
			"polar-session=current",
			"--label",
			`polar-root=${artifactsRoot()}`,
			"polar-work-current",
		]);
		const [prep] = await callsOf("run");
		expect(prep.slice(-4)).toEqual(["polar-sandbox:test", "chown", "1000:1000", "/work"]);
		expect(prep[prep.indexOf("--user") + 1]).toBe("0:0");
		expect(prep).toContain("polar-work-current:/work");
		expect(prep).not.toContain("--rm");
		const prepName = prep[prep.indexOf("--name") + 1];
		expect(prepName).toMatch(/^polar-prep-current-[0-9a-f]{8}$/);
		expect(prep).toContain("polar-session=current");
		expect(prep).toContain(`polar-root=${artifactsRoot()}`);
		expect(calls).toContainEqual(["delete", "--force", prepName]);
		expect(await state.containers()).toEqual([]);
		expect(host.owned.size).toBe(0);

		expect(await ensureWorkVolume(host, session)).toBeUndefined();
		expect(await volumeCalls("create")).toHaveLength(1);
		expect(await callsOf("run")).toHaveLength(2);
	});

	it("recovers from an interrupted preparation", async () => {
		const broken = fakeHost(state, { CHOWN_EXIT: "1", VOLUME_IN_USE: "polar-work-current" });
		expect(await ensureWorkVolume(broken, session)).toEqual({
			reason: "the /work volume could not be prepared: exit 1",
		});
		expect(await state.volumes()).toHaveLength(1);
		expect(await state.containers()).toEqual([]);

		expect(await ensureWorkVolume(fakeHost(state), session)).toBeUndefined();
		expect(await state.volumes()).toHaveLength(1);
		expect(await volumeCalls("create")).toHaveLength(1);
		expect(await callsOf("run")).toHaveLength(2);

		await rm(join(state.directory, "volumes"), { recursive: true, force: true });
		expect(await ensureWorkVolume(fakeHost(state, { CHOWN_EXIT: "1" }), session)).toEqual({
			reason: "the /work volume could not be prepared: exit 1",
		});
		expect(await state.volumes()).toEqual([]);
		expect(await ensureWorkVolume(fakeHost(state, { VOLUME_CREATE_EXIT: "2" }), session)).toEqual({
			reason: "the /work volume could not be created: Error: volume create failed",
		});
	});

	it("does not inspect past an unknown volume answer", async () => {
		const answers: [Record<string, string>, string][] = [
			[{ VOLUME_INSPECT_EXIT: "2" }, "Error: volume inspect failed"],
			[{ VOLUME_INSPECT_GARBAGE: "1" }, "unreadable answer"],
		];
		for (const [knobs, said] of answers) {
			const host = fakeHost(state, knobs);
			expect(await activateRuntime(host, "current", root, host.image, warn, artifactsRoot())).toEqual({
				ready: false,
				message: `sandbox is off: the /work volume could not be inspected: ${said}`,
				leftovers: [],
			});
		}
		expect(await volumeCalls("inspect")).toHaveLength(2);
		expect(await volumeCalls("create")).toEqual([]);
		expect(await callsOf("run")).toEqual([]);
		expect(await state.volumes()).toEqual([]);
	});

	it("keeps a leftover owned when it cannot be deleted at start and deletes it at shutdown", async () => {
		await state.addContainer("polar-sandbox-current-2-ffffffff", ownLabels("current"));
		const host = fakeHost(state, { DELETE_FAIL: "1" });

		expect(await activateRuntime(host, "current", root, host.image, warn, artifactsRoot())).toEqual({
			ready: false,
			message:
				"sandbox is off: leftovers of sandbox stayed; polar-sandbox-current-2-ffffffff (delete: Error: runtime temporarily unavailable; still listed) could not be deleted; delete them with: container delete --force polar-sandbox-current-2-ffffffff",
			leftovers: [
				{
					container: "polar-sandbox-current-2-ffffffff",
					message: "delete: Error: runtime temporarily unavailable; still listed",
				},
			],
		});
		expect(host.owned).toEqual(new Set(["polar-sandbox-current-2-ffffffff"]));
		expect(host.state).toBe("unready");
		expect(await volumeCalls("inspect")).toEqual([]);

		delete host.environment.FAKE_CONTAINER_DELETE_FAIL;
		await shutdownHost(host, () => false, "reload", warn);
		expect(await state.containers()).toEqual([]);
		expect(host.owned.size).toBe(0);
		expect(notices).toEqual([]);
	});

	it("reports the preparation failure and the container that stayed together", async () => {
		const cases: [Record<string, string>, string][] = [
			[{ CHOWN_EXIT: "1", DELETE_FAIL: "1" }, "the /work volume could not be prepared: exit 1"],
			[{ DELETE_FAIL: "1" }, "leftovers of sandbox stayed"],
		];
		for (const [knobs, reason] of cases) {
			await rm(join(state.directory, "containers"), { recursive: true, force: true });
			await rm(join(state.directory, "volumes"), { recursive: true, force: true });
			const host = fakeHost(state, knobs);
			const activation = await activateRuntime(host, "current", root, host.image, warn, artifactsRoot());
			const [prep] = await state.containers();
			expect(prep, reason).toMatch(/^polar-prep-current-[0-9a-f]{8}$/);
			const cleanup = "delete: Error: runtime temporarily unavailable; still listed";
			expect(activation, reason).toEqual({
				ready: false,
				message: `sandbox is off: ${reason}; ${prep} (${cleanup}) could not be deleted; delete them with: container delete --force ${prep}`,
				leftovers: [{ container: prep, message: cleanup }],
			});
			expect(host.owned, reason).toEqual(new Set([prep]));
			expect(host.state, reason).toBe("unready");
		}
		expect(notices).toEqual([]);
	});

	it("creates nothing once shutdown began during the start", async () => {
		const missing = fakeHost(state);
		missing.state = "closing";
		expect(await ensureWorkVolume(missing, session)).toEqual({ reason: "the session is shutting down" });
		await state.addVolume("polar-work-current", ownLabels("current"));
		const existing = fakeHost(state);
		existing.state = "closing";
		expect(await ensureWorkVolume(existing, session)).toEqual({ reason: "the session is shutting down" });
		expect(await volumeCalls("create")).toEqual([]);
		expect(await callsOf("run")).toEqual([]);
		expect(existing.owned.size).toBe(0);
	});

	it("keeps host.imageSpec intact and attaches no handle when activation fails after choosing registryImage", async () => {
		const registry = "registry.example/polar-sandbox@sha256:deadbeef";
		const local = DEFAULT_IMAGE;
		const host = createHost(local, fakeEnvironment(state, { IMAGE_PRESENT: registry, CHOWN_EXIT: "1" }), {
			driver: "apple-container",
			registryImage: registry,
		});
		host.containerCommand = FAKE_CONTAINER;
		host.limits = { ...testLimits };

		const readiness = await checkReadiness(host);
		expect(readiness).toEqual({ ready: true, image: registry });
		if (!readiness.ready) throw new Error("expected ready");

		const activation = await activateRuntime(host, "failed-prep", root, readiness.image, warn, artifactsRoot());
		expect(activation).toEqual({
			ready: false,
			message: "sandbox is off: the /work volume could not be prepared: exit 1",
			leftovers: [],
		});
		expect(host.imageSpec).toEqual({ candidates: [registry, local], pull: registry, build: local });
		expect("handle" in host).toBe(false);
		expect(await exists(join(artifactsRoot(), "failed-prep", "lock"))).toBe(false);

		host.environment.FAKE_CONTAINER_IMAGE_PRESENT = local;
		expect(await checkReadiness(host)).toEqual({ ready: true, image: local });
	});
});

describe("shutdown", () => {
	it("returns at the budget and finishes the call in the background", async () => {
		const runtime = fakeRuntime(
			state,
			handle,
			{ RUN_IGNORES_KILL: "1" },
			{ killGraceMs: 5000, shutdownBudgetMs: 300 },
		);
		const finished = startCall(runtime, "stdout:partial\nhang");
		await until(() => runtime.running.size === 1);
		const children = runChildren(runtime);
		expect(children.length).toBeGreaterThanOrEqual(1);

		const started = performance.now();
		await shutdownRuntime(runtime, "reload", warn);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(280);
		expect(elapsed).toBeLessThan(1500);
		expect(notices).toEqual(["sandbox: 1 program(s) still stopping"]);
		expect(runtime.state).toBe("closing");
		expect(runtime.inFlight).toEqual(new Set(["call-1"]));
		expect(await exists(lockOf(session))).toBe(true);

		const result = await finished;
		expect(performance.now() - started).toBeLessThan(2000);
		expect(result.status).toBe("cancelled");
		expect(runtime.children.size).toBe(0);
		expect(await state.containers()).toEqual([]);
		expect(await sessionFiles()).toEqual([]);
		expect(runtime.state).toBe("closed");
		expect(await exists(lockOf(session))).toBe(false);
	});

	it("destroys a warm hot sandbox at shutdown", async () => {
		const runtime = fakeRuntime(state, handle);
		const result = await startCall(runtime, "stdout:done");
		expect(result.status).toBe("ok");
		expect(runtime.activeSandbox.current).toBeDefined();
		expect(await state.containers()).toHaveLength(1);

		await shutdownRuntime(runtime, "reload", warn);

		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(runtime.owned.size).toBe(0);
		expect(await state.containers()).toEqual([]);
		expect(runtime.state).toBe("closed");
		expect(notices).toEqual([]);
	});

	it("does not hold the handle for an external leftover", async () => {
		const runtime = fakeRuntime(
			state,
			handle,
			{ SCRUB_FAIL: "1", DELETE_HANG: "1" },
			{ commandTimeoutMs: 300, shutdownBudgetMs: 800 },
		);
		const result = await startCall(runtime, "stdout:done");
		const name = result.cleanupError?.container ?? "";
		expect(result.cleanupError?.message).toBe("delete: timed out; no time left to list");
		expect(runtime.inFlight.size).toBe(0);

		await shutdownRuntime(runtime, "reload", warn);

		expect(notices).toEqual([
			`sandbox: ${name} (delete: timed out; no time left to list) could not be deleted at shutdown`,
		]);
		expect(runtime.owned).toEqual(new Set([name]));
		expect(runtime.state).toBe("closed");
		expect(await exists(lockOf(session))).toBe(false);
	});

	it("stops the program and every CLI command with its child process at quit", async () => {
		const runtime = fakeRuntime(
			state,
			handle,
			{ RUN_IGNORES_KILL: "1" },
			{ killGraceMs: 5000, shutdownBudgetMs: 300, commandTimeoutMs: 10_000 },
		);
		const finished = startCall(runtime, "hang");
		await until(() => runtime.running.size === 1);
		let helperPid = 0;
		const hanging = containerCommand(runtime, ["-c", "sleep 30 & echo $!; wait"], {
			command: "sh",
			onLine: (line) => {
				helperPid = Number(line);
			},
		});
		await until(() => helperPid > 0);
		expect(new Set([...runtime.children].map((child) => child.kind))).toEqual(new Set(["run", "service"]));

		const started = performance.now();
		await shutdownRuntime(runtime, "quit", warn);

		expect(performance.now() - started).toBeLessThan(1500);
		expect(notices).toEqual(["sandbox: 1 program(s) still stopping"]);
		expect(runtime.cliStopped).toBe(true);
		await until(() => !processExists(helperPid), 2000);
		expect(await hanging).toMatchObject({ code: null, timedOut: false });
		const recorded = (await state.calls()).length;
		expect(await containerCommand(runtime, ["system", "status"])).toEqual({
			code: null,
			stdout: "",
			stderr: "sandbox is stopping; no command starts",
			timedOut: false,
		});
		expect(await state.calls()).toHaveLength(recorded);
		const result = await finished;
		expect(performance.now() - started).toBeLessThan(2000);
		expect(result.status).toBe("cancelled");
		expect(result.cleanupError?.message).toBe(
			"delete: sandbox is stopping; no command starts; list: sandbox is stopping; no command starts",
		);
		expect(runtime.children.size).toBe(0);
		expect(runtime.state).toBe("closed");
	});

	it("releases the handle when nothing is in flight", async () => {
		const open = fakeRuntime(state, handle);
		const started = performance.now();
		await shutdownRuntime(open, "reload", warn);
		expect(performance.now() - started).toBeLessThan(500);
		expect(open.state).toBe("closed");
		expect(await exists(lockOf(session))).toBe(false);
		expect(notices).toEqual([]);
	});

	it("returns at the budget during a hanging activation, which releases the handle when it ends", async () => {
		await state.addContainer("polar-sandbox-starting-1-aaaaaaaa", ownLabels("starting"));
		const startingLock = join(artifactsRoot(), "starting", "lock");
		const host = fakeHost(state, { DELETE_DELAY_MS: "700" }, { shutdownBudgetMs: 200 });
		let activating = true;
		const activation = activateRuntime(host, "starting", root, host.image, warn, artifactsRoot()).finally(() => {
			activating = false;
		});
		await until(async () => (await callsOf("delete")).length === 1);

		const started = performance.now();
		await shutdownHost(host, () => activating, "reload", warn);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(180);
		expect(notices).toEqual([]);
		expect(host.state).toBe("closing");
		expect(activating).toBe(true);
		expect(await exists(startingLock)).toBe(true);

		expect(await activation).toEqual({
			ready: false,
			message: "sandbox is off: the session is shutting down",
			leftovers: [],
		});
		expect(await exists(startingLock)).toBe(false);
	});

	it("settles containerCommand immediately at quit even when a process outside its group holds stdout", async () => {
		const host = fakeHost(state, {}, { commandTimeoutMs: 3000, shutdownBudgetMs: 100 });
		const holder = `setTimeout(() => {}, 30000)`;
		const script = [
			`const { spawn } = require("child_process");`,
			`const options = { detached: true, stdio: ["ignore", "inherit", "inherit"] };`,
			`console.log(spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], options).pid);`,
			holder,
		].join("\n");
		let holderPid = 0;
		const command = containerCommand(host, ["-e", script], {
			command: process.execPath,
			onLine: (line) => {
				holderPid = Number(line);
			},
		});
		await until(() => holderPid > 0);
		try {
			const started = performance.now();
			await shutdownHost(host, () => false, "quit", warn);
			const outcome = await command;
			expect(performance.now() - started).toBeLessThan(1000);
			expect(outcome).toMatchObject({ code: null, timedOut: false });
			expect(processExists(holderPid)).toBe(true);
			expect(host.children.size).toBe(0);
		} finally {
			if (processExists(holderPid)) process.kill(holderPid, "SIGKILL");
		}
	});

	it("guards warn and shuts down a late runtime when activation finishes after shutdownBudgetMs and context invalidation", async () => {
		const savedArtifactsDir = process.env.POLAR_ARTIFACTS_DIR;
		process.env.POLAR_ARTIFACTS_DIR = artifactsRoot();
		try {
			const locked = await otherSession("locked", process.pid);
			await chmod(join(locked, "lock"), 0o000);
			await state.addContainer("polar-sandbox-locked-1-eeeeeeee", ownLabels("locked"));
			const lateContainer = "polar-sandbox-late-1-aaaaaaaa";

			const host = fakeHost(state, {}, { shutdownBudgetMs: 150 });
			const baseDriver = host.driver;
			let listEntered = false;
			let releaseList: (() => void) | undefined;
			const listGate = new Promise<void>((resolve) => {
				releaseList = resolve;
			});
			const gatedDriver: SandboxDriver = {
				name: baseDriver.name,
				boundaryDescription: baseDriver.boundaryDescription,
				checkRuntime: (deadlineAt) => baseDriver.checkRuntime(deadlineAt),
				inspectImage: (image, deadlineAt) => baseDriver.inspectImage(image, deadlineAt),
				pullImage: (image, signal, onLine) => baseDriver.pullImage(image, signal, onLine),
				buildImage: (image, contextDir, signal, onLine) => baseDriver.buildImage(image, contextDir, signal, onLine),
				listSandboxes: async (artifactsRootPath, deadlineAt) => {
					listEntered = true;
					await listGate;
					return baseDriver.listSandboxes(artifactsRootPath, deadlineAt);
				},
				deleteSandbox: (name, deadlineAt) => baseDriver.deleteSandbox(name, deadlineAt),
				manualDeleteCommand: (names) => baseDriver.manualDeleteCommand(names),
				listWorkVolumes: (sessionPaths, deadlineAt) => baseDriver.listWorkVolumes(sessionPaths, deadlineAt),
				ensureWorkVolume: async () => {
					await state.addContainer(lateContainer, ownLabels("late-session"));
					host.owned.add(lateContainer);
					return undefined;
				},
				deleteWorkVolumes: (volumes, sessionPaths, deadlineAt) =>
					baseDriver.deleteWorkVolumes(volumes, sessionPaths, deadlineAt),
				startSandbox: (name, sessionPaths, deadlineAt, signal) =>
					baseDriver.startSandbox(name, sessionPaths, deadlineAt, signal),
			};
			host.driver = gatedDriver;

			let invalidated = false;
			const uiNotices: string[] = [];
			let registered = 0;
			const ctx = {
				cwd: root,
				hasUI: true,
				mode: "tui",
				ui: {
					notify: (message: string) => {
						if (invalidated) throw new Error("context invalidated");
						uiNotices.push(message);
					},
				},
				sessionManager: { getSessionId: () => "late-session" },
			} as unknown as ExtensionContext;

			const controller = new SandboxController(host, () => {
				if (invalidated) throw new Error("context invalidated");
				registered += 1;
			});
			const starting = controller.start(ctx);
			await until(() => listEntered);
			const lateLock = join(artifactsRoot(), "late-session", "lock");
			expect(await exists(lateLock)).toBe(true);

			await controller.shutdown("reload", ctx);
			invalidated = true;
			releaseList?.();

			await expect(starting).resolves.toBeUndefined();
			expect(registered).toBe(0);
			expect(uiNotices).toEqual([]);
			expect(await exists(lateLock)).toBe(false);
			expect(await state.containers()).toEqual(["polar-sandbox-locked-1-eeeeeeee"]);
		} finally {
			if (savedArtifactsDir === undefined) delete process.env.POLAR_ARTIFACTS_DIR;
			else process.env.POLAR_ARTIFACTS_DIR = savedArtifactsDir;
		}
	});

	it("does not prompt for a missing image after shutdown begins during inspectImage", async () => {
		for (const afterBudget of [true, false]) {
			await rm(state.directory, { recursive: true, force: true });
			state = await fakeState();
			const host = fakeHost(state, { IMAGE_MISSING: "1" }, { shutdownBudgetMs: afterBudget ? 150 : 1000 });
			const baseDriver = host.driver;
			let inspectEntered = false;
			let releaseInspect: (() => void) | undefined;
			const inspectGate = new Promise<void>((resolve) => {
				releaseInspect = resolve;
			});
			host.driver = {
				name: baseDriver.name,
				boundaryDescription: baseDriver.boundaryDescription,
				checkRuntime: (deadlineAt) => baseDriver.checkRuntime(deadlineAt),
				inspectImage: async (image, deadlineAt) => {
					inspectEntered = true;
					await inspectGate;
					return baseDriver.inspectImage(image, deadlineAt);
				},
				pullImage: (image, signal, onLine) => baseDriver.pullImage(image, signal, onLine),
				buildImage: (image, contextDir, signal, onLine) => baseDriver.buildImage(image, contextDir, signal, onLine),
				listSandboxes: (artifactsRootPath, deadlineAt) => baseDriver.listSandboxes(artifactsRootPath, deadlineAt),
				deleteSandbox: (name, deadlineAt) => baseDriver.deleteSandbox(name, deadlineAt),
				manualDeleteCommand: (names) => baseDriver.manualDeleteCommand(names),
				listWorkVolumes: (sessionPaths, deadlineAt) => baseDriver.listWorkVolumes(sessionPaths, deadlineAt),
				ensureWorkVolume: (sessionPaths, deadlineAt) => baseDriver.ensureWorkVolume(sessionPaths, deadlineAt),
				deleteWorkVolumes: (volumes, sessionPaths, deadlineAt) =>
					baseDriver.deleteWorkVolumes(volumes, sessionPaths, deadlineAt),
				startSandbox: (name, sessionPaths, deadlineAt, signal) =>
					baseDriver.startSandbox(name, sessionPaths, deadlineAt, signal),
			};

			let invalidated = false;
			const uiNotices: string[] = [];
			let selectCalls = 0;
			const ui = {
				notify: (message: string) => {
					uiNotices.push(message);
				},
				select: async () => {
					selectCalls += 1;
					return undefined;
				},
			};
			const ctx = {
				cwd: root,
				hasUI: true,
				mode: "tui",
				get ui() {
					if (invalidated) throw new Error("context invalidated");
					return ui;
				},
				sessionManager: { getSessionId: () => "inspect-shutdown" },
			} as unknown as ExtensionContext;

			const controller = new SandboxController(host, () => {});
			const selectImage =
				ctx.hasUI && typeof ctx.ui.select === "function"
					? (title: string, options: string[]) => ctx.ui.select(title, options)
					: undefined;
			const starting = controller.start(ctx, selectImage);
			await until(() => inspectEntered);

			if (afterBudget) {
				await controller.shutdown("reload", ctx);
				invalidated = true;
				releaseInspect?.();
			} else {
				const shuttingDown = controller.shutdown("reload", ctx);
				releaseInspect?.();
				await shuttingDown;
			}

			await expect(starting).resolves.toBeUndefined();
			expect(selectCalls).toBe(0);
			expect(uiNotices).toEqual([]);
			expect(await callsOf("image")).toEqual([["image", "inspect", "polar-sandbox:test"]]);
		}
	});

	it("cleans up a late runtime once and warns with the real reason while session_shutdown is running", async () => {
		const savedArtifactsDir = process.env.POLAR_ARTIFACTS_DIR;
		process.env.POLAR_ARTIFACTS_DIR = artifactsRoot();
		try {
			const cases: { reason: "quit" | "reload"; afterBudget: boolean; sessionId: string }[] = [
				{ reason: "quit", afterBudget: false, sessionId: "late-delete-quit" },
				{ reason: "reload", afterBudget: false, sessionId: "late-delete-reload" },
				{ reason: "reload", afterBudget: true, sessionId: "late-delete-expired" },
			];
			for (const { reason, afterBudget, sessionId } of cases) {
				await rm(state.directory, { recursive: true, force: true });
				state = await fakeState();
				const lateContainer = `polar-prep-${sessionId}-aaaaaaaa`;
				const host = fakeHost(state, { DELETE_FAIL: "1" }, { shutdownBudgetMs: afterBudget ? 150 : 1000 });
				const baseDriver = host.driver;
				let listEntered = false;
				let releaseList: (() => void) | undefined;
				const listGate = new Promise<void>((resolve) => {
					releaseList = resolve;
				});
				host.driver = {
					name: baseDriver.name,
					boundaryDescription: baseDriver.boundaryDescription,
					checkRuntime: (deadlineAt) => baseDriver.checkRuntime(deadlineAt),
					inspectImage: (image, deadlineAt) => baseDriver.inspectImage(image, deadlineAt),
					pullImage: (image, signal, onLine) => baseDriver.pullImage(image, signal, onLine),
					buildImage: (image, contextDir, signal, onLine) =>
						baseDriver.buildImage(image, contextDir, signal, onLine),
					listSandboxes: async (artifactsRootPath, deadlineAt) => {
						listEntered = true;
						await listGate;
						return baseDriver.listSandboxes(artifactsRootPath, deadlineAt);
					},
					deleteSandbox: (name, deadlineAt) => baseDriver.deleteSandbox(name, deadlineAt),
					manualDeleteCommand: (names) => baseDriver.manualDeleteCommand(names),
					listWorkVolumes: (sessionPaths, deadlineAt) => baseDriver.listWorkVolumes(sessionPaths, deadlineAt),
					ensureWorkVolume: async () => {
						await state.addContainer(lateContainer, ownLabels(sessionId));
						host.owned.add(lateContainer);
						return undefined;
					},
					deleteWorkVolumes: (volumes, sessionPaths, deadlineAt) =>
						baseDriver.deleteWorkVolumes(volumes, sessionPaths, deadlineAt),
					startSandbox: (name, sessionPaths, deadlineAt, signal) =>
						baseDriver.startSandbox(name, sessionPaths, deadlineAt, signal),
				};

				let invalidated = false;
				const uiNotices: string[] = [];
				const ui = {
					notify: (message: string) => {
						if (invalidated) throw new Error("context invalidated");
						uiNotices.push(message);
					},
				};
				const ctx = {
					cwd: root,
					hasUI: true,
					mode: "tui",
					get ui() {
						if (invalidated) throw new Error("context invalidated");
						return ui;
					},
					sessionManager: { getSessionId: () => sessionId },
				} as unknown as ExtensionContext;

				const controller = new SandboxController(host, () => {
					if (invalidated) throw new Error("context invalidated");
				});
				const starting = controller.start(ctx);
				await until(() => listEntered);
				const lateLock = join(artifactsRoot(), sessionId, "lock");
				expect(await exists(lateLock)).toBe(true);

				if (afterBudget) {
					await controller.shutdown(reason, ctx);
					invalidated = true;
					releaseList?.();
				} else {
					const shuttingDown = controller.shutdown(reason, ctx);
					releaseList?.();
					await shuttingDown;
				}

				await expect(starting).resolves.toBeUndefined();
				expect(await exists(lateLock)).toBe(false);
				expect(await callsOf("delete")).toEqual([["delete", "--force", lateContainer]]);
				if (afterBudget) {
					expect(uiNotices).toEqual([]);
				} else {
					expect(uiNotices).toEqual([
						`sandbox: ${lateContainer} (delete: Error: runtime temporarily unavailable; still listed) could not be deleted at shutdown`,
					]);
					expect(uiNotices.join("\n")).not.toContain("sandbox is stopping");
				}
			}
		} finally {
			if (savedArtifactsDir === undefined) delete process.env.POLAR_ARTIFACTS_DIR;
			else process.env.POLAR_ARTIFACTS_DIR = savedArtifactsDir;
		}
	});
});
