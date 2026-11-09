import { type ChildProcessByStdio, spawn } from "child_process";
import { once } from "events";
import type { Readable } from "stream";
import type { ProducerRuntime } from "./runtime.ts";
import type { SessionPaths } from "./session.ts";
import {
	discardOutputFile,
	type OpenFile,
	OutputLimitError,
	type OutputSaveError,
	openOutputFile,
	quotaMessage,
} from "./store.ts";

export type OutputLimit = "stdout" | "stderr" | "session";

export type StreamStatus = "ok" | "failed" | "timeout" | "cancelled" | "output_limit" | "save_failed";

export interface StreamResult {
	status: StreamStatus;
	exitCode: number | null;
	signal?: NodeJS.Signals;
	output?: OpenFile;
	stderr: Buffer;
	startError?: string;
	limit?: OutputLimit;
	elapsedMs: number;
	saveError?: OutputSaveError;
}

export interface ProcessCall {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	tool: string;
	timeoutMs: number;
}

type ChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type Stop =
	| { reason: "timeout" | "cancelled" }
	| { reason: "output_limit"; limit: OutputLimit }
	| { reason: "save_failed"; error: string };

const NO_STDERR = Buffer.alloc(0);

export async function runProcess(
	call: ProcessCall,
	runtime: ProducerRuntime,
	session: SessionPaths,
	signal: AbortSignal | undefined,
): Promise<StreamResult> {
	const startedAt = performance.now();
	const { fileMaxBytes, sessionMaxBytes } = runtime.limits;
	const opened = await openOutputFile(session, call.tool, { fileMaxBytes, sessionMaxBytes });
	if ("refused" in opened) {
		return saveFailure(quotaMessage(opened.refused), startedAt);
	}
	if ("openFailed" in opened) {
		return saveFailure(opened.openFailed.message, startedAt);
	}
	if (signal?.aborted) {
		await discardOutputFile(opened.opened);
		return cancelledBeforeStart(startedAt);
	}
	const child = spawn(call.command, call.args, {
		env: call.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (child.pid === undefined) {
		const [error] = await once(child, "error");
		await discardOutputFile(opened.opened);
		return startFailure(error, startedAt);
	}
	return new ProcessRun(child, child.pid, runtime, call.timeoutMs, opened.opened, signal, startedAt).start();
}

function cancelledBeforeStart(startedAt: number): StreamResult {
	return { status: "cancelled", exitCode: null, stderr: NO_STDERR, elapsedMs: elapsedSince(startedAt) };
}

function startFailure(error: Error, startedAt: number): StreamResult {
	return {
		status: "failed",
		exitCode: null,
		stderr: NO_STDERR,
		startError: error.message,
		elapsedMs: elapsedSince(startedAt),
	};
}

function saveFailure(message: string, startedAt: number): StreamResult {
	return {
		status: "save_failed",
		exitCode: null,
		stderr: NO_STDERR,
		elapsedMs: elapsedSince(startedAt),
		saveError: { message },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ProcessRun {
	private readonly child: ChildProcess;
	private readonly pid: number;
	private readonly runtime: ProducerRuntime;
	private readonly timeoutMs: number;
	private readonly file: OpenFile;
	private readonly signal: AbortSignal | undefined;
	private readonly startedAt: number;
	private readonly stderr: StreamCapture;
	private readonly completion = Promise.withResolvers<StreamResult>();
	private exitCode: number | null = null;
	private exitSignal: NodeJS.Signals | undefined;
	private exited = false;
	private stopped: Stop | undefined;
	private sinkEnded = false;
	private sinkFailed = false;
	private settling = false;
	private sigkillSent = false;
	private timeoutTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private readonly onAbort = () => this.kill({ reason: "cancelled" });

	constructor(
		child: ChildProcess,
		pid: number,
		runtime: ProducerRuntime,
		timeoutMs: number,
		file: OpenFile,
		signal: AbortSignal | undefined,
		startedAt: number,
	) {
		this.child = child;
		this.pid = pid;
		this.runtime = runtime;
		this.timeoutMs = timeoutMs;
		this.file = file;
		this.signal = signal;
		this.startedAt = startedAt;
		this.stderr = new StreamCapture(runtime.limits.stderrMaxBytes);
	}

	start(): Promise<StreamResult> {
		this.timeoutTimer = setTimeout(() => this.kill({ reason: "timeout" }), this.timeoutMs);
		this.runtime.activeProcessGroups.add(this.pid);
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.child.stdout.on("data", (chunk: Buffer) => this.forward(chunk));
		this.child.stdout.once("end", () => this.endSink());
		this.file.sink.once("error", (error) => this.onSinkError(error));
		this.child.stderr.on("data", (chunk: Buffer) => this.collect(chunk));
		this.child.once("exit", (code, signal) => this.onExit(code, signal));
		this.child.once("close", () => this.onClose());
		return this.completion.promise;
	}

	private forward(chunk: Buffer): void {
		if (this.sinkFailed) return;
		if (!this.file.sink.write(chunk)) {
			this.child.stdout.pause();
			this.file.sink.once("drain", () => this.child.stdout.resume());
		}
	}

	private endSink(): void {
		if (this.sinkEnded || this.sinkFailed) return;
		this.sinkEnded = true;
		this.file.sink.end();
	}

	private collect(chunk: Buffer): void {
		if (!this.stderr.retain(chunk)) this.kill({ reason: "output_limit", limit: "stderr" });
	}

	private onSinkError(error: Error): void {
		this.sinkFailed = true;
		if (this.settling) return;
		if (error instanceof OutputLimitError) {
			this.kill({ reason: "output_limit", limit: limitOf(error) });
			return;
		}
		this.kill({ reason: "save_failed", error: error.message });
	}

	private kill(stop: Stop): void {
		if (this.stopped !== undefined || this.settling) return;
		this.stopped = stop;
		killProcessGroup(this.pid, "SIGTERM");
		this.graceTimer = setTimeout(() => {
			killProcessGroup(this.pid, "SIGKILL");
			this.sigkillSent = true;
			this.finishKilledRun();
		}, this.runtime.limits.killGraceMs);
		this.finishKilledRun();
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.exited = true;
		this.exitCode = code;
		this.exitSignal = signal ?? undefined;
		this.finishKilledRun();
	}

	private onClose(): void {
		if (this.stopped === undefined) void this.finish();
	}

	private finishKilledRun(): void {
		if (this.stopped === undefined || !this.exited) return;
		if (this.sigkillSent || !processGroupExists(this.pid)) void this.finish();
	}

	private async finish(): Promise<void> {
		if (this.settling) return;
		this.settling = true;
		clearTimeout(this.timeoutTimer);
		clearTimeout(this.graceTimer);
		this.signal?.removeEventListener("abort", this.onAbort);
		this.runtime.activeProcessGroups.delete(this.pid);
		if (this.stopped !== undefined) {
			this.child.stdout.destroy();
			this.child.stderr.destroy();
		}
		this.endSink();
		const stopped = this.stopped;
		let saveError = stopped?.reason === "save_failed" ? stopped.error : undefined;
		let flushLimit: OutputLimit | undefined;
		try {
			await this.file.closed;
		} catch (error) {
			if (error instanceof OutputLimitError) flushLimit = limitOf(error);
			else saveError ??= errorMessage(error);
		}
		const result: StreamResult = {
			status: "ok",
			exitCode: this.exitCode,
			stderr: this.stderr.bytes(),
			elapsedMs: elapsedSince(this.startedAt),
		};
		if (this.exitSignal !== undefined) result.signal = this.exitSignal;
		if (stopped !== undefined) {
			result.status = stopped.reason;
			if (stopped.reason === "output_limit") result.limit = stopped.limit;
		} else if (flushLimit !== undefined) {
			result.status = "output_limit";
			result.limit = flushLimit;
		} else if (this.exitCode !== 0) {
			result.status = "failed";
		}
		if (saveError !== undefined) {
			result.status = "save_failed";
			result.saveError = { message: saveError };
			await discardOutputFile(this.file).catch(() => undefined);
		} else {
			result.output = this.file;
		}
		this.completion.resolve(result);
	}
}

function limitOf(error: OutputLimitError): OutputLimit {
	return error.limit === "file" ? "stdout" : "session";
}

class StreamCapture {
	private readonly maxBytes: number;
	private readonly chunks: Buffer[] = [];
	private retainedBytes = 0;
	private overflowed = false;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	retain(chunk: Buffer): boolean {
		if (this.overflowed || this.retainedBytes + chunk.length > this.maxBytes) {
			this.overflowed = true;
			return false;
		}
		this.chunks.push(chunk);
		this.retainedBytes += chunk.length;
		return true;
	}

	bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {}
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function elapsedSince(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}
