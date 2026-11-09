import type { Static, TObject } from "typebox";
import { type AgentToolResult, defineTool } from "../../core/extensions/types.ts";
import type { StreamResult } from "./process.ts";
import type { ProducerCall, ToolReply } from "./reply.ts";
import { type ProcessLimits, type ProducerLimits, type ProducerRuntime, releaseWhenIdle } from "./runtime.ts";
import type { SessionPaths } from "./session.ts";
import { discardOutputFile } from "./store.ts";
import { nulCharacterError } from "./validation.ts";

const SHUTTING_DOWN = "The session is shutting down.";

export interface ToolSpec<
	Parameters extends TObject = TObject,
	Request = unknown,
	Limits extends ProducerLimits = ProducerLimits,
> {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: Parameters;
	validate(params: Static<Parameters>): string | undefined;
	buildCall(params: Static<Parameters>, limits: Limits): ProducerCall<Request>;
}

export type RunProducer<Request = unknown> = (
	call: ProducerCall<Request>,
	session: SessionPaths,
	signal: AbortSignal | undefined,
) => Promise<StreamResult>;

export type BuildReply = (
	outcome: StreamResult,
	call: ProducerCall,
	limits: ProcessLimits,
	session: SessionPaths,
) => Promise<ToolReply>;

export interface ToolDeps<Request = unknown> {
	run: RunProducer<Request>;
	buildReply: BuildReply;
}

function textResult(text: string, isError: boolean): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

export function createProducerTool<
	Parameters extends TObject,
	Request = unknown,
	Limits extends ProducerLimits = ProducerLimits,
>(spec: ToolSpec<Parameters, Request, Limits>, runtime: ProducerRuntime<Limits>, deps: ToolDeps<Request>) {
	return defineTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		promptGuidelines: spec.promptGuidelines,
		parameters: spec.parameters,
		annotations: { readOnlyHint: true },
		async execute(toolCallId, params, signal) {
			if (runtime.state !== "open") {
				return textResult(SHUTTING_DOWN, true);
			}
			runtime.inFlight.add(toolCallId);
			let outcome: StreamResult | undefined;
			try {
				const parameterError = nulCharacterError(params) ?? spec.validate(params);
				if (parameterError !== undefined) {
					return textResult(parameterError, true);
				}
				const call = spec.buildCall(params, runtime.limits);
				outcome = await deps.run(call, runtime.handle.paths, signal);
				const reply = await deps.buildReply(outcome, call, runtime.limits, runtime.handle.paths);
				return textResult(reply.text, reply.isError);
			} finally {
				if (outcome?.output !== undefined) await discardOutputFile(outcome.output).catch(() => undefined);
				runtime.inFlight.delete(toolCallId);
				await releaseWhenIdle(runtime);
			}
		},
	});
}
