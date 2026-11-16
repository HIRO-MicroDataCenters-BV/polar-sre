import { randomBytes } from "crypto";
import {
	discardOutputFile,
	type OpenFile,
	type OpenOutcome,
	OutputLimitError,
	openOutputFile,
	quotaMessage,
} from "../../shared/store.ts";
import { deadlineAfter, describeCleanupErrors, StreamCapture } from "./cli.ts";
import { WORK_LIMIT_EXIT_CODE } from "./driver.ts";
import type {
	HotSandbox,
	OutputLimit,
	RunningCall,
	SandboxProcess,
	SandboxRequest,
	SandboxResult,
	SandboxRuntime,
} from "./types.ts";
import { cleanupOwned, closeIfDrained } from "./workspace.ts";

type Stop =
	| { reason: "timeout" | "cancelled" | "shutdown" }
	| { reason: "output_limit"; limit: OutputLimit }
	| { reason: "save_failed"; error: string };

const SHUTTING_DOWN = "run_code is shutting down; no program starts.";
const SIGKILL_EXIT_CODE = 137;
const NO_STDERR = Buffer.alloc(0);

export function containerName(sessionId: string, outputName: string): string {
	const number = outputName.slice(outputName.lastIndexOf("-") + 1);
	return `polar-sandbox-${sessionId}-${number}-${randomBytes(4).toString("hex")}`;
}

export function admitCall(
	runtime: SandboxRuntime,
	request: SandboxRequest,
	signal: AbortSignal | undefined,
	toolCallId: string,
): SandboxCall | undefined {
	if (runtime.state !== "open") return undefined;
	runtime.inFlight.add(toolCallId);
	return new SandboxCall(runtime, request, signal, toolCallId);
}

export function shutdownRefusal(startedAt: number = performance.now()): SandboxResult {
	return runtimeFailure(SHUTTING_DOWN, startedAt);
}

export class SandboxCall {
	private readonly runtime: SandboxRuntime;
	private readonly request: SandboxRequest;
	private readonly signal: AbortSignal | undefined;
	private readonly ticket: string;
	private readonly startedAt = performance.now();
	private file: OpenFile | undefined;

	constructor(runtime: SandboxRuntime, request: SandboxRequest, signal: AbortSignal | undefined, ticket: string) {
		this.runtime = runtime;
		this.request = request;
		this.signal = signal;
		this.ticket = ticket;
	}

	async run(): Promise<SandboxResult> {
		const activeName = this.runtime.activeSandbox.current?.name;
		const leftovers = await cleanupOwned(this.runtime, deadlineAfter(this.runtime), activeName);
		const stopped = this.checkpoint();
		if (stopped !== undefined) return stopped;
		if (leftovers.length > 0) {
			return runtimeFailure(
				`a container of an earlier call could not be deleted: ${describeCleanupErrors(leftovers)}.`,
				this.startedAt,
			);
		}
		const { fileMaxBytes, sessionMaxBytes } = this.runtime.limits;
		const opened = await openOutputFile(this.runtime.handle.paths, "run_code", { fileMaxBytes, sessionMaxBytes });
		if ("opened" in opened) this.file = opened.opened;
		const late = this.checkpoint();
		if (late !== undefined) {
			if (this.file !== undefined) await discardOutputFile(this.file);
			return late;
		}
		if (!("opened" in opened)) return saveFailure(openRefusal(opened), this.startedAt);
		return this.executeInSandbox(opened.opened);
	}

	async dispose(): Promise<void> {
		try {
			if (this.file !== undefined) await discardOutputFile(this.file);
		} finally {
			this.runtime.inFlight.delete(this.ticket);
			await closeIfDrained(this.runtime);
		}
	}

	private checkpoint(): SandboxResult | undefined {
		if (this.runtime.state !== "open") return shutdownRefusal(this.startedAt);
		if (this.signal?.aborted) {
			return { status: "cancelled", exitCode: null, stderr: NO_STDERR, elapsedMs: elapsedSince(this.startedAt) };
		}
		return undefined;
	}

	private async executeInSandbox(file: OpenFile): Promise<SandboxResult> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const existing = this.runtime.activeSandbox.current;
			const reused = existing !== undefined;
			let hot: HotSandbox;
			if (existing !== undefined) {
				hot = existing;
			} else {
				const name = containerName(this.runtime.handle.paths.sessionId, file.name);
				const started = await this.runtime.driver.startSandbox(
					name,
					this.runtime.handle.paths,
					deadlineAfter(this.runtime),
					this.signal,
				);
				const afterStart = this.checkpoint();
				if (afterStart !== undefined) {
					if ("started" in started) return this.abortSandbox(started.started, file, afterStart);
					if (started.leftover !== undefined) afterStart.cleanupError = started.leftover;
					await discardOutputFile(file);
					return afterStart;
				}
				if ("failed" in started) {
					await discardOutputFile(file);
					const result = runtimeFailure(started.failed, this.startedAt);
					if (started.leftover !== undefined) result.cleanupError = started.leftover;
					return result;
				}
				hot = started.started;
				this.runtime.activeSandbox.current = hot;
			}

			const spawned = await hot.spawnCall(this.request.language);
			const afterSpawn = this.checkpoint();
			if (afterSpawn !== undefined) {
				if ("spawned" in spawned) {
					spawned.spawned.kill();
					await spawned.spawned.closed;
				}
				return this.abortSandbox(hot, file, afterSpawn);
			}
			if ("spawned" in spawned) {
				return new SandboxRun(spawned.spawned, hot, this.runtime, file, this.signal, performance.now()).start(
					this.request.code,
				);
			}

			if (this.runtime.activeSandbox.current === hot) {
				this.runtime.activeSandbox.current = undefined;
			}
			const cleanup = await hot.destroy(deadlineAfter(this.runtime));
			if (!reused) {
				await discardOutputFile(file);
				const result = runtimeFailure(spawned.gone, this.startedAt);
				if (!cleanup.removed) result.cleanupError = cleanup.error;
				return result;
			}
			const afterCleanup = this.checkpoint();
			if (afterCleanup !== undefined) {
				if (!cleanup.removed) afterCleanup.cleanupError = cleanup.error;
				await discardOutputFile(file);
				return afterCleanup;
			}
			if (!cleanup.removed) {
				await discardOutputFile(file);
				return {
					...runtimeFailure(
						`a container of an earlier call could not be deleted: ${describeCleanupErrors([cleanup.error])}.`,
						this.startedAt,
					),
					cleanupError: cleanup.error,
				};
			}
		}
		throw new Error("unreachable");
	}

	private async abortSandbox(hot: HotSandbox, file: OpenFile, result: SandboxResult): Promise<SandboxResult> {
		if (this.runtime.activeSandbox.current === hot) {
			this.runtime.activeSandbox.current = undefined;
		}
		const cleanup = await hot.destroy(deadlineAfter(this.runtime));
		if (!cleanup.removed) result.cleanupError = cleanup.error;
		await discardOutputFile(file);
		return result;
	}
}

function saveFailure(message: string, startedAt: number): SandboxResult {
	return {
		status: "save_failed",
		exitCode: null,
		stderr: NO_STDERR,
		elapsedMs: elapsedSince(startedAt),
		saveError: { message },
	};
}

function runtimeFailure(message: string, startedAt: number): SandboxResult {
	return {
		status: "runtime_failed",
		exitCode: null,
		stderr: NO_STDERR,
		runtimeMessage: message,
		elapsedMs: elapsedSince(startedAt),
	};
}

export function openRefusal(outcome: Exclude<OpenOutcome, { opened: OpenFile }>): string {
	return "refused" in outcome ? quotaMessage(outcome.refused) : outcome.openFailed.message;
}

export class SandboxRun implements RunningCall {
	private readonly process: SandboxProcess;
	private readonly hot: HotSandbox;
	private readonly runtime: SandboxRuntime;
	private readonly file: OpenFile;
	private readonly signal: AbortSignal | undefined;
	private readonly startedAt: number;
	private readonly stderr: StreamCapture;
	private readonly completion = Promise.withResolvers<SandboxResult>();
	private exitCode: number | null = null;
	private stopped: Stop | undefined;
	private sinkEnded = false;
	private sinkFailed = false;
	private settling = false;
	private timeoutTimer: NodeJS.Timeout | undefined;
	private readonly onAbort = () => this.kill({ reason: "cancelled" });

	constructor(
		process: SandboxProcess,
		hot: HotSandbox,
		runtime: SandboxRuntime,
		file: OpenFile,
		signal: AbortSignal | undefined,
		startedAt: number,
	) {
		this.process = process;
		this.hot = hot;
		this.runtime = runtime;
		this.file = file;
		this.signal = signal;
		this.startedAt = startedAt;
		this.stderr = new StreamCapture(runtime.limits.stderrMaxBytes);
	}

	start(code: string): Promise<SandboxResult> {
		this.runtime.running.add(this);
		this.timeoutTimer = setTimeout(() => this.kill({ reason: "timeout" }), this.runtime.limits.timeoutMs);
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.process.stdin.on("error", () => {});
		this.process.stdin.end(code);
		this.process.stdout.on("data", (chunk: Buffer) => this.forward(chunk));
		this.process.stdout.once("end", () => this.endSink());
		this.file.sink.once("error", (error) => this.onSinkError(error));
		this.process.stderr.on("data", (chunk: Buffer) => this.collect(chunk));
		void this.process.closed.then((code) => this.onClose(code));
		return this.completion.promise;
	}

	stop(): void {
		this.kill({ reason: "shutdown" });
	}

	private forward(chunk: Buffer): void {
		if (this.sinkFailed) return;
		if (!this.file.sink.write(chunk)) {
			this.process.stdout.pause();
			this.file.sink.once("drain", () => this.process.stdout.resume());
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
		this.process.kill();
	}

	private onClose(code: number | null): void {
		this.exitCode = code;
		this.finish().catch((error: unknown) => this.completion.reject(error));
	}

	private async finish(): Promise<void> {
		if (this.settling) return;
		this.settling = true;
		this.runtime.running.delete(this);
		clearTimeout(this.timeoutTimer);
		this.signal?.removeEventListener("abort", this.onAbort);
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
		const result: SandboxResult = {
			status: "ok",
			exitCode: this.exitCode,
			stderr: this.stderr.bytes(),
			elapsedMs: 0,
		};
		let shouldDestroy = false;
		if (stopped !== undefined) {
			result.status = stopped.reason === "shutdown" ? "cancelled" : stopped.reason;
			if (stopped.reason === "output_limit") result.limit = stopped.limit;
			shouldDestroy = true;
		} else if (flushLimit !== undefined) {
			result.status = "output_limit";
			result.limit = flushLimit;
			shouldDestroy = true;
		} else if (this.exitCode !== 0) {
			const judged = await this.judgeExit();
			Object.assign(result, judged);
			if (
				judged.status === "out_of_memory" ||
				(judged.status !== "work_limit" && judged.inspection?.state !== "present")
			) {
				shouldDestroy = true;
			}
		}
		if (!shouldDestroy && saveError === undefined && this.runtime.state === "open") {
			const scrubbed = await this.hot.scrubAfterCall(deadlineAfter(this.runtime));
			if (!scrubbed || this.runtime.state !== "open") {
				shouldDestroy = true;
			}
		} else {
			shouldDestroy = true;
		}
		if (shouldDestroy) {
			if (this.runtime.activeSandbox.current === this.hot) {
				this.runtime.activeSandbox.current = undefined;
			}
			const cleanup = await this.hot.destroy(deadlineAfter(this.runtime));
			if (!cleanup.removed) result.cleanupError = cleanup.error;
		}
		if (saveError !== undefined) {
			result.status = "save_failed";
			result.saveError = { message: saveError };
			await discardOutputFile(this.file).catch(() => undefined);
		} else {
			result.output = this.file;
		}
		result.elapsedMs = elapsedSince(this.startedAt);
		this.completion.resolve(result);
	}

	private async judgeExit(): Promise<Pick<SandboxResult, "status" | "oomEvidence" | "inspection">> {
		if (this.exitCode === WORK_LIMIT_EXIT_CODE) {
			return { status: "work_limit" };
		}
		if (this.exitCode === SIGKILL_EXIT_CODE) {
			const oomEvidence = await this.hot.checkOom(deadlineAfter(this.runtime));
			if (oomEvidence !== undefined) return { status: "out_of_memory", oomEvidence };
		}
		const inspection = await this.hot.inspect(deadlineAfter(this.runtime));
		return { status: "failed", inspection };
	}
}

function limitOf(error: OutputLimitError): OutputLimit {
	return error.limit === "file" ? "stdout" : "session";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function elapsedSince(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}
