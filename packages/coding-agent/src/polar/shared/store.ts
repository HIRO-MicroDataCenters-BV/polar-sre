import { appendFile, open, readFile, rename, rm, stat } from "fs/promises";
import { join } from "path";
import { Readable, Transform, type Writable } from "stream";
import { pipeline } from "stream/promises";
import { formatSize } from "../../core/tools/truncate.ts";
import {
	FILE_MODE,
	MANIFEST_FILE,
	type SessionContext,
	type SessionPaths,
	sessionContext,
	UNFINISHED_SUFFIX,
} from "./session.ts";

export const READ_MAX_BYTES = 16 * 1024 * 1024;

export function describeBytes(bytes: number): string {
	const units: [number, string][] = [
		[1024 ** 3, "GiB"],
		[1024 ** 2, "MiB"],
		[1024, "KiB"],
	];
	for (const [unit, name] of units) {
		if (bytes >= unit && bytes % unit === 0) return `${bytes / unit} ${name}`;
	}
	return `${bytes} B`;
}

export interface FileLimits {
	fileMaxBytes: number;
	sessionMaxBytes: number;
}

export type FileOutcome = "complete" | "truncated";
export type OutputMode = "spillover" | "artifact";

export interface FileRecord {
	tool: string;
	command: string;
}

export interface OpenFile {
	readonly name: string;
	readonly path: string;
	readonly sink: Writable;
	readonly closed: Promise<void>;
	bytesWritten(): number;
}

export interface QuotaRefusal {
	usedBytes: number;
	sessionMaxBytes: number;
}

export function quotaMessage({ usedBytes, sessionMaxBytes }: QuotaRefusal): string {
	return `the session holds ${formatSize(usedBytes)} of saved output; the limit is ${formatSize(sessionMaxBytes)}`;
}

export interface SavedFile {
	file: string;
	path: string;
	size: number;
	status: FileOutcome;
}

export interface OutputSaveError {
	message: string;
}

export type ExcerptSelection = "head" | "tail";

export interface Excerpt {
	text: string;
	cut: boolean;
}

export interface ManifestEntry {
	v: 1;
	file: string;
	tool: string;
	command: string;
	size: number;
	status: FileOutcome;
	createdAt: string;
}

export type OpenOutcome = { opened: OpenFile } | { refused: QuotaRefusal } | { openFailed: OutputSaveError };
export type FinishOutcome = { saved: SavedFile } | { saveFailed: OutputSaveError };
export type SaveOutcome = { saved: SavedFile } | { refused: QuotaRefusal } | { saveFailed: OutputSaveError };

export class OutputLimitError extends Error {
	readonly limit: "file" | "session";

	constructor(limit: "file" | "session") {
		super(limit === "file" ? "the per-file limit was reached" : "the session quota was reached");
		this.name = "OutputLimitError";
		this.limit = limit;
	}
}

const MANIFEST_VERSION = 1;
const FINAL_SUFFIX: Record<FileOutcome, string> = { complete: ".txt", truncated: ".truncated.txt" };
const ARTIFACT_SUFFIX = ".bin";

function usedBytes(context: SessionContext): number {
	let total = context.publishedBytes;
	for (const file of context.openFiles) total += file.bytesWritten();
	return total;
}

class OutputWriter implements OpenFile {
	readonly name: string;
	readonly path: string;
	readonly directory: string;
	readonly context: SessionContext;
	readonly sink: Transform;
	readonly closed: Promise<void>;
	private written = 0;

	constructor(context: SessionContext, name: string, fileStream: Writable, limits: FileLimits) {
		this.directory = context.paths.outputDirectory;
		this.name = name;
		this.path = join(this.directory, `${name}${UNFINISHED_SUFFIX}`);
		this.context = context;
		this.sink = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				if (this.written + chunk.length > limits.fileMaxBytes) return callback(new OutputLimitError("file"));
				if (usedBytes(context) + chunk.length > limits.sessionMaxBytes) {
					return callback(new OutputLimitError("session"));
				}
				this.written += chunk.length;
				callback(null, chunk);
			},
		});
		this.closed = pipeline(this.sink, fileStream);
		this.closed.catch(() => {});
	}

	bytesWritten(): number {
		return this.written;
	}
}

export async function openOutputFile(session: SessionPaths, tool: string, limits: FileLimits): Promise<OpenOutcome> {
	const context = sessionContext(session);
	const used = usedBytes(context);
	if (used >= limits.sessionMaxBytes) {
		return { refused: { usedBytes: used, sessionMaxBytes: limits.sessionMaxBytes } };
	}
	const number = reserveFileNumber(context);
	let created: Awaited<ReturnType<typeof createUnfinishedFile>>;
	try {
		created = await createUnfinishedFile(context, tool, number);
	} catch (error) {
		return { openFailed: { message: errorMessage(error) } };
	}
	const writer = new OutputWriter(context, created.name, created.fileStream, limits);
	context.openFiles.add(writer);
	return { opened: writer };
}

export async function finishOutputFile(
	file: OpenFile,
	outcome: FileOutcome,
	record: FileRecord,
	mode: OutputMode = "spillover",
): Promise<FinishOutcome> {
	const writer = openWriter(file);
	if (mode === "artifact" && outcome !== "complete") {
		throw new Error("Artifact output must be complete");
	}
	try {
		await writer.closed;
	} catch (error) {
		if (!(error instanceof OutputLimitError)) return await withdraw(writer, error);
	}
	const suffix = mode === "artifact" ? ARTIFACT_SUFFIX : FINAL_SUFFIX[outcome];
	const finalName = `${writer.name}${suffix}`;
	const finalPath = join(writer.directory, finalName);
	let size: number;
	try {
		size = (await stat(writer.path)).size;
		await rename(writer.path, finalPath);
	} catch (error) {
		return await withdraw(writer, error);
	}
	const entry: ManifestEntry = {
		v: MANIFEST_VERSION,
		file: finalName,
		tool: record.tool,
		command: record.command,
		size,
		status: outcome,
		createdAt: new Date().toISOString(),
	};
	try {
		await appendManifestLine(writer.context, entry);
	} catch (error) {
		await rm(finalPath, { force: true });
		writer.context.openFiles.delete(writer);
		return { saveFailed: { message: errorMessage(error) } };
	}
	writer.context.publishedBytes += size;
	writer.context.openFiles.delete(writer);
	return { saved: { file: finalName, path: finalPath, size, status: outcome } };
}

export async function saveBytes(
	session: SessionPaths,
	tool: string,
	limits: FileLimits,
	bytes: Buffer,
	outcome: FileOutcome,
	record: FileRecord,
): Promise<SaveOutcome> {
	const opened = await openOutputFile(session, tool, limits);
	if ("refused" in opened) return opened;
	if ("openFailed" in opened) return { saveFailed: opened.openFailed };
	const file = opened.opened;
	try {
		await pipeline(Readable.from([bytes]), file.sink);
	} catch (error) {
		await discardOutputFile(file);
		return { saveFailed: { message: errorMessage(error) } };
	}
	return finishOutputFile(file, outcome, record);
}

export async function discardOutputFile(file: OpenFile): Promise<void> {
	if (file instanceof OutputWriter && !file.context.openFiles.has(file)) return;
	const writer = openWriter(file);
	writer.sink.destroy();
	await writer.closed.catch(() => {});
	await rm(writer.path, { force: true });
	writer.context.openFiles.delete(writer);
}

export async function readExcerpt(
	file: OpenFile | SavedFile,
	selection: ExcerptSelection,
	bytes: number,
): Promise<Excerpt> {
	const handle = await open(await closedPath(file), "r");
	try {
		const { size } = await handle.stat();
		if (size <= bytes) {
			return { text: (await handle.readFile()).toString("utf8"), cut: false };
		}
		const window = Buffer.alloc(bytes);
		const position = selection === "head" ? 0 : size - bytes;
		const { bytesRead } = await handle.read(window, 0, bytes, position);
		return { text: wholeLines(window.toString("utf8", 0, bytesRead), selection), cut: true };
	} finally {
		await handle.close();
	}
}

export async function readManifest(session: SessionPaths): Promise<ManifestEntry[]> {
	let text: string;
	try {
		text = await readFile(join(session.outputDirectory, MANIFEST_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const lines = text.split("\n");
	lines.pop();
	return lines.flatMap(parseManifestLine);
}

function openWriter(file: OpenFile): OutputWriter {
	if (!(file instanceof OutputWriter) || !file.context.openFiles.has(file)) {
		throw new Error(`Not an open output file: ${file.path}`);
	}
	if (file.context.closed) throw new Error(`session context closed: ${file.context.paths.outputDirectory}`);
	return file;
}

async function closedPath(file: OpenFile | SavedFile): Promise<string> {
	if (file instanceof OutputWriter) {
		try {
			await file.closed;
		} catch (error) {
			if (!(error instanceof OutputLimitError)) throw error;
		}
	}
	return file.path;
}

async function withdraw(writer: OutputWriter, error: unknown): Promise<FinishOutcome> {
	await rm(writer.path, { force: true });
	writer.context.openFiles.delete(writer);
	return { saveFailed: { message: errorMessage(error) } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function createUnfinishedFile(context: SessionContext, tool: string, reserved: number) {
	const directory = context.paths.outputDirectory;
	let number = reserved;
	for (;;) {
		const name = `${tool}-${number}`;
		try {
			const handle = await open(join(directory, `${name}${UNFINISHED_SUFFIX}`), "wx", FILE_MODE);
			return { name, fileStream: handle.createWriteStream() };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			number = reserveFileNumber(context);
		}
	}
}

function reserveFileNumber(context: SessionContext): number {
	const number = context.nextFileNumber;
	context.nextFileNumber += 1;
	return number;
}

function appendManifestLine(context: SessionContext, entry: ManifestEntry): Promise<void> {
	const path = join(context.paths.outputDirectory, MANIFEST_FILE);
	const line = `${JSON.stringify(entry)}\n`;
	const append = context.manifestQueue.then(() => appendFile(path, line, { mode: FILE_MODE }));
	context.manifestQueue = append.catch(() => {});
	return append;
}

function parseManifestLine(line: string): ManifestEntry[] {
	try {
		const entry: unknown = JSON.parse(line);
		return isManifestEntry(entry) ? [entry] : [];
	} catch {
		return [];
	}
}

function isManifestEntry(value: unknown): value is ManifestEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		entry.v === MANIFEST_VERSION &&
		typeof entry.file === "string" &&
		typeof entry.tool === "string" &&
		typeof entry.command === "string" &&
		typeof entry.size === "number" &&
		(entry.status === "complete" || entry.status === "truncated") &&
		typeof entry.createdAt === "string"
	);
}

function wholeLines(text: string, selection: ExcerptSelection): string {
	if (selection === "head") {
		const last = text.lastIndexOf("\n");
		return last === -1 ? text : text.slice(0, last + 1);
	}
	const first = text.indexOf("\n");
	const rest = text.slice(first + 1);
	return first === -1 || rest === "" ? text : rest;
}
