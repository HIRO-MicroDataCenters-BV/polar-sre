import { spawnSync } from "child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSandboxImageDir } from "../../../config.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { containerCommand } from "../src/cli.ts";
import { admitCall } from "../src/runner.ts";
import type { SandboxRuntime, SessionPaths } from "../src/types.ts";
import {
	BUILD_IMAGE_OPTION,
	checkReadiness,
	closeAdmission,
	DISABLE_SANDBOX_OPTION,
	DOWNLOAD_IMAGE_OPTION,
	ensureWorkVolume,
	recoverLeftovers,
	shutdownRuntime,
	startRuntime,
} from "../src/workspace.ts";
import { type FakeState, fakeRuntime, fakeState, startingRuntime, until } from "./fixtures.ts";

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
	return [...runtime.children].filter(([, kind]) => kind === "run").map(([child]) => child);
}

describe("start", () => {
	it("offers run_code only with a running runtime and the image", async () => {
		expect(await checkReadiness(fakeRuntime(state, handle))).toEqual({ ready: true });
		expect(await checkReadiness(fakeRuntime(state, handle, { STATUS_EXIT: "1" }))).toEqual({
			ready: false,
			message: "sandbox is off: container system status failed: exit 1",
			leftovers: [],
		});
		expect(await checkReadiness(fakeRuntime(state, handle, { IMAGE_MISSING: "1" }))).toEqual({
			ready: false,
			message:
				"sandbox is off: image polar-sandbox:test is not installed (container image inspect polar-sandbox:test failed: Error: image polar-sandbox:test not found)",
			leftovers: [],
		});
	});

	it("checks custom --sandbox-image first, else registryImage then local default tag, and prompts only when UI is present", async () => {
		const registry = "registry.example/polar-sandbox@sha256:deadbeef";
		const local = "polar-sandbox:0.2";

		// 1. Explicit custom image is checked alone even if registryImage is set
		const custom = startingRuntime(state, handle, { IMAGE_PRESENT: "custom:1" });
		custom.image = "custom:1";
		custom.registryImage = registry;
		custom.customImage = true;
		expect(await checkReadiness(custom)).toEqual({ ready: true });
		expect(custom.image).toBe("custom:1");
		expect(await callsOf("image")).toEqual([["image", "inspect", "custom:1"]]);

		// 2. Default image with registryImage present in cache uses registryImage without checking local tag
		state = await fakeState();
		const cachedRegistry = startingRuntime(state, handle, { IMAGE_PRESENT: registry });
		cachedRegistry.image = local;
		cachedRegistry.registryImage = registry;
		cachedRegistry.customImage = false;
		expect(await checkReadiness(cachedRegistry)).toEqual({ ready: true });
		expect(cachedRegistry.image).toBe(registry);
		expect(await callsOf("image")).toEqual([["image", "inspect", registry]]);

		// 3. Default image with registryImage absent falls back to local tag in cache without prompting
		state = await fakeState();
		const cachedLocal = startingRuntime(state, handle, { IMAGE_PRESENT: local });
		cachedLocal.image = local;
		cachedLocal.registryImage = registry;
		cachedLocal.customImage = false;
		let prompted = false;
		expect(
			await checkReadiness(cachedLocal, async () => {
				prompted = true;
				return undefined;
			}),
		).toEqual({ ready: true });
		expect(prompted).toBe(false);
		expect(cachedLocal.image).toBe(local);
		expect(await callsOf("image")).toEqual([
			["image", "inspect", registry],
			["image", "inspect", local],
		]);

		// 4. Missing image with UI and no registryImage offers Build and Disable (no Download)
		state = await fakeState();
		const buildRuntime = startingRuntime(state, handle, { IMAGE_MISSING: "1" });
		buildRuntime.image = local;
		buildRuntime.customImage = false;
		let seenOptions: string[] = [];
		expect(
			await checkReadiness(buildRuntime, async (_title, options) => {
				seenOptions = options;
				return BUILD_IMAGE_OPTION;
			}),
		).toEqual({ ready: true });
		expect(seenOptions).toEqual([BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]);
		const imageDir = getSandboxImageDir();
		expect(await callsOf("build")).toEqual([
			["build", "--arch", "arm64", "--tag", local, "--file", join(imageDir, "Containerfile"), imageDir],
		]);

		// 5. Missing image with UI and registryImage offers Download, Build, and Disable
		state = await fakeState();
		const pullRuntime = startingRuntime(state, handle, { IMAGE_MISSING: "1" });
		pullRuntime.image = local;
		pullRuntime.registryImage = registry;
		pullRuntime.customImage = false;
		expect(
			await checkReadiness(pullRuntime, async (_title, options) => {
				seenOptions = options;
				return DOWNLOAD_IMAGE_OPTION;
			}),
		).toEqual({ ready: true });
		expect(seenOptions).toEqual([DOWNLOAD_IMAGE_OPTION, BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]);
		expect(pullRuntime.image).toBe(registry);
		expect((await callsOf("image")).at(-1)).toEqual(["image", "pull", "--arch", "arm64", registry]);

		// 5a. Forwards pull output lines to showOperation and calls end()
		state = await fakeState();
		const shownRuntime = startingRuntime(state, handle, { IMAGE_MISSING: "1" });
		shownRuntime.image = local;
		shownRuntime.registryImage = registry;
		shownRuntime.customImage = false;
		const shown: string[] = [];
		expect(
			await checkReadiness(
				shownRuntime,
				async () => DOWNLOAD_IMAGE_OPTION,
				(kind) => {
					shown.push(`start ${kind}`);
					return { output: (line) => shown.push(line), end: () => shown.push("end") };
				},
			),
		).toEqual({ ready: true });
		expect(shown).toEqual(["start download", `pulled ${registry}`, "end"]);

		// 6. Selecting Disable turns off sandbox
		state = await fakeState();
		const disabled = startingRuntime(state, handle, { IMAGE_MISSING: "1" });
		disabled.image = local;
		disabled.customImage = false;
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
			const runtime = startingRuntime(state, handle, { [knob]: value });
			expect(await startRuntime(runtime, warn), `${knob}=${value}`).toEqual({
				ready: false,
				message: `sandbox is off: runtime state could not be established: ${said}`,
				leftovers: [],
			});
			expect(runtime.state).toBe("unready");
			expect(runtime.owned.size).toBe(0);
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

		const runtime = startingRuntime(state, handle, { VOLUME_IN_USE: "polar-work-busy" });
		expect(await recoverLeftovers(runtime, warn)).toEqual({ clean: true });

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
		expect(runtime.owned.size).toBe(0);
	});

	it("refuses a volume with a foreign or missing root label", async () => {
		const cases: [Record<string, string>, string][] = [
			[ownLabels("current", "/elsewhere"), "/elsewhere"],
			[{}, "missing"],
		];
		for (const [labels, actual] of cases) {
			await state.addVolume("polar-work-current", labels);
			const runtime = startingRuntime(state, handle);
			expect(await startRuntime(runtime, warn)).toEqual({
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
		const runtime = startingRuntime(state, handle);
		expect(await ensureWorkVolume(runtime)).toBeUndefined();
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
		expect(runtime.owned.size).toBe(0);

		expect(await ensureWorkVolume(runtime)).toBeUndefined();
		expect(await volumeCalls("create")).toHaveLength(1);
		expect(await callsOf("run")).toHaveLength(2);
	});

	it("recovers from an interrupted preparation", async () => {
		const broken = startingRuntime(state, handle, { CHOWN_EXIT: "1", VOLUME_IN_USE: "polar-work-current" });
		expect(await ensureWorkVolume(broken)).toEqual({ reason: "the /work volume could not be prepared: exit 1" });
		expect(await state.volumes()).toHaveLength(1);
		expect(await state.containers()).toEqual([]);

		expect(await ensureWorkVolume(startingRuntime(state, handle))).toBeUndefined();
		expect(await state.volumes()).toHaveLength(1);
		expect(await volumeCalls("create")).toHaveLength(1);
		expect(await callsOf("run")).toHaveLength(2);

		await rm(join(state.directory, "volumes"), { recursive: true, force: true });
		expect(await ensureWorkVolume(startingRuntime(state, handle, { CHOWN_EXIT: "1" }))).toEqual({
			reason: "the /work volume could not be prepared: exit 1",
		});
		expect(await state.volumes()).toEqual([]);
		expect(await ensureWorkVolume(startingRuntime(state, handle, { VOLUME_CREATE_EXIT: "2" }))).toEqual({
			reason: "the /work volume could not be created: Error: volume create failed",
		});
	});

	it("does not inspect past an unknown volume answer", async () => {
		const answers: [Record<string, string>, string][] = [
			[{ VOLUME_INSPECT_EXIT: "2" }, "Error: volume inspect failed"],
			[{ VOLUME_INSPECT_GARBAGE: "1" }, "unreadable answer"],
		];
		for (const [knobs, said] of answers) {
			const runtime = startingRuntime(state, handle, knobs);
			expect(await startRuntime(runtime, warn)).toEqual({
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

	it("keeps a leftover owned and offers no tool when it cannot be deleted at start", async () => {
		await state.addContainer("polar-sandbox-current-2-ffffffff", ownLabels("current"));
		const runtime = startingRuntime(state, handle, { DELETE_FAIL: "1" });

		expect(await startRuntime(runtime, warn)).toEqual({
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
		expect(runtime.owned).toEqual(new Set(["polar-sandbox-current-2-ffffffff"]));
		expect(runtime.state).toBe("unready");
		expect(await volumeCalls("inspect")).toEqual([]);
	});

	it("reports the preparation failure and the container that stayed together", async () => {
		const cases: [Record<string, string>, string][] = [
			[{ CHOWN_EXIT: "1", DELETE_FAIL: "1" }, "the /work volume could not be prepared: exit 1"],
			[{ DELETE_FAIL: "1" }, "leftovers of sandbox stayed"],
		];
		for (const [knobs, reason] of cases) {
			await rm(join(state.directory, "containers"), { recursive: true, force: true });
			await rm(join(state.directory, "volumes"), { recursive: true, force: true });
			const runtime = startingRuntime(state, handle, knobs);
			const readiness = await startRuntime(runtime, warn);
			const [prep] = await state.containers();
			expect(prep, reason).toMatch(/^polar-prep-current-[0-9a-f]{8}$/);
			const cleanup = "delete: Error: runtime temporarily unavailable; still listed";
			expect(readiness, reason).toEqual({
				ready: false,
				message: `sandbox is off: ${reason}; ${prep} (${cleanup}) could not be deleted; delete them with: container delete --force ${prep}`,
				leftovers: [{ container: prep, message: cleanup }],
			});
			expect(runtime.owned, reason).toEqual(new Set([prep]));
			expect(runtime.state, reason).toBe("unready");
		}
		expect(notices).toEqual([]);
	});

	it("creates nothing once shutdown began during the start", async () => {
		const missing = startingRuntime(state, handle);
		closeAdmission(missing);
		expect(await ensureWorkVolume(missing)).toEqual({ reason: "the session is shutting down" });
		await state.addVolume("polar-work-current", ownLabels("current"));
		const existing = startingRuntime(state, handle);
		closeAdmission(existing);
		expect(await ensureWorkVolume(existing)).toEqual({ reason: "the session is shutting down" });
		expect(await volumeCalls("create")).toEqual([]);
		expect(await callsOf("run")).toEqual([]);
		expect(existing.owned.size).toBe(0);
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
		for (const child of children) expect(child.killed).toBe(true);
		expect(runtime.state).toBe("closing");
		expect(runtime.inFlight).toEqual(new Set(["call-1"]));
		expect(await exists(lockOf(session))).toBe(true);

		const result = await finished;
		expect(result.status).toBe("cancelled");
		for (const child of children) expect(child.signalCode).toBe("SIGKILL");
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

	it("stops every CLI at quit", async () => {
		const runtime = fakeRuntime(
			state,
			handle,
			{ RUN_IGNORES_KILL: "1", DELETE_HANG: "1" },
			{ killGraceMs: 5000, shutdownBudgetMs: 300, commandTimeoutMs: 10_000 },
		);
		const finished = startCall(runtime, "hang");
		await until(() => runtime.running.size === 1);
		const hanging = containerCommand(runtime, ["delete", "--force", "polar-sandbox-current-9-99999999"]);
		await until(async () => (await callsOf("delete")).length === 1);
		const before = [...runtime.children];
		expect(new Set(before.map(([, kind]) => kind))).toEqual(new Set(["run", "service"]));

		const started = performance.now();
		await shutdownRuntime(runtime, "quit", warn);

		expect(performance.now() - started).toBeLessThan(1500);
		expect(notices).toEqual(["sandbox: 1 program(s) still stopping"]);
		expect(runtime.cliStopped).toBe(true);
		for (const [child] of [...before, ...runtime.children]) expect(child.killed).toBe(true);
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
		expect(result.status).toBe("cancelled");
		expect(result.cleanupError?.message).toBe(
			"delete: sandbox is stopping; no command starts; list: sandbox is stopping; no command starts",
		);
		expect(runtime.state).toBe("closed");
	});

	it("releases the handle when nothing is in flight", async () => {
		const open = fakeRuntime(state, handle);
		const started = performance.now();
		await shutdownRuntime(open, "reload", warn);
		expect(performance.now() - started).toBeLessThan(500);
		expect(open.state).toBe("closed");
		expect(await exists(lockOf(session))).toBe(false);

		const offHandle = await acquireSession("off", root, artifactsRoot());
		const off = startingRuntime(state, offHandle, { STATUS_EXIT: "1" });
		expect((await startRuntime(off, warn)).ready).toBe(false);
		expect(await exists(lockOf(offHandle.paths))).toBe(true);
		await shutdownRuntime(off, "new", warn);
		expect(off.state).toBe("closed");
		expect(await exists(lockOf(offHandle.paths))).toBe(false);
		expect(notices).toEqual([]);
	});

	it("returns at the budget during a hanging start and releases the handle when the start ends", async () => {
		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", ownLabels("current"));
		const runtime = startingRuntime(state, handle, { DELETE_DELAY_MS: "700" }, { shutdownBudgetMs: 200 });
		const starting = startRuntime(runtime, warn);
		await until(async () => (await callsOf("delete")).length === 1);

		const started = performance.now();
		await shutdownRuntime(runtime, "reload", warn);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(180);
		expect(notices).toEqual([]);
		expect(runtime.state).toBe("closing");
		expect(runtime.starting).toBeDefined();
		expect(await exists(lockOf(session))).toBe(true);

		const readiness = await starting;
		expect(readiness).toEqual({
			ready: false,
			message: "sandbox is off: the session is shutting down",
			leftovers: [],
		});
		expect(runtime.starting).toBeUndefined();
		expect(runtime.state).toBe("closed");
		expect(await exists(lockOf(session))).toBe(false);
	});
});
