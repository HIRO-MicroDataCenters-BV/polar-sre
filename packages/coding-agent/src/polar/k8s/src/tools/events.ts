import { type Static, Type } from "typebox";
import { invalidParameter, isGiven } from "../../../shared/validation.ts";
import { kubectlCommandLabel } from "../kubectl.ts";
import type { EventsFlagName, EventsRequest, ExecutionLimits, KubectlCall, KubectlFlag, ToolSpec } from "../types.ts";
import { isObjectName, isTypeToken, NAMESPACE_DESCRIPTION, namespaceError } from "../validation.ts";

const TOOL_NAME = "k8s_events";

const eventsParameters = Type.Object(
	{
		namespace: Type.Optional(Type.String({ description: NAMESPACE_DESCRIPTION })),
		allNamespaces: Type.Optional(Type.Boolean()),
		kind: Type.Optional(
			Type.String({
				description:
					"Resource type of one namespaced object: pod, deployment, pvc, or type.group; one type only. Needs name. Empty means not set.",
			}),
		),
		name: Type.Optional(Type.String({ description: "Exact object name; needs kind. Empty means not set." })),
		types: Type.Optional(
			Type.Unsafe<"Warning" | "Normal" | "all">({
				type: "string",
				enum: ["Warning", "Normal", "all"],
				description: "Default Warning.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type EventsParams = Static<typeof eventsParameters>;

function kindError(params: EventsParams): string | undefined {
	if (!isGiven(params.kind) || isTypeToken(params.kind)) {
		return undefined;
	}
	return invalidParameter(
		"kind",
		"give one resource type (pod, deployment, pvc, or type.group)",
		"pass the object name as name and flags as separate parameters",
	);
}

function nameError(params: EventsParams): string | undefined {
	if (!isGiven(params.name) || isObjectName(params.name)) {
		return undefined;
	}
	return invalidParameter(
		"name",
		"give one object name without spaces or slashes",
		"pass the type as kind and flags as separate parameters",
	);
}

function pairingError(params: EventsParams): string | undefined {
	const hasKind = isGiven(params.kind);
	const hasName = isGiven(params.name);
	if (hasKind && !hasName) {
		return 'Invalid parameter "name": kind needs name; give both or neither.';
	}
	if (!hasKind && hasName) {
		return 'Invalid parameter "kind": name needs kind; give both or neither.';
	}
	return undefined;
}

function buildFlags(params: EventsParams): KubectlFlag<EventsFlagName>[] {
	const flags: KubectlFlag<EventsFlagName>[] = [];
	if (isGiven(params.namespace)) {
		flags.push({ name: "--namespace", value: params.namespace });
	}
	if (params.allNamespaces) {
		flags.push({ name: "--all-namespaces" });
	}
	if (isGiven(params.kind) && isGiven(params.name)) {
		flags.push({ name: "--for", value: `${params.kind}/${params.name}` });
	}
	const types = params.types ?? "Warning";
	if (types !== "all") {
		flags.push({ name: "--types", value: types });
	}
	return flags;
}

export function buildEventsCall(params: EventsParams, limits: ExecutionLimits): KubectlCall<EventsRequest> {
	const request: EventsRequest = { operation: "events", flags: buildFlags(params), positionals: [] };
	return {
		request,
		tool: TOOL_NAME,
		commandLabel: kubectlCommandLabel(request),
		timeoutMs: limits.timeoutMs,
		options: {
			maxLines: limits.replyMaxLines,
			maxBytes: limits.replyMaxBytes,
			selection: "tail",
			keepHeader: true,
		},
	};
}

export const eventsSpec: ToolSpec<typeof eventsParameters, EventsRequest> = {
	name: TOOL_NAME,
	label: "k8s events",
	description:
		"'kubectl events' on the cluster bound to this session: Warning events by default, newest last. Long output is cut to the newest rows and saved to a file; the notice says how to read the rest.",
	promptSnippet: "'kubectl events' on the session cluster, Warning by default",
	parameters: eventsParameters,
	validate: (params) =>
		kindError(params) ?? nameError(params) ?? namespaceError(params.namespace) ?? pairingError(params),
	buildCall: buildEventsCall,
};
