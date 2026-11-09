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
import { buildReply } from "../src/reply.ts";
import { admitCall } from "../src/runner.ts";
import type { ExecLimits, ExecRequest, ExecRuntime, SessionPaths } from "../src/types.ts";
import {
	recoverLeftovers,
	SESSION_LABEL,
	sessionLabels,
	shutdownRuntime,
	startRuntime,
	workVolumeName,
} from "../src/workspace.ts";

const REAL = process.env.EXEC_REAL_RUNTIME === "1";
const IMAGE = process.env.EXEC_IMAGE ?? DEFAULT_IMAGE;

const limits: ExecLimits = {
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
let runtime: ExecRuntime;
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
	const started = { ...createRuntime(IMAGE, process.env, sessionHandle), limits };
	const readiness = await timed(`start ${sessionHandle.paths.sessionId}`, () => startRuntime(started, warn));
	if (readiness.ready) started.state = "open";
	return { runtime: started, readiness };
}

async function call(
	code: string,
	language: ExecRequest["language"] = "python",
	overrides: Partial<ExecLimits> = {},
	signal?: AbortSignal,
) {
	const used = { ...runtime, limits: { ...runtime.limits, ...overrides } };
	const request: ExecRequest = { language, code };
	const step = code.split("\n").find((line) => line.trim() !== "") ?? "";
	return timed(step, async () => {
		const admitted = admitCall(used, request, signal, randomUUID());
		if (admitted === undefined) throw new Error("the call was not admitted");
		try {
			const result = await admitted.run();
			return { result, reply: await buildReply(result, request, used.limits, session) };
		} finally {
			await admitted.dispose();
		}
	});
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

describe.skipIf(!REAL)("exec on the real runtime", () => {
	beforeAll(async () => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		root = await mkdtemp(join(homedir(), ".cache", "polar-exec-real-"));
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
		await containerCommand(runtime, ["volume", "delete", workVolumeName(session.sessionId)]);
		await handle.release();
		await rm(root, { recursive: true, force: true });
		console.table(timings);
	});

	it("runs python with duckdb and bash with ripgrep over /data", async () => {
		const sql = await call(
			"import duckdb\nprint(duckdb.sql(\"select count(*) from read_json('/data/k8s_logs-1.txt', format='newline_delimited') where status >= 500\").fetchone()[0])",
		);
		expect(sql.reply).toEqual({ text: "28572\n", isError: false });
		const rg = await call("rg -c '\"status\":503' /data/k8s_logs-1.txt", "bash");
		expect(rg.reply).toEqual({ text: "28572\n", isError: false });
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

	it("stops writes at the hard size of /work", async () => {
		const over = await call("head -c 200000000 /dev/zero > /work/big", "bash");
		expect(over.result.status).toBe("failed");
		expect(over.reply.text).toContain("No space left on device");
		expect((await call("rm -f /work/big; df -m /work | tail -1", "bash")).result.status).toBe("ok");
	}, 60_000);

	it("publishes a large stdout as a session file that the next call can read", async () => {
		const big = await call("head -c 40000000 /dev/zero | tr '\\0' x | fold -w 100", "bash");
		expect(big.result.status).toBe("ok");
		const [entry] = (await readManifest(session)).filter((item) => item.tool === "exec");
		expect(big.reply.text).toContain(`Saved as ${join(session.outputDirectory, entry.file)} (`);
		expect(big.reply.text).toContain(`process it with "exec" tool from /data/${entry.file}.`);
		expect(big.reply.text).not.toContain('read it with "read" tool');
		expect(entry.status).toBe("complete");
		expect(entry.command).toBe("bash: head -c 40000000 /dev/zero | tr '\\0' x | fold -w 100");
		expect((await stat(join(session.outputDirectory, entry.file))).size).toBe(entry.size);
		const next = await call(`wc -l < /data/${entry.file}`, "bash");
		expect(next.reply.text).toBe("399999\n");
	}, 120_000);

	it("names an out-of-memory kill from the kernel line", async () => {
		const oom = await call("b = bytearray(3 * 2**30)\nprint(len(b))");
		expect(oom.result.status).toBe("out_of_memory");
		expect(oom.result.oomEvidence).toContain("Killed process");
		expect(oom.reply.text).toContain("[exec out_of_memory]");
		expect(oom.reply.text).toContain("The 1 GiB memory limit was reached and the process was killed.");
	}, 60_000);

	it("stops the container at the timeout and on cancel, leaving nothing behind", async () => {
		const timeout = await call("echo started; sleep 60", "bash", { timeoutMs: 3000 });
		expect(timeout.result.status).toBe("timeout");
		expect(timeout.result.elapsedMs).toBeLessThan(15_000);
		expect(timeout.reply.text).toContain("started");
		expect(timeout.reply.text).toContain("exec did not finish in 3 s.");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		const cancelled = await call("sleep 60", "bash", {}, controller.signal);
		expect(cancelled.result.status).toBe("cancelled");
		expect(cancelled.result.elapsedMs).toBeLessThan(15_000);
		expect(await containersOf(session.sessionId)).toEqual([]);
		expect(runtime.owned.size).toBe(0);
	}, 60_000);

	it("reports exit codes, tracebacks and the process limit", async () => {
		const failed = await call("raise ValueError('boom')");
		expect(failed.result).toMatchObject({ status: "failed", exitCode: 1 });
		expect(failed.result.inspection?.state).toBe("present");
		expect(failed.reply.text).not.toContain("[The container");
		expect(failed.reply.text).toContain("[exec failed: exit 1]");
		expect(failed.reply.text).toMatch(/\[stderr\]\nTraceback[\s\S]*ValueError: boom\n\[\/stderr\]/);
		const procs = await call(
			"import subprocess\nps = []\nfailed = 0\nfor i in range(200):\n    try:\n        ps.append(subprocess.Popen(['sleep', '30']))\n    except BlockingIOError:\n        failed += 1\nprint(len(ps) < 200, failed > 0)\nfor p in ps:\n    p.kill()",
		);
		expect(procs.reply.text).toBe("True True\n");
	}, 60_000);

	it("reads the labels of containers and volumes from list and inspect", async () => {
		const name = `polar-exec-${session.sessionId}-998`;
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
		const name = `polar-exec-${session.sessionId}-997`;
		await sleeper(name);
		const killed = await timed("kill", () => containerCommand(runtime, ["kill", name]));
		expect(killed.code, killed.stderr).toBe(0);
		expect(await containersOf(session.sessionId)).toEqual([name]);
		const deleted = await timed("delete --force", () => containerCommand(runtime, ["delete", "--force", name]));
		expect(deleted.code, deleted.stderr).toBe(0);
		expect(await containersOf(session.sessionId)).toEqual([]);
	}, 60_000);

	it("removes the leftovers of the session at start", async () => {
		const name = `polar-exec-${session.sessionId}-999`;
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
				message: `exec is off: the volume ${volume} is not this session's: its polar-root label is /elsewhere, expected ${root}`,
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
			const request: ExecRequest = { language: "bash", code: "echo started; sleep 60" };
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
