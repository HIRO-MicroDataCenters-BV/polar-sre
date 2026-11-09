import type { SessionHandle } from "./session.ts";

export type RuntimeState = "open" | "closing" | "closed";

export interface ProcessLimits {
	fileMaxBytes: number;
	sessionMaxBytes: number;
	stderrMaxBytes: number;
	killGraceMs: number;
}

export interface ProducerLimits extends ProcessLimits {
	timeoutMs: number;
	replyMaxLines: number;
	replyMaxBytes: number;
}

export interface ProducerRuntime<Limits extends ProcessLimits = ProcessLimits> {
	limits: Limits;
	activeProcessGroups: Set<number>;
	handle: SessionHandle;
	state: RuntimeState;
	inFlight: Set<string>;
}

export async function releaseWhenIdle(runtime: ProducerRuntime): Promise<void> {
	if (runtime.state !== "closing" || runtime.inFlight.size > 0) return;
	runtime.state = "closed";
	await runtime.handle.release();
}
