import { type ChildProcessByStdio, spawn } from "child_process";
import { randomBytes } from "crypto";
import { once } from "events";
import type { Readable, Writable } from "stream";
import {
	discardOutputFile,
	type OpenFile,
	type OpenOutcome,
	OutputLimitError,
	openOutputFile,
	quotaMessage,
} from "../../shared/store.ts";
import {
	cleanupContainer,
	cleanupOwned,
	commandFailure,
	containerCommand,
	deadlineAfter,
	describeCleanupErrors,
	firstLine,
	parseContainers,
} from "./cli.ts";
import {
	type CommandOutcome,
	DATA_PATH,
	type ExecLanguage,
	type ExecRequest,
	type ExecResult,
	type ExecRuntime,
	type Inspection,
	type OutputLimit,
	type RunningCall,
} from "./types.ts";
import { closeIfDrained, GUEST_USER, sessionLabels, WORK_PATH, workVolumeName } from "./workspace.ts";

type RunProcess = ChildProcessByStdio<Writable, Readable, Readable>;

type Stop =
	| { reason: "timeout" | "cancelled" | "shutdown" }
	| { reason: "output_limit"; limit: OutputLimit }
	| { reason: "save_failed"; error: string };

export const TMP_PATH = "/tmp";

const SHUTTING_DOWN = "exec is shutting down; no program starts.";

const PROGRAM_FILES: Record<ExecLanguage, string> = { python: "program.py", bash: "program.sh" };
const INTERPRETERS: Record<ExecLanguage, string> = { python: "python3", bash: "bash" };

export function launcher(language: ExecLanguage): string {
	const file = `"$d/${PROGRAM_FILES[language]}"`;
	return `d="\${TMPDIR:-/tmp}/.polar"; mkdir -p "$d" && cat > ${file} && exec ${INTERPRETERS[language]} ${file} </dev/null`;
}

const OOM_LINE = /(?:Memory cgroup out of memory|Out of memory): Killed process[^\n]*/;
const SIGKILL_EXIT_CODE = 137;
const NO_STDERR = Buffer.alloc(0);

export function containerName(sessionId: string, outputName: string): string {
	const number = outputName.slice(outputName.lastIndexOf("-") + 1);
	return `polar-exec-${sessionId}-${number}-${randomBytes(4).toString("hex")}`;
}

function mebibytes(bytes: number): number {
	return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

export function runArguments(runtime: ExecRuntime, name: string, language: ExecLanguage): string[] {
	const { limits } = runtime;
	const session = runtime.handle.paths;
	return [
		"run",
		"--progress",
		"none",
		"--network",
		"none",
		"--init",
		"--user",
		GUEST_USER,
		"--cap-drop",
		"ALL",
		"--read-only",
		"--tmpfs",
		`${TMP_PATH}:size=${mebibytes(limits.tmpMaxBytes)}M`,
		"--memory",
		`${mebibytes(limits.memoryBytes)}M`,
		"--cpus",
		String(limits.cpus),
		"--ulimit",
		`nproc=${limits.processMax}:${limits.processMax}`,
		"--volume",
		`${session.outputDirectory}:${DATA_PATH}:ro`,
		"--volume",
		`${workVolumeName(session.sessionId)}:${WORK_PATH}`,
		"--workdir",
		WORK_PATH,
		"--env",
		`HOME=${WORK_PATH}`,
		"--env",
		`TMPDIR=${TMP_PATH}`,
		"--name",
		name,
		...sessionLabels(session),
		"--interactive",
		runtime.image,
		"sh",
		"-c",
		launcher(language),
	];
}

export function admitCall(
	runtime: ExecRuntime,
	request: ExecRequest,
	signal: AbortSignal | undefined,
	toolCallId: string,
): ExecCall | undefined {
	if (runtime.state !== "open") return undefined;
	runtime.inFlight.add(toolCallId);
	return new ExecCall(runtime, request, signal, toolCallId);
}

export function shutdownRefusal(startedAt: number = performance.now()): ExecResult {
	return runtimeFailure(SHUTTING_DOWN, startedAt);
}

export class ExecCall {
	private readonly runtime: ExecRuntime;
	private readonly request: ExecRequest;
	private readonly signal: AbortSignal | undefined;
	private readonly ticket: string;
	private readonly startedAt = performance.now();
	private file: OpenFile | undefined;

	constructor(runtime: ExecRuntime, request: ExecRequest, signal: AbortSignal | undefined, ticket: string) {
		this.runtime = runtime;
		this.request = request;
		this.signal = signal;
		this.ticket = ticket;
	}

	async run(): Promise<ExecResult> {
		const leftovers = await cleanupOwned(this.runtime, deadlineAfter(this.runtime));
		const stopped = this.checkpoint();
		if (stopped !== undefined) return stopped;
		if (leftovers.length > 0) {
			return runtimeFailure(
				`a container of an earlier call could not be deleted: ${describeCleanupErrors(leftovers)}.`,
				this.startedAt,
			);
		}
		const { fileMaxBytes, sessionMaxBytes } = this.runtime.limits;
		const opened = await openOutputFile(this.runtime.handle.paths, "exec", { fileMaxBytes, sessionMaxBytes });
		if ("opened" in opened) this.file = opened.opened;
		const late = this.checkpoint();
		if (late !== undefined) {
			if (this.file !== undefined) await discardOutputFile(this.file);
			return late;
		}
		if (!("opened" in opened)) return saveFailure(openRefusal(opened), this.startedAt);
		return this.spawnRun(opened.opened);
	}

	async dispose(): Promise<void> {
		try {
			if (this.file !== undefined) await discardOutputFile(this.file);
		} finally {
			this.runtime.inFlight.delete(this.ticket);
			await closeIfDrained(this.runtime);
		}
	}

	private checkpoint(): ExecResult | undefined {
		if (this.runtime.state !== "open") return shutdownRefusal(this.startedAt);
		if (this.signal?.aborted) {
			return { status: "cancelled", exitCode: null, stderr: NO_STDERR, elapsedMs: elapsedSince(this.startedAt) };
		}
		return undefined;
	}

	private spawnRun(file: OpenFile): Promise<ExecResult> {
		const { runtime } = this;
		const name = containerName(runtime.handle.paths.sessionId, file.name);
		const args = runArguments(runtime, name, this.request.language);
		const child = spawn(runtime.containerCommand, args, {
			env: runtime.environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (child.pid === undefined) return this.spawnFailure(child, file);
		runtime.owned.add(name);
		runtime.children.set(child, "run");
		return new ExecRun(child, name, runtime, file, this.signal, this.startedAt).start(this.request.code);
	}

	private async spawnFailure(child: RunProcess, file: OpenFile): Promise<ExecResult> {
		const [error] = await once(child, "error");
		await discardOutputFile(file);
		return runtimeFailure((error as Error).message, this.startedAt);
	}
}

function saveFailure(message: string, startedAt: number): ExecResult {
	return {
		status: "save_failed",
		exitCode: null,
		stderr: NO_STDERR,
		elapsedMs: elapsedSince(startedAt),
		saveError: { message },
	};
}

function runtimeFailure(message: string, startedAt: number): ExecResult {
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

export class ExecRun implements RunningCall {
	private readonly child: RunProcess;
	private readonly name: string;
	private readonly runtime: ExecRuntime;
	private readonly file: OpenFile;
	private readonly signal: AbortSignal | undefined;
	private readonly startedAt: number;
	private readonly stderr: StreamCapture;
	private readonly completion = Promise.withResolvers<ExecResult>();
	private exitCode: number | null = null;
	private stopped: Stop | undefined;
	private killing: Promise<CommandOutcome> | undefined;
	private sinkEnded = false;
	private sinkFailed = false;
	private settling = false;
	private timeoutTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private readonly onAbort = () => this.kill({ reason: "cancelled" });

	constructor(
		child: RunProcess,
		name: string,
		runtime: ExecRuntime,
		file: OpenFile,
		signal: AbortSignal | undefined,
		startedAt: number,
	) {
		this.child = child;
		this.name = name;
		this.runtime = runtime;
		this.file = file;
		this.signal = signal;
		this.startedAt = startedAt;
		this.stderr = new StreamCapture(runtime.limits.stderrMaxBytes);
	}

	start(code: string): Promise<ExecResult> {
		this.runtime.running.add(this);
		this.timeoutTimer = setTimeout(() => this.kill({ reason: "timeout" }), this.runtime.limits.timeoutMs);
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.child.stdin.on("error", () => {});
		this.child.stdin.end(code);
		this.child.stdout.on("data", (chunk: Buffer) => this.forward(chunk));
		this.child.stdout.once("end", () => this.endSink());
		this.file.sink.once("error", (error) => this.onSinkError(error));
		this.child.stderr.on("data", (chunk: Buffer) => this.collect(chunk));
		this.child.once("close", (code) => this.onClose(code));
		return this.completion.promise;
	}

	stop(): void {
		this.kill({ reason: "shutdown" });
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
		this.killing = containerCommand(this.runtime, ["kill", this.name]);
		this.graceTimer = setTimeout(() => this.child.kill("SIGKILL"), this.runtime.limits.killGraceMs);
	}

	private onClose(code: number | null): void {
		this.runtime.children.delete(this.child);
		this.exitCode = code;
		this.finish().catch((error: unknown) => this.completion.reject(error));
	}

	private async finish(): Promise<void> {
		if (this.settling) return;
		this.settling = true;
		this.runtime.running.delete(this);
		clearTimeout(this.timeoutTimer);
		clearTimeout(this.graceTimer);
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
		await this.killing;
		const result: ExecResult = {
			status: "ok",
			exitCode: this.exitCode,
			stderr: this.stderr.bytes(),
			elapsedMs: 0,
		};
		if (stopped !== undefined) {
			result.status = stopped.reason === "shutdown" ? "cancelled" : stopped.reason;
			if (stopped.reason === "output_limit") result.limit = stopped.limit;
		} else if (flushLimit !== undefined) {
			result.status = "output_limit";
			result.limit = flushLimit;
		} else if (this.exitCode !== 0) {
			Object.assign(result, await this.judgeExit());
		}
		const cleanup = await cleanupContainer(this.runtime, this.name, deadlineAfter(this.runtime));
		if (!cleanup.removed) result.cleanupError = cleanup.error;
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

	private async judgeExit(): Promise<Pick<ExecResult, "status" | "oomEvidence" | "inspection">> {
		if (this.exitCode === SIGKILL_EXIT_CODE) {
			const log = await containerCommand(this.runtime, ["logs", "--boot", this.name]);
			const evidence = OOM_LINE.exec(log.stdout);
			if (evidence !== null) return { status: "out_of_memory", oomEvidence: evidence[0].trim() };
		}
		const inspected = await containerCommand(this.runtime, ["inspect", this.name]);
		return { status: "failed", inspection: inspectionOf(inspected, this.name) };
	}
}

function inspectionOf(inspected: CommandOutcome, name: string): Inspection {
	if (inspected.code === 0) {
		const listed = parseContainers(inspected.stdout);
		if (listed?.some((container) => container.name === name)) return { state: "present" };
		return { state: "unknown", detail: "unreadable answer" };
	}
	if (firstLine(inspected.stderr) === `Error: container not found: ${name}`) return { state: "absent" };
	return { state: "unknown", detail: commandFailure(inspected) };
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

	text(): string {
		return this.bytes().toString("utf8");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function elapsedSince(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}
