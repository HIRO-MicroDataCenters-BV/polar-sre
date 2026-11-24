import { spawnSync } from "child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSandboxImageDir } from "../../../config.ts";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { createHost, DEFAULT_IMAGE, REGISTRY_IMAGE } from "../index.ts";
import { containerCommand } from "../src/cli.ts";
import { SandboxController } from "../src/controller.ts";
import {
	BUILD_IMAGE_OPTION,
	DOWNLOAD_IMAGE_OPTION,
	IMAGE_BUILD_OUTLOOK,
	IMAGE_DOWNLOAD_OUTLOOK,
} from "../src/driver.ts";
import { buildImageSpec, probeHost } from "../src/host.ts";
import { admitCall } from "../src/runner.ts";
import type { SandboxDriver, SandboxRuntime, SessionPaths } from "../src/types.ts";
import {
	activateRuntime,
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
let savedAgentDir: string | undefined;
let handle: SessionHandle;
let session: SessionPaths;
let state: FakeState;
let notices: string[];
const warn = (message: string) => notices.push(message);

beforeEach(async () => {
	savedAgentDir = process.env.POLAR_CODING_AGENT_DIR;
	root = await mkdtemp(join(tmpdir(), "sandbox-workspace-"));
	process.env.POLAR_CODING_AGENT_DIR = join(root, "agent");
	handle = await acquireSession("current", root, artifactsRoot());
	session = handle.paths;
	state = await fakeState();
	notices = [];
});

afterEach(async () => {
	await handle.release();
	if (savedAgentDir === undefined) delete process.env.POLAR_CODING_AGENT_DIR;
	else process.env.POLAR_CODING_AGENT_DIR = savedAgentDir;
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
	it("diagnoses Apple container observations across all 5 table rows and version cases", async () => {
		const writeScript = async (name: string, body: string): Promise<string> => {
			const scriptPath = join(root, name);
			await writeFile(scriptPath, `#!/bin/sh\n${body}\n`);
			await chmod(scriptPath, 0o755);
			return scriptPath;
		};
		const arm64Sysctl = await writeScript("sysctl-arm64", "echo 1");
		const intelSysctl = await writeScript("sysctl-intel", "echo 0");
		const macos26SwVers = await writeScript("sw_vers-26", "echo 26.5.1");
		const macos15SwVers = await writeScript("sw_vers-15", "echo 15.4");

		// Row 1: ENOENT -> runtime_missing with install_runtime on Apple silicon + macOS >= 26, manual instructions on older macOS, unsupported on Intel
		const missingBinHost = fakeHost(state, {}, {}, undefined, {
			sysctlPath: arm64Sysctl,
			swVersPath: macos26SwVers,
		});
		missingBinHost.containerCommand = join(root, "nonexistent-container-bin");
		const missingDiag = await probeHost(missingBinHost);
		expect(missingDiag).toMatchObject({
			kind: "runtime_missing",
			reason: "Apple container is not installed",
			remedy: {
				kind: "actions",
				outlook: [
					"Download and install Apple container 1.7.1 — 170 MB, signed by Apple. Asks for your macOS password.",
					"Start the container service — the first start downloads a Linux kernel, about 680 MB.",
					IMAGE_BUILD_OUTLOOK,
				],
			},
		});
		if (missingDiag.kind !== "runtime_missing" || missingDiag.remedy.kind !== "actions") {
			throw new Error("expected install_runtime action");
		}
		expect(missingDiag.remedy.actions).toHaveLength(1);
		expect(missingDiag.remedy.actions[0].id).toBe("install_runtime");
		expect(missingDiag.remedy.actions[0].label).toBe("Install and set up");
		expect(missingDiag.remedy.actions[0].title).toBe("Installing Apple container 1.7.1");
		expect(missingDiag.remedy.actions[0].mode).toBe("foreground");
		expect(missingDiag.remedy.actions[0].preview).toEqual([
			"curl -fLo container-1.7.1-installer-signed.pkg https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg",
			"sudo installer -pkg container-1.7.1-installer-signed.pkg -target /",
			"container system start --enable-kernel-install",
		]);

		const oldMacHost = fakeHost(state, {}, {}, undefined, {
			sysctlPath: arm64Sysctl,
			swVersPath: macos15SwVers,
		});
		oldMacHost.containerCommand = join(root, "nonexistent-container-bin");
		expect(await probeHost(oldMacHost)).toEqual({
			kind: "runtime_missing",
			reason: "Apple container is not installed",
			remedy: {
				kind: "manual",
				instructions: [
					"Automatic installation requires macOS 26 or later (found 15.4)",
					"Install Apple container (>= 1.5.0) from https://github.com/apple/container/releases",
					"container system start --enable-kernel-install",
				],
			},
		});

		const intelHost = fakeHost(state, {}, {}, undefined, {
			sysctlPath: intelSysctl,
			swVersPath: macos26SwVers,
		});
		intelHost.containerCommand = join(root, "nonexistent-container-bin");
		expect(await probeHost(intelHost)).toEqual({
			kind: "unsupported",
			reason: "Apple container requires Apple silicon (arm64)",
		});

		// Installed and running container is accepted regardless of macOS version
		const runningOnOldMac = fakeHost(state, {}, {}, undefined, {
			sysctlPath: arm64Sysctl,
			swVersPath: macos15SwVers,
		});
		expect(await probeHost(runningOnOldMac)).toMatchObject({
			kind: "ready",
			image: "polar-sandbox:test",
			version: "1.7.1",
		});

		// Row 2: exit != 0, status is "unregistered" or "not running", container --version >= 1.5.0 -> runtime_not_ready with start_service (including runQuick)
		for (const knobs of [{ SERVICE_STOPPED: "1" }, { SERVICE_STATUS: "not running", STATUS_EXIT: "1" }] as Record<
			string,
			string
		>[]) {
			const stoppedDiag = await probeHost(fakeHost(state, knobs));
			expect(stoppedDiag).toMatchObject({
				kind: "runtime_not_ready",
				reason: "Apple container service is not running",
				remedy: {
					kind: "actions",
					outlook: [
						"Start the container service — the first start downloads a Linux kernel, about 680 MB.",
						IMAGE_BUILD_OUTLOOK,
					],
				},
			});
			if (stoppedDiag.kind !== "runtime_not_ready" || stoppedDiag.remedy.kind !== "actions") {
				throw new Error("expected start_service action");
			}
			expect(stoppedDiag.remedy.actions).toHaveLength(1);
			const [startAction] = stoppedDiag.remedy.actions;
			expect(startAction.id).toBe("start_service");
			expect(startAction.label).toBe("Start container service");
			expect(startAction.preview).toEqual(["container system start --enable-kernel-install"]);
			expect(startAction.mode).toBe("background");
			expect(startAction.runQuick).toBeDefined();
		}

		const startState = await fakeState();
		try {
			const pullSpec = {
				candidates: ["registry.example/polar-sandbox:test", "polar-sandbox:test"],
				pull: "registry.example/polar-sandbox:test",
				build: "polar-sandbox:test",
			};
			const startDiag = await probeHost(
				fakeHost(startState, { SERVICE_STOPPED: "1", KERNEL_MISSING: "1" }, {}, pullSpec),
			);
			if (startDiag.kind !== "runtime_not_ready" || startDiag.remedy.kind !== "actions") {
				throw new Error("expected start_service action");
			}
			expect(startDiag.remedy.outlook).toEqual([
				"Start the container service — the first start downloads a Linux kernel, about 680 MB.",
				IMAGE_DOWNLOAD_OUTLOOK,
			]);
			const serviceLines: string[] = [];
			const startResult = await startDiag.remedy.actions[0].run({
				signal: new AbortController().signal,
				onLine: (line) => serviceLines.push(line),
			});
			expect(startResult).toEqual({ ok: true });
			expect(serviceLines).toEqual([
				"Launching container-apiserver...",
				"Testing access to container-apiserver...",
				"Verifying machine API server is running...",
				"Installing kernel...",
			]);
			expect((await startState.calls()).at(-1)).toEqual(["system", "start", "--enable-kernel-install"]);
		} finally {
			await rm(startState.directory, { recursive: true, force: true });
		}

		// Row 3: running, client and server version >= 1.5.0 -> ready with version (including client/server mismatch) and repair (start_service without runQuick)
		const readyDiag = await probeHost(fakeHost(state));
		expect(readyDiag).toMatchObject({
			kind: "ready",
			image: "polar-sandbox:test",
			version: "1.7.1",
			repair: {
				kind: "actions",
				outlook: ["Start the container service — the first start downloads a Linux kernel, about 680 MB."],
			},
		});
		if (readyDiag.kind !== "ready" || readyDiag.repair?.kind !== "actions") {
			throw new Error("expected repair action on ready Apple diagnosis");
		}
		expect(readyDiag.repair.actions).toHaveLength(1);
		expect(readyDiag.repair.actions[0].id).toBe("start_service");
		expect(readyDiag.repair.actions[0].label).toBe("Start container service");
		expect(readyDiag.repair.actions[0].preview).toEqual(["container system start --enable-kernel-install"]);
		expect(readyDiag.repair.actions[0].mode).toBe("background");
		expect(readyDiag.repair.actions[0].runQuick).toBeUndefined();

		const mismatchDiag = await probeHost(fakeHost(state, { CLIENT_VERSION: "1.7.1", SERVER_VERSION: "1.5.0" }));
		expect(mismatchDiag).toMatchObject({
			kind: "ready",
			image: "polar-sandbox:test",
			version: "1.7.1 (service 1.5.0)",
			repair: {
				kind: "actions",
				outlook: ["Start the container service — the first start downloads a Linux kernel, about 680 MB."],
			},
		});

		// Row 4: client or server version < 1.5.0 (including unreadable JSON when container --version < 1.5.0)
		const outdatedUpdateInstructions = [
			"Update Apple container to >= 1.5.0 from https://github.com/apple/container/releases",
			"container system stop && container system start --enable-kernel-install",
		];
		expect(await probeHost(fakeHost(state, { CLIENT_VERSION: "1.4.2", SERVER_VERSION: "1.4.2" }))).toEqual({
			kind: "runtime_not_ready",
			reason: "Apple container >= 1.5.0 is required (found 1.4.2)",
			remedy: { kind: "manual", instructions: outdatedUpdateInstructions },
		});
		expect(await probeHost(fakeHost(state, { CLIENT_VERSION: "1.7.1", SERVER_VERSION: "1.4.2" }))).toEqual({
			kind: "runtime_not_ready",
			reason: "Apple container >= 1.5.0 is required (client 1.7.1, service 1.4.2)",
			remedy: { kind: "manual", instructions: outdatedUpdateInstructions },
		});
		expect(await probeHost(fakeHost(state, { STATUS_GARBAGE: "1", CLIENT_VERSION: "1.4.2" }))).toEqual({
			kind: "runtime_not_ready",
			reason: "Apple container >= 1.5.0 is required (found 1.4.2)",
			remedy: { kind: "manual", instructions: outdatedUpdateInstructions },
		});
		expect(await probeHost(fakeHost(state, { SERVICE_STOPPED: "1", CLIENT_VERSION: "1.4.2" }))).toEqual({
			kind: "runtime_not_ready",
			reason: "Apple container >= 1.5.0 is required (found 1.4.2)",
			remedy: { kind: "manual", instructions: outdatedUpdateInstructions },
		});

		// Row 5: timeout, unknown status, or unreadable JSON when CLI >= 1.5.0 (or error of container --version)
		expect(await probeHost(fakeHost(state, { STATUS_HANG: "1" }, { commandTimeoutMs: 100 }))).toEqual({
			kind: "probe_failed",
			reason: "container system status failed: timed out",
		});
		expect(await probeHost(fakeHost(state, { SERVICE_STATUS: "degraded" }))).toEqual({
			kind: "probe_failed",
			reason: 'container system status reported unknown status "degraded"',
		});
		expect(await probeHost(fakeHost(state, { STATUS_GARBAGE: "1", CLIENT_VERSION: "1.7.1" }))).toEqual({
			kind: "probe_failed",
			reason: "container system status returned unreadable JSON",
		});
		expect(await probeHost(fakeHost(state, { STATUS_GARBAGE: "1", VERSION_FAIL: "1" }))).toEqual({
			kind: "probe_failed",
			reason: "container system status returned unreadable JSON",
		});
		expect(await probeHost(fakeHost(state, { SERVICE_STOPPED: "1", VERSION_FAIL: "1" }))).toEqual({
			kind: "probe_failed",
			reason: "container --version failed: Error: version failed",
		});
		expect(
			await probeHost(fakeHost(state, { SERVICE_STOPPED: "1", VERSION_STDOUT: "container CLI (no semver)" })),
		).toEqual({
			kind: "probe_failed",
			reason: "container --version returned an unreadable version",
		});
		expect(
			await probeHost(
				fakeHost(state, {
					STATUS_JSON: JSON.stringify({ status: "running", client: { version: "1.7.1" } }),
				}),
			),
		).toEqual({
			kind: "probe_failed",
			reason: "container system status returned missing version fields",
		});
		expect(
			await probeHost(
				fakeHost(state, {
					STATUS_JSON: JSON.stringify({
						status: "running",
						client: { version: "main-abc" },
						server: { version: "1.7.1" },
					}),
				}),
			),
		).toEqual({
			kind: "probe_failed",
			reason: 'container system status returned an unreadable version "main-abc"',
		});
		expect(
			await probeHost(
				fakeHost(state, {
					STATUS_JSON: JSON.stringify({
						status: "running",
						client: { version: "1.7.1" },
						server: { version: "dev-snapshot" },
					}),
				}),
			),
		).toEqual({
			kind: "probe_failed",
			reason: 'container system status returned an unreadable version "dev-snapshot"',
		});
		expect(await probeHost(fakeHost(state, { STATUS_EXIT: "1" }))).toEqual({
			kind: "probe_failed",
			reason: "container system status failed: Error: exit 1",
		});
	});

	it("resolves image candidates and remedies across all 4 flag combinations and without a registry image", async () => {
		const registry = "registry.example/polar-sandbox@sha256:deadbeef";
		const custom = "custom.example/polar-sandbox:1.0";
		const local = DEFAULT_IMAGE;
		const imageDir = getSandboxImageDir();
		const hostFor = (image: string, knobs: Record<string, string>, options = {}) => {
			const h = createHost(image, fakeEnvironment(state, knobs), { driver: "apple-container", ...options });
			h.containerCommand = FAKE_CONTAINER;
			h.limits = { ...testLimits };
			return h;
		};

		// 1. No flags: searches REGISTRY_IMAGE then polar-sandbox:0.2, pulls REGISTRY_IMAGE, builds polar-sandbox:0.2
		const row1 = hostFor(local, { IMAGE_PRESENT: local });
		expect(row1.imageSpec).toEqual({ candidates: [REGISTRY_IMAGE, local], pull: REGISTRY_IMAGE, build: local });
		expect(await probeHost(row1)).toMatchObject({ kind: "ready", image: local, version: "1.7.1" });
		expect(await callsOf("image")).toEqual([
			["image", "inspect", REGISTRY_IMAGE as string],
			["image", "inspect", local],
		]);

		// 2. --sandbox-registry-image R: searches R then polar-sandbox:0.2, pulls R, builds polar-sandbox:0.2
		state = await fakeState();
		const row2 = hostFor(local, { IMAGE_PRESENT: registry }, { registryImage: registry });
		expect(row2.imageSpec).toEqual({ candidates: [registry, local], pull: registry, build: local });
		expect(await probeHost(row2)).toMatchObject({ kind: "ready", image: registry, version: "1.7.1" });
		expect(await callsOf("image")).toEqual([["image", "inspect", registry]]);

		// 3. --sandbox-image C: searches C, pulls C (does NOT pull built-in REGISTRY_IMAGE), builds C
		state = await fakeState();
		const row3 = hostFor(custom, { IMAGE_MISSING: "1" }, { customImage: true });
		expect(row3.imageSpec).toEqual({ candidates: [custom], pull: custom, build: custom });
		const diag3 = await probeHost(row3);
		expect(diag3.kind).toBe("image_missing");
		if (diag3.kind !== "image_missing" || diag3.remedy.kind !== "actions") throw new Error("expected image actions");
		expect(diag3.remedy.actions.map((a) => [a.id, a.label, a.preview])).toEqual([
			["pull_image", DOWNLOAD_IMAGE_OPTION, [`container image pull --arch arm64 ${custom}`]],
			[
				"build_image",
				BUILD_IMAGE_OPTION,
				[`container build --arch arm64 --tag ${custom} --file ${join(imageDir, "Containerfile")} ${imageDir}`],
			],
		]);
		const shownLines: string[] = [];
		const pullResult3 = await diag3.remedy.actions[0].run({
			signal: new AbortController().signal,
			onLine: (line) => shownLines.push(line),
		});
		expect(pullResult3).toEqual({ ok: true });
		expect(shownLines).toEqual([`pulled ${custom}`]);
		expect((await callsOf("image")).at(-1)).toEqual(["image", "pull", "--arch", "arm64", custom]);
		expect(await probeHost(row3)).toMatchObject({ kind: "ready", image: custom, version: "1.7.1" });

		// 4. Both flags (--sandbox-image C and --sandbox-registry-image R): searches R then C, pulls R, builds C
		state = await fakeState();
		const row4 = hostFor(custom, { IMAGE_MISSING: "1" }, { customImage: true, registryImage: registry });
		expect(row4.imageSpec).toEqual({ candidates: [registry, custom], pull: registry, build: custom });
		const diag4 = await probeHost(row4);
		expect(diag4.kind).toBe("image_missing");
		if (diag4.kind !== "image_missing" || diag4.remedy.kind !== "actions") throw new Error("expected image actions");
		expect(diag4.remedy.actions.map((a) => [a.id, a.preview])).toEqual([
			["pull_image", [`container image pull --arch arm64 ${registry}`]],
			[
				"build_image",
				[`container build --arch arm64 --tag ${custom} --file ${join(imageDir, "Containerfile")} ${imageDir}`],
			],
		]);
		expect(await diag4.remedy.actions[0].run({ signal: new AbortController().signal })).toEqual({ ok: true });
		// After pulling R, probing row4 finds R in candidates [R, C]
		expect(await probeHost(row4)).toMatchObject({ kind: "ready", image: registry, version: "1.7.1" });

		// 5. Without registry image: offers only build_image
		state = await fakeState();
		expect(buildImageSpec(local)).toEqual({ candidates: [local], build: local });
		const noRegistryHost = fakeHost(state, { IMAGE_MISSING: "1" }, {}, buildImageSpec(local));
		expect(noRegistryHost.imageSpec).toEqual({ candidates: [local], build: local });
		const diagNoReg = await probeHost(noRegistryHost);
		expect(diagNoReg.kind).toBe("image_missing");
		if (diagNoReg.kind !== "image_missing" || diagNoReg.remedy.kind !== "actions") {
			throw new Error("expected image actions");
		}
		expect(diagNoReg.remedy.actions.map((a) => [a.id, a.label])).toEqual([["build_image", BUILD_IMAGE_OPTION]]);
		expect(await diagNoReg.remedy.actions[0].run({ signal: new AbortController().signal })).toEqual({ ok: true });
		expect(await callsOf("build")).toEqual([
			["build", "--arch", "arm64", "--tag", local, "--file", join(imageDir, "Containerfile"), imageDir],
		]);
		expect(await probeHost(noRegistryHost)).toMatchObject({ kind: "ready", image: local, version: "1.7.1" });
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

		const diagnosis = await probeHost(host);
		expect(diagnosis).toMatchObject({ kind: "ready", image: registry, version: "1.7.1" });
		if (diagnosis.kind !== "ready") throw new Error("expected ready");

		const activation = await activateRuntime(host, "failed-prep", root, diagnosis.image, warn, artifactsRoot());
		expect(activation).toEqual({
			ready: false,
			message: "sandbox is off: the /work volume could not be prepared: exit 1",
			leftovers: [],
		});
		expect(host.imageSpec).toEqual({ candidates: [registry, local], pull: registry, build: local });
		expect("handle" in host).toBe(false);
		expect(await exists(join(artifactsRoot(), "failed-prep", "lock"))).toBe(false);

		host.environment.FAKE_CONTAINER_IMAGE_PRESENT = local;
		expect(await probeHost(host)).toMatchObject({ kind: "ready", image: local, version: "1.7.1" });
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
				supportsServiceAutoStart: baseDriver.supportsServiceAutoStart,
				probeRuntime: () => baseDriver.probeRuntime(),
				imageRemedy: (spec) => baseDriver.imageRemedy(spec),
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

			const controller = new SandboxController(
				() => host,
				() => {
					if (invalidated) throw new Error("context invalidated");
					registered += 1;
				},
			);
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

	it("does not notify or set status for a missing image after shutdown begins during inspectImage", async () => {
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
				supportsServiceAutoStart: baseDriver.supportsServiceAutoStart,
				probeRuntime: () => baseDriver.probeRuntime(),
				imageRemedy: (spec) => baseDriver.imageRemedy(spec),
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
			const uiStatuses: [string, string | undefined][] = [];
			const ui = {
				notify: (message: string) => {
					uiNotices.push(message);
				},
				setStatus: (key: string, text: string | undefined) => {
					uiStatuses.push([key, text]);
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

			const controller = new SandboxController(
				() => host,
				() => {},
			);
			const starting = controller.start(ctx);
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
			expect(uiNotices).toEqual([]);
			expect(uiStatuses).toEqual([]);
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
					supportsServiceAutoStart: baseDriver.supportsServiceAutoStart,
					probeRuntime: () => baseDriver.probeRuntime(),
					imageRemedy: (spec) => baseDriver.imageRemedy(spec),
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

				const controller = new SandboxController(
					() => host,
					() => {
						if (invalidated) throw new Error("context invalidated");
					},
				);
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
