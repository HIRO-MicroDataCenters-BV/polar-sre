import type { ChildProcess } from "child_process";
import type { Readable, Writable } from "stream";
import type { FinalizedStderr, FinalizedStdout } from "../../shared/reply.ts";
import type { SessionHandle, SessionPaths } from "../../shared/session.ts";
import type { OpenFile, OutputSaveError } from "../../shared/store.ts";

export type { FinalizedStderr, FinalizedStdout, SessionHandle, SessionPaths };

export const DATA_PATH = "/data";

export interface SandboxLimits {
	timeoutMs: number;
	memoryBytes: number;
	cpus: number;
	workMaxBytes: number;
	processMax: number;
	tmpMaxBytes: number;
	fileMaxBytes: number;
	sessionMaxBytes: number;
	stderrMaxBytes: number;
	killGraceMs: number;
	commandTimeoutMs: number;
	replyMaxLines: number;
	replyMaxBytes: number;
	shutdownBudgetMs: number;
}

export type SandboxLanguage = "python" | "bash";

export interface SandboxRequest {
	language: SandboxLanguage;
	code: string;
}

export type RuntimeState = "unready" | "open" | "closing" | "closed";

export type ChildKind = "run" | "service";

export interface RunningCall {
	stop(): void;
}

export interface OwnedResource {
	name: string;
	sessionId: string;
}

export interface ActiveSandboxHolder {
	current?: HotSandbox;
}

export interface SandboxRuntime {
	containerCommand: string;
	image: string;
	limits: SandboxLimits;
	environment: NodeJS.ProcessEnv;
	handle: SessionHandle;
	state: RuntimeState;
	starting?: Promise<Readiness>;
	inFlight: Set<string>;
	owned: Set<string>;
	children: Map<ChildProcess, ChildKind>;
	cliStopped: boolean;
	running: Set<RunningCall>;
	driver: SandboxDriver;
	activeSandbox: ActiveSandboxHolder;
}

export interface CleanupError {
	container: string;
	message: string;
}

export type CleanupOutcome = { removed: true } | { removed: false; error: CleanupError };

export type SandboxStatus =
	| "ok"
	| "failed"
	| "timeout"
	| "cancelled"
	| "out_of_memory"
	| "output_limit"
	| "save_failed"
	| "runtime_failed";

export type InspectionState = "present" | "absent" | "unknown";

export interface Inspection {
	state: InspectionState;
	detail?: string;
}

export type OutputLimit = "stdout" | "stderr" | "session";

export interface SandboxResult {
	status: SandboxStatus;
	exitCode: number | null;
	output?: OpenFile;
	stderr: Buffer;
	runtimeMessage?: string;
	limit?: OutputLimit;
	elapsedMs: number;
	oomEvidence?: string;
	saveError?: OutputSaveError;
	cleanupError?: CleanupError;
	inspection?: Inspection;
}

export interface FinalizedSandboxOutput extends Omit<SandboxResult, "output" | "stderr"> {
	stdout: FinalizedStdout;
	stderr: FinalizedStderr;
}

export interface ToolReply {
	text: string;
	isError: boolean;
}

export type Readiness = { ready: true } | { ready: false; message: string; leftovers: CleanupError[] };

export interface VolumeFailure {
	reason: string;
	leftover?: CleanupError;
}

export interface CommandOutcome {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface SandboxProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly closed: Promise<number | null>;
	kill(): void;
}

export type SandboxStartOutcome = { started: HotSandbox } | { failed: string; leftover?: CleanupError };

export type SpawnCallOutcome = { spawned: SandboxProcess } | { gone: string };

export interface SandboxDriver {
	readonly name: "apple-container" | "oci" | "k8s";
	readonly boundaryDescription: string;

	checkRuntime(deadlineAt: number): Promise<{ ready: true } | { ready: false; reason: string }>;
	inspectImage(image: string, deadlineAt: number): Promise<boolean>;
	pullImage(image: string, signal?: AbortSignal): Promise<CommandOutcome>;
	buildImage(image: string, contextDir: string, signal?: AbortSignal): Promise<CommandOutcome>;

	listSandboxes(root: string, deadlineAt: number): Promise<OwnedResource[]>;
	deleteSandbox(name: string, deadlineAt: number): Promise<CleanupOutcome>;

	listWorkVolumes(root: string, deadlineAt: number): Promise<OwnedResource[]>;
	ensureWorkVolume(session: SessionPaths, deadlineAt: number): Promise<VolumeFailure | undefined>;
	deleteWorkVolume(name: string, ownerSessionId: string, deadlineAt: number): Promise<void>;

	startSandbox(
		name: string,
		session: SessionPaths,
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<SandboxStartOutcome>;
}

export interface HotSandbox {
	readonly name: string;
	inspect(deadlineAt: number): Promise<Inspection>;
	spawnCall(language: SandboxLanguage): Promise<SpawnCallOutcome>;
	checkOom(deadlineAt: number): Promise<string | undefined>;
	scrubAfterCall(deadlineAt: number): Promise<boolean>;
	destroy(deadlineAt: number): Promise<CleanupOutcome>;
}
