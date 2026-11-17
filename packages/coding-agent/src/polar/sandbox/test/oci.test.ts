import { spawnSync } from "child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSandboxImageDir } from "../../../config.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { discardOutputFile, readExcerpt } from "../../shared/store.ts";
import { createRuntime } from "../index.ts";
import { deadlineAfter } from "../src/cli.ts";
import {
	cleanupOciContainer,
	KEEPALIVE_COMMAND,
	launcher,
	type OciDriver,
	ociExecArguments,
	ociInspectionOf,
	ociSandboxArguments,
	parseOciContainers,
	parseOciNames,
	parseOciVolumes,
	ROOTLESS_DOCKER_UNSUPPORTED,
	SCRUB_SCRIPT,
	WORK_LIMIT_EXIT_CODE,
} from "../src/driver.ts";
import { buildReply } from "../src/reply.ts";
import { admitCall } from "../src/runner.ts";
import type { SandboxLanguage, SandboxResult, SandboxRuntime, SessionPaths } from "../src/types.ts";
import {
	BUILD_IMAGE_OPTION,
	checkReadiness,
	DISABLE_SANDBOX_OPTION,
	ensureWorkVolume,
	recoverLeftovers,
	shutdownRuntime,
	startRuntime,
} from "../src/workspace.ts";
import {
	FAKE_OCI,
	type FakeState,
	fakeOciEnvironment,
	fakeOciRuntime,
	fakeState,
	startingOciRuntime,
	testLimits,
} from "./fixtures.ts";

let root: string;
let handle: SessionHandle;
let session: SessionPaths;
let state: FakeState;
let notices: string[];
let callNumber = 0;
const warn = (message: string) => notices.push(message);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-oci-"));
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

async function run(code: string, runtime: SandboxRuntime, language: SandboxLanguage = "python", signal?: AbortSignal) {
	callNumber += 1;
	const call = admitCall(runtime, { language, code }, signal, `oci-call-${callNumber}`);
	if (call === undefined) throw new Error("the call was not admitted");
	try {
		const result = await call.run();
		return { ...result, stdout: await takeOutput(result) };
	} finally {
		await call.dispose();
	}
}

async function takeOutput(result: SandboxResult): Promise<string> {
	if (result.output === undefined) return "";
	const { text } = await readExcerpt(result.output, "head", 4 * 1024 * 1024);
	await discardOutputFile(result.output);
	return text;
}

describe("OciDriver readiness & engine discovery", () => {
	it("prefers podman in auto mode, falls back to docker when podman is unavailable, and reports boundaryDescription", async () => {
		const bin = join(root, "bin");
		await mkdir(bin, { recursive: true });
		const dockerWrapper = join(bin, "docker");
		await writeFile(
			dockerWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=docker\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(dockerWrapper, 0o755);

		// 1. Only docker in PATH -> auto selects docker
		const envOnlyDocker = { ...fakeOciEnvironment(state), PATH: bin };
		const dockerRuntime = createRuntime("polar-sandbox:0.2", envOnlyDocker, handle, {
			driver: "oci",
			ociEngine: "auto",
		});
		dockerRuntime.limits = { ...testLimits };
		expect(await checkReadiness(dockerRuntime)).toEqual({ ready: true });
		expect(dockerRuntime.driver.boundaryDescription).toBe("oci (docker/runc, shared kernel)");
		expect(dockerRuntime.containerCommand).toBe("docker");

		// 2. Add podman to PATH -> auto prefers podman
		const podmanWrapper = join(bin, "podman");
		await writeFile(
			podmanWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=podman\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(podmanWrapper, 0o755);
		const podmanRuntime = createRuntime("polar-sandbox:0.2", envOnlyDocker, handle, {
			driver: "oci",
			ociEngine: "auto",
		});
		podmanRuntime.limits = { ...testLimits };
		expect(await checkReadiness(podmanRuntime)).toEqual({ ready: true });
		expect(podmanRuntime.driver.boundaryDescription).toBe("oci (podman/crun, shared kernel)");
		expect(podmanRuntime.containerCommand).toBe("podman");

		// 3. Explicit --sandbox-oci-runtime=krun or runsc omits "shared kernel"
		const krunRuntime = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "podman" },
			{},
			{ engine: "podman", ociRuntime: "krun" },
		);
		expect(await checkReadiness(krunRuntime)).toEqual({ ready: true });
		expect(krunRuntime.driver.boundaryDescription).toBe("oci (podman/krun)");

		const runscRuntime = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "docker" },
			{},
			{ engine: "docker", ociRuntime: "runsc" },
		);
		expect(await checkReadiness(runscRuntime)).toEqual({ ready: true });
		expect(runscRuntime.driver.boundaryDescription).toBe("oci (docker/runsc)");
	});

	it("refuses rootless Docker and rootless Podman < 4.3 with clear reasons", async () => {
		const rootlessDocker = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "docker", DOCKER_ROOTLESS: "1" },
			{},
			{ engine: "docker" },
		);
		expect(await checkReadiness(rootlessDocker)).toEqual({
			ready: false,
			message: `sandbox is off: ${ROOTLESS_DOCKER_UNSUPPORTED}`,
			leftovers: [],
		});

		const oldPodman = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "podman", PODMAN_ROOTLESS: "1", PODMAN_VERSION: "4.2.1" },
			{},
			{ engine: "podman" },
		);
		expect(await checkReadiness(oldPodman)).toEqual({
			ready: false,
			message: "sandbox is off: rootless Podman >= 4.3 is required for keep-id UID mapping (found 4.2.1)",
			leftovers: [],
		});

		const serverErrorDocker = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "docker", DOCKER_SERVER_ERROR: "Cannot connect to the Docker daemon" },
			{},
			{ engine: "docker" },
		);
		expect(await checkReadiness(serverErrorDocker)).toEqual({
			ready: false,
			message: "sandbox is off: docker info failed: Cannot connect to the Docker daemon",
			leftovers: [],
		});

		const missingRuntimeDocker = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "docker", DOCKER_RUNTIMES_JSON: '{"runc":{}}' },
			{},
			{ engine: "docker", ociRuntime: "runsc" },
		);
		expect(await checkReadiness(missingRuntimeDocker)).toEqual({
			ready: false,
			message: "sandbox is off: OCI runtime runsc is not available in docker",
			leftovers: [],
		});
	});

	it("builds with --platform and --build-arg TARGETARCH when selected in UI", async () => {
		const buildRuntime = startingOciRuntime(state, handle, { IMAGE_MISSING: "1" });
		buildRuntime.image = "polar-sandbox:0.2";
		buildRuntime.customImage = false;
		expect(await checkReadiness(buildRuntime, async () => BUILD_IMAGE_OPTION)).toEqual({ ready: true });
		const arch = process.arch === "x64" ? "amd64" : "arm64";
		const imageDir = getSandboxImageDir();
		expect(await state.calls()).toContainEqual([
			"build",
			"--build-arg",
			`TARGETARCH=${arch}`,
			"--tag",
			"polar-sandbox:0.2",
			"--file",
			join(imageDir, "Containerfile"),
			imageDir,
		]);

		const disabled = startingOciRuntime(state, handle, { IMAGE_MISSING: "1" });
		disabled.image = "polar-sandbox:0.2";
		expect(await checkReadiness(disabled, async () => DISABLE_SANDBOX_OPTION)).toEqual({
			ready: false,
			message:
				"sandbox is off: image polar-sandbox:0.2 is not installed (podman image inspect polar-sandbox:0.2 failed: Error: image polar-sandbox:0.2 not found)",
			leftovers: [],
		});
	});
});

describe("OciDriver arguments, volumes, and leftovers", () => {
	it("constructs rootless Podman vs standard Docker arguments and respects cpu cgroup delegation", async () => {
		// 1. Rootless Podman with cpu delegated
		const podmanRuntime = startingOciRuntime(
			state,
			handle,
			{ ENGINE: "podman", PODMAN_ROOTLESS: "1", CPU_DELEGATED: "1" },
			{},
			{ engine: "podman", hostUid: 501, hostGid: 501 },
		);
		expect(await startRuntime(podmanRuntime, warn)).toEqual({ ready: true });
		podmanRuntime.state = "open";
		const podmanDriver = podmanRuntime.driver as OciDriver;
		expect(podmanDriver.guestUser).toBe("1000:1000");

		const first = await run("echo_argv", podmanRuntime);
		const podmanEcho = JSON.parse(first.stdout) as { argv: string[]; runArgv: string[] };
		expect(podmanEcho.runArgv).toContain("--userns=keep-id:uid=1000,gid=1000");
		expect(podmanEcho.runArgv).toContain("--security-opt=no-new-privileges");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--security-opt") + 1]).toBe("label=disable");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--user") + 1]).toBe("1000:1000");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,exec,nosuid,nodev,size=16m");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--memory") + 1]).toBe("2048m");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--memory-swap") + 1]).toBe("2048m");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--cpus") + 1]).toBe("2");
		expect(podmanEcho.runArgv[podmanEcho.runArgv.indexOf("--pids-limit") + 1]).toBe("64");
		expect(podmanEcho.runArgv).toContain("--read-only");
		expect(podmanEcho.runArgv).not.toContain("--init");
		expect(podmanEcho.runArgv.slice(-4)).toEqual(["polar-sandbox:test", "bash", "-c", KEEPALIVE_COMMAND]);
		await shutdownRuntime(podmanRuntime, "reload", warn);

		// 2. Rootless Podman without cpu controller delegated omits --cpus
		state = await fakeState();
		const noCpuHandle = await acquireSession("nocpu", root, artifactsRoot());
		try {
			const noCpuRuntime = startingOciRuntime(
				state,
				noCpuHandle,
				{ ENGINE: "podman", PODMAN_ROOTLESS: "1", CPU_DELEGATED: "0" },
				{},
				{ engine: "podman", ociRuntime: "krun" },
			);
			expect(await startRuntime(noCpuRuntime, warn)).toEqual({ ready: true });
			noCpuRuntime.state = "open";
			const noCpuEcho = JSON.parse((await run("echo_argv", noCpuRuntime)).stdout) as { runArgv: string[] };
			expect(noCpuEcho.runArgv).not.toContain("--cpus");
			expect(noCpuEcho.runArgv[noCpuEcho.runArgv.indexOf("--runtime") + 1]).toBe("krun");
			await shutdownRuntime(noCpuRuntime, "reload", warn);
		} finally {
			await noCpuHandle.release();
		}

		// 3. Standard Docker uses hostUid:hostGid and no --userns=keep-id
		state = await fakeState();
		const dockerHandle = await acquireSession("docker", root, artifactsRoot());
		try {
			const dockerRuntime = startingOciRuntime(
				state,
				dockerHandle,
				{ ENGINE: "docker" },
				{},
				{ engine: "docker", hostUid: 1002, hostGid: 1003 },
			);
			expect(await startRuntime(dockerRuntime, warn)).toEqual({ ready: true });
			dockerRuntime.state = "open";
			const dockerDriver = dockerRuntime.driver as OciDriver;
			expect(dockerDriver.guestUser).toBe("1002:1003");
			const calls = await state.calls();
			const prep = calls.find((call) => call[0] === "run" && call.includes("chown")) ?? [];
			expect(prep).not.toContain("--userns=keep-id:uid=1000,gid=1000");
			expect(prep.slice(-3)).toEqual(["chown", "1002:1003", "/work"]);

			const dockerEcho = JSON.parse((await run("echo_argv", dockerRuntime)).stdout) as {
				argv: string[];
				runArgv: string[];
			};
			expect(dockerEcho.runArgv).not.toContain("--userns=keep-id:uid=1000,gid=1000");
			expect(dockerEcho.runArgv[dockerEcho.runArgv.indexOf("--user") + 1]).toBe("1002:1003");
			const name = dockerEcho.runArgv[dockerEcho.runArgv.indexOf("--name") + 1];
			expect(dockerEcho.runArgv).toEqual(
				ociSandboxArguments(dockerRuntime, name, dockerDriver.runOptions, dockerHandle.paths),
			);
			expect(dockerEcho.argv).toEqual(
				ociExecArguments(name, "python", "1002:1003", dockerRuntime.limits.workMaxBytes),
			);
			expect(dockerEcho.runArgv).toContain(`polar-work-docker:/work:nocopy`);
			await shutdownRuntime(dockerRuntime, "reload", warn);
		} finally {
			await dockerHandle.release();
		}
	});

	it("recovers leftovers via ps -a + inspect and cleans up volumes of gone sessions", async () => {
		const liveDir = join(artifactsRoot(), "live");
		await mkdir(liveDir, { recursive: true });
		await writeFile(join(liveDir, "lock"), `${process.ppid}\n`);

		const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const endedDir = join(artifactsRoot(), "ended");
		await mkdir(endedDir, { recursive: true });
		await writeFile(join(endedDir, "lock"), `${exitedPid}\n`);

		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", ownLabels("current"));
		await state.addContainer("polar-sandbox-live-1-bbbbbbbb", ownLabels("live"));
		await state.addContainer("polar-sandbox-ended-1-cccccccc", ownLabels("ended"));
		await state.addContainer("polar-sandbox-gone-1-dddddddd", ownLabels("gone"));
		await state.addVolume("polar-work-current", ownLabels("current"));
		await state.addVolume("polar-work-live", ownLabels("live"));
		await state.addVolume("polar-work-ended", ownLabels("ended"));
		await state.addVolume("polar-work-gone", ownLabels("gone"));

		const runtime = startingOciRuntime(state, handle);
		expect(await recoverLeftovers(runtime, warn)).toEqual({ clean: true });
		expect(await state.containers()).toEqual(["polar-sandbox-live-1-bbbbbbbb"]);
		expect((await state.volumes()).map((v) => v.name).sort()).toEqual([
			"polar-work-current",
			"polar-work-ended",
			"polar-work-live",
		]);
	});

	it("parses OCI container and volume inspect outputs and handles cleanup errors", async () => {
		expect(parseOciNames("a\nb\n")).toEqual(["a", "b"]);
		expect(parseOciNames("not valid\n")).toBeUndefined();
		expect(
			parseOciContainers(
				JSON.stringify([
					{
						Name: "/c1",
						Config: { Labels: { "polar-session": "s1" } },
						State: { Status: "running", Running: true },
					},
					{
						Name: "c2",
						Config: { Labels: null },
						State: { Status: "exited", Running: false },
					},
				]),
			),
		).toEqual([
			{ name: "c1", labels: { "polar-session": "s1" }, state: "running" },
			{ name: "c2", labels: {}, state: "exited" },
		]);
		expect(parseOciVolumes(JSON.stringify([{ Name: "v1", Labels: null }]))).toEqual([{ name: "v1", labels: {} }]);
		expect(
			ociInspectionOf({ code: 1, stdout: "", stderr: "Error: No such container: c1\n", timedOut: false }, "c1"),
		).toEqual({ state: "absent" });

		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", ownLabels("current"));
		const ghost = fakeOciRuntime(state, handle, { DELETE_GHOST: "1" });
		expect(await cleanupOciContainer(ghost, "polar-sandbox-current-1-aaaaaaaa", deadlineAfter(ghost))).toEqual({
			removed: true,
		});
		expect(ghost.owned.size).toBe(0);

		await state.addContainer("polar-sandbox-current-2-bbbbbbbb", ownLabels("current"));
		const failing = fakeOciRuntime(state, handle, { DELETE_FAIL: "1" });
		expect(await cleanupOciContainer(failing, "polar-sandbox-current-2-bbbbbbbb", deadlineAfter(failing))).toEqual({
			removed: false,
			error: {
				container: "polar-sandbox-current-2-bbbbbbbb",
				message: "delete: Error: runtime temporarily unavailable; still listed",
			},
		});
		expect(failing.driver.manualDeleteCommand(["polar-sandbox-current-2-bbbbbbbb"])).toBe(
			"podman rm --force polar-sandbox-current-2-bbbbbbbb",
		);

		await state.addVolume("polar-work-current", ownLabels("current", "/foreign"));
		expect(await ensureWorkVolume(startingOciRuntime(state, handle))).toEqual({
			reason: `the volume polar-work-current is not this session's: its polar-root label is /foreign, expected ${artifactsRoot()}`,
		});
	});
});

describe("OciHotSandbox execution, OOM, and work_limit", () => {
	it("detects OOM via memory.events delta and State.OOMKilled fallback without poisoning subsequent calls", async () => {
		const runtime = fakeOciRuntime(state, handle);

		// 1. Subprocess OOM caught by user script (even if container State.OOMKilled becomes true while running)
		const survived = await run("stdout:caught\noom_survived\nexit:0", runtime);
		expect(survived).toMatchObject({ status: "ok", exitCode: 0, stdout: "caught\n" });

		// 2. Next call exits 137 without a new OOM -> reported as failed: exit 137, NOT out_of_memory
		const notOom = await run("exit137", runtime);
		expect(notOom).toMatchObject({ status: "failed", exitCode: 137 });
		expect(notOom.oomEvidence).toBeUndefined();
		expect(notOom.inspection).toEqual({ state: "present" });

		// 3. Actual OOM in call 3 -> memory.events oom_kill increases -> out_of_memory and container destroyed
		const oom = await run("stdout:before\noom", runtime);
		expect(oom).toMatchObject({
			status: "out_of_memory",
			exitCode: 137,
			stdout: "before\n",
			oomEvidence: "oom_kill 2 in /sys/fs/cgroup/memory.events",
		});
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);

		// 4. Container itself dies from OOM during call -> fallback to State.OOMKilled in inspect
		const diedOom = await run("stdout:before2\noom_container_died", runtime);
		expect(diedOom).toMatchObject({
			status: "out_of_memory",
			exitCode: 137,
			stdout: "before2\n",
			oomEvidence: "container State.OOMKilled is true",
		});
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);

		// 5. Next call on fresh container is clean
		const clean = await run("stdout:ok\nexit:0", runtime);
		expect(clean).toMatchObject({ status: "ok", exitCode: 0, stdout: "ok\n" });
		const calls = await state.calls();
		expect(calls.at(-1)?.slice(-3)).toEqual(["bash", "-c", SCRUB_SCRIPT]);
	});

	it("reports work_limit from runner and reply when the launcher exits with 199", async () => {
		const runtime = fakeOciRuntime(state, handle);
		const call = admitCall(runtime, { language: "bash", code: "stdout:partial\nwork_limit" }, undefined, "wl-1");
		if (call === undefined) throw new Error("not admitted");
		try {
			const result = await call.run();
			expect(result.status).toBe("work_limit");
			expect(result.exitCode).toBe(WORK_LIMIT_EXIT_CODE);
			expect(runtime.activeSandbox.current).toBeDefined();
			const reply = await buildReply(
				result,
				{ language: "bash", code: "stdout:partial\nwork_limit" },
				runtime.limits,
				session,
			);
			expect(reply).toEqual({
				text: "[run_code work_limit] bash: stdout:partial\n\npartial\n\nThe 4 MiB /work limit was reached and the process was killed.",
				isError: true,
			});
		} finally {
			await call.dispose();
		}
	});

	it("enforces work_limit in the bash launcher and allows rm when /work is already over the limit", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "sandbox-work-watchdog-"));
		const workDir = join(tmpDir, "work");
		await mkdir(workDir, { recursive: true });
		const maxBytes = 64 * 1024; // 64 KiB
		const execLauncher = (language: SandboxLanguage, code: string) =>
			spawnSync("bash", ["-c", launcher(language, { workMaxBytes: maxBytes })], {
				input: code,
				encoding: "utf8",
				env: { ...process.env, TMPDIR: tmpDir, POLAR_WORK_DIR: workDir },
			});
		try {
			// 1. Small write within quota succeeds
			const small = execLauncher("bash", `head -c 4096 /dev/zero > "${workDir}/small.bin" && echo ok\n`);
			expect(small.status).toBe(0);
			expect(small.stdout).toBe("ok\n");

			// 2. Fast write exceeding quota exits with WORK_LIMIT_EXIT_CODE (199)
			const fastOver = execLauncher("bash", `head -c 262144 /dev/zero > "${workDir}/big.bin"\n`);
			expect(fastOver.status).toBe(WORK_LIMIT_EXIT_CODE);

			// 3. While over quota, deleting the file with rm does not increase size and succeeds
			const cleanup = execLauncher("bash", `rm -f "${workDir}/big.bin" && echo cleaned\n`);
			expect(cleanup.status).toBe(0);
			expect(cleanup.stdout).toBe("cleaned\n");

			// 4. Slow write exceeding quota while sleeping is killed by the background watchdog loop
			const started = performance.now();
			const slowOver = execLauncher(
				"python",
				`with open(${JSON.stringify(join(workDir, "slow.bin"))}, "wb") as f:\n    f.write(b"x" * 262144)\n    f.flush()\nimport time\ntime.sleep(30)\n`,
			);
			expect(slowOver.status).toBe(WORK_LIMIT_EXIT_CODE);
			expect(performance.now() - started).toBeLessThan(3000);
			expect(await readdir(workDir)).toContain("slow.bin");

			// 5. Cleanup after slow write succeeds
			const cleanup2 = execLauncher("bash", `rm -f "${workDir}/slow.bin" && echo ok2\n`);
			expect(cleanup2.status).toBe(0);
			expect(cleanup2.stdout).toBe("ok2\n");
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});
