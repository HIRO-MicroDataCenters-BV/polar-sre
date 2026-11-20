import { spawn } from "child_process";
import { tmpdir } from "os";
import { StringDecoder } from "string_decoder";
import { killProcessGroup } from "../../shared/process.ts";
import type { CleanupError, CommandOutcome, SandboxDriverContext } from "./types.ts";

export const CLI_STOPPED = "sandbox is stopping; no command starts";
const COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const DIAGNOSTIC_MAX_LINES = 64;

export interface ListedResource {
	name: string;
	labels: Record<string, unknown>;
	state?: string;
}

export interface CommandOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	command?: string;
	env?: NodeJS.ProcessEnv;
	onLine?: (line: string) => void;
}

export function containerCommand(
	runtime: SandboxDriverContext,
	args: string[],
	options?: CommandOptions,
): Promise<CommandOutcome>;
export function containerCommand(
	runtime: SandboxDriverContext,
	args: string[],
	timeoutMs?: number,
	signal?: AbortSignal,
	command?: string,
	env?: NodeJS.ProcessEnv,
): Promise<CommandOutcome>;
export function containerCommand(
	runtime: SandboxDriverContext,
	args: string[],
	timeoutOrOptions?: number | CommandOptions,
	positionalSignal?: AbortSignal,
	positionalCommand?: string,
	positionalEnv?: NodeJS.ProcessEnv,
): Promise<CommandOutcome> {
	const options: CommandOptions =
		typeof timeoutOrOptions === "object"
			? timeoutOrOptions
			: { timeoutMs: timeoutOrOptions, signal: positionalSignal, command: positionalCommand, env: positionalEnv };
	const timeoutMs = options.timeoutMs ?? runtime.limits.commandTimeoutMs;
	const signal = options.signal;
	const command = options.command ?? runtime.containerCommand;
	const env = options.env ?? runtime.environment;
	if (runtime.cliStopped) return Promise.resolve({ code: null, stdout: "", stderr: CLI_STOPPED, timedOut: false });
	if (signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "cancelled", timedOut: false });
	return new Promise((resolve) => {
		// The command leads its own process group, so stopping it also stops the helpers it started.
		const child = spawn(command, args, {
			cwd: tmpdir(),
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const { pid } = child;
		if (pid !== undefined) runtime.children.set(child, "service");
		const stdout = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		const stderr = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		const stdoutLines = options.onLine ? new LineSplitter(options.onLine) : undefined;
		const stderrLines = options.onLine ? new LineSplitter(options.onLine) : undefined;
		let timedOut = false;
		let settled = false;
		let graceTimer: NodeJS.Timeout | undefined;
		const settle = (code: number | null, error?: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(graceTimer);
			signal?.removeEventListener("abort", stop);
			runtime.children.delete(child);
			stdoutLines?.end();
			stderrLines?.end();
			resolve({
				code,
				stdout: stdout.text(),
				stderr: error === undefined ? stderr.text() : error.message,
				timedOut,
				spawnError: error?.code,
			});
		};
		const stop = () => {
			if (pid === undefined || graceTimer !== undefined) return;
			killProcessGroup(pid, "SIGTERM");
			graceTimer = setTimeout(() => {
				killProcessGroup(pid, "SIGKILL");
				// A process that left the group may still hold the pipes, and "close" would wait for it.
				child.stdout.destroy();
				child.stderr.destroy();
				settle(child.exitCode);
			}, runtime.limits.killGraceMs);
		};
		signal?.addEventListener("abort", stop, { once: true });
		const timer = setTimeout(
			() => {
				timedOut = true;
				stop();
			},
			Math.max(1, timeoutMs),
		);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout.retain(chunk);
			stdoutLines?.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr.retain(chunk);
			stderrLines?.write(chunk);
		});
		child.once("error", (error) => settle(null, error));
		// "exit" can precede the last output, so a command that ends on its own settles on "close".
		child.once("close", (code) => settle(code));
	});
}

export function deadlineAfter(runtime: SandboxDriverContext): number {
	return Date.now() + runtime.limits.commandTimeoutMs;
}

export function remainingMs(deadlineAt: number): number {
	return Math.max(0, deadlineAt - Date.now());
}

export function firstLine(text: string): string {
	return text.split("\n", 1)[0].trim();
}

export function commandFailure(outcome: CommandOutcome): string {
	const said = outcome.stderr.trim();
	if (outcome.timedOut) return said === "" ? "timed out" : `timed out; stderr: ${boundDiagnostic(said)}`;
	return said === "" ? `exit ${outcome.code}` : boundDiagnostic(said);
}

export function boundDiagnostic(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	let end = Math.min(bytes.length, DIAGNOSTIC_MAX_BYTES);
	let lines = 0;
	for (let index = 0; index < end; index += 1) {
		if (bytes[index] === 0x0a && ++lines === DIAGNOSTIC_MAX_LINES) {
			end = index;
			break;
		}
	}
	if (end === bytes.length) return text;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return `${bytes.toString("utf8", 0, end)} [${bytes.length - end} more bytes not shown]`;
}

export function describeCleanupErrors(errors: CleanupError[]): string {
	return errors.map((error) => `${error.container} (${error.message})`).join(", ");
}

export class LineSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private readonly onLine: (line: string) => void;
	private partial = "";

	constructor(onLine: (line: string) => void) {
		this.onLine = onLine;
	}

	write(chunk: Buffer): void {
		this.push(this.decoder.write(chunk));
	}

	end(): void {
		this.push(`${this.decoder.end()}\n`);
	}

	private push(text: string): void {
		const lines = (this.partial + text).split(/[\r\n]/);
		this.partial = lines.pop() ?? "";
		for (const line of lines) {
			if (line !== "") this.onLine(line);
		}
	}
}

export class StreamCapture {
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
