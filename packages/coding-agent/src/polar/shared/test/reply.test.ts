import { mkdir, mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, isAbsolute, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSize } from "../../../core/tools/truncate.ts";
import type { OutputLimit, StreamResult } from "../process.ts";
import {
	buildReply,
	type FinalizedOutput,
	finalizeOutput,
	formatReply,
	type ProducerCall,
	type ReplyOptions,
} from "../reply.ts";
import type { ProducerLimits } from "../runtime.ts";
import { acquireSession, type SessionHandle, type SessionPaths } from "../session.ts";
import { type FileOutcome, openOutputFile, readManifest } from "../store.ts";

interface CommandSpec {
	tool: string;
	commandLabel: string;
}

const getPods: CommandSpec = {
	tool: "k8s_get",
	commandLabel: "kubectl get pods --namespace=prod --output=wide",
};

const listAllPods: CommandSpec = {
	tool: "k8s_get",
	commandLabel: "kubectl get pods --all-namespaces --output=wide",
};

const longJsonpath: CommandSpec = {
	tool: "k8s_get",
	commandLabel: `kubectl get pods --output=jsonpath=${"{.metadata.name}{.status.phase}".repeat(40)}`,
};

const copyOutArchive: CommandSpec = {
	tool: "k8s_inspect",
	commandLabel: "kubectl exec web-0 -- cat /var/log/app.tar.gz",
};

const STATUS_PREFIX = getPods.commandLabel;

const head: ReplyOptions = { maxLines: 40, maxBytes: 4096, selection: "head", keepHeader: false };
const tail: ReplyOptions = { ...head, selection: "tail" };
const tailWithHeader: ReplyOptions = { ...head, selection: "tail", keepHeader: true };
const headLimitedByBytes: ReplyOptions = { ...head, maxLines: 2000 };
const artifact: ReplyOptions = { ...head, mode: "artifact" };

const limits: ProducerLimits = {
	timeoutMs: 60_000,
	fileMaxBytes: 64 * 1024 * 1024,
	sessionMaxBytes: 256 * 1024 * 1024,
	stderrMaxBytes: 1024 * 1024,
	killGraceMs: 1000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
};
const LOGS_TIMEOUT_MS = 600_000;
const STORE_LIMITS = { fileMaxBytes: limits.fileMaxBytes, sessionMaxBytes: limits.sessionMaxBytes };
const READ_LIMIT = 16 * 1024 * 1024;
const NO_STDERR = Buffer.alloc(0);

let root: string;
let handle: SessionHandle;
let session: SessionPaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "shared-reply-"));
	handle = await acquireSession("current", root, root);
	session = handle.paths;
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
});

async function restartSession(): Promise<void> {
	await handle.release();
	await rm(session.outputDirectory, { recursive: true, force: true });
	handle = await acquireSession("current", root, root);
	session = handle.paths;
}

function bytes(text: string): Buffer {
	return Buffer.from(text, "utf8");
}

async function result(
	fields: Partial<StreamResult>,
	stdout: string | Buffer = "",
	tool = "k8s_get",
): Promise<StreamResult> {
	const opened = await openOutputFile(session, tool, STORE_LIMITS);
	if (!("opened" in opened)) throw new Error("the session quota refused the test file");
	const payload = typeof stdout === "string" ? Buffer.from(stdout) : stdout;
	await pipeline(Readable.from([payload]), opened.opened.sink);
	return { status: "ok", exitCode: 0, output: opened.opened, stderr: NO_STDERR, elapsedMs: 300, ...fields };
}

function bare(fields: Partial<StreamResult>): StreamResult {
	return { status: "ok", exitCode: 0, stderr: NO_STDERR, elapsedMs: 300, ...fields };
}

function callOf(command: CommandSpec, policy: ReplyOptions, timeoutMs = limits.timeoutMs): ProducerCall {
	return {
		request: command,
		tool: command.tool,
		commandLabel: command.commandLabel,
		options: policy,
		timeoutMs,
	};
}

function build(outcome: StreamResult, command = getPods, policy = head, used = limits) {
	return buildReply(outcome, callOf(command, policy, used.timeoutMs), used, session);
}

async function blockManifest(): Promise<void> {
	await mkdir(join(session.outputDirectory, "manifest.jsonl"), { recursive: true });
}

async function savedFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory).catch(() => []))
		.filter((name) => name !== "manifest.jsonl" && name !== "lock")
		.sort();
}

function podRow(number: number): string {
	return `web-${number}   1/1   Running`;
}

function podRows(count: number): string {
	const rows = Array.from({ length: count }, (_, index) => podRow(index + 1));
	return `${rows.join("\n")}\n`;
}

function wideRow(number: number): string {
	return `web-${number}   ${"app=web,tier=frontend,".repeat(9)}`;
}

function wideRows(count: number): string {
	const rows = Array.from({ length: count }, (_, index) => wideRow(index + 1));
	return `${rows.join("\n")}\n`;
}

function errLines(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `err ${index + 1}`).join("\n")}\n`;
}

function linesOf(text: string): string[] {
	return text.split("\n");
}

function lineCount(text: string): number {
	return text.endsWith("\n") ? linesOf(text).length - 1 : linesOf(text).length;
}

function capturedNumber(text: string, pattern: RegExp): number {
	const match = pattern.exec(text);
	expect(match, `no line matches ${pattern}`).not.toBeNull();
	return Number(match?.[1]);
}

function savedPath(name: string): string {
	return join(session.outputDirectory, name);
}

function savedAs(name: string, size = "[\\d.]+K?B"): string {
	const path = savedPath(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `Saved as ${path} \\(${size}\\)`;
}

function namedFile(text: string): string {
	const match = /Saved as (.+?) \([\d.]+[KM]?B\)/.exec(text);
	expect(match, "no notice names a saved file").not.toBeNull();
	return match?.[1] ?? "";
}

const READ_HINT = "read it with read, or narrow the request\\.";

const ENDINGS: [Partial<StreamResult>, string, FileOutcome][] = [
	[{ status: "ok", exitCode: 0 }, "k8s_get-1.txt", "complete"],
	[{ status: "failed", exitCode: 1 }, "k8s_get-1.txt", "complete"],
	[{ status: "failed", exitCode: null, signal: "SIGKILL" }, "k8s_get-1.truncated.txt", "truncated"],
	[{ status: "timeout", exitCode: null, elapsedMs: 60_000 }, "k8s_get-1.truncated.txt", "truncated"],
	[{ status: "cancelled", exitCode: null }, "k8s_get-1.truncated.txt", "truncated"],
	[{ status: "output_limit", exitCode: null, limit: "stdout" }, "k8s_get-1.truncated.txt", "truncated"],
];

describe("reply pipeline", () => {
	it("returns raw stdout and deletes .part on plain ok, and names an empty stdout", async () => {
		const table = "NAME    READY   STATUS\nweb-1   1/1     Running\n";
		expect(await build(await result({}, table))).toEqual({ text: table, isError: false });
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);

		expect(await build(await result({}))).toEqual({
			text: `[k8s_get ok] ${STATUS_PREFIX}\n\n[stdout is empty]`,
			isError: false,
		});
		expect(await savedFiles()).toEqual([]);

		const eventsInShop: CommandSpec = {
			tool: "k8s_events",
			commandLabel: "kubectl events --namespace=shop",
		};
		const noEvents = await result({ stderr: bytes("No events found in shop namespace.\n") });
		expect(await build(noEvents, eventsInShop)).toEqual({
			text: "[k8s_events ok] kubectl events --namespace=shop\n\n[stderr]\nNo events found in shop namespace.\n[/stderr]\n\n[stdout is empty]",
			isError: false,
		});

		const denied = await result({ status: "failed", exitCode: 1, stderr: bytes("Error from server (Forbidden)\n") });
		const failed = await build(denied);
		expect(linesOf(failed.text)).not.toContain("[stdout is empty]");
		expect(failed.isError).toBe(true);
	});

	it("deletes .part when whole stdout fits or publishes .txt / .truncated.txt with one manifest entry and full path", async () => {
		const stdout = podRows(500);
		const endings: [Partial<StreamResult>, string][] = [
			[{ status: "ok", exitCode: 0 }, "k8s_get-1.txt"],
			[{ status: "failed", exitCode: 1 }, "k8s_get-2.txt"],
			[{ status: "failed", exitCode: null, signal: "SIGKILL" }, "k8s_get-3.truncated.txt"],
			[{ status: "timeout", exitCode: null }, "k8s_get-4.truncated.txt"],
			[{ status: "cancelled", exitCode: null }, "k8s_get-5.truncated.txt"],
			[{ status: "output_limit", exitCode: null, limit: "stdout" }, "k8s_get-6.truncated.txt"],
		];
		for (const [fields, name] of endings) {
			const reply = await build(await result(fields, stdout));
			const named = namedFile(reply.text);
			expect(isAbsolute(named), `${named} is not a full path`).toBe(true);
			expect(dirname(named)).toBe(session.outputDirectory);
			expect(named).toBe(savedPath(name));
			expect(await readFile(named, "utf8")).toBe(stdout);
		}
		const names = endings.map(([, name]) => name).sort();
		expect(await savedFiles()).toEqual(names);
		const entries = await readManifest(session);
		expect(entries.map((entry) => [entry.file, entry.status, entry.command])).toEqual(
			endings.map(([, name]) => [name, name.endsWith(".truncated.txt") ? "truncated" : "complete", STATUS_PREFIX]),
		);

		const outputs = { fits: podRows(3), "does not fit": podRows(head.maxLines + 1) };
		const stderrs = { "no stderr": NO_STDERR, stderr: bytes("W1017 slow\n") };
		for (const [ending, published, fileStatus] of ENDINGS) {
			for (const [fit, text] of Object.entries(outputs)) {
				for (const [stderrPresence, stderr] of Object.entries(stderrs)) {
					const cell = `${ending.status}, ${fit}, ${stderrPresence}`;
					await restartSession();
					const reply = await build(await result({ ...ending, stderr }, text));

					const manifest = (await readManifest(session)).map((entry) => [entry.file, entry.status]);
					if (fit === "fits") {
						expect(await savedFiles(), cell).toEqual([]);
						expect(manifest, cell).toEqual([]);
						expect(reply.text, cell).toContain(text);
					} else {
						expect(await savedFiles(), cell).toEqual([published]);
						expect(await readFile(savedPath(published), "utf8"), cell).toBe(text);
						expect(manifest, cell).toEqual([[published, fileStatus]]);
						expect(reply.text, cell).toContain(`Saved as ${savedPath(published)} (`);
					}
				}
			}
		}

		await restartSession();
		const policy: ReplyOptions = { maxLines: 2000, maxBytes: 51_200, selection: "head", keepHeader: false };
		const row = (index: number) => `web-${String(index).padStart(4, "0")}   1/1   Running   ${"x".repeat(22)}`;
		const fiftyKb = `${Array.from({ length: 1000 }, (_, index) => row(index)).join("\n")}\n`;
		expect(Buffer.byteLength(fiftyKb)).toBe(50_000);

		expect(await build(await result({}, fiftyKb), getPods, policy)).toEqual({ text: fiftyKb, isError: false });
		expect(await savedFiles()).toEqual([]);

		const withStderr = await build(await result({ stderr: bytes("W1017 slow\n") }, fiftyKb), getPods, policy);
		expect(withStderr.text).toContain(fiftyKb);
		expect(Buffer.byteLength(withStderr.text)).toBeLessThanOrEqual(policy.maxBytes);
		expect(await savedFiles()).toEqual([]);

		const longStderr = bytes(`W1017 ${"x".repeat(1200)}\n`);
		const pushedOut = await build(await result({ stderr: longStderr }, fiftyKb), getPods, policy);
		expect(pushedOut.text).toMatch(new RegExp(`^\\[First \\d+ lines shown.*${savedAs("k8s_get-3.txt")}`, "m"));
		expect(Buffer.byteLength(pushedOut.text)).toBeLessThanOrEqual(policy.maxBytes);
		expect(await savedFiles()).toEqual(["k8s_get-3.txt"]);
	});

	it("keeps the reply within maxLines and maxBytes across the line-limit boundary sweep", async () => {
		const stderrs: [string, Buffer][] = [
			["no stderr", NO_STDERR],
			["stderr", bytes("W1017 slow\n")],
		];
		const tails = ["", "   \n\n"];
		for (const [stderrCase, stderr] of stderrs) {
			for (const trailing of tails) {
				for (let rows = 28; rows <= 40; rows += 1) {
					await restartSession();
					const stdout = `${podRows(rows)}${trailing}`;
					const reply = await build(await result({ stderr }, stdout));
					const form = `${rows} rows, ${stderrCase}, tail ${JSON.stringify(trailing)}`;
					const files = await savedFiles();
					if (files.length === 0) expect(reply.text, form).toContain(stdout);
					else expect(reply.text, form).toContain(`Saved as ${savedPath(files[0])} (`);
					expect(lineCount(reply.text), form).toBeLessThanOrEqual(head.maxLines);
					expect(Buffer.byteLength(reply.text), form).toBeLessThanOrEqual(head.maxBytes);
				}
			}
		}
	});

	it("formats head, tail, keepHeader, and single-line-over-byte-limit excerpt labels", async () => {
		const cutByLines = await build(await result({}, podRows(500)));
		const linesShown = capturedNumber(
			cutByLines.text,
			new RegExp(`^\\[First (\\d+) lines shown\\. ${savedAs("k8s_get-1.txt")}; ${READ_HINT}\\]$`, "m"),
		);
		expect(linesOf(cutByLines.text)).toContain(podRow(linesShown));
		expect(linesOf(cutByLines.text)).not.toContain(podRow(linesShown + 1));

		const cutByBytes = await build(await result({}, wideRows(100)), getPods, headLimitedByBytes);
		const rowsShown = capturedNumber(
			cutByBytes.text,
			new RegExp(
				`^\\[First (\\d+) lines shown \\([\\d.]+K?B limit\\)\\. ${savedAs("k8s_get-2.txt")}; ${READ_HINT}\\]$`,
				"m",
			),
		);
		expect(linesOf(cutByBytes.text)).toContain(wideRow(rowsShown));
		expect(linesOf(cutByBytes.text)).not.toContain(wideRow(rowsShown + 1));

		const table = `NAME    READY   STATUS\n${podRows(500)}`;
		const cutFromTail = await build(await result({}, table), getPods, tailWithHeader);
		const rowsFromTail = capturedNumber(
			cutFromTail.text,
			new RegExp(`^\\[Header \\+ last (\\d+) lines shown\\. ${savedAs("k8s_get-3.txt")}; ${READ_HINT}\\]$`, "m"),
		);
		const firstRowShown = 500 - rowsFromTail + 1;
		expect(cutFromTail.text).toContain(`NAME    READY   STATUS\n${podRow(firstRowShown)}\n`);
		expect(linesOf(cutFromTail.text)).toContain(podRow(500));
		expect(linesOf(cutFromTail.text)).not.toContain(podRow(firstRowShown - 1));

		const cutTail = await build(await result({}, podRows(500)), getPods, tail);
		const tailShown = capturedNumber(
			cutTail.text,
			new RegExp(`^\\[Last (\\d+) lines shown\\. ${savedAs("k8s_get-4.txt")}`, "m"),
		);
		expect(linesOf(cutTail.text)).toContain(podRow(500 - tailShown + 1));
		expect(linesOf(cutTail.text)).not.toContain(podRow(500 - tailShown));

		const longLine = await build(await result({}, "web-0 ".repeat(20 * 1024)));
		expect(longLine.text).toMatch(
			new RegExp(
				`^\\[Line 1 is longer than the [\\d.]+K?B limit; nothing shown\\. ${savedAs("k8s_get-5.txt", "120\\.0KB")}\\.\\]$`,
				"m",
			),
		);
		expect(longLine.text).not.toContain("jsonpath");
	});

	it("chooses the file notice by the 16 MiB read limit", async () => {
		const atReadLimit = await build(await result({}, `${"x".repeat(READ_LIMIT - 1)}\n`), getPods, tail);
		expect(atReadLimit.text).toContain(
			`Saved as ${savedPath("k8s_get-1.txt")} (16.0MB); read it with read, or narrow the request.`,
		);

		const overReadLimit = await build(await result({}, `${"x".repeat(READ_LIMIT)}\n`), getPods, tail);
		expect(overReadLimit.text).toContain(
			`Saved as ${savedPath("k8s_get-2.txt")} (16.0MB); it is over the 16 MiB read limit; narrow the request.`,
		);
	});

	it("formats every non-ok status with isError, status line, startError, and limit names", async () => {
		const cutOk = await build(await result({}, podRows(500)));
		expect(cutOk.isError).toBe(false);
		expect(linesOf(cutOk.text)[0]).toBe(`[k8s_get ok] ${STATUS_PREFIX}`);

		const forbiddenLine =
			'Error from server (Forbidden): pods is forbidden: User "dev" cannot list resource "pods"\n';
		const denied = await build(await result({ status: "failed", exitCode: 1, stderr: bytes(forbiddenLine) }));
		expect(denied).toEqual({
			text: `[k8s_get failed: exit 1] ${STATUS_PREFIX}\n\n[stderr]\n${forbiddenLine}[/stderr]`,
			isError: true,
		});
		const silent = await build(await result({ status: "failed", exitCode: 42 }));
		expect(silent).toEqual({ text: `[k8s_get failed: exit 42] ${STATUS_PREFIX}`, isError: true });

		const killed = await build(await result({ status: "failed", exitCode: null, signal: "SIGKILL" }, podRows(2)));
		expect(killed).toEqual({
			text: `[k8s_get failed: signal SIGKILL] ${STATUS_PREFIX}\n\n${podRows(2)}`,
			isError: true,
		});
		expect(killed.text).not.toMatch(/memory|cause|retry/i);

		const notStarted = await build(bare({ status: "failed", exitCode: null, startError: "spawn kubectl ENOENT" }));
		expect(notStarted).toEqual({
			text: `[k8s_get failed] ${STATUS_PREFIX}\n\nCould not start: spawn kubectl ENOENT`,
			isError: true,
		});

		const timedOut = await build(await result({ status: "timeout", exitCode: null, elapsedMs: 60_400 }), listAllPods);
		expect(timedOut).toEqual({
			text: `[k8s_get timeout] kubectl get pods --all-namespaces --output=wide\n\nDid not finish in 60 s.`,
			isError: true,
		});
		const slowLog = await result({ status: "timeout", exitCode: null, elapsedMs: 600_000 });
		const logsCall = callOf(getPods, head, LOGS_TIMEOUT_MS);
		expect((await buildReply(slowLog, logsCall, limits, session)).text).toContain("Did not finish in 600 s.");

		const cancelled = await build(bare({ status: "cancelled", exitCode: null }));
		expect(cancelled).toEqual({ text: `[k8s_get cancelled] ${STATUS_PREFIX}\n\nCancelled.`, isError: true });

		const cases: [OutputLimit, string][] = [
			["stdout", "[stdout reached the 64 MiB file limit; the output is incomplete.]"],
			["stderr", "[stderr reached the 1 MiB limit; the output is incomplete.]"],
			["session", "[The session output quota of 256 MiB was reached; the output is incomplete.]"],
		];
		for (const [limit, line] of cases) {
			const reply = await build(await result({ status: "output_limit", exitCode: null, limit }, "partial\n"));
			expect(reply, limit).toEqual({
				text: `[k8s_get output_limit] ${STATUS_PREFIX}\n\npartial\n\n${line}`,
				isError: true,
			});
			expect(reply.text, limit).not.toMatch(/stopped|Narrow| shown/);
		}
		const raised = { ...limits, stderrMaxBytes: 8 * 1024 * 1024 };
		const raisedReply = await build(
			await result({ status: "output_limit", exitCode: null, limit: "stderr" }),
			getPods,
			head,
			raised,
		);
		expect(raisedReply.text).toContain("[stderr reached the 8 MiB limit;");

		const message = "the session holds 8.0GB of saved output; the limit is 8.0GB";
		const unsaved = await build(bare({ status: "save_failed", exitCode: null, saveError: { message } }));
		expect(unsaved).toEqual({
			text: `[k8s_get save_failed] ${STATUS_PREFIX}\n\nThe output could not be saved: ${message}. Tell the user.`,
			isError: true,
		});
	});

	it("passes short stderr unchanged and saves long stderr whole while showing its tail within half the budget", async () => {
		const shortCases: [string, string][] = [
			["  warn \n\n", "[stderr]\n  warn \n\n[/stderr]"],
			["\n", "[stderr]\n\n[/stderr]"],
			["no newline at the end", "[stderr]\nno newline at the end[/stderr]"],
			["\tß → ü\n", "[stderr]\n\tß → ü\n[/stderr]"],
		];
		for (const [stderr, section] of shortCases) {
			const reply = await build(await result({ stderr: bytes(stderr) }, "fine\n"));
			expect(reply, JSON.stringify(stderr)).toEqual({
				text: `[k8s_get ok] ${STATUS_PREFIX}\n\nfine\n\n${section}`,
				isError: false,
			});
		}
		const failed = await build(await result({ status: "failed", exitCode: 1, stderr: bytes("boom\n") }));
		expect(failed.text).toBe(`[k8s_get failed: exit 1] ${STATUS_PREFIX}\n\n[stderr]\nboom\n[/stderr]`);
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);

		const stderr = errLines(60);
		const ok = await build(await result({ stderr: bytes(stderr) }, "fine\n"));
		const [entry] = await readManifest(session);
		expect(entry).toMatchObject({ tool: "k8s_get", command: STATUS_PREFIX, status: "complete" });
		expect(entry.file).toMatch(/^k8s_get-stderr-\d+\.txt$/);
		expect(await readFile(savedPath(entry.file), "utf8")).toBe(stderr);
		const shown = capturedNumber(ok.text, /^\[stderr: last (\d+) of 60 lines shown\. Saved as /m);
		const shownTail = errLines(60)
			.split("\n")
			.slice(60 - shown, 60)
			.join("\n");
		const stderrSection = `[stderr]\n${shownTail}\n[/stderr]\n[stderr: last ${shown} of 60 lines shown. Saved as ${savedPath(entry.file)} (${formatSize(entry.size)}); read it with read, or narrow the request.]`;
		expect(lineCount(stderrSection)).toBeLessThanOrEqual(Math.floor(head.maxLines / 2));
		expect(Buffer.byteLength(stderrSection)).toBeLessThanOrEqual(Math.floor(head.maxBytes / 2));
		expect(ok).toEqual({
			text: `[k8s_get ok] ${STATUS_PREFIX}\n\nfine\n\n${stderrSection}`,
			isError: false,
		});
		expect(await savedFiles()).toEqual([entry.file]);

		const prefixes: Partial<StreamResult>[] = [
			{ status: "timeout", exitCode: null },
			{ status: "failed", exitCode: null, signal: "SIGKILL" },
		];
		for (const fields of prefixes) {
			const reply = await build(await result({ ...fields, stderr: bytes(stderr) }, "partial\n"));
			const entries = await readManifest(session);
			const truncated = entries[entries.length - 1];
			expect(truncated, fields.status).toMatchObject({ status: "truncated", command: STATUS_PREFIX });
			expect(truncated.file, fields.status).toMatch(/^k8s_get-stderr-\d+\.truncated\.txt$/);
			expect(reply.text, fields.status).toContain(`Saved as ${savedPath(truncated.file)} (`);
		}

		const long = `${"x".repeat(3000)}\n`;
		const partial = await build(await result({ stderr: bytes(long) }, "fine\n"));
		expect(partial.text).toMatch(
			/\n\[stderr\]\nx+\n\[\/stderr\]\n\[stderr: last 1 of 1 lines shown; the first shown line is cut at its start\. Saved as /,
		);
		expect(partial.text).not.toContain(long);
		expect(Buffer.byteLength(partial.text)).toBeLessThanOrEqual(head.maxBytes);
	});

	it("keeps the command result and reports the failure when the stderr file cannot be saved", async () => {
		const stderr = errLines(60);
		const refusing = { ...limits, sessionMaxBytes: 0 };
		const refused = await build(
			await result({ status: "failed", exitCode: 1, stderr: bytes(stderr) }, "fine\n"),
			getPods,
			head,
			refusing,
		);
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/^\[k8s_get failed: exit 1\] /);
		expect(refused.text).toContain("\n\nfine\n\n[stderr]\n");
		expect(refused.text).toMatch(
			/\[\/stderr\]\n\[stderr: last \d+ of 60 lines shown\. The rest could not be saved: the session holds \S+ of saved output; the limit is 0B\.\]/,
		);
		expect(refused.text).toContain("err 60");
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);

		const small = { ...limits, fileMaxBytes: 10 };
		const failed = await build(await result({ stderr: bytes(stderr) }, "fine\n"), getPods, head, small);
		expect(failed.isError).toBe(false);
		expect(failed.text).toMatch(/^\[k8s_get ok\] /);
		expect(failed.text).toContain("\n\nfine\n\n[stderr]\n");
		expect(failed.text).toMatch(
			/\[\/stderr\]\n\[stderr: last \d+ of 60 lines shown\. The rest could not be saved: the per-file limit was reached\.\]/,
		);
		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);
	});

	it("shows the excerpt and reports [Full output could not be saved: ...] when stdout publication fails", async () => {
		await blockManifest();
		const degraded = await build(await result({}, podRows(500)));
		expect(linesOf(degraded.text)).toContain(podRow(1));
		expect(degraded.text).toMatch(/^\[First \d+ lines shown\.\]$/m);
		expect(degraded.text).toMatch(/^\[Full output could not be saved: .+\.\]$/m);
		expect(degraded.text).not.toContain("Saved as");
		expect(await savedFiles()).toEqual([]);

		const unsavedTail = await build(await result({}, podRows(500)), getPods, tail);
		expect(unsavedTail.text).toMatch(/^\[Last \d+ lines shown\.\]$/m);
		expect(unsavedTail.text).toMatch(/^\[Full output could not be saved: .+\.\]$/m);
		expect(unsavedTail.text).not.toContain("Saved as");
		expect(await savedFiles()).toEqual([]);

		const deep = join(root, "a".repeat(200), "b".repeat(200), "c".repeat(200));
		await mkdir(deep, { recursive: true });
		await handle.release();
		handle = await acquireSession("current", deep, deep);
		session = handle.paths;
		await mkdir(savedPath("k8s_get-1.txt"));

		const renameFailed = await build(await result({ status: "failed", exitCode: 1 }, podRows(500)));
		const notice = renameFailed.text.match(/^\[Full output could not be saved: .+\.\]$/m)?.[0] ?? "";
		expect(notice).toContain("rename");
		expect(notice).toMatch(/\[\d+ more bytes not shown\]/);
		expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(Math.floor(head.maxBytes * 0.15));
		expect(renameFailed.text).toMatch(/^\[First \d+ lines shown\.\]$/m);
		expect(renameFailed.text).not.toContain("Saved as");
		expect(linesOf(renameFailed.text)).toContain(podRow(1));
		expect(linesOf(renameFailed.text).length).toBeLessThanOrEqual(head.maxLines);
		expect(Buffer.byteLength(renameFailed.text)).toBeLessThanOrEqual(head.maxBytes);
	});

	it("keeps the reply within maxLines and maxBytes when every notice and long command label appear at once", async () => {
		for (const message of ["x".repeat(5000), "disk error\n".repeat(100), "🙂".repeat(2000)]) {
			const reply = await build(bare({ status: "save_failed", exitCode: null, saveError: { message } }));
			const notice = reply.text.slice(reply.text.indexOf("The output could not be saved: "));
			expect(notice).toMatch(/^The output could not be saved: /);
			expect(notice).toMatch(/\[\d+ more bytes not shown\]\. Tell the user\.$/);
			expect(notice).not.toContain("\uFFFD");
			expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(Math.floor(head.maxBytes * 0.15));
			expect(lineCount(notice)).toBeLessThanOrEqual(Math.floor(head.maxLines * 0.15));
			expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(head.maxBytes);
			expect(lineCount(reply.text)).toBeLessThanOrEqual(head.maxLines);
		}

		const longSelector: CommandSpec = {
			tool: "k8s_get",
			commandLabel: `kubectl get pods --selector=${"x".repeat(60_000)}`,
		};
		const shortSaveError = await build(
			bare({ status: "save_failed", exitCode: null, saveError: { message: "disk full" } }),
			longSelector,
		);
		expect(shortSaveError.text).toContain("The output could not be saved: disk full. Tell the user.");
		expect(Buffer.byteLength(shortSaveError.text)).toBeGreaterThan(head.maxBytes - 16);
		expect(Buffer.byteLength(shortSaveError.text)).toBeLessThanOrEqual(head.maxBytes);

		const cutCommand = await build(await result({}, podRows(500)), longSelector);
		const [statusLine] = linesOf(cutCommand.text);
		expect(statusLine).toMatch(/^\[k8s_get ok\] kubectl get pods --selector=x+ \[\d+ more bytes not shown\]$/);
		expect(cutCommand.text).toMatch(
			new RegExp(`^\\[First \\d+ lines shown\\. ${savedAs("k8s_get-1.txt")}; ${READ_HINT}\\]$`, "m"),
		);
		expect(linesOf(cutCommand.text)).toContain(podRow(1));
		expect(linesOf(cutCommand.text).length).toBeLessThanOrEqual(head.maxLines);
		expect(Buffer.byteLength(cutCommand.text)).toBeLessThanOrEqual(head.maxBytes);
		const leftOut = capturedNumber(statusLine, /\[(\d+) more bytes not shown\]$/);
		const shownCommand = statusLine.slice("[k8s_get ok] ".length, statusLine.lastIndexOf(" ["));
		expect(Buffer.byteLength(shownCommand) + leftOut).toBe(
			Buffer.byteLength("kubectl get pods --selector=") + 60_000,
		);

		const broken = join(root, "line\nbreak");
		await mkdir(broken, { recursive: true });
		await handle.release();
		handle = await acquireSession("current", broken, broken);
		session = handle.paths;
		const brokenPathReply = await build(
			await result({ status: "failed", exitCode: 1, stderr: bytes(errLines(60)) }, podRows(500)),
		);
		expect(brokenPathReply.text).toContain(`Saved as ${savedPath("k8s_get-1.txt")} (`);
		expect(brokenPathReply.text).toMatch(/\[stderr: last \d+ of 60 lines shown\. Saved as /);
		expect(lineCount(brokenPathReply.text)).toBeLessThanOrEqual(head.maxLines);
		expect(Buffer.byteLength(brokenPathReply.text)).toBeLessThanOrEqual(head.maxBytes);

		const concurrentCases = [
			{ directories: ["a".repeat(200), "b".repeat(200), "c".repeat(200)], policy: head, failStdout: true },
			{
				directories: Array.from({ length: 4 }, () => "\n".repeat(175)),
				policy: { ...head, maxBytes: limits.replyMaxBytes, maxLines: limits.replyMaxLines },
				failStdout: false,
			},
		];
		for (const { directories, policy, failStdout } of concurrentCases) {
			await restartSession();
			const directory = join(root, ...directories);
			await handle.release();
			handle = await acquireSession("current", directory, directory);
			session = handle.paths;
			await mkdir(savedPath("k8s_get-stderr-2.txt"));
			if (failStdout) await mkdir(savedPath("k8s_get-1.txt"));
			const stdout = podRows(3000);
			const reply = await build(
				await result({ status: "failed", exitCode: 1, stderr: bytes(errLines(3000)) }, stdout),
				longSelector,
				policy,
			);
			const notices = [...reply.text.matchAll(/(?:\[Full output could not be saved:|\[stderr:)[\s\S]*?\.\]/g)].map(
				(match) => match[0],
			);
			expect(notices).toHaveLength(failStdout ? 2 : 1);
			for (const notice of notices) {
				expect(notice).toContain("rename");
				expect(notice).toMatch(/\[\d+ more bytes not shown\]/);
				expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(Math.floor(policy.maxBytes * 0.15));
				expect(lineCount(notice)).toBeLessThanOrEqual(Math.floor(policy.maxLines * 0.15));
			}
			expect(reply.isError).toBe(true);
			expect(reply.text).toMatch(/^\[k8s_get failed: exit 1\] /);
			expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(policy.maxBytes);
			expect(lineCount(reply.text)).toBeLessThanOrEqual(policy.maxLines);
			const entries = await readManifest(session);
			expect(entries).toHaveLength(failStdout ? 0 : 1);
			for (const entry of entries) {
				expect(reply.text).toContain(`Saved as ${savedPath(entry.file)} (`);
				expect(await readFile(savedPath(entry.file), "utf8")).toBe(stdout);
			}
			expect((await readdir(session.outputDirectory)).filter((name) => name.endsWith(".part"))).toEqual([]);
		}

		const outcomes: [Partial<StreamResult>, string | undefined][] = [
			[{}, podRows(head.maxLines + 1)],
			[{}, podRows(1000)],
			[{}, wideRows(300)],
			[{}, "web-0 ".repeat(20 * 1024)],
			[{ status: "failed", exitCode: 1, stderr: bytes(podRows(1000)) }, podRows(1000)],
			[{ status: "failed", exitCode: 1, stderr: bytes("x".repeat(100_000)) }, ""],
			[{ status: "failed", exitCode: null, signal: "SIGKILL", stderr: bytes(podRows(1000)) }, podRows(1000)],
			[{ status: "failed", exitCode: null, startError: `spawn kubectl ENOENT ${"x".repeat(300)}` }, undefined],
			[{ status: "failed", exitCode: null, startError: `spawn kubectl ENOENT ${"x".repeat(5000)}` }, undefined],
			[{ status: "save_failed", exitCode: null, saveError: { message: "x".repeat(5000) } }, undefined],
			[{ status: "output_limit", exitCode: null, limit: "stdout" }, wideRows(300)],
			[{ status: "output_limit", exitCode: null, limit: "stderr", stderr: bytes(podRows(1000)) }, podRows(1000)],
			[{ status: "output_limit", exitCode: null, limit: "session", stderr: bytes(podRows(1000)) }, podRows(1000)],
			[{ status: "timeout", exitCode: null, elapsedMs: 60_000, stderr: bytes(podRows(1000)) }, podRows(1000)],
			[{ status: "cancelled", exitCode: null, stderr: bytes("x".repeat(100_000)) }, "partial\n"],
			[{ status: "save_failed", exitCode: null, saveError: { message: "x".repeat(500) } }, undefined],
		];

		for (const blocked of [false, true]) {
			await restartSession();
			if (blocked) await blockManifest();
			for (const policy of [head, tail, tailWithHeader]) {
				for (const [fields, stdout] of outcomes) {
					const outcome = stdout === undefined ? bare(fields) : await result(fields, stdout);
					const reply = await build(outcome, longJsonpath, policy);
					const form = `${fields.status ?? "ok"}, ${policy.selection}, blocked ${blocked}`;

					expect(lineCount(reply.text), form).toBeLessThanOrEqual(policy.maxLines);
					expect(Buffer.byteLength(reply.text), form).toBeLessThanOrEqual(policy.maxBytes);
				}
			}
		}
	});

	it("publishes .bin with complete manifest entry and returns only status and [Saved as ...] on artifact ok", async () => {
		const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
		const outcome = await result({ status: "ok", exitCode: 0 }, payload, copyOutArchive.tool);
		const reply = await build(outcome, copyOutArchive, artifact);

		const expectedPath = savedPath("k8s_inspect-1.bin");
		expect(reply).toEqual({
			text: `[k8s_inspect ok] ${copyOutArchive.commandLabel}\n\n[Saved as ${expectedPath} (8B).]`,
			isError: false,
		});
		expect(await savedFiles()).toEqual(["k8s_inspect-1.bin"]);
		expect(await readFile(expectedPath)).toEqual(payload);
		expect(await readManifest(session)).toEqual([
			{
				v: 1,
				file: "k8s_inspect-1.bin",
				tool: copyOutArchive.tool,
				command: copyOutArchive.commandLabel,
				size: 8,
				status: "complete",
				createdAt: expect.any(String),
			},
		]);
	});

	it("deletes .part and returns status, stderr, and outcome notice on any non-ok status in artifact mode", async () => {
		const streamFailures: [Partial<StreamResult>, string][] = [
			[
				{ status: "failed", exitCode: 1, stderr: bytes("cat: /var/log/app.tar.gz: No such file or directory\n") },
				`[k8s_inspect failed: exit 1] ${copyOutArchive.commandLabel}\n\n[stderr]\ncat: /var/log/app.tar.gz: No such file or directory\n[/stderr]`,
			],
			[
				{ status: "failed", exitCode: null, signal: "SIGKILL" },
				`[k8s_inspect failed: signal SIGKILL] ${copyOutArchive.commandLabel}`,
			],
			[
				{ status: "timeout", exitCode: null, elapsedMs: 60_000 },
				`[k8s_inspect timeout] ${copyOutArchive.commandLabel}\n\nDid not finish in 60 s.`,
			],
			[
				{ status: "cancelled", exitCode: null },
				`[k8s_inspect cancelled] ${copyOutArchive.commandLabel}\n\nCancelled.`,
			],
			[
				{ status: "output_limit", exitCode: null, limit: "stdout" },
				`[k8s_inspect output_limit] ${copyOutArchive.commandLabel}\n\n[stdout reached the 64 MiB file limit; the output is incomplete.]`,
			],
		];

		for (const [fields, expectedText] of streamFailures) {
			const outcome = await result(fields, "partial-bytes", copyOutArchive.tool);
			const reply = await build(outcome, copyOutArchive, artifact);
			expect(reply, fields.status).toEqual({ text: expectedText, isError: true });
			expect(reply.text, fields.status).not.toContain("partial-bytes");
			expect(reply.text, fields.status).not.toContain("Saved as");
		}

		const startFailed = await build(
			bare({ status: "failed", exitCode: null, startError: "spawn kubectl ENOENT" }),
			copyOutArchive,
			artifact,
		);
		expect(startFailed).toEqual({
			text: `[k8s_inspect failed] ${copyOutArchive.commandLabel}\n\nCould not start: spawn kubectl ENOENT`,
			isError: true,
		});

		const saveFailed = await build(
			bare({ status: "save_failed", exitCode: null, saveError: { message: "ENOSPC" } }),
			copyOutArchive,
			artifact,
		);
		expect(saveFailed).toEqual({
			text: `[k8s_inspect save_failed] ${copyOutArchive.commandLabel}\n\nThe output could not be saved: ENOSPC. Tell the user.`,
			isError: true,
		});

		expect(await savedFiles()).toEqual([]);
		expect(await readManifest(session)).toEqual([]);
	});

	it("formats a finalized object whose paths do not exist on disk", async () => {
		const outcome = await result({ status: "failed", exitCode: 1, stderr: bytes(errLines(60)) }, podRows(500));
		const call = callOf(getPods, head);
		const finalized = await finalizeOutput(outcome, call, limits, session);
		await rm(session.outputDirectory, { recursive: true, force: true });

		const fromDeletedDisk = formatReply(finalized, call, limits);
		expect(fromDeletedDisk.isError).toBe(true);
		expect(fromDeletedDisk.text).toContain(`Saved as ${savedPath("k8s_get-1.txt")} (`);
		expect(fromDeletedDisk.text).toContain(`Saved as ${savedPath("k8s_get-stderr-2.txt")} (`);

		const synthetic: FinalizedOutput = {
			status: "ok",
			exitCode: 0,
			elapsedMs: 120,
			stdout: {
				head: { text: podRows(50), cut: true },
				kept: {
					saved: {
						file: "k8s_get-99.txt",
						path: "/nonexistent/dir/k8s_get-99.txt",
						size: 4096,
						status: "complete",
					},
				},
			},
			stderr: {
				text: errLines(40),
				kept: {
					saved: {
						file: "k8s_get-stderr-100.txt",
						path: "/nonexistent/dir/k8s_get-stderr-100.txt",
						size: 2048,
						status: "complete",
					},
				},
			},
		};
		const formatted = formatReply(synthetic, call, limits);
		expect(formatted.isError).toBe(false);
		expect(formatted.text).toContain("Saved as /nonexistent/dir/k8s_get-99.txt (4.0KB);");
		expect(formatted.text).toContain("Saved as /nonexistent/dir/k8s_get-stderr-100.txt (2.0KB);");
	});
});
