import type { ChildProcess } from "child_process";
import type { FinalizedStderr, FinalizedStdout } from "../../shared/reply.ts";
import type { SessionHandle, SessionPaths } from "../../shared/session.ts";
import type { OpenFile, OutputSaveError } from "../../shared/store.ts";

export type { FinalizedStderr, FinalizedStdout, SessionHandle, SessionPaths };

export const DATA_PATH = "/data";

export interface ExecLimits {
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

export type ExecLanguage = "python" | "bash";

export interface ExecRequest {
	language: ExecLanguage;
	code: string;
}

export type RuntimeState = "unready" | "open" | "closing" | "closed";

export type ChildKind = "run" | "service";

export interface RunningCall {
	stop(): void;
}

export interface ExecRuntime {
	containerCommand: string;
	image: string;
	limits: ExecLimits;
	environment: NodeJS.ProcessEnv;
	handle: SessionHandle;
	state: RuntimeState;
	starting?: Promise<Readiness>;
	inFlight: Set<string>;
	owned: Set<string>;
	children: Map<ChildProcess, ChildKind>;
	cliStopped: boolean;
	running: Set<RunningCall>;
}

export interface CleanupError {
	container: string;
	message: string;
}

export type CleanupOutcome = { removed: true } | { removed: false; error: CleanupError };

export type ExecStatus =
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

export interface ExecResult {
	status: ExecStatus;
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

export interface FinalizedExecOutput extends Omit<ExecResult, "output" | "stderr"> {
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
