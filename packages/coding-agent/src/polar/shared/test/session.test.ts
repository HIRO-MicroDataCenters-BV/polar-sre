import { spawn } from "child_process";
import { once } from "events";
import { existsSync, readFileSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { isAbsolute, join, relative } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireSession,
	artifactsRoot,
	type SessionContext,
	type SessionHandle,
	sessionLiveness,
	sessionPaths,
} from "../session.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "polar-artifacts-test-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function exitedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""]);
	const pid = child.pid as number;
	await once(child, "exit");
	return pid;
}

async function sessionDirectory(name: string, files: Record<string, string>, ageDays: number): Promise<string> {
	const directory = join(root, name);
	await mkdir(directory);
	for (const [file, content] of Object.entries(files)) {
		await writeFile(join(directory, file), content);
	}
	const then = (Date.now() - ageDays * DAY_MS) / 1000;
	await utimes(directory, then, then);
	return directory;
}

function registeredContext(outputDirectory: string): SessionContext | undefined {
	const slots = globalThis as Record<symbol, Map<string, SessionContext> | undefined>;
	return slots[Symbol.for("polar/session-registry@1")]?.get(outputDirectory);
}

describe("sessionPaths", () => {
	it("one directory per session", () => {
		const cwd = "/home/operator/project";
		expect(sessionPaths("a", cwd, root)).toEqual({ sessionId: "a", cwd, outputDirectory: join(root, "a") });
		expect(sessionPaths("b", cwd, root)).toEqual({ sessionId: "b", cwd, outputDirectory: join(root, "b") });

		expect(artifactsRoot({ POLAR_ARTIFACTS_DIR: "/srv/artifacts" })).toBe("/srv/artifacts");
		expect(artifactsRoot({ XDG_CACHE_HOME: "/cache" })).toBe("/cache/polar-artifacts");
		expect(artifactsRoot({})).toBe(join(homedir(), ".cache", "polar-artifacts"));
	});

	it("a relative root counts from the working directory of the process", () => {
		const paths = sessionPaths("s1", "/elsewhere", "artifacts/./a/../b");
		expect(paths.outputDirectory).toBe(join(process.cwd(), "artifacts", "b", "s1"));
		expect(isAbsolute(paths.outputDirectory)).toBe(true);
		expect(sessionPaths("s1", "/elsewhere", "/srv/artifacts").outputDirectory).toBe("/srv/artifacts/s1");
	});
});

describe("acquireSession", () => {
	it("creates, joins and closes the context", async () => {
		const directory = join(root, "current");
		const lock = join(directory, "lock");
		const unfinished = join(directory, "k8s_logs-1.part");
		const published = join(directory, "k8s_logs-2.txt");

		const first = await acquireSession("current", "/w", root, { pid: 4242 });
		expect(first.paths).toEqual(sessionPaths("current", "/w", root));
		expect(await readFile(lock, "utf8")).toBe("4242\n");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(lock)).mode & 0o777).toBe(0o600);
		expect(registeredContext(directory)?.nextFileNumber).toBe(1);

		await writeFile(unfinished, "partial");
		await writeFile(published, "done");
		const second = await acquireSession("current", "/w", root, { pid: 4343 });
		const third = await acquireSession("current", "/w", root, { pid: 4444 });
		expect(await exists(unfinished)).toBe(true);
		expect(await exists(published)).toBe(true);
		expect(await readFile(lock, "utf8")).toBe("4242\n");
		expect(registeredContext(directory)?.nextFileNumber).toBe(1);

		await second.release();
		await second.release();
		expect(await exists(lock)).toBe(true);
		await first.release();
		expect(await exists(lock)).toBe(true);
		await third.release();
		expect(await exists(lock)).toBe(false);
		expect(registeredContext(directory)).toBeUndefined();

		const again = await acquireSession("current", "/w", root, { pid: 4545 });
		expect(await readFile(lock, "utf8")).toBe("4545\n");
		expect(await exists(unfinished)).toBe(false);
		expect(await exists(published)).toBe(true);
		expect(registeredContext(directory)?.nextFileNumber).toBe(3);
		await third.release();
		expect(await readFile(lock, "utf8")).toBe("4545\n");
		await again.release();
		expect(await exists(lock)).toBe(false);
	});

	it("joins a context whose preparation is still running", async () => {
		const directory = join(root, "current");
		const lock = join(directory, "lock");
		const withLock = (handle: SessionHandle) => ({
			handle,
			lock: existsSync(lock) ? readFileSync(lock, "utf8") : undefined,
		});

		const [first, second] = await Promise.all([
			acquireSession("current", "/w", root, { pid: 4242 }).then(withLock),
			acquireSession("current", "/w", root, { pid: 4343 }).then(withLock),
		]);

		expect(first.lock).toBe("4242\n");
		expect(second.lock).toBe("4242\n");
		expect(registeredContext(directory)?.holders).toBe(2);
		await first.handle.release();
		expect(await exists(lock)).toBe(true);
		await second.handle.release();
		expect(await exists(lock)).toBe(false);
	});

	it("one context for every spelling of the root", async () => {
		const directory = join(root, "current");
		const lock = join(directory, "lock");
		const relativeRoot = relative(process.cwd(), root);

		const first = await acquireSession("current", "/w", relativeRoot, { pid: 4242 });
		const second = await acquireSession("current", "/w", root, { pid: 4343 });
		expect(first.paths.outputDirectory).toBe(directory);
		expect(second.paths.outputDirectory).toBe(directory);
		expect(registeredContext(directory)?.holders).toBe(2);
		expect(await readFile(lock, "utf8")).toBe("4242\n");

		await first.release();
		expect(await exists(lock)).toBe(true);
		await second.release();
		expect(await exists(lock)).toBe(false);
		expect(registeredContext(directory)).toBeUndefined();
	});

	it("measures the next file number at creation", async () => {
		const directory = join(root, "current");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "k8s_get-3.txt"), "pods\n");
		await writeFile(join(directory, "exec-7.truncated.txt"), "rows\n");
		await writeFile(join(directory, "k8s_inspect-9.bin"), Buffer.from([1, 2, 3, 4]));
		await writeFile(join(directory, "exec-12.part"), "partial");
		await writeFile(join(directory, "notes-20.md"), "operator notes");

		const creator = await acquireSession("current", "/w", root);
		expect(registeredContext(directory)?.nextFileNumber).toBe(10);
		expect(registeredContext(directory)?.publishedBytes).toBe(14);
		await creator.release();
	});

	it("repairs an incomplete trailing manifest line at creation", async () => {
		const directory = join(root, "current");
		const manifest = join(directory, "manifest.jsonl");
		const wholeLine =
			'{"v":1,"file":"k8s_get-8.txt","tool":"k8s_get","command":"kubectl get pods","size":5,"status":"complete","createdAt":"2026-10-17T12:00:00.000Z"}\n';
		await mkdir(directory, { recursive: true });

		await writeFile(manifest, `${wholeLine}{"v":1,"file":"k8s_get-9`);
		const first = await acquireSession("current", "/w", root);
		expect(await readFile(manifest, "utf8")).toBe(wholeLine);
		await first.release();

		await writeFile(manifest, `${wholeLine}{"v":1,"file":"k8s_get-9.txt","command":"${"x".repeat(10_000)}`);
		const second = await acquireSession("current", "/w", root);
		expect(await readFile(manifest, "utf8")).toBe(wholeLine);
		await second.release();

		await writeFile(manifest, '{"v":1,"file":"k8s_logs-9');
		const third = await acquireSession("current", "/w", root);
		expect(await readFile(manifest, "utf8")).toBe("");
		await third.release();
	});

	it("removes unfinished files and stale sessions only at creation", async () => {
		const directory = join(root, "current");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "k8s_logs-1.part"), "partial");
		await writeFile(join(directory, "k8s_logs-2.txt"), "done");
		const stale = await sessionDirectory("stale", { lock: `${await exitedPid()}\n`, "k8s_get-1.txt": "x" }, 8);
		const unlocked = await sessionDirectory("unlocked", { "k8s_get-1.txt": "x" }, 8);
		const live = await sessionDirectory("live", { lock: `${process.pid}\n`, "k8s_get-1.txt": "x" }, 30);
		const recent = await sessionDirectory("recent", {}, 6);
		const unreadable = await sessionDirectory("unreadable", { lock: `${await exitedPid()}\n` }, 30);
		await chmod(join(unreadable, "lock"), 0o000);
		try {
			const creator = await acquireSession("current", "/w", root);

			expect(await exists(join(directory, "k8s_logs-1.part"))).toBe(false);
			expect(await exists(join(directory, "k8s_logs-2.txt"))).toBe(true);
			expect(await exists(stale)).toBe(false);
			expect(await exists(unlocked)).toBe(false);
			expect(await exists(live)).toBe(true);
			expect(await exists(recent)).toBe(true);
			expect(await exists(unreadable)).toBe(true);

			const later = await sessionDirectory("later", { "k8s_get-1.txt": "x" }, 8);
			const joiner = await acquireSession("current", "/w", root);
			expect(await exists(later)).toBe(true);
			await joiner.release();
			await creator.release();
			const next = await acquireSession("current", "/w", root);
			expect(await exists(later)).toBe(false);
			await next.release();
		} finally {
			await chmod(join(unreadable, "lock"), 0o600);
		}
	});
});

describe("sessionLiveness", () => {
	it("reports liveness", async () => {
		await sessionDirectory("live", { lock: `${process.pid}\n` }, 0);
		await sessionDirectory("foreign", { lock: "1\n" }, 0);
		await sessionDirectory("unlocked", {}, 0);
		await sessionDirectory("exited", { lock: `${await exitedPid()}\n` }, 0);
		await sessionDirectory("garbage", { lock: "not a pid\n" }, 0);
		await sessionDirectory("zero", { lock: "0\n" }, 0);
		const unreadable = await sessionDirectory("unreadable", { lock: `${process.pid}\n` }, 0);
		await chmod(join(unreadable, "lock"), 0o000);
		try {
			expect(await sessionLiveness(root, "live")).toBe("alive");
			expect(await sessionLiveness(root, "foreign")).toBe("alive");
			expect(await sessionLiveness(root, "missing")).toBe("ended");
			expect(await sessionLiveness(root, "unlocked")).toBe("ended");
			expect(await sessionLiveness(root, "exited")).toBe("ended");
			expect(await sessionLiveness(root, "unreadable")).toBe("unknown");
			expect(await sessionLiveness(root, "garbage")).toBe("unknown");
			expect(await sessionLiveness(root, "zero")).toBe("unknown");
		} finally {
			await chmod(join(unreadable, "lock"), 0o600);
		}
	});
});
