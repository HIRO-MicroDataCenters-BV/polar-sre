import { rmSync } from "fs";
import { type FileHandle, mkdir, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface SessionPaths {
	sessionId: string;
	cwd: string;
	outputDirectory: string;
}

export interface AcquireOptions {
	pid?: number;
	now?: number;
	staleAfterMs?: number;
}

export interface SessionHandle {
	readonly paths: SessionPaths;
	release(): Promise<void>;
}

export type SessionLiveness = "alive" | "ended" | "unknown";

export interface OpenFileCount {
	bytesWritten(): number;
}

export interface SessionContext {
	readonly paths: SessionPaths;
	holders: number;
	publishedBytes: number;
	nextFileNumber: number;
	readonly openFiles: Set<OpenFileCount>;
	manifestQueue: Promise<unknown>;
	closed: boolean;
}

const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;
const LOCK_FILE = "lock";
export const MANIFEST_FILE = "manifest.jsonl";
const MANIFEST_TAIL_CHUNK_BYTES = 4096;
export const UNFINISHED_SUFFIX = ".part";
export const OUTPUT_FILE_NAME = /^(.+)-(\d+)\.(?:part|txt|truncated\.txt|bin)$/;
export const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const REGISTRY_SLOT = Symbol.for("polar/session-registry@1");

interface RegisteredContext extends SessionContext {
	prepared: Promise<void>;
}

function registry(): Map<string, RegisteredContext> {
	const slots = globalThis as Record<symbol, Map<string, RegisteredContext> | undefined>;
	let contexts = slots[REGISTRY_SLOT];
	if (contexts === undefined) {
		contexts = new Map();
		slots[REGISTRY_SLOT] = contexts;
	}
	return contexts;
}

export function artifactsRoot(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.POLAR_ARTIFACTS_DIR) return environment.POLAR_ARTIFACTS_DIR;
	const cacheHome = environment.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cacheHome, "polar-artifacts");
}

export function sessionPaths(sessionId: string, cwd: string, root: string = artifactsRoot()): SessionPaths {
	return { sessionId, cwd, outputDirectory: join(resolve(root), sessionId) };
}

export async function acquireSession(
	sessionId: string,
	cwd: string,
	root: string = artifactsRoot(),
	options: AcquireOptions = {},
): Promise<SessionHandle> {
	const paths = sessionPaths(sessionId, cwd, root);
	const contexts = registry();
	let context = contexts.get(paths.outputDirectory);
	if (context === undefined) {
		context = {
			paths,
			holders: 1,
			publishedBytes: 0,
			nextFileNumber: 1,
			openFiles: new Set(),
			manifestQueue: Promise.resolve(),
			closed: false,
			prepared: Promise.resolve(),
		};
		contexts.set(paths.outputDirectory, context);
		context.prepared = prepare(context, options);
	} else {
		context.holders += 1;
	}
	await context.prepared;
	return createHandle(context, paths);
}

export function sessionContext(paths: SessionPaths): SessionContext {
	const context = registry().get(paths.outputDirectory);
	if (context === undefined || context.closed) throw new Error(`session context closed: ${paths.outputDirectory}`);
	return context;
}

export async function sessionLiveness(root: string, sessionId: string): Promise<SessionLiveness> {
	let content: string;
	try {
		content = await readFile(join(root, sessionId, LOCK_FILE), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "ended" : "unknown";
	}
	const text = content.trim();
	const pid = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "ended";
		return code === "EPERM" ? "alive" : "unknown";
	}
}

function createHandle(context: RegisteredContext, paths: SessionPaths): SessionHandle {
	let released = false;
	return {
		paths,
		async release() {
			if (released) return;
			released = true;
			releaseHolder(context);
		},
	};
}

function releaseHolder(context: RegisteredContext): void {
	context.holders -= 1;
	if (context.holders > 0) return;
	context.closed = true;
	registry().delete(context.paths.outputDirectory);
	rmSync(join(context.paths.outputDirectory, LOCK_FILE), { force: true });
}

async function prepare(context: RegisteredContext, options: AcquireOptions): Promise<void> {
	const directory = context.paths.outputDirectory;
	try {
		await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
		await writeFile(join(directory, LOCK_FILE), `${options.pid ?? process.pid}\n`, { mode: FILE_MODE });
		await deleteUnfinishedFiles(directory);
		await repairManifestTail(join(directory, MANIFEST_FILE));
		await removeStaleSessions(
			dirname(directory),
			directory,
			options.now ?? Date.now(),
			options.staleAfterMs ?? STALE_SESSION_MS,
		);
		const measured = await measureOutputFiles(directory);
		context.publishedBytes = measured.publishedBytes;
		context.nextFileNumber = measured.highestNumber + 1;
	} catch (error) {
		context.closed = true;
		registry().delete(directory);
		throw error;
	}
}

async function deleteUnfinishedFiles(directory: string): Promise<void> {
	for (const name of await readdir(directory)) {
		if (name.endsWith(UNFINISHED_SUFFIX)) await rm(join(directory, name), { force: true });
	}
}

async function repairManifestTail(path: string): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r+");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		const end = await endOfWholeLines(handle, size);
		if (end < size) await handle.truncate(end);
	} finally {
		await handle.close();
	}
}

async function endOfWholeLines(handle: FileHandle, size: number): Promise<number> {
	const chunk = Buffer.alloc(Math.min(MANIFEST_TAIL_CHUNK_BYTES, size));
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - chunk.length);
		const { bytesRead } = await handle.read(chunk, 0, end - start, start);
		const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
		if (newline !== -1) return start + newline + 1;
		end = start;
	}
	return 0;
}

async function removeStaleSessions(root: string, current: string, now: number, staleAfterMs: number): Promise<void> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const directory = join(root, entry.name);
		if (!entry.isDirectory() || directory === current) continue;
		if ((await sessionLiveness(root, entry.name)) !== "ended") continue;
		const { mtimeMs } = await stat(directory);
		if (now - mtimeMs > staleAfterMs) await rm(directory, { recursive: true, force: true });
	}
}

async function measureOutputFiles(directory: string): Promise<{ publishedBytes: number; highestNumber: number }> {
	let publishedBytes = 0;
	let highestNumber = 0;
	for (const name of await readdir(directory)) {
		const match = OUTPUT_FILE_NAME.exec(name);
		if (match === null) continue;
		highestNumber = Math.max(highestNumber, Number(match[2]));
		if (!name.endsWith(UNFINISHED_SUFFIX)) publishedBytes += (await stat(join(directory, name))).size;
	}
	return { publishedBytes, highestNumber };
}
