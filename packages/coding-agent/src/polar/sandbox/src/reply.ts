import { formatSize, truncateHead, truncateTail } from "../../../core/tools/truncate.ts";
import {
	describeBytes,
	discardOutputFile,
	type FileOutcome,
	type FinishOutcome,
	finishOutputFile,
	quotaMessage,
	READ_MAX_BYTES,
	readExcerpt,
	type SavedFile,
	type SaveOutcome,
	saveBytes,
} from "../../shared/store.ts";
import {
	DATA_PATH,
	type FinalizedSandboxOutput,
	type FinalizedStderr,
	type FinalizedStdout,
	type SandboxLimits,
	type SandboxRequest,
	type SandboxResult,
	type SandboxStatus,
	type SessionPaths,
	type ToolReply,
} from "./types.ts";

export const COMMAND_MAX_CHARS = 100;
const RESERVED_LINES = 6;
const RESERVED_BYTES = 2 * 1024;
const WINDOW_MARGIN_BYTES = 16 * 1024;
const STDERR_OPEN = "[stderr]";
const STDERR_CLOSE = "[/stderr]";
const STDERR_FILE_TOOL = "run_code-stderr";

type ResultState = Omit<FinalizedSandboxOutput, "stdout" | "stderr">;

interface Limits {
	maxLines: number;
	maxBytes: number;
}

interface Size {
	lines: number;
	bytes: number;
}

interface Shown {
	content: string;
	notice?: string;
}

interface StderrSection extends Size {
	section: string;
}

export function commandLine(request: SandboxRequest): string {
	const line = request.code.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	const trimmed = line.trim();
	const shown = trimmed.length > COMMAND_MAX_CHARS ? `${trimmed.slice(0, COMMAND_MAX_CHARS - 1)}…` : trimmed;
	return `${request.language}: ${shown}`;
}

export async function finalizeOutput(
	result: SandboxResult,
	request: SandboxRequest,
	limits: SandboxLimits,
	session: SessionPaths,
): Promise<FinalizedSandboxOutput> {
	const policy = { maxLines: limits.replyMaxLines, maxBytes: limits.replyMaxBytes };
	const statusLine = renderStatusLine(result, request);
	const fixed = fixedNotices(result, limits);
	const room = excerptRoom(policy, [statusLine, ...fixed]);
	const stderrBudget = halfOf(room);
	const stderr = await takeStderr(result, request, limits, session, stderrBudget);
	const stderrSection = formatStderr(stderr, stderrBudget);
	const stdoutRoom = leftOf(room, stderrSection);
	const stdout = await takeStdout(result, request, stderr.text === "", policy, stdoutRoom);
	const { output: _output, stderr: _stderr, ...state } = result;
	return { ...state, stdout, stderr };
}

export function formatReply(
	finalized: FinalizedSandboxOutput,
	request: SandboxRequest,
	limits: SandboxLimits,
): ToolReply {
	const policy = { maxLines: limits.replyMaxLines, maxBytes: limits.replyMaxBytes };
	const statusLine = renderStatusLine(finalized, request);
	const fixed = fixedNotices(finalized, limits);
	const room = excerptRoom(policy, [statusLine, ...fixed]);
	const stderr = formatStderr(finalized.stderr, halfOf(room));
	const stdoutRoom = leftOf(room, stderr);
	if (
		finalized.stdout.kept === undefined &&
		finalized.stdout.whole !== undefined &&
		isPlainOk(finalized, finalized.stdout.whole, finalized.stderr.text === "", policy)
	) {
		return { text: finalized.stdout.whole, isError: false };
	}
	const shown = cutStdout(finalized.stdout, stdoutRoom);
	const notices = [
		emptyStdoutNotice(finalized, finalized.stdout),
		shown.notice,
		saveFailedNotice(finalized.stdout.kept),
		...fixed,
	]
		.filter((notice) => notice !== undefined)
		.join("\n");
	return {
		text: joinSections([statusLine, finalized.runtimeMessage ?? "", shown.content, stderr.section, notices]),
		isError: finalized.status !== "ok",
	};
}

export async function buildReply(
	result: SandboxResult,
	request: SandboxRequest,
	limits: SandboxLimits,
	session: SessionPaths,
): Promise<ToolReply> {
	const finalized = await finalizeOutput(result, request, limits, session);
	return formatReply(finalized, request, limits);
}

async function takeStdout(
	result: SandboxResult,
	request: SandboxRequest,
	stderrEmpty: boolean,
	policy: Limits,
	room: Limits,
): Promise<FinalizedStdout> {
	const file = result.output;
	if (file === undefined) return { whole: "", head: { text: "", cut: false } };
	const window = policy.maxBytes + WINDOW_MARGIN_BYTES;
	let ended = false;
	try {
		const head = await readExcerpt(file, "head", window);
		if (!head.cut && (isPlainOk(result, head.text, stderrEmpty, policy) || fits(head.text, room))) {
			ended = true;
			await discardOutputFile(file);
			return { whole: head.text, head };
		}
		const record = { tool: "run_code", command: commandLine(request) };
		ended = true;
		const kept = await finishOutputFile(file, fileOutcome(result.status), record);
		return { whole: head.cut ? undefined : head.text, head, kept };
	} catch (error) {
		if (!ended) await discardOutputFile(file).catch(() => undefined);
		throw error;
	}
}

async function takeStderr(
	result: SandboxResult,
	request: SandboxRequest,
	limits: SandboxLimits,
	session: SessionPaths,
	budget: Limits,
): Promise<FinalizedStderr> {
	if (result.stderr.length === 0) return { text: "" };
	const text = result.stderr.toString("utf8");
	const whole = `${STDERR_OPEN}\n${text}${STDERR_CLOSE}`;
	if (fits(whole, budget)) return { text };
	const { fileMaxBytes, sessionMaxBytes } = limits;
	const record = { tool: "run_code", command: commandLine(request) };
	const kept = await saveBytes(
		session,
		STDERR_FILE_TOOL,
		{ fileMaxBytes, sessionMaxBytes },
		result.stderr,
		fileOutcome(result.status),
		record,
	);
	return { text, kept };
}

function formatStderr(stderr: FinalizedStderr, budget: Limits): StderrSection {
	if (stderr.text === "") return { section: "", lines: 0, bytes: 0 };
	const whole = `${STDERR_OPEN}\n${stderr.text}${STDERR_CLOSE}`;
	if (stderr.kept === undefined && fits(whole, budget)) return { section: whole, ...measure(whole) };
	const kept: SaveOutcome = stderr.kept ?? { saveFailed: { message: "not saved" } };
	const total = measure(stderr.text).lines;
	const frame = measure(`${STDERR_OPEN}\n${STDERR_CLOSE}\n${stderrCutLine(total, total, true, kept)}`);
	const tail = truncateTail(stderr.text, leftOf(budget, frame));
	const end = tail.outputLines > 0 && stderr.text.endsWith("\n") ? "\n" : "";
	const cutLine = stderrCutLine(tail.outputLines, tail.totalLines, tail.lastLinePartial, kept);
	const section = `${STDERR_OPEN}\n${tail.content}${end}${STDERR_CLOSE}\n${cutLine}`;
	return { section, ...measure(section) };
}

function stderrCutLine(shown: number, total: number, partial: boolean, kept: SaveOutcome): string {
	const cut = `last ${shown} of ${total} lines shown${partial ? "; the first shown line is cut at its start" : ""}`;
	if ("saved" in kept) {
		const { file, path, size } = kept.saved;
		return `[stderr: ${cut}. Saved as ${path} (${formatSize(size)}); ${readHint(file, size)}]`;
	}
	return `[stderr: ${cut}. The rest could not be saved: ${unsaved(kept)}.]`;
}

function unsaved(kept: Exclude<SaveOutcome, { saved: SavedFile }>): string {
	return "refused" in kept ? quotaMessage(kept.refused) : kept.saveFailed.message;
}

function fileOutcome(status: SandboxStatus): FileOutcome {
	return status === "ok" || status === "failed" ? "complete" : "truncated";
}

function isPlainOk(result: ResultState, whole: string, stderrEmpty: boolean, policy: Limits): boolean {
	return (
		result.status === "ok" && result.cleanupError === undefined && whole !== "" && stderrEmpty && fits(whole, policy)
	);
}

function fits(text: string, limits: Limits): boolean {
	return !truncateHead(text, limits).truncated;
}

function measure(text: string): Size {
	const { totalLines, totalBytes } = truncateHead(text, {
		maxLines: Number.MAX_SAFE_INTEGER,
		maxBytes: Number.MAX_SAFE_INTEGER,
	});
	return { lines: totalLines, bytes: totalBytes };
}

function renderStatusLine(result: ResultState, request: SandboxRequest): string {
	const status =
		result.status === "failed" && result.exitCode !== null ? `failed: exit ${result.exitCode}` : result.status;
	return `[run_code ${status}] ${commandLine(request)}`;
}

function excerptRoom(policy: Limits, measured: string[]): Limits {
	const known: Size = { lines: 0, bytes: 0 };
	for (const text of measured) {
		const size = measure(text);
		known.lines += size.lines;
		known.bytes += size.bytes + 1;
	}
	return leftOf({ maxLines: policy.maxLines - RESERVED_LINES, maxBytes: policy.maxBytes - RESERVED_BYTES }, known);
}

function leftOf(room: Limits, taken: Size): Limits {
	return { maxLines: Math.max(0, room.maxLines - taken.lines), maxBytes: Math.max(0, room.maxBytes - taken.bytes) };
}

function halfOf(room: Limits): Limits {
	return { maxLines: Math.floor(room.maxLines / 2), maxBytes: Math.floor(room.maxBytes / 2) };
}

function cutStdout(stdout: FinalizedStdout, room: Limits): Shown {
	if (stdout.kept === undefined) return { content: stdout.whole ?? "" };
	const cut = truncateHead(stdout.head.text, room);
	if (cut.firstLineExceedsLimit) return { content: cut.content, notice: longLineNotice(cut.maxBytes, stdout) };
	if (!cut.truncated && !stdout.head.cut) return { content: cut.content };
	const limit = cut.truncatedBy === "bytes" ? ` (${formatSize(cut.maxBytes)} limit)` : "";
	return { content: cut.content, notice: keptNotice(`First ${cut.outputLines} lines shown${limit}.`, stdout) };
}

function keptNotice(shown: string, stdout: FinalizedStdout): string {
	if (stdout.kept === undefined || "saveFailed" in stdout.kept) return `[${shown}]`;
	const { file, path, size } = stdout.kept.saved;
	return `[${shown} Saved as ${path} (${formatSize(size)}); ${readHint(file, size)}]`;
}

function readHint(file: string, size: number): string {
	return size <= READ_MAX_BYTES ? `read it with "read" tool, or ${runCodeHint(file)}` : runCodeHint(file);
}

function runCodeHint(file: string): string {
	return `process it with "run_code" tool from ${DATA_PATH}/${file}.`;
}

function longLineNotice(maxBytes: number, stdout: FinalizedStdout): string {
	const shown = `Line 1 is longer than the ${formatSize(maxBytes)} limit; nothing shown.`;
	if (stdout.kept === undefined || "saveFailed" in stdout.kept) return `[${shown} Print shorter lines.]`;
	const { file, path, size } = stdout.kept.saved;
	return `[${shown} Saved as ${path} (${formatSize(size)}); ${runCodeHint(file)}]`;
}

function emptyStdoutNotice(result: ResultState, stdout: FinalizedStdout): string | undefined {
	return result.status === "ok" && stdout.whole === "" ? "[stdout is empty]" : undefined;
}

function fixedNotices(result: ResultState, limits: SandboxLimits): string[] {
	return [
		outputLimitNotice(result, limits),
		cleanupNotice(result),
		inspectionNotice(result),
		statusMessage(result, limits),
	].filter((notice) => notice !== undefined);
}

function outputLimitNotice(result: ResultState, limits: SandboxLimits): string | undefined {
	if (result.status !== "output_limit") return undefined;
	const stopped = "the program was stopped; the output is incomplete.";
	switch (result.limit) {
		case "stdout":
			return `[stdout reached the ${describeBytes(limits.fileMaxBytes)} file limit; ${stopped}]`;
		case "stderr":
			return `[stderr reached the ${describeBytes(limits.stderrMaxBytes)} limit; ${stopped}]`;
		case "session":
			return `[The session output quota of ${describeBytes(limits.sessionMaxBytes)} was reached; ${stopped}]`;
		case undefined:
			return `[An output limit was reached; ${stopped}]`;
	}
}

function saveFailedNotice(kept: FinishOutcome | undefined): string | undefined {
	if (kept === undefined || "saved" in kept) return undefined;
	return `[Full output could not be saved: ${kept.saveFailed.message}.]`;
}

function cleanupNotice(result: ResultState): string | undefined {
	if (result.cleanupError === undefined) return undefined;
	const { container, message } = result.cleanupError;
	return `[The container ${container} could not be deleted: ${message}. Do not rerun the program for this; tell the user.]`;
}

function inspectionNotice({ inspection }: ResultState): string | undefined {
	if (inspection === undefined || inspection.state === "present") return undefined;
	if (inspection.state === "stopped") {
		return "[The container stopped during the run; the output may be incomplete.]";
	}
	if (inspection.state === "absent") {
		return "[The container was not found after the run; whether the program started is not known.]";
	}
	const reason = inspection.detail === undefined ? "" : `: ${inspection.detail}`;
	return `[The container could not be inspected${reason}.]`;
}

function statusMessage(result: ResultState, limits: SandboxLimits): string | undefined {
	switch (result.status) {
		case "ok":
		case "failed":
		case "output_limit":
			return undefined;
		case "timeout":
			return `run_code did not finish in ${Math.round(limits.timeoutMs / 1000)} s.`;
		case "cancelled":
			return "Cancelled.";
		case "out_of_memory":
			return `The ${describeBytes(limits.memoryBytes)} memory limit was reached and the process was killed. Kernel: ${result.oomEvidence ?? ""}`.trimEnd();
		case "work_limit":
			return `The ${describeBytes(limits.workMaxBytes)} /work limit was reached and the process was killed.`;
		case "save_failed":
			return `The output could not be saved: ${result.saveError?.message}. Tell the user.`;
		case "runtime_failed":
			return "The container runtime failed to run the code. Tell the user.";
	}
}

function joinSections(sections: string[]): string {
	return sections
		.map((section) => section.trimEnd())
		.filter((section) => section !== "")
		.join("\n\n");
}
