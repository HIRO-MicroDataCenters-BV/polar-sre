import { getEventListeners } from "events";
import { chmod, mkdtemp, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OutputLimit, type ProcessCall, runProcess, type StreamResult, type StreamStatus } from "../process.ts";
import type { ProcessLimits, ProducerRuntime } from "../runtime.ts";
import { acquireSession, type SessionHandle, type SessionPaths } from "../session.ts";
import { discardOutputFile, finishOutputFile, OutputLimitError, openOutputFile, readExcerpt } from "../store.ts";

vi.mock(import("../store.ts"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		openOutputFile: vi.fn(original.openOutputFile),
	};
});

const FAKE_COMMAND = fileURLToPath(new URL("./fake-command.mjs", import.meta.url));
const TOOL_NAME = "test_tool";
const DEFAULT_TIMEOUT_MS = 10_000;

const testLimits: ProcessLimits = {
	fileMaxBytes: 1024 * 1024,
	sessionMaxBytes: 16 * 1024 * 1024,
	stderrMaxBytes: 64 * 1024,
	killGraceMs: 300,
};

interface RunOptions {
	command?: string;
	args?: readonly string[];
	timeoutMs?: number;
	limits?: Partial<ProcessLimits>;
	runtime?: ProducerRuntime;
	signal?: AbortSignal;
}

let root: string;
let handle: SessionHandle;
let session: SessionPaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "shared-process-"));
	handle = await acquireSession("current", root, root);
	session = handle.paths;
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
});

async function outputFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory)).filter((name) => name !== "lock");
}

function fakeEnv(knobs: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	for (const [name, value] of Object.entries(knobs)) {
		env[`FAKE_COMMAND_${name}`] = value;
	}
	return env;
}

function fakeRuntime(limits: Partial<ProcessLimits> = {}): ProducerRuntime {
	return {
		limits: { ...testLimits, ...limits },
		activeProcessGroups: new Set(),
		handle,
		state: "open",
		inFlight: new Set(),
	};
}

function callOf(knobs: Record<string, string>, options: RunOptions = {}): ProcessCall {
	return {
		command: options.command ?? FAKE_COMMAND,
		args: options.args ?? [],
		env: fakeEnv(knobs),
		tool: TOOL_NAME,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

async function run(knobs: Record<string, string>, options: RunOptions = {}) {
	const runtime = options.runtime ?? fakeRuntime(options.limits);
	const result = await runProcess(callOf(knobs, options), runtime, session, options.signal);
	return { ...result, stdout: await takeOutput(result) };
}

async function takeOutput(result: StreamResult): Promise<string> {
	if (result.output === undefined) return "";
	const { text } = await readExcerpt(result.output, "head", 4 * 1024 * 1024);
	await discardOutputFile(result.output);
	return text;
}

function childPid(result: { stdout: string }): number {
	const match = /child-pid (\d+)/.exec(result.stdout);
	if (match === null) throw new Error(`The fake command reported no child: ${result.stdout}`);
	return Number(match[1]);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function untilStarted(runtime: ProducerRuntime): Promise<void> {
	while (runtime.activeProcessGroups.size === 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function failFileCloseOnce(error: Error): Promise<void> {
	const original = await vi.importActual<typeof import("../store.ts")>("../store.ts");
	vi.mocked(openOutputFile).mockImplementationOnce(async (...args) => {
		const outcome = await original.openOutputFile(...args);
		if ("opened" in outcome) {
			const closed = outcome.opened.closed.then(() => {
				throw error;
			});
			closed.catch(() => {});
			Object.defineProperty(outcome.opened, "closed", { value: closed });
		}
		return outcome;
	});
}

describe("runProcess", () => {
	it("streams stdout to the .part file and returns stderr as bytes on exit 0", async () => {
		const handed = await runProcess(
			callOf({ STDOUT: "pods\n", STDERR: "No resources found in default namespace.\n" }),
			fakeRuntime(),
			session,
			undefined,
		);
		expect(handed.status).toBe("ok");
		expect(handed.exitCode).toBe(0);
		expect(handed.output?.path).toBe(join(session.outputDirectory, "test_tool-1.part"));
		expect(handed.output?.bytesWritten()).toBe(5);
		expect(handed.stderr).toEqual(Buffer.from("No resources found in default namespace.\n", "utf8"));
		expect(await takeOutput(handed)).toBe("pods\n");
		expect(await outputFiles()).toEqual([]);
	});

	it("reports non-zero exit codes and signal exits", async () => {
		const forbiddenLine =
			'Error from server (Forbidden): pods is forbidden: User "dev" cannot list resource "pods" in API group "" in the namespace "prod"\n';
		const denied = await run({ EXIT: "1", STDOUT: "NAME   READY\n", STDERR: forbiddenLine });
		expect(denied).toMatchObject({ status: "failed", exitCode: 1, stdout: "NAME   READY\n" });
		expect(denied.stderr.toString("utf8")).toBe(forbiddenLine);
		expect(denied).not.toHaveProperty("signal");
		expect(denied).not.toHaveProperty("startError");
		expect(denied).not.toHaveProperty("limit");

		const silent = await run({ EXIT: "42" });
		expect(silent).toMatchObject({ status: "failed", exitCode: 42 });
		expect(silent.stderr).toHaveLength(0);

		const lines = [
			'Error from server (BadRequest): container "certificate-agent" in pod "web-0" is waiting to start: ContainerCreating\n',
			"Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority\n",
			"error: context was not found for specified context: stagin\n",
			"Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin not found\n",
			"W1015 12:00:00 ß → ü\n",
		];
		for (const line of lines) {
			const result = await run({ EXIT: "1", STDERR: line });
			expect(result, line).toMatchObject({ status: "failed", exitCode: 1 });
			expect(result.stderr, line).toEqual(Buffer.from(line, "utf8"));
			expect(result, line).not.toHaveProperty("startError");
		}

		const runtime = fakeRuntime();
		const pending = run({ STDOUT: "NAME   READY\n", DELAY_MS: "60000" }, { runtime });
		await untilStarted(runtime);
		const part = join(session.outputDirectory, `${TOOL_NAME}-${lines.length + 3}.part`);
		await expect.poll(async () => (await stat(part).catch(() => ({ size: 0 }))).size).toBeGreaterThan(0);
		for (const pid of runtime.activeProcessGroups) process.kill(pid, "SIGKILL");
		const killed = await pending;
		expect(killed).toMatchObject({ status: "failed", exitCode: null, signal: "SIGKILL", stdout: "NAME   READY\n" });
		expect(killed).not.toHaveProperty("startError");
	});

	it("reports a missing binary with startError and leaves no output file", async () => {
		const missing = await run({}, { command: "/nonexistent/bin/command" });
		expect(missing).toMatchObject({ status: "failed", exitCode: null, stdout: "" });
		expect(missing.startError).toMatch(/ENOENT/);
		expect(missing.stderr).toHaveLength(0);
		expect(missing).not.toHaveProperty("signal");
		expect(missing.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);
	});

	it("stops at stdout, stderr, and session output limits and keeps the prefix written so far", async () => {
		const limits = { fileMaxBytes: 4096, stderrMaxBytes: 1024 };

		const atLimit = await run({ STDOUT_BYTES: "4096" }, { limits });
		expect(atLimit).toMatchObject({ status: "ok" });
		expect(atLimit.stdout).toHaveLength(4096);

		const stdoutStopped = await run(
			{ STDOUT: "prefix\n", STDOUT_BYTES: "1000000", DELAY_MS: "60000" },
			{ limits: { fileMaxBytes: 128 * 1024 } },
		);
		expect(stdoutStopped).toMatchObject({ status: "output_limit", exitCode: null, limit: "stdout" });
		expect(stdoutStopped.stdout.startsWith("prefix\n")).toBe(true);
		expect(stdoutStopped.stdout.length).toBeLessThanOrEqual(128 * 1024);

		const stderrStopped = await run(
			{ STDOUT: "prefix\n", STDERR: "e".repeat(1025), STDERR_DELAY_MS: "100", DELAY_MS: "60000" },
			{ limits },
		);
		expect(stderrStopped).toMatchObject({
			status: "output_limit",
			exitCode: null,
			limit: "stderr",
			stdout: "prefix\n",
		});
		expect(stderrStopped.stderr.length).toBeLessThanOrEqual(1024);

		const quotaStopped = await run(
			{ STDOUT: "prefix\n", STDOUT_BYTES: "1000000", DELAY_MS: "60000" },
			{ limits: { sessionMaxBytes: 128 * 1024 } },
		);
		expect(quotaStopped).toMatchObject({ status: "output_limit", exitCode: null, limit: "session" });
		expect(quotaStopped.stdout.startsWith("prefix\n")).toBe(true);
		expect(quotaStopped.stdout.length).toBeLessThanOrEqual(128 * 1024);

		const quota = { sessionMaxBytes: 10 };
		const published = await runProcess(callOf({ STDOUT_BYTES: "10" }), fakeRuntime(quota), session, undefined);
		expect(published.output).toBeDefined();
		if (published.output !== undefined) {
			expect(
				await finishOutputFile(published.output, "complete", { tool: TOOL_NAME, command: "test" }),
			).toHaveProperty("saved");
		}
		const refused = await run({ ECHO: "1" }, { limits: quota });
		expect(refused).toMatchObject({
			status: "save_failed",
			exitCode: null,
			stdout: "",
			saveError: { message: "the session holds 10B of saved output; the limit is 10B" },
		});
		expect(refused.output).toBeUndefined();
	});

	it("keeps the first output limit when both streams overflow", async () => {
		const flood = "e".repeat(256);
		const orders: [string, Record<string, string>, Partial<ProcessLimits>, OutputLimit][] = [
			[
				"stdout then stderr",
				{ STDOUT_BYTES: "4096", STDERR: flood, STDERR_DELAY_MS: "200" },
				{ fileMaxBytes: 1024, stderrMaxBytes: 128 },
				"stdout",
			],
			[
				"session quota then stderr",
				{ STDOUT_BYTES: "4096", STDERR: flood, STDERR_DELAY_MS: "200" },
				{ sessionMaxBytes: 1024, stderrMaxBytes: 128 },
				"session",
			],
			[
				"stderr then stdout",
				{ STDERR: flood, STDOUT_BYTES: "4096", STDOUT_DELAY_MS: "200" },
				{ fileMaxBytes: 1024, stderrMaxBytes: 128 },
				"stderr",
			],
		];
		for (const [order, knobs, limits, limit] of orders) {
			const stubborn = { ...knobs, IGNORE_SIGTERM: "1", DELAY_MS: "60000" };
			const result = await run(stubborn, { limits: { ...limits, killGraceMs: 600 } });
			expect(result, order).toMatchObject({ status: "output_limit", exitCode: null, limit });
		}
	});

	it("times out with SIGTERM, escalates to SIGKILL after killGraceMs, and keeps output so far", async () => {
		const timedOut = await run(
			{ STDOUT: "NAME   READY\n", STDERR: "W1015 slow\n", DELAY_MS: "60000" },
			{ timeoutMs: 300 },
		);
		expect(timedOut).toMatchObject({
			status: "timeout",
			exitCode: null,
			signal: "SIGTERM",
			stdout: "NAME   READY\n",
		});
		expect(timedOut.stderr.toString("utf8")).toBe("W1015 slow\n");

		const stubborn = await run(
			{ IGNORE_SIGTERM: "1", STDOUT: "partial\n", DELAY_MS: "60000" },
			{ timeoutMs: 300, limits: { killGraceMs: 600 } },
		);
		expect(stubborn).toMatchObject({
			status: "timeout",
			exitCode: null,
			signal: "SIGKILL",
			stdout: "partial\n",
		});
		expect(stubborn.elapsedMs).toBeGreaterThanOrEqual(600);
	});

	it("cancels before spawn, during the file open, and during the run", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		const beforeSpawn = await runProcess(
			callOf({ ECHO: "1" }, { command: "/nonexistent/bin/command" }),
			fakeRuntime(),
			session,
			preAborted.signal,
		);
		expect(beforeSpawn.status).toBe("cancelled");
		expect(beforeSpawn.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);

		const duringOpen = new AbortController();
		const pendingOpen = runProcess(
			callOf({}, { command: "/nonexistent/bin/command" }),
			fakeRuntime(),
			session,
			duringOpen.signal,
		);
		duringOpen.abort();
		const cancelledOpen = await pendingOpen;
		expect(cancelledOpen.status).toBe("cancelled");
		expect(cancelledOpen.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);

		const runtime = fakeRuntime();
		const duringRun = new AbortController();
		const running = run({ CHILD: "1", DELAY_MS: "60000" }, { runtime, signal: duringRun.signal });
		const part = join(session.outputDirectory, `${TOOL_NAME}-3.part`);
		await expect.poll(async () => (await stat(part).catch(() => ({ size: 0 }))).size).toBeGreaterThan(0);
		duringRun.abort();
		const cancelledRun = await running;
		expect(cancelledRun.status).toBe("cancelled");
		const child = childPid(cancelledRun);
		await expect.poll(() => isAlive(child)).toBe(false);
		expect(runtime.activeProcessGroups.size).toBe(0);
	});

	it("kills the process tree", async () => {
		const stubborn = await run(
			{ IGNORE_SIGTERM: "1", CHILD: "1", CHILD_INHERITS: "1", DELAY_MS: "60000" },
			{ timeoutMs: 300, limits: { killGraceMs: 600 } },
		);
		expect(stubborn).toMatchObject({ status: "timeout", exitCode: null });
		expect(stubborn.elapsedMs).toBeGreaterThanOrEqual(600);
		const stubbornChild = childPid(stubborn);
		await expect.poll(() => isAlive(stubbornChild)).toBe(false);

		const cancelled = await run({ CHILD: "1", DELAY_MS: "60000" }, { signal: AbortSignal.timeout(300) });
		expect(cancelled.status).toBe("cancelled");
		const orphan = childPid(cancelled);
		await expect.poll(() => isAlive(orphan)).toBe(false);

		const unblocked = await run(
			{ CHILD: "1", CHILD_INHERITS: "1", CHILD_DETACHED: "1", DELAY_MS: "60000" },
			{ timeoutMs: 300 },
		);
		const escaped = childPid(unblocked);
		try {
			expect(unblocked.status).toBe("timeout");
			expect(isAlive(escaped)).toBe(true);
		} finally {
			process.kill(escaped, "SIGKILL");
		}
	});

	it("reports a write error that arrives after the process exited or after a stop", async () => {
		await failFileCloseOnce(new Error("ENOSPC: no space left on device, write"));
		const afterExit = await runProcess(callOf({ STDOUT: "output\n" }), fakeRuntime(), session, undefined);
		expect(afterExit).toMatchObject({
			status: "save_failed",
			exitCode: 0,
			saveError: { message: "ENOSPC: no space left on device, write" },
		});
		expect(afterExit.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);

		await failFileCloseOnce(new Error("ENOSPC: no space left on device, write"));
		const afterStop = await runProcess(
			callOf({ STDOUT: "output\n", DELAY_MS: "60000" }, { timeoutMs: 300 }),
			fakeRuntime(),
			session,
			undefined,
		);
		expect(afterStop).toMatchObject({
			status: "save_failed",
			exitCode: null,
			signal: "SIGTERM",
			saveError: { message: "ENOSPC: no space left on device, write" },
		});
		expect(afterStop.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);
	});

	it("reports a limit that is reached after the process exited", async () => {
		await failFileCloseOnce(new OutputLimitError("file"));
		const result = await run({ STDOUT: "output\n" });

		expect(result).toMatchObject({ status: "output_limit", exitCode: 0, limit: "stdout", stdout: "output\n" });
		expect(result.saveError).toBeUndefined();
		expect(await outputFiles()).toEqual([]);
	});

	it("reports a file that cannot be created as save_failed without spawning", async () => {
		await chmod(session.outputDirectory, 0o500);
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run({ ECHO: "1" });
		} finally {
			await chmod(session.outputDirectory, 0o700);
		}
		expect(result).toMatchObject({ status: "save_failed", exitCode: null, stdout: "" });
		expect(result.saveError?.message).toContain("EACCES");
		expect(result.output).toBeUndefined();
		expect(await outputFiles()).toEqual([]);
	});

	it("releases timers, abort listeners, and process groups after every ending", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const expectReleased = (runtime: ProducerRuntime, signal: AbortSignal) => {
				expect(runtime.activeProcessGroups.size).toBe(0);
				expect(getEventListeners(signal, "abort")).toHaveLength(0);
				expect(vi.getTimerCount()).toBe(0);
			};

			const completions: [StreamStatus, Record<string, string>, RunOptions][] = [
				["ok", {}, {}],
				["failed", { EXIT: "1" }, {}],
				["failed", {}, { command: "/nonexistent/bin/command" }],
				["output_limit", { STDOUT_BYTES: "100000", DELAY_MS: "60000" }, { limits: { fileMaxBytes: 1000 } }],
			];
			for (const [status, knobs, options] of completions) {
				const runtime = fakeRuntime(options.limits);
				const { signal } = new AbortController();
				expect((await run(knobs, { ...options, runtime, signal })).status).toBe(status);
				expectReleased(runtime, signal);
			}

			const slow = fakeRuntime();
			const slowCaller = new AbortController();
			const timingOut = run({ DELAY_MS: "60000" }, { runtime: slow, signal: slowCaller.signal });
			await untilStarted(slow);
			vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
			expect((await timingOut).status).toBe("timeout");
			expectReleased(slow, slowCaller.signal);

			const running = fakeRuntime();
			const caller = new AbortController();
			const cancelling = run({ DELAY_MS: "60000" }, { runtime: running, signal: caller.signal });
			await untilStarted(running);
			expect(running.activeProcessGroups.size).toBe(1);
			caller.abort();
			expect((await cancelling).status).toBe("cancelled");
			expectReleased(running, caller.signal);

			const neverStarted = fakeRuntime();
			expect((await run({}, { runtime: neverStarted, signal: caller.signal })).status).toBe("cancelled");
			expectReleased(neverStarted, caller.signal);
		} finally {
			vi.useRealTimers();
		}
	});
});
