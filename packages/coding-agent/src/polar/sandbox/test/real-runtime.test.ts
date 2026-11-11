import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { readManifest } from "../../shared/store.ts";
import { createRuntime, DEFAULT_IMAGE } from "../index.ts";
import { containerCommand, parseContainers, parseListing } from "../src/cli.ts";
import { SESSION_LABEL, sandboxArguments, sessionLabels, workVolumeName } from "../src/driver.ts";
import { buildReply } from "../src/reply.ts";
import { admitCall } from "../src/runner.ts";
import type { SandboxLimits, SandboxRequest, SandboxRuntime, SessionPaths } from "../src/types.ts";
import { recoverLeftovers, shutdownRuntime, startRuntime } from "../src/workspace.ts";

const REAL = process.env.SANDBOX_REAL_RUNTIME === "1";
const IMAGE = process.env.POLAR_SANDBOX_IMAGE ?? DEFAULT_IMAGE;

const limits: SandboxLimits = {
	timeoutMs: 60_000,
	memoryBytes: 1024 * 1024 * 1024,
	cpus: 2,
	workMaxBytes: 64 * 1024 * 1024,
	processMax: 64,
	tmpMaxBytes: 64 * 1024 * 1024,
	fileMaxBytes: 256 * 1024 * 1024,
	sessionMaxBytes: 1024 * 1024 * 1024,
	stderrMaxBytes: 1024 * 1024,
	killGraceMs: 2000,
	commandTimeoutMs: 30_000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
	shutdownBudgetMs: 10_000,
};

let root: string;
let handle: SessionHandle;
let session: SessionPaths;
let runtime: SandboxRuntime;
const timings: { step: string; ms: number }[] = [];
const notices: string[] = [];
const warn = (message: string) => notices.push(message);

async function timed<T>(step: string, work: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try {
		return await work();
	} finally {
		timings.push({ step, ms: Math.round(performance.now() - started) });
	}
}

async function startedRuntime(sessionHandle: SessionHandle) {
	const started = createRuntime(IMAGE, process.env, sessionHandle);
	started.limits = { ...limits };
	const readiness = await timed(`start ${sessionHandle.paths.sessionId}`, () => startRuntime(started, warn));
	if (readiness.ready) started.state = "open";
	return { runtime: started, readiness };
}

async function call(
	code: string,
	language: SandboxRequest["language"] = "python",
	overrides: Partial<SandboxLimits> = {},
	signal?: AbortSignal,
) {
	const previousLimits = runtime.limits;
	runtime.limits = { ...runtime.limits, ...overrides };
	const request: SandboxRequest = { language, code };
	const step = code.split("\n").find((line) => line.trim() !== "") ?? "";
	try {
		return await timed(step, async () => {
			const admitted = admitCall(runtime, request, signal, randomUUID());
			if (admitted === undefined) throw new Error("the call was not admitted");
			try {
				const result = await admitted.run();
				return { result, reply: await buildReply(result, request, runtime.limits, session) };
			} finally {
				await admitted.dispose();
			}
		});
	} finally {
		runtime.limits = previousLimits;
	}
}

async function listing() {
	const listed = await containerCommand(runtime, ["list", "--all", "--format", "json"]);
	const containers = parseContainers(listed.stdout);
	if (listed.code !== 0 || containers === undefined) throw new Error(`unreadable listing: ${listed.stderr}`);
	return containers;
}

async function containersOf(sessionId: string): Promise<string[]> {
	return (await listing())
		.filter((container) => container.labels[SESSION_LABEL] === sessionId)
		.map((container) => container.name);
}

async function isRunning(name: string): Promise<boolean> {
	const inspected = await containerCommand(runtime, ["inspect", name]);
	if (inspected.code !== 0) return false;
	try {
		const parsed = JSON.parse(inspected.stdout) as Array<{ status?: string | { state?: string } }>;
		const status = parsed[0]?.status;
		const state = typeof status === "string" ? status : status?.state;
		return state === "running";
	} catch {
		return false;
	}
}

async function sleeper(name: string, paths: SessionPaths = session): Promise<void> {
	const started = await containerCommand(runtime, [
		"run",
		"--detach",
		"--progress",
		"none",
		"--network",
		"none",
		"--name",
		name,
		...sessionLabels(paths),
		IMAGE,
		"sleep",
		"300",
	]);
	expect(started.code, started.stderr).toBe(0);
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe.skipIf(!REAL)("sandbox on the real runtime", () => {
	beforeAll(async () => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		root = await mkdtemp(join(homedir(), ".cache", "polar-sandbox-real-"));
		handle = await acquireSession(`real-${randomUUID().slice(0, 8)}`, root, root);
		session = handle.paths;
		const lines: string[] = [];
		for (let index = 0; index < 200_000; index += 1) {
			const status = index % 7 === 0 ? 503 : 200;
			lines.push(
				`{"ts":"2026-10-18T00:${String(index % 60).padStart(2, "0")}:00Z","status":${status},"path":"/api/${index % 13}","request_id":"r${index}"}`,
			);
		}
		await writeFile(join(session.outputDirectory, "k8s_logs-1.txt"), `${lines.join("\n")}\n`);
		const started = await startedRuntime(handle);
		runtime = started.runtime;
		expect(started.readiness).toEqual({ ready: true });
		expect(runtime.state).toBe("open");
		expect(runtime.owned.size).toBe(0);
	}, 120_000);

	afterAll(async () => {
		if (runtime !== undefined) {
			await shutdownRuntime(runtime, "reload", warn);
			await containerCommand(runtime, ["volume", "delete", workVolumeName(session.sessionId)]);
		}
		if (handle !== undefined) await handle.release();
		if (root !== undefined) await rm(root, { recursive: true, force: true });
		console.table(timings);
	});

	it("runs python with duckdb and bash with ripgrep over /data in a warm VM", async () => {
		const sql = await call(
			"import duckdb\nprint(duckdb.sql(\"select count(*) from read_json('/data/k8s_logs-1.txt', format='newline_delimited') where status >= 500\").fetchone()[0])",
		);
		expect(sql.reply).toEqual({ text: "28572\n", isError: false });
		const rg = await call("rg -c '\"status\":503' /data/k8s_logs-1.txt", "bash");
		expect(rg.reply).toEqual({ text: "28572\n", isError: false });
	}, 60_000);

	it("scrubs background processes, files, 000 directories in /tmp, /dev/shm, and /dev/mqueue, and SysV IPC between calls in the same VM", async () => {
		const dirty = await call(
			[
				"cat /proc/sys/kernel/random/boot_id",
				"sleep 300 </dev/null >/dev/null 2>&1 &",
				"ipcmk -M 4096 >/dev/null",
				"ipcmk -Q >/dev/null",
				"ipcmk -S 1 >/dev/null",
				"mkdir -p /tmp/locked/sub",
				"echo secret > /tmp/locked/sub/file.txt",
				"chmod 000 /tmp/locked/sub /tmp/locked",
				"echo shm > /dev/shm/leaked.txt",
				"if [ -d /dev/mqueue ] && [ -w /dev/mqueue ]; then touch /dev/mqueue/leaked 2>/dev/null || true; fi",
			].join("\n"),
			"bash",
		);
		expect(dirty.result.status).toBe("ok");
		const bootId1 = dirty.reply.text.trim();
		expect(bootId1).not.toBe("");

		const check = await call(
			[
				"cat /proc/sys/kernel/random/boot_id",
				"procs=$(for p in /proc/[0-9]*/comm; do cat \"$p\" 2>/dev/null; done | grep -c '^sleep$' || true)",
				"files=$(find /tmp /dev/shm /dev/mqueue -mindepth 1 ! -path '/tmp/.polar' ! -path '/tmp/.polar/*' -print 2>/dev/null | wc -l | tr -d ' ')",
				"ipcs_count=$(ipcs -m -q -s | grep -c '^0x' || true)",
				'echo "procs=$procs files=$files ipcs=$ipcs_count"',
			].join("\n"),
			"bash",
		);
		expect(check.result.status).toBe("ok");
		const [bootId2, counts] = check.reply.text.trim().split("\n");
		expect(bootId2).toBe(bootId1);
		expect(counts).toBe("procs=0 files=0 ipcs=0");
	}, 60_000);

	it("keeps /work between calls, refuses writes to /data and has no network", async () => {
		expect((await call("echo persisted > /work/note.txt", "bash")).result.status).toBe("ok");
		expect((await call("cat /work/note.txt", "bash")).reply.text).toBe("persisted\n");
		const readOnly = await call("touch /data/x", "bash");
		expect(readOnly.result.status).toBe("failed");
		expect(readOnly.reply.text).toContain("Read-only file system");
		const net = await call(
			"import os, socket\nprint(sorted(os.listdir('/sys/class/net')))\ntry:\n    socket.create_connection(('1.1.1.1', 53), 3)\n    print('connected')\nexcept OSError as error:\n    print('refused:', error.errno)",
		);
		expect(net.reply.text).toBe("['lo']\nrefused: 101\n");
		const stdin = await call('cat\necho AFTER\nread -r line; echo "[$line]"\nhead -c 10; echo END', "bash");
		expect(stdin.reply).toEqual({ text: "AFTER\n[]\nEND\n", isError: false });
	}, 60_000);

	it("stops writes at the hard size of /work (ENOSPC) and lets the next call delete files with rm and continue", async () => {
		const over = await call("head -c 200000000 /dev/zero > /work/big", "bash");
		expect(over.result.status).toBe("failed");
		expect(over.reply.text).toContain("No space left on device");
		const recovered = await call(
			"rm -f /work/big && echo ok > /work/after-enospc.txt && cat /work/after-enospc.txt",
			"bash",
		);
		expect(recovered.result.status).toBe("ok");
		expect(recovered.reply.text).toBe("ok\n");
	}, 60_000);

	it("publishes a large stdout as a session file that the next call can read", async () => {
		const big = await call("head -c 40000000 /dev/zero | tr '\\0' x | fold -w 100", "bash");
		expect(big.result.status).toBe("ok");
		const [entry] = (await readManifest(session)).filter((item) => item.tool === "run_code");
		expect(big.reply.text).toContain(`Saved as ${join(session.outputDirectory, entry.file)} (`);
		expect(big.reply.text).toContain(`process it with "run_code" tool from /data/${entry.file}.`);
		expect(big.reply.text).not.toContain('read it with "read" tool');
		expect(entry.status).toBe("complete");
		expect(entry.command).toBe("bash: head -c 40000000 /dev/zero | tr '\\0' x | fold -w 100");
		expect((await stat(join(session.outputDirectory, entry.file))).size).toBe(entry.size);
		const next = await call(`wc -l < /data/${entry.file}`, "bash");
		expect(next.reply.text).toBe("399999\n");
	}, 120_000);

	it("detects OOM by delta so an OOM in call N never marks call N+1 as OOM", async () => {
		const caught = await call('{ python3 -c "b = bytearray(3 * 2**30)"; } 2>/dev/null || echo caught', "bash");
		expect(caught.result.status).toBe("ok");
		expect(caught.reply.text).toBe("caught\n");

		const killedAfterSubOom = await call("kill -9 $$", "bash");
		expect(killedAfterSubOom.result.status).toBe("failed");
		expect(killedAfterSubOom.result.exitCode).toBe(137);
		expect(killedAfterSubOom.result.oomEvidence).toBeUndefined();
		expect(killedAfterSubOom.reply.text).toContain("[run_code failed: exit 137]");

		const oom = await call("b = bytearray(3 * 2**30)\nprint(len(b))");
		expect(oom.result.status).toBe("out_of_memory");
		expect(oom.result.oomEvidence).toContain("Killed process");
		expect(oom.reply.text).toContain("[run_code out_of_memory]");
		expect(oom.reply.text).toContain("The 1 GiB memory limit was reached and the process was killed.");

		const killedAfterFullOom = await call("kill -9 $$", "bash");
		expect(killedAfterFullOom.result.status).toBe("failed");
		expect(killedAfterFullOom.result.exitCode).toBe(137);
		expect(killedAfterFullOom.result.oomEvidence).toBeUndefined();
		expect(killedAfterFullOom.reply.text).toContain("[run_code failed: exit 137]");
	}, 90_000);

	it("recreates the VM on timeout and cancel while preserving /work", async () => {
		const before = await call(
			"echo survived-timeout > /work/timeout-check.txt && cat /proc/sys/kernel/random/boot_id",
			"bash",
		);
		expect(before.result.status).toBe("ok");
		const bootBefore = before.reply.text.trim();

		const timeout = await call("echo started; sleep 60", "bash", { timeoutMs: 3000 });
		expect(timeout.result.status).toBe("timeout");
		expect(timeout.result.elapsedMs).toBeLessThan(15_000);
		expect(timeout.reply.text).toContain("started");
		expect(timeout.reply.text).toContain("run_code did not finish in 3 s.");
		expect(await containersOf(session.sessionId)).toEqual([]);
		expect(runtime.owned.size).toBe(0);

		const after = await call("cat /work/timeout-check.txt && cat /proc/sys/kernel/random/boot_id", "bash");
		expect(after.result.status).toBe("ok");
		const [persisted, bootAfter] = after.reply.text.trim().split("\n");
		expect(persisted).toBe("survived-timeout");
		expect(bootAfter).not.toBe(bootBefore);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		const cancelled = await call("sleep 60", "bash", {}, controller.signal);
		expect(cancelled.result.status).toBe("cancelled");
		expect(cancelled.result.elapsedMs).toBeLessThan(15_000);
		expect(await containersOf(session.sessionId)).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	}, 90_000);

	it("collapses the VM in <1 s when the parent process is killed with SIGKILL", async () => {
		const hot = runtime.activeSandbox.current;
		runtime.activeSandbox.current = undefined;
		if (hot !== undefined) await hot.destroy(Date.now() + 30_000);

		const name = `polar-sandbox-kill9-${session.sessionId}`;
		const args = sandboxArguments(runtime, name);
		const parent = spawn(
			process.execPath,
			[
				"-e",
				`
				import { spawn } from "child_process";
				const child = spawn("container", ${JSON.stringify(args)}, { stdio: ["pipe", "pipe", "pipe"] });
				child.stdout.once("data", () => process.stdout.write("READY\\n"));
				setInterval(() => {}, 1000);
				`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		try {
			await new Promise<void>((resolve, reject) => {
				parent.stdout.on("data", (chunk: Buffer) => {
					if (chunk.toString("utf8").includes("READY")) resolve();
				});
				parent.once("exit", (code) => reject(new Error(`parent exited early: ${code}`)));
			});
			expect(await isRunning(name)).toBe(true);

			const killedAt = performance.now();
			process.kill(parent.pid as number, "SIGKILL");
			while (await isRunning(name)) {
				if (performance.now() - killedAt > 2000) break;
				await sleep(20);
			}
			const elapsedMs = performance.now() - killedAt;
			timings.push({ step: "collapse after parent SIGKILL", ms: Math.round(elapsedMs) });
			expect(elapsedMs).toBeLessThan(1000);
			expect(await isRunning(name)).toBe(false);
		} finally {
			try {
				process.kill(parent.pid as number, "SIGKILL");
			} catch {}
			await containerCommand(runtime, ["delete", "--force", name]);
		}
	}, 60_000);

	it("reports inspection stopped, destroys the VM, and recreates it on the next call when the VM is killed mid-call", async () => {
		const pending = call("echo started; sleep 30", "bash");
		for (;;) {
			const parts = (await readdir(session.outputDirectory)).filter((name) => name.endsWith(".part"));
			if (parts.length === 1 && (await stat(join(session.outputDirectory, parts[0]))).size > 0) break;
			await sleep(50);
		}
		const name = runtime.activeSandbox.current?.name;
		expect(name).toBeDefined();
		const killed = await containerCommand(runtime, ["kill", name as string]);
		expect(killed.code, killed.stderr).toBe(0);

		const stopped = await pending;
		expect(stopped.result.status).toBe("failed");
		expect(stopped.result.exitCode).toBe(137);
		expect(stopped.result.inspection).toEqual({ state: "stopped" });
		expect(stopped.reply.isError).toBe(true);
		expect(stopped.reply.text).toContain("started");
		expect(stopped.reply.text).toContain("[The container stopped during the run; the output may be incomplete.]");
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await containersOf(session.sessionId)).toEqual([]);

		const next = await call("echo recreated", "bash");
		expect(next.result.status).toBe("ok");
		expect(next.reply).toEqual({ text: "recreated\n", isError: false });
		expect(runtime.activeSandbox.current?.name).toBeDefined();
		expect(runtime.activeSandbox.current?.name).not.toBe(name);
	}, 90_000);

	it("reports exit codes, tracebacks and the process limit", async () => {
		const failed = await call("raise ValueError('boom')");
		expect(failed.result).toMatchObject({ status: "failed", exitCode: 1 });
		expect(failed.result.inspection?.state).toBe("present");
		expect(failed.reply.text).not.toContain("[The container");
		expect(failed.reply.text).toContain("[run_code failed: exit 1]");
		expect(failed.reply.text).toMatch(/\[stderr\]\nTraceback[\s\S]*ValueError: boom\n\[\/stderr\]/);
		const procs = await call(
			"import subprocess\nps = []\nfailed = 0\nfor i in range(200):\n    try:\n        ps.append(subprocess.Popen(['sleep', '30']))\n    except BlockingIOError:\n        failed += 1\nprint(len(ps) < 200, failed > 0)\nfor p in ps:\n    p.kill()",
		);
		expect(procs.reply.text).toBe("True True\n");
	}, 60_000);

	it("reads the labels of containers and volumes from list and inspect", async () => {
		const name = `polar-sandbox-${session.sessionId}-998`;
		await sleeper(name);
		const [listed] = (await listing()).filter((container) => container.name === name);
		expect(listed.labels).toMatchObject({ "polar-session": session.sessionId, "polar-root": root });
		const inspected = await containerCommand(runtime, ["volume", "inspect", workVolumeName(session.sessionId)]);
		expect(inspected.code).toBe(0);
		const [volume] = parseListing(inspected.stdout, "name") ?? [];
		expect(volume).toEqual({
			name: workVolumeName(session.sessionId),
			labels: { "polar-session": session.sessionId, "polar-root": root },
		});
		const volumes = await containerCommand(runtime, ["volume", "list", "--format", "json"]);
		expect(parseListing(volumes.stdout, "name")).toContainEqual(volume);
		expect((await containerCommand(runtime, ["delete", "--force", name])).code).toBe(0);
	}, 60_000);

	it("confirms kill and delete --force through the listing", async () => {
		const hot = runtime.activeSandbox.current;
		runtime.activeSandbox.current = undefined;
		if (hot !== undefined) await hot.destroy(Date.now() + 30_000);

		const name = `polar-sandbox-${session.sessionId}-997`;
		await sleeper(name);
		const killed = await timed("kill", () => containerCommand(runtime, ["kill", name]));
		expect(killed.code, killed.stderr).toBe(0);
		expect(await containersOf(session.sessionId)).toEqual([name]);
		const deleted = await timed("delete --force", () => containerCommand(runtime, ["delete", "--force", name]));
		expect(deleted.code, deleted.stderr).toBe(0);
		expect(await containersOf(session.sessionId)).toEqual([]);
	}, 60_000);

	it("removes the leftovers of the session at start", async () => {
		const name = `polar-sandbox-${session.sessionId}-999`;
		await sleeper(name);
		expect(await containersOf(session.sessionId)).toEqual([name]);
		expect(await timed("recovery", () => recoverLeftovers(runtime, warn))).toEqual({ clean: true });
		expect(await containersOf(session.sessionId)).toEqual([]);
	}, 60_000);

	it("refuses to mount a volume with a foreign root label", async () => {
		const foreignHandle = await acquireSession(`real-foreign-${randomUUID().slice(0, 8)}`, root, root);
		const volume = workVolumeName(foreignHandle.paths.sessionId);
		try {
			const created = await containerCommand(runtime, [
				"volume",
				"create",
				"-s",
				"64M",
				"--label",
				`polar-session=${foreignHandle.paths.sessionId}`,
				"--label",
				"polar-root=/elsewhere",
				volume,
			]);
			expect(created.code, created.stderr).toBe(0);
			const { runtime: refused, readiness } = await startedRuntime(foreignHandle);
			expect(readiness).toEqual({
				ready: false,
				message: `sandbox is off: the volume ${volume} is not this session's: its polar-root label is /elsewhere, expected ${root}`,
				leftovers: [],
			});
			expect(refused.state).toBe("unready");
			const inspected = await containerCommand(runtime, ["volume", "inspect", volume]);
			expect(inspected.code).toBe(0);
			expect(parseListing(inspected.stdout, "name")?.[0].labels).toMatchObject({ "polar-root": "/elsewhere" });
			expect(await containersOf(foreignHandle.paths.sessionId)).toEqual([]);
		} finally {
			await containerCommand(runtime, ["volume", "delete", volume]);
			await foreignHandle.release();
		}
	}, 120_000);

	it("deletes the container and closes the file at shutdown with a running program", async () => {
		const ownHandle = await acquireSession(`real-shutdown-${randomUUID().slice(0, 8)}`, root, root);
		const paths = ownHandle.paths;
		const { runtime: closing, readiness } = await startedRuntime(ownHandle);
		try {
			expect(readiness).toEqual({ ready: true });
			const request: SandboxRequest = { language: "bash", code: "echo started; sleep 60" };
			const admitted = admitCall(closing, request, undefined, "call-1");
			if (admitted === undefined) throw new Error("the call was not admitted");
			const finished = admitted
				.run()
				.then((result) => buildReply(result, request, closing.limits, paths).then((reply) => ({ result, reply })))
				.finally(() => admitted.dispose());
			for (;;) {
				const parts = (await readdir(paths.outputDirectory)).filter((name) => name.endsWith(".part"));
				if (parts.length === 1 && (await stat(join(paths.outputDirectory, parts[0]))).size > 0) break;
				await sleep(50);
			}
			const [name] = await containersOf(paths.sessionId);

			await timed("shutdown with a running program", () => shutdownRuntime(closing, "reload", warn));

			const { result, reply } = await finished;
			expect(result.status).toBe("cancelled");
			expect(reply.text).toContain("started");
			expect(reply.text).toContain("Cancelled.");
			expect(await containersOf(paths.sessionId)).not.toContain(name);
			expect((await readdir(paths.outputDirectory)).filter((file) => file.endsWith(".part"))).toEqual([]);
			expect(closing.state).toBe("closed");
			expect(await exists(join(paths.outputDirectory, "lock"))).toBe(false);
		} finally {
			await containerCommand(runtime, ["volume", "delete", workVolumeName(paths.sessionId)]);
			await ownHandle.release();
		}
	}, 120_000);
});
