import type { ChildProcessByStdio } from "child_process";
import { dirname } from "path";
import type { Readable, Writable } from "stream";
import type { ListedResource } from "../cli.ts";
import type {
	CleanupOutcome,
	CommandOutcome,
	OwnedResource,
	SandboxDriver,
	SandboxDriverName,
	SandboxLanguage,
	SandboxStartOutcome,
	SessionPaths,
	VolumeFailure,
} from "../types.ts";

export type RunProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export const SESSION_LABEL = "polar-session";
export const ROOT_LABEL = "polar-root";
export const WORK_PATH = "/work";
export const TMP_PATH = "/tmp";
export const GUEST_USER = "1000:1000";
export const KEEPALIVE_COMMAND = "echo; while read -r _; do :; done";

export const SCRUB_SCRIPT = [
	"kill -9 -1 2>/dev/null",
	"ipcrm --all 2>/dev/null",
	"chmod -R u+rwX /tmp /dev/shm /dev/mqueue 2>/dev/null",
	"find /tmp /dev/shm /dev/mqueue -mindepth 1 -delete 2>/dev/null",
	"for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -1 2>/dev/null || break; sleep 0.02; done",
	'! kill -0 -1 2>/dev/null && [ -z "$(find /tmp /dev/shm /dev/mqueue -mindepth 1 -print -quit 2>/dev/null)" ] && [ -z "$(ipcs -m -q -s 2>/dev/null | grep "^0x")" ]',
].join("\n");

export const START_ENDED = "the session is shutting down";
export const LEFTOVERS_STAYED = "leftovers of sandbox stayed";
export const WORK_LIMIT_EXIT_CODE = 199;
export const BUILD_TIMEOUT_MS = 600_000;
export const KEEPALIVE_STOP_GRACE_MS = 200;
export const COMMAND_STDERR_MAX_BYTES = 16 * 1024 * 1024;

const PROGRAM_FILES: Record<SandboxLanguage, string> = { python: "program.py", bash: "program.sh" };
const INTERPRETERS: Record<SandboxLanguage, string> = { python: "python3", bash: "bash" };

export interface LauncherOptions {
	workMaxBytes?: number;
	processMax?: number;
}

export function launcher(language: SandboxLanguage, options: LauncherOptions = {}): string {
	const file = `"$d/${PROGRAM_FILES[language]}"`;
	const interpreter = INTERPRETERS[language];
	const ulimitPrefix = options.processMax === undefined ? "" : `ulimit -u ${options.processMax}\n`;
	if (options.workMaxBytes === undefined) {
		return `${ulimitPrefix}d="\${TMPDIR:-/tmp}/.polar"; mkdir -p "$d" && cat > ${file} && exec ${interpreter} ${file} </dev/null`;
	}
	const max = options.workMaxBytes;
	return (
		ulimitPrefix +
		[
			`d="\${TMPDIR:-/tmp}/.polar"`,
			`w="\${POLAR_WORK_DIR:-${WORK_PATH}}"`,
			`mkdir -p "$d" && rm -f "$d/work_limit" "$d/.w" && cat > ${file} || exit 1`,
			`kb() { local v; v=$(du -sk "$w" 2>/dev/null | cut -f1); echo "\${v:-0}"; }`,
			`init=$(( $(kb) * 1024 ))`,
			`max=${max}`,
			`mkfifo "$d/.w" 2>/dev/null`,
			`set -m`,
			`${interpreter} ${file} </dev/null &`,
			`pid=$!`,
			`set +m`,
			`(`,
			`  exec 9<>"$d/.w"`,
			`  rm -f "$d/.w"`,
			`  while kill -0 "$pid" 2>/dev/null; do`,
			`    read -r -t 0.1 -u 9 || true`,
			`    kill -0 "$pid" 2>/dev/null || exit 0`,
			`    cur=$(( $(kb) * 1024 ))`,
			`    if [ "$cur" -gt "$max" ] && [ "$cur" -gt "$init" ]; then`,
			`      : > "$d/work_limit"`,
			`      kill -9 -"$pid" "$pid" 2>/dev/null`,
			`      exit 0`,
			`    fi`,
			`  done`,
			`) </dev/null >/dev/null 2>&1 &`,
			`wpid=$!`,
			`wait "$pid" 2>/dev/null`,
			`rc=$?`,
			`exec 2>/dev/null`,
			`kill -9 "$wpid"`,
			`wait "$wpid"`,
			`rm -f "$d/.w"`,
			`cur=$(( $(kb) * 1024 ))`,
			`if [ -f "$d/work_limit" ] || { [ "$cur" -gt "$max" ] && [ "$cur" -gt "$init" ]; }; then`,
			`  exit ${WORK_LIMIT_EXIT_CODE}`,
			`fi`,
			`exit "$rc"`,
		].join("\n")
	);
}

export function workVolumeName(sessionId: string): string {
	return `polar-work-${sessionId}`;
}

export function artifactsRootOf(session: SessionPaths): string {
	return dirname(session.outputDirectory);
}

export function sessionLabels(session: SessionPaths): string[] {
	return ["--label", `${SESSION_LABEL}=${session.sessionId}`, "--label", `${ROOT_LABEL}=${artifactsRootOf(session)}`];
}

export function createVolumeMebibytes(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}

export function limitMebibytes(bytes: number): number {
	return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

export function labelOf(labels: Record<string, unknown>, key: string): string | undefined {
	const value = labels[key];
	return typeof value === "string" ? value : undefined;
}

export function ownedInRoot(resources: ListedResource[], root: string): OwnedResource[] {
	const owned: OwnedResource[] = [];
	for (const resource of resources) {
		if (labelOf(resource.labels, ROOT_LABEL) !== root) continue;
		const sessionId = labelOf(resource.labels, SESSION_LABEL);
		if (sessionId !== undefined) owned.push({ name: resource.name, sessionId });
	}
	return owned;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOomKillCount(text: string): number | undefined {
	const match = /^oom_kill\s+(\d+)$/m.exec(text);
	return match === null ? undefined : Number(match[1]);
}

export class UnsupportedSandboxDriver implements SandboxDriver {
	readonly name: SandboxDriverName;
	readonly boundaryDescription: string;
	private readonly reason: string;

	constructor(name: SandboxDriverName, reason: string) {
		this.name = name;
		this.boundaryDescription = name;
		this.reason = reason;
	}

	async checkRuntime(): Promise<{ ready: false; reason: string }> {
		return { ready: false, reason: this.reason };
	}

	async inspectImage(): Promise<{ found: false; reason: string }> {
		return { found: false, reason: this.reason };
	}

	async pullImage(): Promise<CommandOutcome> {
		return { code: 1, stdout: "", stderr: this.reason, timedOut: false };
	}

	async buildImage(): Promise<CommandOutcome> {
		return { code: 1, stdout: "", stderr: this.reason, timedOut: false };
	}

	async listSandboxes(): Promise<OwnedResource[]> {
		return [];
	}

	async deleteSandbox(name: string): Promise<CleanupOutcome> {
		return { removed: false, error: { container: name, message: this.reason } };
	}

	manualDeleteCommand(names: string[]): string {
		return names.join(" ");
	}

	async listWorkVolumes(): Promise<OwnedResource[]> {
		return [];
	}

	async ensureWorkVolume(): Promise<VolumeFailure | undefined> {
		return { reason: this.reason };
	}

	async deleteWorkVolume(): Promise<void> {}

	async startSandbox(): Promise<SandboxStartOutcome> {
		return { failed: this.reason };
	}
}
