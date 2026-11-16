import { access, mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSize } from "../../../core/tools/truncate.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { describeBytes, discardOutputFile, openOutputFile, READ_MAX_BYTES, readManifest } from "../../shared/store.ts";
import { commandFailure } from "../src/cli.ts";
import { buildReply, commandLine, finalizeOutput, formatReply } from "../src/reply.ts";
import type {
	Inspection,
	OutputLimit,
	SandboxLimits,
	SandboxRequest,
	SandboxResult,
	SandboxStatus,
	SessionPaths,
} from "../src/types.ts";
import { testLimits } from "./fixtures.ts";

const store = vi.hoisted(() => ({
	failOpenOf: undefined as string | undefined,
	failPublicationOf: undefined as string | undefined,
}));
vi.mock(import("../../shared/store.ts"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		saveBytes: async (...args: Parameters<typeof original.saveBytes>) => {
			if (store.failOpenOf !== undefined && args[1] === store.failOpenOf) {
				return { saveFailed: { message: `ENOSPC: no space left on device, open '${args[1]}-2.part'` } };
			}
			if (store.failPublicationOf !== undefined && args[1] === store.failPublicationOf) {
				throw new Error("the publication failed");
			}
			return original.saveBytes(...args);
		},
	};
});

const request: SandboxRequest = { language: "python", code: "\n  print(1)\nprint(2)\n" };
const STATUS_PREFIX = "python: print(1)";
const limits: SandboxLimits = { ...testLimits, replyMaxLines: 40, replyMaxBytes: 4096 };
const STORE_LIMITS = { fileMaxBytes: 64 * 1024 * 1024, sessionMaxBytes: 256 * 1024 * 1024 };
const LEFTOVER = { container: "polar-sandbox-current-1-abcdef01", message: "delete: timed out; list: unreadable" };
const LEFTOVER_LINE =
	"[The container polar-sandbox-current-1-abcdef01 could not be deleted: delete: timed out; list: unreadable. Do not rerun the program for this; tell the user.]";
const STOPPED_LINE = "[The container stopped during the run; the output may be incomplete.]";
const ABSENT_LINE = "[The container was not found after the run; whether the program started is not known.]";
const UNINSPECTED_LINE = "[The container could not be inspected: timed out.]";
const NO_STDERR = Buffer.alloc(0);

let root: string;
let handle: SessionHandle;
let session: SessionPaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-reply-"));
	handle = await acquireSession("current", root, root);
	session = handle.paths;
	store.failOpenOf = undefined;
	store.failPublicationOf = undefined;
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
});

function bytes(text: string): Buffer {
	return Buffer.from(text, "utf8");
}

async function result(fields: Partial<SandboxResult>, stdout = ""): Promise<SandboxResult> {
	const opened = await openOutputFile(session, "run_code", STORE_LIMITS);
	if (!("opened" in opened)) throw new Error("the session quota refused the test file");
	await pipeline(Readable.from([Buffer.from(stdout)]), opened.opened.sink);
	return { status: "ok", exitCode: 0, output: opened.opened, stderr: NO_STDERR, elapsedMs: 300, ...fields };
}

function bare(fields: Partial<SandboxResult>): SandboxResult {
	return { status: "ok", exitCode: 0, stderr: NO_STDERR, elapsedMs: 300, ...fields };
}

function build(taken: SandboxResult, used: SandboxLimits = limits) {
	return buildReply(taken, request, used, session);
}

async function savedFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory).catch(() => []))
		.filter((name) => name !== "manifest.jsonl" && name !== "lock")
		.sort();
}

function rows(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `row ${index + 1}`).join("\n")}\n`;
}

function errLines(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `err ${index + 1}`).join("\n")}\n`;
}

function pathOf(file: string): string {
	return join(session.outputDirectory, file);
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

const READ_WAY = (file: string) => `read it with "read" tool, or process it with "run_code" tool from /data/${file}.`;

describe("buildReply", () => {
	it("returns raw stdout and deletes .part on plain ok, names an empty stdout, and keeps the stderr tail", async () => {
		const reply = await build(await result({}, rows(5)));
		expect(reply).toEqual({ text: rows(5), isError: false });
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);

		const empty = await build(await result({}));
		expect(empty).toEqual({ text: `[run_code ok] ${STATUS_PREFIX}\n\n[stdout is empty]`, isError: false });

		const stderr = errLines(100).trimEnd();
		const noisy = await build(await result({ stderr: bytes(stderr) }, "fine\n"));
		expect(noisy.text).toContain("err 100[/stderr]\n[stderr: last 13 of 100 lines shown. Saved as ");
		expect(noisy.text).not.toContain("err 1\n");
		expect(noisy.text).toContain("fine");
		expect(noisy.isError).toBe(false);
	});

	it("publishes the file with the outcome by how the run ended or deletes it, naming the absolute path", async () => {
		const statuses: SandboxStatus[] = [
			"ok",
			"failed",
			"timeout",
			"cancelled",
			"output_limit",
			"work_limit",
			"out_of_memory",
		];
		const outputs: [string, string][] = [
			["fits", rows(3)],
			["does not fit", rows(500)],
		];
		const stderrs: [string, string][] = [
			["empty", ""],
			["present", "Traceback\nValueError: x\n"],
		];
		let published = 0;
		for (const status of statuses) {
			for (const [output, stdout] of outputs) {
				for (const [stderrCase, stderr] of stderrs) {
					const form = `${status}, output ${output}, stderr ${stderrCase}`;
					const exitCode = status === "ok" ? 0 : status === "failed" ? 3 : 137;
					const taken = await result({ status, exitCode, stderr: bytes(stderr) }, stdout);
					const name = taken.output?.name ?? "";
					const reply = await build(taken);
					const files = (await savedFiles()).filter((file) => file.startsWith(`${name}.`));
					const manifest = await readManifest(session);
					expect(reply.isError, form).toBe(status !== "ok");
					if (output === "fits") {
						expect(files, form).toEqual([]);
						expect(manifest, form).toHaveLength(published);
						expect(reply.text, form).toContain(stdout.trimEnd());
						expect(reply.text, form).not.toContain("Saved as");
					} else {
						const complete = status === "ok" || status === "failed";
						const file = `${name}${complete ? ".txt" : ".truncated.txt"}`;
						published += 1;
						expect(files, form).toEqual([file]);
						expect(manifest, form).toHaveLength(published);
						expect(manifest.at(-1), form).toMatchObject({
							file,
							tool: "run_code",
							command: STATUS_PREFIX,
							status: complete ? "complete" : "truncated",
						});
						const path = /Saved as (.+?) \(/.exec(reply.text)?.[1] ?? "";
						expect(isAbsolute(path), form).toBe(true);
						expect(path, form).toBe(pathOf(file));
						expect(await exists(path), form).toBe(true);
						expect(reply.text, form).toContain(
							`Saved as ${path} (${formatSize((await stat(path)).size)}); ${READ_WAY(file)}`,
						);
					}
					if (stderr !== "") expect(reply.text, form).toContain(`[stderr]\n${stderr}[/stderr]`);
				}
			}
		}
		expect(published).toBe(statuses.length * stderrs.length);
	});

	it("points a file over 16 MiB to /data only and up to 16 MiB to read and /data", async () => {
		const small = await build(await result({}, rows(500)));
		expect(small.text).toContain(`Saved as ${pathOf("run_code-1.txt")} (`);
		expect(small.text).toContain(READ_WAY("run_code-1.txt"));

		const line = `${"x".repeat(1023)}\n`;
		const big = line.repeat(READ_MAX_BYTES / 1024 + 1);
		const large = await build(await result({}, big));
		expect(large.text).toContain(`Saved as ${pathOf("run_code-2.txt")} (`);
		expect(large.text).toContain('process it with "run_code" tool from /data/run_code-2.txt.');
		expect(large.text).not.toContain('read it with "read" tool');
	});

	it("formats the status line, cuts a first line over the byte limit, and states the message per status", async () => {
		expect(commandLine(request)).toBe("python: print(1)");
		expect(commandLine({ language: "bash", code: "rg -c error /data/k8s_logs-3.txt" })).toBe(
			"bash: rg -c error /data/k8s_logs-3.txt",
		);
		const longCode = commandLine({ language: "python", code: "x".repeat(300) });
		expect(longCode).toHaveLength("python: ".length + 100);
		expect(longCode.endsWith("…")).toBe(true);
		expect(commandLine({ language: "bash", code: "   \n\n" })).toBe("bash: ");

		const longFirstLine = await build(await result({}, `${"y".repeat(5000)}\n`));
		expect(longFirstLine.text).toMatch(/\[Line 1 is longer than the \S+ limit; nothing shown\. Saved as /);
		expect(longFirstLine.text).toContain(`Saved as ${pathOf("run_code-1.txt")} (`);
		expect(longFirstLine.text).toContain('process it with "run_code" tool from /data/run_code-1.txt.]');

		for (const exitCode of [137, 3]) {
			const failedExit = await build(await result({ status: "failed", exitCode, inspection: { state: "present" } }));
			expect(failedExit, String(exitCode)).toEqual({
				text: `[run_code failed: exit ${exitCode}] ${STATUS_PREFIX}`,
				isError: true,
			});
			expect(failedExit.text).not.toMatch(/killed|cause/);
		}

		const cases: [Partial<SandboxResult>, string[]][] = [
			[{ status: "timeout", exitCode: 137 }, ["[run_code timeout]", "run_code did not finish in 10 s."]],
			[{ status: "cancelled", exitCode: 137 }, ["[run_code cancelled]", "Cancelled."]],
			[
				{
					status: "out_of_memory",
					exitCode: 137,
					oomEvidence: "Memory cgroup out of memory: Killed process 129 (python3)",
				},
				[
					"[run_code out_of_memory]",
					`The ${describeBytes(limits.memoryBytes)} memory limit was reached and the process was killed. Kernel: Memory cgroup out of memory: Killed process 129 (python3)`,
				],
			],
			[
				{ status: "work_limit", exitCode: 199 },
				[
					"[run_code work_limit]",
					`The ${describeBytes(limits.workMaxBytes)} /work limit was reached and the process was killed.`,
				],
			],
			[{ status: "failed", exitCode: 137 }, ["[run_code failed: exit 137]"]],
		];
		for (const [fields, expected] of cases) {
			const reply = await build(await result(fields, "partial\n"));
			expect(reply.isError).toBe(true);
			for (const text of expected) expect(reply.text, fields.status).toContain(text);
			expect(reply.text).toContain("partial");
			expect(reply.text, fields.status).not.toContain("Write less");
		}

		const limitCases: [OutputLimit, string][] = [
			["stdout", "[stdout reached the 1 MiB file limit; the program was stopped; the output is incomplete.]"],
			["stderr", "[stderr reached the 64 KiB limit; the program was stopped; the output is incomplete.]"],
			[
				"session",
				"[The session output quota of 16 MiB was reached; the program was stopped; the output is incomplete.]",
			],
		];
		for (const [limit, line] of limitCases) {
			const reply = await build(await result({ status: "output_limit", exitCode: 137, limit }, "partial\n"));
			expect(reply, limit).toEqual({
				text: `[run_code output_limit] ${STATUS_PREFIX}\n\npartial\n\n${line}`,
				isError: true,
			});
		}
		const raised = { ...limits, stderrMaxBytes: 8 * 1024 * 1024 };
		const raisedReply = await build(await result({ status: "output_limit", exitCode: 137, limit: "stderr" }), raised);
		expect(raisedReply.text).toContain("[stderr reached the 8 MiB limit;");

		const saveFailed = await build(
			bare({ status: "save_failed", exitCode: null, saveError: { message: "disk full" } }),
		);
		expect(saveFailed.text).toContain("The output could not be saved: disk full. Tell the user.");

		const runtimeFailed = await build(
			bare({ status: "runtime_failed", exitCode: null, runtimeMessage: "spawn container ENOENT" }),
		);
		expect(runtimeFailed.text).toBe(
			`[run_code runtime_failed] ${STATUS_PREFIX}\n\nspawn container ENOENT\n\nThe container runtime failed to run the code. Tell the user.`,
		);
	});

	it("passes short stderr unchanged, saves long stderr whole with its tail shown, and reports stderr save failures", async () => {
		const shortCases: [string, string][] = [
			["  warn \n\n", "[stderr]\n  warn \n\n[/stderr]"],
			["\n", "[stderr]\n\n[/stderr]"],
			["no newline at the end", "[stderr]\nno newline at the end[/stderr]"],
			["\tß → ü\n", "[stderr]\n\tß → ü\n[/stderr]"],
		];
		for (const [stderr, section] of shortCases) {
			const reply = await build(await result({ stderr: bytes(stderr) }, "fine\n"));
			expect(reply, JSON.stringify(stderr)).toEqual({
				text: `[run_code ok] ${STATUS_PREFIX}\n\nfine\n\n${section}`,
				isError: false,
			});
		}
		const failedShort = await build(await result({ status: "failed", exitCode: 1, stderr: bytes("boom\n") }));
		expect(failedShort.text).toBe(`[run_code failed: exit 1] ${STATUS_PREFIX}\n\n[stderr]\nboom\n[/stderr]`);
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);

		const stderr = errLines(60);
		const ok = await build(await result({ stderr: bytes(stderr) }, "fine\n"));
		const [entry] = await readManifest(session);
		expect(entry).toMatchObject({ tool: "run_code", command: STATUS_PREFIX, status: "complete" });
		expect(entry.file).toMatch(/^run_code-stderr-\d+\.txt$/);
		expect(await readFile(pathOf(entry.file), "utf8")).toBe(stderr);
		const tail = errLines(60).split("\n").slice(47, 60).join("\n");
		expect(ok).toEqual({
			text: `[run_code ok] ${STATUS_PREFIX}\n\nfine\n\n[stderr]\n${tail}\n[/stderr]\n[stderr: last 13 of 60 lines shown. Saved as ${pathOf(entry.file)} (${formatSize(entry.size)}); ${READ_WAY(entry.file)}]`,
			isError: false,
		});
		expect(await savedFiles()).toEqual([entry.file]);

		const stopped = await build(
			await result({ status: "timeout", exitCode: 137, stderr: bytes(stderr) }, "partial\n"),
		);
		const [, truncated] = await readManifest(session);
		expect(truncated).toMatchObject({ status: "truncated", command: STATUS_PREFIX });
		expect(truncated.file).toMatch(/^run_code-stderr-\d+\.truncated\.txt$/);
		expect(stopped.text).toContain(`Saved as ${pathOf(truncated.file)} (`);
		expect(stopped.text).toContain("run_code did not finish in 10 s.");

		const longLine = `${"x".repeat(3000)}\n`;
		const partial = await build(await result({ stderr: bytes(longLine) }, "fine\n"));
		expect(partial.text).toMatch(
			/\n\[stderr\]\nx+\n\[\/stderr\]\n\[stderr: last 1 of 1 lines shown; the first shown line is cut at its start\. Saved as /,
		);
		expect(partial.text).not.toContain(longLine);
		expect(Buffer.byteLength(partial.text)).toBeLessThanOrEqual(limits.replyMaxBytes);

		await rm(pathOf(entry.file));
		await rm(pathOf(truncated.file));
		const partialFile = (await savedFiles())[0];
		if (partialFile !== undefined) await rm(pathOf(partialFile));

		store.failOpenOf = "run_code-stderr";
		const forms: [SandboxStatus, number][] = [
			["ok", 0],
			["failed", 3],
		];
		for (const [status, exitCode] of forms) {
			const reply = await build(await result({ status, exitCode, stderr: bytes(stderr) }, "VISIBLE_STDOUT\n"));
			expect(reply.isError, status).toBe(status !== "ok");
			expect(reply.text, status).toMatch(status === "ok" ? /^\[run_code ok\] / : /^\[run_code failed: exit 3\] /);
			expect(reply.text, status).toContain("\n\nVISIBLE_STDOUT\n\n[stderr]\n");
			expect(reply.text, status).toContain(
				"err 60\n[/stderr]\n[stderr: last 13 of 60 lines shown. The rest could not be saved: ENOSPC: no space left on device, open 'run_code-stderr-2.part'.]",
			);
		}
		store.failOpenOf = undefined;

		const refused = await build(await result({ stderr: bytes(stderr) }, "fine\n"), {
			...limits,
			sessionMaxBytes: 0,
		});
		expect(refused.text).toMatch(
			/\[\/stderr\]\n\[stderr: last 13 of 60 lines shown\. The rest could not be saved: the session holds \S+ of saved output; the limit is 0B\.\]/,
		);
		const fileLimitFailed = await build(await result({ stderr: bytes(stderr) }, "fine\n"), {
			...limits,
			fileMaxBytes: 10,
		});
		expect(fileLimitFailed.text).toContain(
			"[/stderr]\n[stderr: last 13 of 60 lines shown. The rest could not be saved: the per-file limit was reached.]",
		);
		expect(await savedFiles()).toEqual([]);
	});

	it("propagates a publication error and leaves the .part file to the call", async () => {
		store.failPublicationOf = "run_code-stderr";
		const taken = await result({ stderr: bytes(errLines(60)) }, "fine\n");
		const partFile = pathOf(`${taken.output?.name}.part`);
		await expect(build(taken)).rejects.toThrow("the publication failed");
		expect(await exists(partFile)).toBe(true);
		if (taken.output !== undefined) await discardOutputFile(taken.output);
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);
	});

	it("keeps exit code, leftover container, and uncertain diagnosis on separate lines and stays within limits", async () => {
		const speaksOfStart = /\bprogram (?:ran|started)\b|\bcould not be inspected\b|\bstopped during the run\b/;
		expect(speaksOfStart.test("[The program ran, but its container could not be deleted.]")).toBe(true);
		expect(speaksOfStart.test(LEFTOVER_LINE)).toBe(false);
		const statuses: [SandboxStatus, number][] = [
			["ok", 0],
			["failed", 3],
		];
		const inspections: [Inspection | undefined, string[]][] = [
			[undefined, []],
			[{ state: "present" }, []],
			[{ state: "stopped" }, [STOPPED_LINE]],
			[{ state: "absent" }, [ABSENT_LINE]],
			[{ state: "unknown", detail: "timed out" }, [UNINSPECTED_LINE]],
		];
		for (const [status, exitCode] of statuses) {
			for (const [inspection, diagnosis] of inspections) {
				if (status === "ok" && inspection !== undefined) continue;
				for (const cleanupError of [undefined, LEFTOVER]) {
					const deletion = cleanupError === undefined ? "deleted" : "left over";
					const form = `${status}, inspection ${inspection?.state ?? "none"}, ${deletion}`;
					const taken = await result({ status, exitCode, inspection, cleanupError }, rows(3));
					const reply = await build(taken);
					const lines = reply.text.split("\n");
					const aboutStart = lines.filter((line) => speaksOfStart.test(line));
					const leftovers = lines.filter((line) => line.includes("could not be deleted"));
					expect(aboutStart, form).toEqual(diagnosis);
					expect(leftovers, form).toEqual(cleanupError === undefined ? [] : [LEFTOVER_LINE]);
					expect(reply.isError, form).toBe(status !== "ok");
					if (status === "ok" && cleanupError === undefined) {
						expect(reply.text, form).toBe(rows(3));
					} else {
						expect(lines[0], form).toBe(
							`[run_code ${status === "ok" ? "ok" : "failed: exit 3"}] ${STATUS_PREFIX}`,
						);
					}
				}
			}
		}

		const answer = { code: 1, stdout: "", stderr: "x\n".repeat(2200), timedOut: false };
		const longCleanup = {
			container: LEFTOVER.container,
			message: `delete: ${commandFailure(answer)}; still listed`,
		};
		const longInspection: Inspection = { state: "unknown", detail: commandFailure(answer) };
		for (const stdout of ["", "VISIBLE_STDOUT\n"]) {
			const taken = await result(
				{
					status: "failed",
					exitCode: 1,
					cleanupError: longCleanup,
					inspection: longInspection,
					stderr: bytes("ORIGINAL_ERROR\n"),
				},
				stdout,
			);
			const reply = await build(taken, testLimits);
			const form = stdout === "" ? "empty stdout" : "stdout";
			expect(reply.text.split("\n").length, form).toBeLessThanOrEqual(testLimits.replyMaxLines);
			expect(Buffer.byteLength(reply.text), form).toBeLessThanOrEqual(testLimits.replyMaxBytes);
			expect(reply.text, form).toMatch(/^\[run_code failed: exit 1\] /);
			expect(reply.text, form).toContain("[stderr]\nORIGINAL_ERROR\n[/stderr]");
			expect(reply.text, form).toContain(" more bytes not shown]; still listed. Do not rerun the program");
			if (stdout !== "") expect(reply.text, form).toContain("\n\nVISIBLE_STDOUT\n\n");
		}

		const wide = { ...testLimits, replyMaxLines: 60, replyMaxBytes: 8192 };
		const wideCleanup = {
			container: LEFTOVER.container,
			message: `delete: Error: ${Array(40).fill("x".repeat(70)).join("\n")}; still listed`,
		};
		const wideInspection: Inspection = { state: "unknown", detail: "y".repeat(1000) };
		const taken = await result(
			{
				status: "failed",
				exitCode: 3,
				cleanupError: wideCleanup,
				inspection: wideInspection,
				stderr: bytes(errLines(200)),
			},
			rows(500),
		);
		const finalized = await finalizeOutput(taken, request, wide, session);
		await rm(session.outputDirectory, { recursive: true, force: true });
		const reply = formatReply(finalized, request, wide);
		expect(reply.text.split("\n").length).toBeLessThanOrEqual(wide.replyMaxLines);
		expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(wide.replyMaxBytes);
		for (const text of [
			"[stderr]\n",
			"err 200\n[/stderr]\n[stderr: last ",
			"First ",
			wideCleanup.message,
			"y".repeat(1000),
		]) {
			expect(reply.text).toContain(text);
		}
	});

	it("names operator sizes in binary units", () => {
		expect(describeBytes(2 * 1024 ** 3)).toBe("2 GiB");
		expect(describeBytes(512 * 1024 ** 2)).toBe("512 MiB");
		expect(describeBytes(50 * 1024)).toBe("50 KiB");
		expect(describeBytes(1536)).toBe("1536 B");
	});
});
