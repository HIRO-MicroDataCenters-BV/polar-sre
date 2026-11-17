import { spawn } from "child_process";
import { tmpdir } from "os";
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

export function containerCommand(
	runtime: SandboxDriverContext,
	args: string[],
	timeoutMs = runtime.limits.commandTimeoutMs,
	signal?: AbortSignal,
	command = runtime.containerCommand,
	env: NodeJS.ProcessEnv = runtime.environment,
): Promise<CommandOutcome> {
	if (runtime.cliStopped) return Promise.resolve({ code: null, stdout: "", stderr: CLI_STOPPED, timedOut: false });
	if (signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "cancelled", timedOut: false });
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: tmpdir(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid !== undefined) runtime.children.set(child, "service");
		const stdout = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		const stderr = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		let timedOut = false;
		let settled = false;
		const onAbort = () => {
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => {
				timedOut = true;
				child.kill("SIGKILL");
			},
			Math.max(1, timeoutMs),
		);
		const settle = (code: number | null, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				code,
				stdout: stdout.text(),
				stderr: error === undefined ? stderr.text() : error.message,
				timedOut,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => stdout.retain(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.retain(chunk));
		child.once("error", (error) => settle(null, error));
		child.once("close", (code) => {
			runtime.children.delete(child);
			settle(code);
		});
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
