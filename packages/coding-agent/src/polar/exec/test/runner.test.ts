import { spawnSync } from "child_process";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { discardOutputFile, readExcerpt } from "../../shared/store.ts";
import { buildReply } from "../src/reply.ts";
import { admitCall, containerName, launcher, runArguments } from "../src/runner.ts";
import type {
	ExecLanguage,
	ExecLimits,
	ExecResult,
	ExecRuntime,
	Inspection,
	OutputLimit,
	SessionPaths,
} from "../src/types.ts";
import { closeAdmission, workVolumeName } from "../src/workspace.ts";
import { type FakeState, fakeRuntime, fakeState, until } from "./fixtures.ts";

const store = vi.hoisted(() => ({ onOpened: undefined as (() => void) | undefined }));
vi.mock(import("../../shared/store.ts"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		openOutputFile: async (...args: Parameters<typeof original.openOutputFile>) => {
			const opened = await original.openOutputFile(...args);
			store.onOpened?.();
			return opened;
		},
	};
});

const SHUTTING_DOWN = "exec is shutting down; no program starts.";

let root: string;
let handle: SessionHandle;
let session: SessionPaths;
let state: FakeState;
let callNumber = 0;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "exec-container-"));
	handle = await acquireSession("current", root, root);
	session = handle.paths;
	state = await fakeState();
	store.onOpened = undefined;
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
	await rm(state.directory, { recursive: true, force: true });
});

function admit(code: string, runtime: ExecRuntime, language: ExecLanguage = "python", signal?: AbortSignal) {
	callNumber += 1;
	const call = admitCall(runtime, { language, code }, signal, `call-${callNumber}`);
	if (call === undefined) throw new Error("the call was not admitted");
	return call;
}

async function run(code: string, runtime: ExecRuntime, language: ExecLanguage = "python", signal?: AbortSignal) {
	const call = admit(code, runtime, language, signal);
	try {
		const result = await call.run();
		return { ...result, stdout: await takeOutput(result) };
	} finally {
		await call.dispose();
	}
}

async function takeOutput(result: ExecResult): Promise<string> {
	if (result.output === undefined) return "";
	const { text } = await readExcerpt(result.output, "head", 4 * 1024 * 1024);
	await discardOutputFile(result.output);
	return text;
}

async function sessionFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory).catch(() => [])).filter((name) => name !== "lock").sort();
}

function callIndex(calls: string[][], ...prefix: string[]): number {
	return calls.findIndex((call) => prefix.every((word, index) => call[index] === word));
}

async function runCalls(): Promise<string[][]> {
	return (await state.calls()).filter((call) => call[0] === "run");
}

async function nameOf(number: number): Promise<string> {
	const runs = (await runCalls()).filter((call) => call.includes("--interactive"));
	const name = runs
		.map((call) => call[call.indexOf("--name") + 1])
		.find((id) => id.startsWith(`polar-exec-current-${number}-`));
	if (name === undefined) throw new Error(`no run with output number ${number}`);
	return name;
}

const NAME_PATTERN = /^polar-exec-current-1-[0-9a-f]{8}$/;

describe("ExecCall", () => {
	it("runs the code and hands over its streams", async () => {
		const runtime = fakeRuntime(state, handle);
		const result = await run("stdout:hello\nstderr:warn\nexit:0", runtime);

		expect(result).toMatchObject({ status: "ok", exitCode: 0, stdout: "hello\n" });
		expect(result.stderr.equals(Buffer.from("warn\n"))).toBe(true);
		expect(result.runtimeMessage).toBeUndefined();
		expect(result.limit).toBeUndefined();
		expect(result.oomEvidence).toBeUndefined();
		expect(result.cleanupError).toBeUndefined();
		expect(result.inspection).toBeUndefined();
		const name = await nameOf(1);
		expect(name).toMatch(NAME_PATTERN);
		expect(await state.containers()).toEqual([]);
		const calls = await state.calls();
		expect(calls.map((call) => call[0])).toEqual(["run", "delete"]);
		expect(calls[1]).toEqual(["delete", "--force", name]);
		expect(runtime.owned.size).toBe(0);
		expect(await sessionFiles()).toEqual([]);
		expect(runtime.inFlight.size).toBe(0);
		expect(runtime.children.size).toBe(0);
		expect(runtime.running.size).toBe(0);
	});

	it("passes the operator limits, the mounts and the code to the runtime", async () => {
		const runtime = fakeRuntime(state, handle);
		const code = `echo_argv\n${"# padding\n".repeat(100)}`;
		const result = await run(code, runtime);
		const echo = JSON.parse(result.stdout) as { argv: string[]; codeLength: number };

		expect(echo.codeLength).toBe(code.length);
		const name = await nameOf(1);
		const expectedPairs = [
			["--progress", "none"],
			["--network", "none"],
			["--user", "1000:1000"],
			["--cap-drop", "ALL"],
			["--tmpfs", "/tmp:size=16M"],
			["--memory", "2048M"],
			["--cpus", "2"],
			["--ulimit", "nproc=64:64"],
			["--volume", `${session.outputDirectory}:/data:ro`],
			["--volume", "polar-work-current:/work"],
			["--workdir", "/work"],
			["--env", "HOME=/work"],
			["--env", "TMPDIR=/tmp"],
			["--name", name],
			["--label", "polar-session=current"],
			["--label", `polar-root=${root}`],
		];
		for (const [flag, value] of expectedPairs) {
			const positions = echo.argv.flatMap((word, index) => (word === flag ? [index] : []));
			expect(
				positions.map((index) => echo.argv[index + 1]),
				flag,
			).toContain(value);
		}
		expect(echo.argv).toContain("--init");
		expect(echo.argv).toContain("--read-only");
		expect(echo.argv).toContain("--interactive");
		expect(echo.argv.slice(-4)).toEqual(["polar-exec:test", "sh", "-c", launcher("python")]);
		expect(echo.argv[0]).toBe("run");
		expect(runArguments(runtime, name, "python")).toEqual(echo.argv);

		const bash = await run("echo_argv", runtime, "bash");
		expect((JSON.parse(bash.stdout) as { argv: string[] }).argv.slice(-3)).toEqual(["sh", "-c", launcher("bash")]);
		expect(containerName("current", "exec-7")).toMatch(/^polar-exec-current-7-[0-9a-f]{8}$/);
		expect(containerName("current", "exec-7")).not.toBe(containerName("current", "exec-7"));
		expect(workVolumeName("current")).toBe("polar-work-current");
	});

	it("gives the program an empty stdin and keeps the source out of it", async () => {
		const programs = await mkdtemp(join(tmpdir(), "exec-launcher-"));
		const sh = (language: ExecLanguage, code: string) =>
			spawnSync("sh", ["-c", launcher(language)], {
				input: code,
				encoding: "utf8",
				env: { ...process.env, TMPDIR: programs },
			});
		try {
			const bash = sh("bash", 'cat\necho AFTER\nread -r line; echo "[$line]"\nhead -c 10; echo END\n');
			expect(bash.status).toBe(0);
			expect(bash.stdout).toBe("AFTER\n[]\nEND\n");
			const python = sh("python", "import sys\nprint(repr(sys.stdin.read()))\nprint('AFTER')\n");
			expect(python.status).toBe(0);
			expect(python.stdout).toBe("''\nAFTER\n");
		} finally {
			await rm(programs, { recursive: true, force: true });
		}
	});

	it("reports an exit code the code chose as failed", async () => {
		const result = await run("stdout:partial\nstderr:boom\nexit:3", fakeRuntime(state, handle));

		expect(result).toMatchObject({ status: "failed", exitCode: 3, stdout: "partial\n" });
		expect(result.stderr.toString("utf8")).toBe("boom\n");
		expect(result.inspection).toEqual({ state: "present" });
		const name = await nameOf(1);
		const calls = await state.calls();
		expect(callIndex(calls, "inspect", name)).toBeGreaterThan(callIndex(calls, "run"));
		expect(callIndex(calls, "inspect", name)).toBeLessThan(callIndex(calls, "delete", "--force", name));
	});

	it("names an out-of-memory kill only with the kernel line", async () => {
		const oom = await run("stdout:before\noom", fakeRuntime(state, handle));
		expect(oom).toMatchObject({ status: "out_of_memory", exitCode: 137, stdout: "before\n" });
		expect(oom.oomEvidence).toBe(
			"Memory cgroup out of memory: Killed process 129 (python3) total-vm:3158408kB, anon-rss:1046208kB",
		);
		expect(oom.inspection).toBeUndefined();
		const name = await nameOf(1);
		const calls = await state.calls();
		expect(callIndex(calls, "logs", "--boot", name)).toBeLessThan(callIndex(calls, "delete", "--force", name));
		expect(callIndex(calls, "inspect", name)).toBe(-1);

		const unknown = await run("exit137", fakeRuntime(state, handle));
		expect(unknown).toMatchObject({ status: "failed", exitCode: 137 });
		expect(unknown.oomEvidence).toBeUndefined();
		expect(unknown.inspection).toEqual({ state: "present" });
	});

	it("stops the container at the timeout and keeps the output so far", async () => {
		const runtime = fakeRuntime(state, handle, {}, { timeoutMs: 300 });
		const result = await run("stdout:partial\nhang", runtime);

		expect(result).toMatchObject({ status: "timeout", exitCode: 137, stdout: "partial\n" });
		expect(result.inspection).toBeUndefined();
		const name = await nameOf(1);
		const calls = await state.calls();
		expect(calls).toContainEqual(["kill", name]);
		expect(calls.at(-1)).toEqual(["delete", "--force", name]);
		expect(await state.containers()).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	});

	it("keeps a late kill of one call away from the next call", async () => {
		const slowKill = fakeRuntime(state, handle, { KILL_DELAY_MS: "1000" }, { timeoutMs: 250, killGraceMs: 100 });
		const first = await run("hang", slowKill);
		expect(first.status).toBe("timeout");
		const calls = await state.calls();
		const firstName = await nameOf(1);
		expect(callIndex(calls, "kill", firstName)).toBeLessThan(callIndex(calls, "delete", "--force", firstName));

		const second = await run("stdout:second\ndelay_ms:300", fakeRuntime(state, handle));
		expect(second).toMatchObject({ status: "ok", exitCode: 0, stdout: "second\n" });
		const names = (await runCalls()).map((call) => call[call.indexOf("--name") + 1]);
		expect(names).toHaveLength(2);
		expect(names[0]).not.toBe(names[1]);
		expect(names[0]).toMatch(/^polar-exec-current-1-/);
		expect(names[1]).toMatch(/^polar-exec-current-2-/);
	});

	it("stops the container on cancel, or never starts it", async () => {
		const runtime = fakeRuntime(state, handle);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const cancelled = await run("stdout:partial\nhang", runtime, "python", controller.signal);
		expect(cancelled).toMatchObject({ status: "cancelled", stdout: "partial\n" });
		expect(await state.calls()).toContainEqual(["kill", await nameOf(1)]);
		expect(await state.containers()).toEqual([]);

		const aborted = new AbortController();
		aborted.abort();
		const before = await run("stdout:never", runtime, "python", aborted.signal);
		expect(before).toMatchObject({ status: "cancelled", exitCode: null });
		expect(before.output).toBeUndefined();
		expect(await runCalls()).toHaveLength(1);
		expect(await sessionFiles()).toEqual([]);
	});

	it("stops the container at the output limit", async () => {
		const runtime = fakeRuntime(state, handle, {}, { fileMaxBytes: 1024 });
		const stopped = await run("stdout_bytes:4096\nhang", runtime);
		expect(stopped).toMatchObject({ status: "output_limit", limit: "stdout" });
		expect(stopped.stdout.length).toBeLessThanOrEqual(1024);
		expect(await state.calls()).toContainEqual(["kill", await nameOf(1)]);

		const late = await run("stdout_bytes:4096\nexit:0", runtime);
		expect(late).toMatchObject({ status: "output_limit", limit: "stdout" });

		const quota = await run("stdout_bytes:4096\nhang", fakeRuntime(state, handle, {}, { sessionMaxBytes: 2048 }));
		expect(quota).toMatchObject({ status: "output_limit", limit: "session" });

		const noisy = await run(
			`stderr:${"e".repeat(200)}\nhang`,
			fakeRuntime(state, handle, {}, { stderrMaxBytes: 100 }),
		);
		expect(noisy).toMatchObject({ status: "output_limit", limit: "stderr" });
		expect(await state.containers()).toEqual([]);

		const flood = "e".repeat(256);
		const orders: [string, Partial<ExecLimits>, string, OutputLimit][] = [
			[
				"stdout then stderr",
				{ fileMaxBytes: 1024, stderrMaxBytes: 128 },
				`stdout_bytes:4096\nsleep_ms:200\nstderr:${flood}\nexit:0`,
				"stdout",
			],
			[
				"session quota then stderr",
				{ sessionMaxBytes: 1024, stderrMaxBytes: 128 },
				`stdout_bytes:4096\nsleep_ms:200\nstderr:${flood}\nexit:0`,
				"session",
			],
			[
				"stderr then stdout",
				{ fileMaxBytes: 1024, stderrMaxBytes: 128 },
				`stderr:${flood}\nsleep_ms:200\nstdout_bytes:4096\nexit:0`,
				"stderr",
			],
		];
		for (const [order, limits, code, limit] of orders) {
			const runtime = fakeRuntime(state, handle, { KILL_DELAY_MS: "600" }, { ...limits, killGraceMs: 1000 });
			const result = await run(code, runtime);
			expect(result, order).toMatchObject({ status: "output_limit", limit });
			expect(await state.containers(), order).toEqual([]);
		}
	});

	it("kills the run command when the container outlives the kill", async () => {
		const runtime = fakeRuntime(state, handle, { RUN_IGNORES_KILL: "1" }, { timeoutMs: 300, killGraceMs: 200 });
		const result = await run("hang", runtime);

		expect(result).toMatchObject({ status: "timeout", exitCode: null });
		expect(await state.calls()).toContainEqual(["delete", "--force", await nameOf(1)]);
		expect(await state.containers()).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	});

	it("reports a runtime that cannot run the code", async () => {
		const missing = { ...fakeRuntime(state, handle), containerCommand: "/nonexistent/bin/container" };
		const noCli = await run("stdout:never", missing);
		expect(noCli.status).toBe("runtime_failed");
		expect(noCli.runtimeMessage).toContain("ENOENT");
		expect(noCli.stderr.length).toBe(0);
		expect(noCli.output).toBeUndefined();
		expect(missing.owned.size).toBe(0);
		expect(missing.children.size).toBe(0);

		const runtime = fakeRuntime(state, handle, { RUN_FAILS: "1" });
		const call = admit("stdout:never", runtime);
		try {
			const failing = await call.run();
			expect(failing).toMatchObject({ status: "failed", exitCode: 1 });
			expect(failing.stderr.toString("utf8")).toContain("Error: failed to create container");
			expect(failing.runtimeMessage).toBeUndefined();
			expect(failing.inspection).toEqual({ state: "absent" });
			expect(failing.output?.bytesWritten()).toBe(0);
			const reply = await buildReply(
				failing,
				{ language: "python", code: "stdout:never" },
				runtime.limits,
				runtime.handle.paths,
			);
			expect(reply).toEqual({
				text: "[exec failed: exit 1] python: stdout:never\n\n[stderr]\nError: failed to create container: image not found\n[/stderr]\n\n[The container was not found after the run; whether the program started is not known.]",
				isError: true,
			});
		} finally {
			await call.dispose();
		}
		expect(await sessionFiles()).toEqual([]);
		expect(await state.containers()).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	});

	it("keeps the program result when the diagnosis fails", async () => {
		const diagnoses: [Record<string, string>, Partial<ExecLimits>, Inspection][] = [
			[{ INSPECT_EXIT: "2" }, {}, { state: "unknown", detail: "Error: inspect failed" }],
			[{ INSPECT_GARBAGE: "1" }, {}, { state: "unknown", detail: "unreadable answer" }],
			[{ INSPECT_HANG: "1" }, { commandTimeoutMs: 2000 }, { state: "unknown", detail: "timed out" }],
			[{ INSPECT_MISSING: "1" }, {}, { state: "absent" }],
		];
		for (const [index, [knobs, limits, inspection]] of diagnoses.entries()) {
			const form = Object.keys(knobs).join();
			const runtime = fakeRuntime(state, handle, knobs, limits);
			const result = await run("stdout:partial\nexit:3", runtime);
			expect(result, form).toMatchObject({ status: "failed", exitCode: 3, stdout: "partial\n" });
			expect(result.output, form).toBeDefined();
			expect(result.inspection, form).toEqual(inspection);
			const name = await nameOf(index + 1);
			const calls = await state.calls();
			expect(callIndex(calls, "inspect", name), form).toBeGreaterThan(callIndex(calls, "run"));
			expect(callIndex(calls, "delete", "--force", name), form).toBeGreaterThan(callIndex(calls, "inspect", name));
			expect(runtime.owned.size, form).toBe(0);
		}
		const killed = await run("stdout:partial\nexit137", fakeRuntime(state, handle, { INSPECT_EXIT: "2" }));
		expect(killed).toMatchObject({
			status: "failed",
			exitCode: 137,
			stdout: "partial\n",
			inspection: { state: "unknown", detail: "Error: inspect failed" },
		});
		expect(await state.containers()).toEqual([]);
	});

	it("refuses to run when the session quota is used up", async () => {
		const runtime = fakeRuntime(state, handle, {}, { sessionMaxBytes: 0 });
		const result = await run("stdout:never", runtime);

		expect(result.status).toBe("save_failed");
		expect(result.saveError?.message).toBe("the session holds 0B of saved output; the limit is 0B");
		expect(await state.calls()).toEqual([]);
	});
});

describe("admission", () => {
	const ownHandle = () => acquireSession("current", root, root);

	it("closes admission at every await point", async () => {
		const deleting = fakeRuntime(state, await ownHandle(), { DELETE_DELAY_MS: "400" });
		await state.addContainer("polar-exec-current-9-99999999", { "polar-session": "current", "polar-root": root });
		deleting.owned.add("polar-exec-current-9-99999999");
		const first = admit("stdout:never", deleting);
		const firstRun = first.run();
		await until(async () => (await state.calls()).some((call) => call[0] === "delete"));
		closeAdmission(deleting);
		const refusedInCleanup = await firstRun;
		await first.dispose();
		expect(refusedInCleanup).toMatchObject({ status: "runtime_failed", runtimeMessage: SHUTTING_DOWN });
		expect(deleting.owned.size).toBe(0);
		expect(await sessionFiles()).toEqual([]);

		const opening = fakeRuntime(state, await ownHandle());
		const second = admit("stdout:never", opening);
		store.onOpened = () => closeAdmission(opening);
		const refusedInOpen = await second.run();
		await second.dispose();
		expect(refusedInOpen).toMatchObject({ status: "runtime_failed", runtimeMessage: SHUTTING_DOWN });
		expect(refusedInOpen.output).toBeUndefined();
		expect(await runCalls()).toEqual([]);
		expect(await sessionFiles()).toEqual([]);
		store.onOpened = undefined;

		const spawned = fakeRuntime(state, await ownHandle());
		const third = admit("stdout:partial\nhang", spawned);
		const thirdRun = third.run();
		await until(() => spawned.running.size === 1);
		closeAdmission(spawned);
		const stopped = await thirdRun;
		expect(stopped.status).toBe("cancelled");
		expect(stopped.output).toBeDefined();
		const name = await nameOf(2);
		const calls = await state.calls();
		expect(callIndex(calls, "kill", name)).toBeLessThan(callIndex(calls, "delete", "--force", name));
		expect(spawned.owned.size).toBe(0);
		expect(await takeOutput(stopped)).toMatch(/^(partial\n)?$/);
		await third.dispose();
		expect(await sessionFiles()).toEqual([]);
		for (const runtime of [deleting, opening, spawned]) {
			expect(runtime.inFlight.size).toBe(0);
			expect(runtime.state).toBe("closed");
		}
		expect(admitCall(spawned, { language: "bash", code: "true" }, undefined, "late")).toBeUndefined();
		expect(spawned.inFlight.size).toBe(0);
	});
});

describe("cleanup", () => {
	it("keeps the program result and the ownership when the container cannot be deleted", async () => {
		const runtime = fakeRuntime(state, handle, { DELETE_FAIL: "1" }, { commandTimeoutMs: 2000 });
		const result = await run("stdout:done\nexit:0", runtime);
		const name = await nameOf(1);

		expect(result).toMatchObject({ status: "ok", exitCode: 0, stdout: "done\n" });
		expect(result.cleanupError).toEqual({
			container: name,
			message: "delete: Error: runtime temporarily unavailable; still listed",
		});
		expect(await state.containers()).toEqual([name]);
		expect(runtime.owned.has(name)).toBe(true);

		const blocked = await run("stdout:never", runtime);
		expect(blocked.status).toBe("runtime_failed");
		expect(blocked.runtimeMessage).toBe(
			`a container of an earlier call could not be deleted: ${name} (delete: Error: runtime temporarily unavailable; still listed).`,
		);
		expect(await runCalls()).toHaveLength(1);
		delete runtime.environment.FAKE_CONTAINER_DELETE_FAIL;
		const next = await run("stdout:again", runtime);
		expect(next).toMatchObject({ status: "ok", stdout: "again\n" });
		expect(next.cleanupError).toBeUndefined();
		expect(await state.containers()).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	});

	it("keeps the status and the file when the cleanup fails", async () => {
		const runtime = fakeRuntime(state, handle, { DELETE_FAIL: "1" });
		const ok = await run("stdout:done\nexit:0", runtime);
		const firstName = await nameOf(1);
		expect(ok).toMatchObject({ status: "ok", exitCode: 0, stdout: "done\n" });
		expect(ok.output).toBeDefined();
		expect(ok.cleanupError?.container).toBe(firstName);
		const reply = await buildReply(
			{ ...ok, output: undefined },
			{ language: "python", code: "stdout:done" },
			runtime.limits,
			session,
		);
		expect(reply.text).toContain(`[The container ${firstName} could not be deleted:`);

		const failed = await run("stdout:partial\nexit:3", fakeRuntime(state, handle, { DELETE_FAIL: "1" }));
		expect(failed).toMatchObject({ status: "failed", exitCode: 3, stdout: "partial\n" });
		expect(failed.output).toBeDefined();
		expect(failed.cleanupError?.message).toBe("delete: Error: runtime temporarily unavailable; still listed");
	});
});
