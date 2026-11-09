import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireSession,
	type SessionContext,
	type SessionHandle,
	type SessionPaths,
	sessionContext,
} from "../session.ts";
import {
	discardOutputFile,
	type FileLimits,
	type FileOutcome,
	finishOutputFile,
	type OpenFile,
	type OpenOutcome,
	OutputLimitError,
	openOutputFile,
	readExcerpt,
	readManifest,
	type SavedFile,
	saveBytes,
} from "../store.ts";

const creation = vi.hoisted(() => ({
	hold: undefined as { reached: () => void; released: Promise<void> } | undefined,
}));
vi.mock(import("fs/promises"), async (importOriginal) => {
	const original = await importOriginal();
	const open = async (...args: Parameters<typeof original.open>) => {
		const hold = creation.hold;
		if (hold !== undefined && args[1] === "wx") {
			creation.hold = undefined;
			hold.reached();
			await hold.released;
		}
		return original.open(...args);
	};
	return { ...original, open };
});

const LIMITS: FileLimits = { fileMaxBytes: 1024, sessionMaxBytes: 4096 };
const RECORD = { tool: "k8s_logs", command: "kubectl logs web-0 --namespace=shop" };

let root: string;
let handle: SessionHandle;
let session: SessionPaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "polar-store-test-"));
	handle = await acquireSession("s", "/w", root);
	session = handle.paths;
});

afterEach(async () => {
	creation.hold = undefined;
	await discardOpenFiles();
	await handle.release();
	await rm(root, { recursive: true, force: true });
});

async function discardOpenFiles(): Promise<void> {
	let context: SessionContext;
	try {
		context = sessionContext(session);
	} catch {
		return;
	}
	for (const file of [...context.openFiles]) await discardOutputFile(file as OpenFile);
}

function opened(outcome: OpenOutcome): OpenFile {
	if (!("opened" in outcome)) throw new Error(`not opened: ${JSON.stringify(outcome)}`);
	return outcome.opened;
}

function stream(file: OpenFile, ...chunks: string[]): Promise<void> {
	return pipeline(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), file.sink);
}

async function save(text: string, outcome: FileOutcome = "complete", limits = LIMITS): Promise<SavedFile> {
	const file = opened(await openOutputFile(session, RECORD.tool, limits));
	await stream(file, text);
	const result = await finishOutputFile(file, outcome, RECORD);
	if (!("saved" in result)) throw new Error(result.saveFailed.message);
	return result.saved;
}

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

async function names(): Promise<string[]> {
	return (await readdir(session.outputDirectory)).filter((name) => name !== "lock").sort();
}

function holdNextCreation(): { reached: Promise<void>; release: () => void } {
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	creation.hold = { reached: reached.resolve, released: released.promise };
	return { reached: reached.promise, release: released.resolve };
}

async function manifestLines(): Promise<string[]> {
	const lines = (await readFile(join(session.outputDirectory, "manifest.jsonl"), "utf8")).split("\n");
	expect(lines.pop()).toBe("");
	return lines;
}

describe("openOutputFile", () => {
	it("opens a new private file per call", async () => {
		const first = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		expect(first.name).toBe("k8s_logs-1");
		expect(first.path).toBe(join(session.outputDirectory, "k8s_logs-1.part"));
		expect(await mode(session.outputDirectory)).toBe(0o700);
		expect(await mode(first.path)).toBe(0o600);

		const second = opened(await openOutputFile(session, "k8s_get", LIMITS));
		expect(second.name).toBe("k8s_get-2");
	});

	it("reserves the number before the first await", async () => {
		const hold = holdNextCreation();
		const pendingB = openOutputFile(session, "exec", LIMITS);
		await hold.reached;
		const fileA = opened(await openOutputFile(session, "exec", LIMITS));
		await stream(fileA, "output of A\n");
		const savedA = await finishOutputFile(fileA, "complete", { tool: "exec", command: "python: a()" });
		hold.release();
		const fileB = opened(await pendingB);
		await stream(fileB, "output of B\n");
		const savedB = await finishOutputFile(fileB, "complete", { tool: "exec", command: "python: b()" });

		expect([fileB.name, fileA.name]).toEqual(["exec-1", "exec-2"]);
		expect(savedA).toMatchObject({ saved: { file: "exec-2.txt" } });
		expect(savedB).toMatchObject({ saved: { file: "exec-1.txt" } });
		expect(await readFile(join(session.outputDirectory, "exec-2.txt"), "utf8")).toBe("output of A\n");
		expect(await readFile(join(session.outputDirectory, "exec-1.txt"), "utf8")).toBe("output of B\n");
		expect((await readManifest(session)).map((entry) => [entry.file, entry.command])).toEqual([
			["exec-2.txt", "python: a()"],
			["exec-1.txt", "python: b()"],
		]);
		expect(await manifestLines()).toHaveLength(2);

		const [third, fourth] = await Promise.all([
			openOutputFile(session, "k8s_events", LIMITS),
			openOutputFile(session, "k8s_events", LIMITS),
		]);
		expect([opened(third).name, opened(fourth).name]).toEqual(["k8s_events-3", "k8s_events-4"]);
	});

	it("refuses at the session quota", async () => {
		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 10 };
		await save("0123456789", "complete", limits);

		const outcome = await openOutputFile(session, "k8s_logs", limits);
		expect(outcome).toEqual({ refused: { usedBytes: 10, sessionMaxBytes: 10 } });
		expect(await names()).toEqual(["k8s_logs-1.txt", "manifest.jsonl"]);
	});

	it("reports a file that cannot be created as open_failed", async () => {
		await chmod(session.outputDirectory, 0o500);
		let outcome: OpenOutcome;
		try {
			outcome = await openOutputFile(session, "k8s_logs", LIMITS);
		} finally {
			await chmod(session.outputDirectory, 0o700);
		}
		expect(outcome).toHaveProperty("openFailed");
		if ("openFailed" in outcome) expect(outcome.openFailed.message).toContain("EACCES");
		expect(sessionContext(session).openFiles.size).toBe(0);
		expect(await names()).toEqual([]);
		expect(opened(await openOutputFile(session, "k8s_logs", LIMITS)).name).toBe("k8s_logs-2");
	});

	it("stops at the limits", async () => {
		const small = opened(await openOutputFile(session, "k8s_logs", { fileMaxBytes: 5, sessionMaxBytes: 1024 }));
		await expect(stream(small, "abc", "def")).rejects.toMatchObject({ name: "OutputLimitError", limit: "file" });
		const result = await finishOutputFile(small, "truncated", RECORD);
		expect(result).toMatchObject({ saved: { file: "k8s_logs-1.truncated.txt", size: 3, status: "truncated" } });
		expect(await readFile(join(session.outputDirectory, "k8s_logs-1.truncated.txt"), "utf8")).toBe("abc");

		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 8 };
		const left = opened(await openOutputFile(session, "k8s_get", limits));
		const right = opened(await openOutputFile(session, "k8s_get", limits));
		await stream(left, "1234");
		await expect(stream(right, "5", "6")).rejects.toBeInstanceOf(OutputLimitError);
		expect(right.bytesWritten()).toBe(1);
		await finishOutputFile(left, "complete", RECORD);
		await finishOutputFile(right, "truncated", RECORD);
	});

	it("keeps the quota across published files", async () => {
		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 10 };
		const first = opened(await openOutputFile(session, "k8s_get", limits));
		const second = opened(await openOutputFile(session, "k8s_get", limits));
		await stream(first, "123456");
		expect(await finishOutputFile(first, "complete", RECORD)).toHaveProperty("saved");

		await expect(stream(second, "123456")).rejects.toMatchObject({ limit: "session" });
		expect(second.bytesWritten()).toBe(0);
		await finishOutputFile(second, "truncated", RECORD);
		expect(await openOutputFile(session, "k8s_get", limits)).toHaveProperty("opened");
	});

	it("keeps sessions apart", async () => {
		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 10 };
		const otherHandle = await acquireSession("other", "/w", root);
		const other = otherHandle.paths;
		const busy = opened(await openOutputFile(session, "k8s_get", limits));
		await stream(busy, "123456789");

		const free = opened(await openOutputFile(other, "k8s_get", limits));
		await stream(free, "12345");
		expect(await finishOutputFile(free, "complete", RECORD)).toMatchObject({ saved: { size: 5 } });
		expect(await finishOutputFile(busy, "complete", RECORD)).toMatchObject({ saved: { size: 9 } });
		await otherHandle.release();
	});
});

describe("finishOutputFile", () => {
	it("publishes complete writes or fails", async () => {
		const saved = await save("hello\n");
		expect(saved).toEqual({
			file: "k8s_logs-1.txt",
			path: join(session.outputDirectory, "k8s_logs-1.txt"),
			size: 6,
			status: "complete",
		});
		expect(await names()).toEqual(["k8s_logs-1.txt", "manifest.jsonl"]);
		expect(await readFile(saved.path, "utf8")).toBe("hello\n");

		const broken = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		broken.sink.destroy(new Error("disk full"));
		expect(await finishOutputFile(broken, "complete", RECORD)).toEqual({ saveFailed: { message: "disk full" } });
		expect(await names()).toEqual(["k8s_logs-1.txt", "manifest.jsonl"]);

		await rm(join(session.outputDirectory, "manifest.jsonl"));
		await mkdir(join(session.outputDirectory, "manifest.jsonl"));
		const unlisted = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		await stream(unlisted, "x");
		const result = await finishOutputFile(unlisted, "complete", RECORD);
		expect(result).toHaveProperty("saveFailed");
		expect(await names()).toEqual(["k8s_logs-1.txt", "manifest.jsonl"]);
	});

	it("names by outcome and records the file", async () => {
		await save("one\n");
		const saved = await save("two", "truncated");
		expect(saved.file).toBe("k8s_logs-2.truncated.txt");

		const entries = await readManifest(session);
		expect(entries).toEqual([
			{ v: 1, file: "k8s_logs-1.txt", ...RECORD, size: 4, status: "complete", createdAt: expect.any(String) },
			{
				v: 1,
				file: "k8s_logs-2.truncated.txt",
				...RECORD,
				size: 3,
				status: "truncated",
				createdAt: expect.any(String),
			},
		]);
		expect(new Date(entries[0].createdAt).toISOString()).toBe(entries[0].createdAt);
	});

	it("publishes <tool>-<n>.bin with status complete in artifact mode", async () => {
		const record = { tool: "k8s_inspect", command: "kubectl exec web-0 -- tar cf - /var/log" };
		const bytes = Buffer.from([0, 255, 10, 128]);
		const file = opened(await openOutputFile(session, record.tool, LIMITS));
		await pipeline(Readable.from([bytes]), file.sink);
		const result = await finishOutputFile(file, "complete", record, "artifact");

		expect(result).toEqual({
			saved: {
				file: "k8s_inspect-1.bin",
				path: join(session.outputDirectory, "k8s_inspect-1.bin"),
				size: 4,
				status: "complete",
			},
		});
		expect(await readFile(join(session.outputDirectory, "k8s_inspect-1.bin"))).toEqual(bytes);
		expect(await readManifest(session)).toEqual([
			{
				v: 1,
				file: "k8s_inspect-1.bin",
				...record,
				size: 4,
				status: "complete",
				createdAt: expect.any(String),
			},
		]);
	});

	it("the saved file's path opens from another working directory", async () => {
		const elsewhere = await mkdtemp(join(tmpdir(), "polar-store-cwd-"));
		const sessionCwd = join(elsewhere, process.cwd());
		await mkdir(sessionCwd, { recursive: true });
		try {
			const relativeRoot = relative(process.cwd(), root);
			await handle.release();
			handle = await acquireSession("s", sessionCwd, relativeRoot);
			session = handle.paths;
			const saved = await save("hello\n");

			expect(await readFile(resolve(sessionCwd, saved.path), "utf8")).toBe("hello\n");
			expect(isAbsolute(saved.path)).toBe(true);
			expect(saved.path).toBe(join(resolve(relativeRoot), "s", saved.file));
		} finally {
			await rm(elsewhere, { recursive: true, force: true });
		}
	});
});

describe("saveBytes", () => {
	it("saves bytes whole or leaves no file", async () => {
		const text = "line 1\nline 2\n";
		const saved = await saveBytes(session, "k8s_logs-stderr", LIMITS, Buffer.from(text), "complete", RECORD);
		expect(saved).toEqual({
			saved: {
				file: "k8s_logs-stderr-1.txt",
				path: join(session.outputDirectory, "k8s_logs-stderr-1.txt"),
				size: 14,
				status: "complete",
			},
		});
		expect(await readFile(join(session.outputDirectory, "k8s_logs-stderr-1.txt"), "utf8")).toBe(text);
		expect(await readManifest(session)).toEqual([
			{
				v: 1,
				file: "k8s_logs-stderr-1.txt",
				...RECORD,
				size: 14,
				status: "complete",
				createdAt: expect.any(String),
			},
		]);

		const binary = Buffer.from([0, 255, 10, 128]);
		const truncated = await saveBytes(session, "k8s_logs-stderr", LIMITS, binary, "truncated", RECORD);
		expect(truncated).toMatchObject({
			saved: { file: "k8s_logs-stderr-2.truncated.txt", size: 4, status: "truncated" },
		});
		expect(await readFile(join(session.outputDirectory, "k8s_logs-stderr-2.truncated.txt"))).toEqual(binary);

		const quota = { ...LIMITS, sessionMaxBytes: 18 };
		const refused = await saveBytes(session, "k8s_logs-stderr", quota, Buffer.from("x"), "complete", RECORD);
		expect(refused).toEqual({ refused: { usedBytes: 18, sessionMaxBytes: 18 } });

		const small = { ...LIMITS, fileMaxBytes: 4 };
		const overLimit = await saveBytes(session, "k8s_logs-stderr", small, Buffer.from("too long"), "complete", RECORD);
		expect(overLimit).toEqual({ saveFailed: { message: "the per-file limit was reached" } });

		await chmod(session.outputDirectory, 0o500);
		let unopened: Awaited<ReturnType<typeof saveBytes>>;
		try {
			unopened = await saveBytes(session, "k8s_logs-stderr", LIMITS, Buffer.from("x"), "complete", RECORD);
		} finally {
			await chmod(session.outputDirectory, 0o700);
		}
		expect(unopened).toHaveProperty("saveFailed");
		if ("saveFailed" in unopened) expect(unopened.saveFailed.message).toContain("EACCES");

		await rm(join(session.outputDirectory, "manifest.jsonl"));
		await mkdir(join(session.outputDirectory, "manifest.jsonl"));
		const unlisted = await saveBytes(session, "k8s_logs-stderr", LIMITS, Buffer.from("x"), "complete", RECORD);
		expect(unlisted).toHaveProperty("saveFailed");
		expect(await names()).toEqual(["k8s_logs-stderr-1.txt", "k8s_logs-stderr-2.truncated.txt", "manifest.jsonl"]);
	});
});

describe("discardOutputFile", () => {
	it("deletes the file and frees its quota", async () => {
		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 4 };
		const file = opened(await openOutputFile(session, "k8s_get", limits));
		await stream(file, "1234");
		await discardOutputFile(file);

		expect(await names()).toEqual([]);
		expect(await openOutputFile(session, "k8s_get", limits)).toHaveProperty("opened");
	});

	it("discard is idempotent", async () => {
		const kept = opened(await openOutputFile(session, "k8s_get", LIMITS));
		await stream(kept, "kept\n");
		expect(await finishOutputFile(kept, "complete", RECORD)).toHaveProperty("saved");
		await discardOutputFile(kept);
		expect(await names()).toEqual(["k8s_get-1.txt", "manifest.jsonl"]);
		expect((await readManifest(session)).map((entry) => entry.file)).toEqual(["k8s_get-1.txt"]);

		const dropped = opened(await openOutputFile(session, "k8s_get", LIMITS));
		await stream(dropped, "dropped\n");
		await discardOutputFile(dropped);
		await discardOutputFile(dropped);
		expect(await names()).toEqual(["k8s_get-1.txt", "manifest.jsonl"]);
		await expect(finishOutputFile(dropped, "complete", RECORD)).rejects.toThrow(
			`Not an open output file: ${dropped.path}`,
		);
		expect((await readManifest(session)).map((entry) => entry.file)).toEqual(["k8s_get-1.txt"]);
	});

	it("does not reuse the number of a discarded file within a context", async () => {
		const kept = await save("kept\n");
		const dropped = opened(await openOutputFile(session, "exec", LIMITS));
		await discardOutputFile(dropped);
		const next = opened(await openOutputFile(session, "exec", LIMITS));
		expect([kept.file, dropped.name, next.name]).toEqual(["k8s_logs-1.txt", "exec-2", "exec-3"]);
		await discardOutputFile(next);
		expect(await names()).toEqual(["k8s_logs-1.txt", "manifest.jsonl"]);

		await handle.release();
		handle = await acquireSession("s", "/w", root);
		session = handle.paths;
		expect(opened(await openOutputFile(session, "exec", LIMITS)).name).toBe("exec-2");
	});
});

describe("readExcerpt", () => {
	it("reads one bounded window", async () => {
		const saved = await save("line1\nline2\nline3\n");
		expect(await readExcerpt(saved, "head", 100)).toEqual({ text: "line1\nline2\nline3\n", cut: false });
		expect(await readExcerpt(saved, "head", 8)).toEqual({ text: "line1\n", cut: true });
		expect(await readExcerpt(saved, "tail", 8)).toEqual({ text: "line3\n", cut: true });
	});

	it("cuts at line boundaries", async () => {
		const longLine = await save("x".repeat(50));
		expect(await readExcerpt(longLine, "head", 10)).toEqual({ text: "x".repeat(10), cut: true });
		expect(await readExcerpt(longLine, "tail", 10)).toEqual({ text: "x".repeat(10), cut: true });

		const terminated = await save(`${"x".repeat(50)}\n`);
		expect(await readExcerpt(terminated, "tail", 10)).toEqual({ text: `${"x".repeat(9)}\n`, cut: true });
		expect(await readExcerpt(terminated, "head", 10)).toEqual({ text: "x".repeat(10), cut: true });

		const multibyte = await save("ää\nbb\n");
		expect(await readExcerpt(multibyte, "tail", 5)).toEqual({ text: "bb\n", cut: true });
		expect(await readExcerpt(multibyte, "head", 6)).toEqual({ text: "ää\n", cut: true });
	});
});

describe("readExcerpt of an open file", () => {
	it("waits for the stream to close", async () => {
		const file = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		await stream(file, "line1\nline2\n");
		expect(await readExcerpt(file, "tail", 100)).toEqual({ text: "line1\nline2\n", cut: false });
		await discardOutputFile(file);
	});

	it("reads the prefix after a limit stop", async () => {
		const file = opened(await openOutputFile(session, "k8s_logs", { fileMaxBytes: 5, sessionMaxBytes: 1024 }));
		await expect(stream(file, "abc\n", "defg")).rejects.toBeInstanceOf(OutputLimitError);
		expect(await readExcerpt(file, "head", 100)).toEqual({ text: "abc\n", cut: false });
		await discardOutputFile(file);
	});

	it("passes a disk error on", async () => {
		const file = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		file.sink.destroy(new Error("disk full"));
		await expect(readExcerpt(file, "head", 100)).rejects.toThrow("disk full");
		await discardOutputFile(file);
	});
});

describe("readManifest", () => {
	it("reads the manifest tolerantly", async () => {
		expect(await readManifest(session)).toEqual([]);

		const good = {
			v: 1,
			file: "k8s_get-1.txt",
			tool: "k8s_get",
			command: "kubectl get pods",
			size: 1,
			status: "complete",
			createdAt: "2026-10-17T12:00:00.000Z",
		};
		const later = { ...good, file: "k8s_get-3.txt" };
		await mkdir(session.outputDirectory, { recursive: true });
		await writeFile(
			join(session.outputDirectory, "manifest.jsonl"),
			[
				JSON.stringify(good),
				"not json",
				JSON.stringify({ v: 1, file: "k8s_get-2.txt" }),
				JSON.stringify(later),
				JSON.stringify({ ...good, file: "interrupted" }),
			].join("\n"),
		);

		expect(await readManifest(session)).toEqual([good, later]);
	});
});

describe("session context", () => {
	it("refuses after the context closed", async () => {
		const finished = opened(await openOutputFile(session, "k8s_get", LIMITS));
		await stream(finished, "done\n");
		expect(await finishOutputFile(finished, "complete", RECORD)).toHaveProperty("saved");
		const open = opened(await openOutputFile(session, "k8s_logs", LIMITS));
		await stream(open, "partial\n");

		await handle.release();

		const closed = `session context closed: ${session.outputDirectory}`;
		await expect(openOutputFile(session, "k8s_logs", LIMITS)).rejects.toThrow(closed);
		await expect(finishOutputFile(open, "complete", RECORD)).rejects.toThrow(closed);
		await expect(discardOutputFile(open)).rejects.toThrow(closed);
		await discardOutputFile(finished);
		expect(await names()).toEqual(["k8s_get-1.txt", "k8s_logs-2.part", "manifest.jsonl"]);
	});

	it("re-measures at a new creation", async () => {
		await save("0123456789");
		await handle.release();
		handle = await acquireSession("s", "/w", root);
		session = handle.paths;

		const limits = { fileMaxBytes: 1024, sessionMaxBytes: 10 };
		expect(await openOutputFile(session, "k8s_get", limits)).toEqual({
			refused: { usedBytes: 10, sessionMaxBytes: 10 },
		});
	});

	it("continues numbering from the highest published number at creation", async () => {
		await handle.release();
		await writeFile(join(session.outputDirectory, "k8s_get-3.txt"), "pods\n");
		await writeFile(join(session.outputDirectory, "exec-7.truncated.txt"), "rows\n");
		handle = await acquireSession("s", "/w", root);
		session = handle.paths;

		expect(opened(await openOutputFile(session, "k8s_logs", LIMITS)).name).toBe("k8s_logs-8");
	});

	it("shares one accounting between module copies", async () => {
		vi.resetModules();
		const sessionA = await import("../session.ts");
		const storeA = await import("../store.ts");
		vi.resetModules();
		const sessionB = await import("../session.ts");
		const storeB = await import("../store.ts");
		expect(storeB).not.toBe(storeA);
		expect(sessionB).not.toBe(sessionA);

		const copies = await sessionA.acquireSession("copies", "/w", root);
		const paths = copies.paths;
		try {
			const publications = Array.from({ length: 10 }, async (_, index) => {
				const store = index % 2 === 0 ? storeA : storeB;
				const file = opened(await store.openOutputFile(paths, "k8s_get", LIMITS));
				await stream(file, `${index}\n`);
				const record = { tool: "k8s_get", command: `kubectl get pods --selector=batch=${index}` };
				expect(await store.finishOutputFile(file, "complete", record)).toHaveProperty("saved");
				return file.name;
			});
			expect(await Promise.all(publications)).toEqual(
				Array.from({ length: 10 }, (_, index) => `k8s_get-${index + 1}`),
			);

			const manifest = await readFile(join(paths.outputDirectory, "manifest.jsonl"), "utf8");
			const lines = manifest.split("\n");
			expect(lines.pop()).toBe("");
			expect(lines).toHaveLength(10);
			for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
			const entries = await storeB.readManifest(paths);
			expect(entries).toHaveLength(10);
			expect(entries.map((entry) => entry.command).sort()).toEqual(
				Array.from({ length: 10 }, (_, index) => `kubectl get pods --selector=batch=${index}`).sort(),
			);
			expect(entries.map((entry) => entry.file).sort()).toEqual(
				Array.from({ length: 10 }, (_, index) => `k8s_get-${index + 1}.txt`).sort(),
			);

			const limits = { fileMaxBytes: 1024, sessionMaxBytes: 26 };
			const fileA = opened(await storeA.openOutputFile(paths, "k8s_get", limits));
			await stream(fileA, "123456");
			expect(await storeB.openOutputFile(paths, "exec", limits)).toEqual({
				refused: { usedBytes: 26, sessionMaxBytes: 26 },
			});
			expect(await storeA.finishOutputFile(fileA, "complete", RECORD)).toHaveProperty("saved");
			expect(await storeB.openOutputFile(paths, "exec", limits)).toEqual({
				refused: { usedBytes: 26, sessionMaxBytes: 26 },
			});
		} finally {
			await copies.release();
		}
	});
});
