import { spawn } from "child_process";
import type { CleanupError, CleanupOutcome, CommandOutcome, ExecRuntime } from "./types.ts";

const CLI_STOPPED = "exec is stopping; no command starts";
const COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const DIAGNOSTIC_MAX_LINES = 64;

export interface ListedResource {
	name: string;
	labels: Record<string, unknown>;
}

export function containerCommand(
	runtime: ExecRuntime,
	args: string[],
	timeoutMs = runtime.limits.commandTimeoutMs,
): Promise<CommandOutcome> {
	if (runtime.cliStopped) return Promise.resolve({ code: null, stdout: "", stderr: CLI_STOPPED, timedOut: false });
	return new Promise((resolve) => {
		const child = spawn(runtime.containerCommand, args, {
			env: runtime.environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid !== undefined) runtime.children.set(child, "service");
		const stdout = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		const stderr = new StreamCapture(COMMAND_OUTPUT_MAX_BYTES);
		let timedOut = false;
		let settled = false;
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

export function parseListing(text: string, key: "id" | "name"): ListedResource[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const resources: ListedResource[] = [];
	for (const entry of parsed) {
		const configuration = isObject(entry) ? entry.configuration : undefined;
		if (!isObject(configuration)) return undefined;
		const name = configuration[key];
		const labels = configuration.labels === undefined ? {} : configuration.labels;
		if (typeof name !== "string" || !isObject(labels)) return undefined;
		resources.push({ name, labels });
	}
	return resources;
}

export function parseContainers(text: string): ListedResource[] | undefined {
	return parseListing(text, "id");
}

export function parseVolumes(text: string): ListedResource[] | undefined {
	return parseListing(text, "name");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deadlineAfter(runtime: ExecRuntime): number {
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

export async function cleanupContainer(
	runtime: ExecRuntime,
	name: string,
	deadlineAt: number,
): Promise<CleanupOutcome> {
	runtime.owned.add(name);
	const confirmed = () => {
		runtime.owned.delete(name);
		return { removed: true } as const;
	};
	if (remainingMs(deadlineAt) === 0) return { removed: false, error: { container: name, message: "no time left" } };
	const deleted = await containerCommand(runtime, ["delete", "--force", name], remainingMs(deadlineAt));
	if (deleted.code === 0) return confirmed();
	let message = `delete: ${commandFailure(deleted)}`;
	if (remainingMs(deadlineAt) > 0) {
		const listed = await containerCommand(runtime, ["list", "--all", "--format", "json"], remainingMs(deadlineAt));
		const listing = listed.code === 0 ? parseContainers(listed.stdout) : undefined;
		if (listing !== undefined && !listing.some((container) => container.name === name)) return confirmed();
		message +=
			listing === undefined
				? `; list: ${listed.code === 0 ? "unreadable" : commandFailure(listed)}`
				: "; still listed";
	} else {
		message += "; no time left to list";
	}
	return { removed: false, error: { container: name, message } };
}

export async function cleanupOwned(runtime: ExecRuntime, deadlineAt: number): Promise<CleanupError[]> {
	const errors: CleanupError[] = [];
	for (const name of [...runtime.owned]) {
		const outcome = await cleanupContainer(runtime, name, deadlineAt);
		if (!outcome.removed) errors.push(outcome.error);
	}
	return errors;
}

export function describeCleanupErrors(errors: CleanupError[]): string {
	return errors.map((error) => `${error.container} (${error.message})`).join(", ");
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
