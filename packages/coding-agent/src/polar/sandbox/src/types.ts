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

export interface TrackedChild {
	readonly kind: ChildKind;
	kill(): void;
}

export interface ImageSpec {
	readonly candidates: readonly string[];
	readonly pull?: string;
	readonly build: string;
}

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

export interface SandboxDriverContext {
	containerCommand: string;
	image: string;
	readonly imageSpec: ImageSpec;
	limits: SandboxLimits;
	environment: NodeJS.ProcessEnv;
	state: RuntimeState;
	owned: Set<string>;
	children: Set<TrackedChild>;
	cliStopped: boolean;
}

export interface SandboxHost extends SandboxDriverContext {
	driver: SandboxDriver;
}

export interface SandboxRuntime extends SandboxHost {
	handle: SessionHandle;
	inFlight: Set<string>;
	running: Set<RunningCall>;
	activeSandbox: ActiveSandboxHolder;
}

export interface CleanupError {
	container: string;
	message: string;
}

export type CleanupOutcome = { removed: true } | { removed: false; error: CleanupError };

export type SandboxDriverName = "apple-container" | "oci" | "k8s";
export type SandboxDriverChoice = "auto" | SandboxDriverName;
export type OciEngine = "podman" | "docker";
export type OciEngineChoice = "auto" | OciEngine;

export type SandboxStatus =
	| "ok"
	| "failed"
	| "timeout"
	| "cancelled"
	| "out_of_memory"
	| "output_limit"
	| "work_limit"
	| "save_failed"
	| "runtime_failed";

export type InspectionState = "present" | "stopped" | "absent" | "unknown";

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

export type NotReady = { ready: false; message: string; leftovers: CleanupError[] };

export type Activation = { ready: true; runtime: SandboxRuntime } | NotReady;

export type SetupActionId = "install_runtime" | "start_service" | "pull_image" | "build_image";

export type SetupActionMode = "background" | "foreground";

export interface ActionIO {
	signal: AbortSignal;
	onLine?: (line: string) => void;
	onDownloadProgress?: (doneBytes: number, totalBytes?: number) => void;
	handoffTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type ActionResult = { ok: true; detail?: string } | { ok: false; reason: string; cancelled?: boolean };

export interface SetupAction {
	id: SetupActionId;
	label: string;
	preview: string[];
	mode: SetupActionMode;
	run(io: ActionIO): Promise<ActionResult>;
	runQuick?(signal: AbortSignal): Promise<ActionResult>;
}

export type Remedy =
	| { kind: "manual"; instructions: string[] }
	| { kind: "actions"; actions: SetupAction[]; outlook: string[] };

export type RuntimeProbeResult =
	| { kind: "ready"; version?: string; repair?: Remedy }
	| { kind: "unsupported"; reason: string }
	| { kind: "runtime_missing"; reason: string; remedy: Remedy }
	| { kind: "runtime_not_ready"; reason: string; remedy: Remedy }
	| { kind: "probe_failed"; reason: string };

export type HostDiagnosis =
	| { kind: "ready"; image: string; version?: string; repair?: Remedy }
	| Exclude<RuntimeProbeResult, { kind: "ready" }>
	| { kind: "image_missing"; reason: string; remedy: Remedy };

export type ImageOperationKind = "download" | "build";

export interface ImageOperation {
	output(line: string): void;
	end(): void;
}

export interface VolumeFailure {
	reason: string;
	leftover?: CleanupError;
}

export interface CommandOutcome {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnError?: string;
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
	readonly supportsServiceAutoStart: boolean;

	probeRuntime(): Promise<RuntimeProbeResult>;
	imageRemedy(imageSpec: ImageSpec): Remedy;
	inspectImage(image: string, deadlineAt: number): Promise<{ found: true } | { found: false; reason: string }>;
	pullImage(image: string, signal?: AbortSignal, onLine?: (line: string) => void): Promise<CommandOutcome>;
	buildImage(
		image: string,
		contextDir: string,
		signal?: AbortSignal,
		onLine?: (line: string) => void,
	): Promise<CommandOutcome>;

	listSandboxes(root: string, deadlineAt: number): Promise<OwnedResource[]>;
	deleteSandbox(name: string, deadlineAt: number): Promise<CleanupOutcome>;
	manualDeleteCommand(names: string[]): string;

	listWorkVolumes(session: SessionPaths, deadlineAt: number): Promise<OwnedResource[]>;
	ensureWorkVolume(session: SessionPaths, deadlineAt: number): Promise<VolumeFailure | undefined>;
	deleteWorkVolumes(volumes: OwnedResource[], session: SessionPaths, deadlineAt: number): Promise<void>;

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
