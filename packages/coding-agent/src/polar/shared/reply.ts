import { formatSize, truncateHead, truncateTail } from "../../core/tools/truncate.ts";
import type { OutputLimit, StreamResult, StreamStatus } from "./process.ts";
import type { ProcessLimits } from "./runtime.ts";
import type { SessionPaths } from "./session.ts";
import {
	describeBytes,
	discardOutputFile,
	type Excerpt,
	type FileOutcome,
	type FinishOutcome,
	finishOutputFile,
	type OutputMode,
	type OutputSaveError,
	quotaMessage,
	READ_MAX_BYTES,
	readExcerpt,
	type SavedFile,
	type SaveOutcome,
	saveBytes,
} from "./store.ts";

const WINDOW_MARGIN_BYTES = 16 * 1024;
const STDERR_OPEN = "[stderr]";
const STDERR_CLOSE = "[/stderr]";
const STDERR_FILE_SUFFIX = "-stderr";
const SAVE_ERROR_SHARE = 0.15;

export interface ReplyOptions {
	maxLines: number;
	maxBytes: number;
	selection: "head" | "tail";
	keepHeader: boolean;
	mode?: OutputMode;
}

export interface ProducerCall<Request = unknown> {
	request: Request;
	tool: string;
	commandLabel: string;
	options: ReplyOptions;
	timeoutMs: number;
}

export interface ToolReply {
	text: string;
	isError: boolean;
}

export interface FinalizedStdout {
	whole?: string;
	head: Excerpt;
	tail?: Excerpt;
	kept?: FinishOutcome;
}

export interface FinalizedStderr {
	text: string;
	kept?: SaveOutcome;
}

export interface FinalizedOutput {
	status: StreamStatus;
	exitCode: number | null;
	signal?: NodeJS.Signals;
	startError?: string;
	limit?: OutputLimit;
	elapsedMs: number;
	saveError?: OutputSaveError;
	stdout: FinalizedStdout;
	stderr: FinalizedStderr;
}

type ResultState = Omit<FinalizedOutput, "stdout" | "stderr">;

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

export async function finalizeOutput(
	outcome: StreamResult,
	call: ProducerCall,
	limits: ProcessLimits,
	session: SessionPaths,
): Promise<FinalizedOutput> {
	const policy = call.options;
	const layout = prepareLayout(outcome, call, limits);
	const stderr = await finalizeStderr(outcome, call, limits, session, layout.stderrBudget);
	const stderrSection = formatStderr(stderr, layout.stderrBudget, policy);
	const wholeReply = (whole: string) =>
		layout.compose(whole, stderrSection.section, joinNotices([emptyStdoutNotice(outcome, whole), ...layout.fixed]));
	const stdout = await finalizeStdout(outcome, call, stderr.text === "", wholeReply);
	const { output: _output, stderr: _stderr, ...state } = outcome;
	return { ...state, stdout, stderr };
}

export function formatReply(finalized: FinalizedOutput, call: ProducerCall, limits: ProcessLimits): ToolReply {
	const policy = call.options;
	const isError = finalized.status !== "ok";
	const layout = prepareLayout(finalized, call, limits);
	const stderr = formatStderr(finalized.stderr, layout.stderrBudget, policy);
	const parts = [...layout.parts, stderr.section];
	if (policy.mode === "artifact") {
		const savedNotice =
			finalized.stdout.kept !== undefined && "saved" in finalized.stdout.kept
				? artifactSavedNotice(finalized.stdout.kept.saved)
				: undefined;
		const reserved = [...parts, savedNotice ?? ""];
		const unsavedLine = saveFailedNotice(finalized.stdout.kept, leftAfter(policy, reserved), policy);
		const notices = joinNotices([savedNotice, unsavedLine, ...layout.fixed]);
		return { text: layout.compose("", stderr.section, notices), isError };
	}
	const wholeReply = (whole: string) =>
		layout.compose(whole, stderr.section, joinNotices([emptyStdoutNotice(finalized, whole), ...layout.fixed]));
	if (finalized.stdout.kept === undefined) {
		const whole = finalized.stdout.whole ?? "";
		if (isPlainOk(finalized, whole, finalized.stderr.text === "", policy)) return { text: whole, isError: false };
		return { text: wholeReply(whole), isError };
	}
	const reserved = [...parts, longestCutNotice(finalized.stdout, policy)];
	const unsavedLine = saveFailedNotice(finalized.stdout.kept, leftAfter(policy, reserved), policy);
	reserved.push(unsavedLine ?? "");
	const shown = cutStdout(finalized.stdout, policy, leftAfter(policy, reserved));
	return {
		text: layout.compose(shown.content, stderr.section, joinNotices([shown.notice, unsavedLine, ...layout.fixed])),
		isError,
	};
}

export async function buildReply(
	outcome: StreamResult,
	call: ProducerCall,
	limits: ProcessLimits,
	session: SessionPaths,
): Promise<ToolReply> {
	const finalized = await finalizeOutput(outcome, call, limits, session);
	return formatReply(finalized, call, limits);
}

function prepareLayout(outcome: ResultState, call: ProducerCall, limits: ProcessLimits) {
	const policy = call.options;
	const status = `[${call.tool} ${describeStatus(outcome)}] `;
	const fullCommand = call.commandLabel;
	const parts: string[] = [`${status}${cutMarker(Buffer.byteLength(fullCommand))}`];
	const take = (text: string) => {
		const shown = cutInto(leftAfter(policy, parts), text);
		parts.push(shown);
		return shown;
	};
	const fixed = fixedNotices(outcome, call, limits).map(take);
	const startFailure = startFailureSection(outcome).map(take);
	const stderrBudget = halfOf(leftAfter(policy, parts));
	const compose = (content: string, stderrSection: string, notices: string) => {
		const sections = [...startFailure, content, stderrSection, notices];
		const left = leftAfter(policy, [status, ...sections]);
		const shownCommand = cutInto({ maxLines: left.maxLines + 1, maxBytes: left.maxBytes }, fullCommand);
		return joinSections([`${status}${shownCommand}`, ...sections]);
	};
	return { parts, fixed, stderrBudget, compose };
}

function leftAfter(policy: Limits, parts: string[]): Limits {
	let lines = policy.maxLines;
	let bytes = policy.maxBytes;
	for (const part of parts) {
		if (part === "") continue;
		const size = measure(part);
		lines -= size.lines + 1;
		bytes -= size.bytes + 2;
	}
	return { maxLines: Math.max(0, lines), maxBytes: Math.max(0, bytes) };
}

function saveErrorRoom(replyLimits: Limits, available: Limits): Limits {
	return {
		maxLines: Math.min(available.maxLines, Math.floor(replyLimits.maxLines * SAVE_ERROR_SHARE)),
		maxBytes: Math.min(available.maxBytes, Math.floor(replyLimits.maxBytes * SAVE_ERROR_SHARE)),
	};
}

async function finalizeStdout(
	outcome: StreamResult,
	call: ProducerCall,
	stderrEmpty: boolean,
	wholeReply: (whole: string) => string,
): Promise<FinalizedStdout> {
	const file = outcome.output;
	const empty: Excerpt = { text: "", cut: false };
	if (file === undefined) return { whole: "", head: empty };
	const record = { tool: call.tool, command: call.commandLabel };
	const policy = call.options;
	if (policy.mode === "artifact") {
		if (outcome.status === "ok") {
			const kept = await finishOutputFile(file, "complete", record, "artifact");
			return { head: empty, kept };
		}
		await discardOutputFile(file);
		return { head: empty };
	}
	const window = policy.maxBytes + WINDOW_MARGIN_BYTES;
	let ended = false;
	try {
		const head = await readExcerpt(file, "head", window);
		if (!head.cut && (isPlainOk(outcome, head.text, stderrEmpty, policy) || fits(wholeReply(head.text), policy))) {
			ended = true;
			await discardOutputFile(file);
			return { whole: head.text, head };
		}
		const tail = policy.selection === "tail" ? await readExcerpt(file, "tail", window) : undefined;
		ended = true;
		const kept = await finishOutputFile(file, fileOutcome(outcome), record, "spillover");
		return { whole: head.cut ? undefined : head.text, head, tail, kept };
	} catch (error) {
		if (!ended) await discardOutputFile(file).catch(() => undefined);
		throw error;
	}
}

async function finalizeStderr(
	outcome: StreamResult,
	call: ProducerCall,
	limits: ProcessLimits,
	session: SessionPaths,
	budget: Limits,
): Promise<FinalizedStderr> {
	if (outcome.stderr.length === 0) return { text: "" };
	const text = outcome.stderr.toString("utf8");
	const whole = `${STDERR_OPEN}\n${text}${STDERR_CLOSE}`;
	if (fits(whole, budget)) return { text };
	const { fileMaxBytes, sessionMaxBytes } = limits;
	const record = { tool: call.tool, command: call.commandLabel };
	const kept = await saveBytes(
		session,
		`${call.tool}${STDERR_FILE_SUFFIX}`,
		{ fileMaxBytes, sessionMaxBytes },
		outcome.stderr,
		fileOutcome(outcome),
		record,
	);
	return { text, kept };
}

function formatStderr(stderr: FinalizedStderr, budget: Limits, replyLimits: Limits): StderrSection {
	if (stderr.text === "") return { section: "", lines: 0, bytes: 0 };
	const whole = `${STDERR_OPEN}\n${stderr.text}${STDERR_CLOSE}`;
	if (stderr.kept === undefined && fits(whole, budget)) return { section: whole, ...measure(whole) };
	const kept: SaveOutcome = stderr.kept ?? { saveFailed: { message: "not saved" } };
	const total = measure(stderr.text).lines;
	const cutLineFrame = stderrCutLine(total, total, true, kept, "");
	const noticeRoom = saveErrorRoom(replyLimits, leftOf(budget, measure(`${STDERR_OPEN}\n${STDERR_CLOSE}\n`)));
	const failure = "saved" in kept ? "" : cutInto(leftOf(noticeRoom, measure(cutLineFrame)), unsaved(kept));
	const frame = measure(`${STDERR_OPEN}\n${STDERR_CLOSE}\n${stderrCutLine(total, total, true, kept, failure)}`);
	const tail = truncateTail(stderr.text, leftOf(budget, frame));
	const end = tail.outputLines > 0 && stderr.text.endsWith("\n") ? "\n" : "";
	const cutLine = stderrCutLine(tail.outputLines, tail.totalLines, tail.lastLinePartial, kept, failure);
	const section = `${STDERR_OPEN}\n${tail.content}${end}${STDERR_CLOSE}\n${cutLine}`;
	return { section, ...measure(section) };
}

function stderrCutLine(shown: number, total: number, partial: boolean, kept: SaveOutcome, failure: string): string {
	const cut = `last ${shown} of ${total} lines shown${partial ? "; the first shown line is cut at its start" : ""}`;
	if ("saved" in kept) {
		const { path, size } = kept.saved;
		return `[stderr: ${cut}. Saved as ${path} (${formatSize(size)}); ${readHint(size)}]`;
	}
	return `[stderr: ${cut}. The rest could not be saved: ${failure}.]`;
}

function unsaved(kept: Exclude<SaveOutcome, { saved: SavedFile }>): string {
	return "refused" in kept ? quotaMessage(kept.refused) : kept.saveFailed.message;
}

function fileOutcome(outcome: ResultState): FileOutcome {
	const ended = outcome.status === "ok" || (outcome.status === "failed" && outcome.signal === undefined);
	return ended ? "complete" : "truncated";
}

function isPlainOk(outcome: ResultState, whole: string, stderrEmpty: boolean, policy: ReplyOptions): boolean {
	const limits = { maxLines: policy.maxLines, maxBytes: policy.maxBytes };
	return outcome.status === "ok" && whole !== "" && stderrEmpty && fits(whole, limits);
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

function cutInto(room: Limits, text: string): string {
	if (fits(text, room)) return text;
	const bytes = Buffer.from(text, "utf8");
	const completeMarker = cutMarker(bytes.length);
	if (room.maxLines < 1 || room.maxBytes < Buffer.byteLength(completeMarker.trimStart())) return "";
	const markerBytes = Buffer.byteLength(completeMarker);
	let end = Math.max(0, Math.min(bytes.length, room.maxBytes - markerBytes));
	let lines = 1;
	for (let index = 0; index < end; index += 1) {
		if (bytes[index] === 0x0a && ++lines > room.maxLines) {
			end = index;
			break;
		}
	}
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	const marker = cutMarker(bytes.length - end);
	return end === 0 ? marker.trimStart() : `${bytes.toString("utf8", 0, end)}${marker}`;
}

function cutMarker(bytes: number): string {
	return ` [${bytes} more bytes not shown]`;
}

function describeStatus(outcome: ResultState): string {
	if (outcome.status !== "failed") return outcome.status;
	if (outcome.exitCode !== null) return `failed: exit ${outcome.exitCode}`;
	if (outcome.signal !== undefined) return `failed: signal ${outcome.signal}`;
	return "failed";
}

function startFailureSection(outcome: ResultState): string[] {
	return outcome.startError === undefined ? [] : [`Could not start: ${outcome.startError}`];
}

function leftOf(room: Limits, taken: Size): Limits {
	return { maxLines: Math.max(0, room.maxLines - taken.lines), maxBytes: Math.max(0, room.maxBytes - taken.bytes) };
}

function halfOf(room: Limits): Limits {
	return { maxLines: Math.floor(room.maxLines / 2), maxBytes: Math.floor(room.maxBytes / 2) };
}

function cutStdout(stdout: FinalizedStdout, policy: ReplyOptions, room: Limits): Shown {
	if (stdout.kept === undefined) return { content: stdout.whole ?? "" };
	if (policy.selection === "head") return cutHead(stdout, room);
	if (policy.keepHeader) return cutTailKeepingHeader(stdout, room);
	return cutTail(stdout, room);
}

function cutHead(stdout: FinalizedStdout, room: Limits): Shown {
	const cut = truncateHead(stdout.head.text, room);
	if (cut.firstLineExceedsLimit) return { content: cut.content, notice: longLineNotice(cut.maxBytes, stdout) };
	if (!cut.truncated && !stdout.head.cut) return { content: cut.content };
	const limit = cut.truncatedBy === "bytes" ? ` (${formatSize(cut.maxBytes)} limit)` : "";
	return { content: cut.content, notice: keptNotice(`First ${cut.outputLines} lines shown${limit}.`, stdout) };
}

function cutTail(stdout: FinalizedStdout, room: Limits): Shown {
	const tail = stdout.tail ?? stdout.head;
	const cut = truncateTail(tail.text, room);
	if (!cut.truncated && !tail.cut) return { content: cut.content };
	return { content: cut.content, notice: keptNotice(`Last ${cut.outputLines} lines shown.`, stdout) };
}

function cutTailKeepingHeader(stdout: FinalizedStdout, room: Limits): Shown {
	const tail = stdout.tail ?? stdout.head;
	const header = firstLineOf(stdout.head.text);
	const roomForRows = { maxLines: room.maxLines - 1, maxBytes: room.maxBytes - Buffer.byteLength(header) - 1 };
	if (roomForRows.maxBytes < 0) return cutTail(stdout, room);
	const rows = tail.cut ? tail.text : tail.text.slice(header.length + 1);
	const cut = truncateTail(rows, roomForRows);
	if (!cut.truncated && !tail.cut) return { content: `${header}\n${cut.content}` };
	const notice = keptNotice(`Header + last ${cut.outputLines} lines shown.`, stdout);
	return { content: `${header}\n${cut.content}`, notice };
}

function firstLineOf(text: string): string {
	return text.split("\n", 1)[0];
}

function longestCutNotice(stdout: FinalizedStdout, policy: ReplyOptions): string {
	const lines = Math.max(measure(stdout.head.text).lines, measure(stdout.tail?.text ?? "").lines);
	const regular = keptNotice(`Header + last ${lines} lines shown (${formatSize(policy.maxBytes)} limit).`, stdout);
	const longLine = longLineNotice(policy.maxBytes, stdout);
	return Buffer.byteLength(regular) >= Buffer.byteLength(longLine) ? regular : longLine;
}

function keptNotice(shown: string, stdout: FinalizedStdout): string {
	if (stdout.kept === undefined || "saveFailed" in stdout.kept) return `[${shown}]`;
	const { path, size } = stdout.kept.saved;
	return `[${shown} Saved as ${path} (${formatSize(size)}); ${readHint(size)}]`;
}

function artifactSavedNotice({ path, size }: SavedFile): string {
	return `[Saved as ${path} (${formatSize(size)}).]`;
}

function readHint(size: number): string {
	if (size <= READ_MAX_BYTES) return "read it with read, or narrow the request.";
	return "it is over the 16 MiB read limit; narrow the request.";
}

function longLineNotice(maxBytes: number, stdout: FinalizedStdout): string {
	const shown = `Line 1 is longer than the ${formatSize(maxBytes)} limit; nothing shown.`;
	if (stdout.kept === undefined || "saveFailed" in stdout.kept) return `[${shown}]`;
	const { path, size } = stdout.kept.saved;
	return `[${shown} Saved as ${path} (${formatSize(size)}).]`;
}

function emptyStdoutNotice(outcome: ResultState, whole: string): string | undefined {
	return outcome.status === "ok" && whole === "" ? "[stdout is empty]" : undefined;
}

function fixedNotices(outcome: ResultState, call: ProducerCall, limits: ProcessLimits): string[] {
	return [outputLimitNotice(outcome, limits), statusMessage(outcome, call)].filter((notice) => notice !== undefined);
}

function outputLimitNotice(outcome: ResultState, limits: ProcessLimits): string | undefined {
	if (outcome.status !== "output_limit") return undefined;
	const incomplete = "the output is incomplete.";
	switch (outcome.limit) {
		case "stdout":
			return `[stdout reached the ${describeBytes(limits.fileMaxBytes)} file limit; ${incomplete}]`;
		case "stderr":
			return `[stderr reached the ${describeBytes(limits.stderrMaxBytes)} limit; ${incomplete}]`;
		case "session":
			return `[The session output quota of ${describeBytes(limits.sessionMaxBytes)} was reached; ${incomplete}]`;
		case undefined:
			return `[An output limit was reached; ${incomplete}]`;
	}
}

function saveFailedNotice(kept: FinishOutcome | undefined, available: Limits, replyLimits: Limits): string | undefined {
	if (kept === undefined || "saved" in kept) return undefined;
	const prefix = "[Full output could not be saved: ";
	const suffix = ".]";
	const room = saveErrorRoom(replyLimits, available);
	const message = cutInto(leftAfter(room, [prefix + suffix]), kept.saveFailed.message);
	return `${prefix}${message}${suffix}`;
}

function statusMessage(outcome: ResultState, call: ProducerCall): string | undefined {
	switch (outcome.status) {
		case "ok":
		case "failed":
		case "output_limit":
			return undefined;
		case "timeout":
			return `Did not finish in ${Math.round(call.timeoutMs / 1000)} s.`;
		case "cancelled":
			return "Cancelled.";
		case "save_failed": {
			const prefix = "The output could not be saved: ";
			const suffix = ". Tell the user.";
			const room = saveErrorRoom(call.options, call.options);
			const message = cutInto(leftOf(room, measure(prefix + suffix)), String(outcome.saveError?.message));
			return `${prefix}${message}${suffix}`;
		}
	}
}

function joinNotices(notices: (string | undefined)[]): string {
	return notices.filter((notice) => notice !== undefined).join("\n");
}

function joinSections(sections: string[]): string {
	let text = "";
	for (const section of sections) {
		if (section === "") continue;
		if (text !== "") text += text.endsWith("\n") ? "\n" : "\n\n";
		text += section;
	}
	return text;
}
