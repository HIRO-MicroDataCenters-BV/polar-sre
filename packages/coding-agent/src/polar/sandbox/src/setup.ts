import { mkdir } from "fs/promises";
import { join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../config.ts";
import { probeHost } from "./host.ts";
import type { ActionIO, HostDiagnosis, SandboxHost, SetupAction, SetupActionId } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 1_000;
const LOCK_TARGET_NAME = "sandbox-setup";

export type SetupStopReason =
	| "ready"
	| "cancelled"
	| "compromised"
	| "action_failed"
	| "diagnosis_failed"
	| "manual_remedy"
	| "no_progress"
	| "foreground_required";

export interface SetupTaskResult {
	diagnosis: HostDiagnosis;
	completedActions: SetupActionId[];
	stopReason: SetupStopReason;
	reason?: string;
}

export type HostSetupOutcome =
	| { kind: "locked" }
	| { kind: "stale"; diagnosis: HostDiagnosis }
	| { kind: "finished"; result: SetupTaskResult };

export interface SetupTaskCallbacks {
	signal: AbortSignal;
	onActionStart?: (action: SetupAction) => void;
	onLine?: (line: string) => void;
	onActionEnd?: () => void;
	onDownloadProgress?: (doneBytes: number, totalBytes?: number) => void;
	handoffTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type MachineLockOutcome<T> = { locked: false } | { locked: true; value: T };

export function diagnosisActions(diagnosis: HostDiagnosis): SetupAction[] {
	switch (diagnosis.kind) {
		case "ready":
			return diagnosis.repair?.kind === "actions" ? diagnosis.repair.actions : [];
		case "runtime_missing":
		case "runtime_not_ready":
		case "image_missing":
			return diagnosis.remedy.kind === "actions" ? diagnosis.remedy.actions : [];
		case "unsupported":
		case "probe_failed":
			return [];
	}
}

function diagnosisRank(diagnosis: HostDiagnosis): number | undefined {
	switch (diagnosis.kind) {
		case "runtime_missing":
			return 0;
		case "runtime_not_ready":
			return 1;
		case "image_missing":
			return 2;
		case "ready":
			return 3;
		case "unsupported":
		case "probe_failed":
			return undefined;
	}
}

function isLockBusyError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		String((error as { code?: unknown }).code) === "ELOCKED"
	);
}

export async function withMachineLock<T>(
	onCompromised: (error: Error) => void,
	fn: () => Promise<T>,
): Promise<MachineLockOutcome<T>> {
	const dir = getAgentDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lockTarget = join(dir, LOCK_TARGET_NAME);
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockTarget, {
			realpath: false,
			retries: 0,
			stale: LOCK_STALE_MS,
			update: LOCK_UPDATE_MS,
			onCompromised,
		});
	} catch (error) {
		if (isLockBusyError(error)) return { locked: false };
		throw error;
	}
	try {
		return { locked: true, value: await fn() };
	} finally {
		try {
			await release();
		} catch {
			// Ignore unlock errors if the lock was already compromised or removed.
		}
	}
}

export async function runHostSetup(
	host: SandboxHost,
	actionId: SetupActionId,
	callbacks: SetupTaskCallbacks,
): Promise<HostSetupOutcome> {
	const taskAbort = new AbortController();
	let compromised = false;
	const onParentAbort = () => taskAbort.abort();
	if (callbacks.signal.aborted) taskAbort.abort();
	else callbacks.signal.addEventListener("abort", onParentAbort, { once: true });

	try {
		const locked = await withMachineLock(
			() => {
				compromised = true;
				taskAbort.abort();
			},
			async (): Promise<HostSetupOutcome> => {
				let currentDiagnosis = await probeHost(host);
				if (compromised || taskAbort.signal.aborted) {
					return {
						kind: "finished",
						result: {
							diagnosis: currentDiagnosis,
							completedActions: [],
							stopReason: compromised ? "compromised" : "cancelled",
							reason: compromised ? "sandbox setup lock was lost" : "setup cancelled",
						},
					};
				}

				const firstAction = diagnosisActions(currentDiagnosis).find((candidate) => candidate.id === actionId);
				if (firstAction === undefined) {
					return { kind: "stale", diagnosis: currentDiagnosis };
				}

				const completedActions: SetupActionId[] = [];
				let action: SetupAction = firstAction;
				let stepIndex = 0;

				while (true) {
					if (stepIndex > 0 && action.mode === "foreground") {
						return {
							kind: "finished",
							result: {
								diagnosis: currentDiagnosis,
								completedActions,
								stopReason: "foreground_required",
								reason: `${currentDiagnosis.kind === "ready" ? "additional setup step required" : currentDiagnosis.reason}; run /sandbox to continue`,
							},
						};
					}

					let lastLine: string | undefined;
					if (action.mode === "background") {
						callbacks.onActionStart?.(action);
					}

					const io: ActionIO = {
						signal: taskAbort.signal,
						onLine: (line) => {
							const trimmed = line.trim();
							if (trimmed !== "") lastLine = trimmed;
							if (action.mode === "background") callbacks.onLine?.(line);
						},
						onDownloadProgress: callbacks.onDownloadProgress,
						handoffTerminal: callbacks.handoffTerminal,
					};

					let outcome: Awaited<ReturnType<SetupAction["run"]>>;
					try {
						outcome = await action.run(io);
					} finally {
						if (action.mode === "background") callbacks.onActionEnd?.();
					}

					if (compromised) {
						return {
							kind: "finished",
							result: {
								diagnosis: currentDiagnosis,
								completedActions,
								stopReason: "compromised",
								reason: "sandbox setup lock was lost",
							},
						};
					}
					if (taskAbort.signal.aborted || (!outcome.ok && outcome.cancelled)) {
						return {
							kind: "finished",
							result: {
								diagnosis: currentDiagnosis,
								completedActions,
								stopReason: "cancelled",
								reason: "setup cancelled",
							},
						};
					}
					if (!outcome.ok) {
						return {
							kind: "finished",
							result: {
								diagnosis: currentDiagnosis,
								completedActions,
								stopReason: "action_failed",
								reason: outcome.reason,
							},
						};
					}

					completedActions.push(action.id);
					const actionDetail = outcome.detail ?? lastLine;
					const next = await probeHost(host);

					if (next.kind === "ready") {
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "ready",
							},
						};
					}
					if (compromised) {
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "compromised",
								reason: "sandbox setup lock was lost",
							},
						};
					}
					if (taskAbort.signal.aborted) {
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "cancelled",
								reason: "setup cancelled",
							},
						};
					}
					if (next.kind === "unsupported" || next.kind === "probe_failed") {
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "diagnosis_failed",
								reason: next.reason,
							},
						};
					}
					if (next.remedy.kind === "manual" || next.remedy.actions.length === 0) {
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "manual_remedy",
								reason: next.reason,
							},
						};
					}

					const prevRank = diagnosisRank(currentDiagnosis);
					const nextRank = diagnosisRank(next);
					if (prevRank === undefined || nextRank === undefined || nextRank <= prevRank) {
						const reason =
							actionDetail !== undefined && actionDetail !== ""
								? `${next.reason} (${actionDetail})`
								: next.reason;
						return {
							kind: "finished",
							result: {
								diagnosis: next,
								completedActions,
								stopReason: "no_progress",
								reason,
							},
						};
					}

					currentDiagnosis = next;
					action = next.remedy.actions[0];
					stepIndex += 1;
				}
			},
		);
		if (!locked.locked) return { kind: "locked" };
		return locked.value;
	} finally {
		callbacks.signal.removeEventListener("abort", onParentAbort);
	}
}
