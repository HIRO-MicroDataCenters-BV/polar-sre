import { type Static, Type } from "typebox";
import { invalidParameter, isGiven } from "../../../shared/validation.ts";
import { kubectlCommandLabel } from "../kubectl.ts";
import type { ExecutionLimits, KubectlCall, KubectlFlag, LogsFlagName, LogsRequest, ToolSpec } from "../types.ts";
import { isObjectName, NAMESPACE_DESCRIPTION, namespaceError } from "../validation.ts";

const TOOL_NAME = "k8s_logs";

const logsParameters = Type.Object(
	{
		pod: Type.String({ description: "Exact pod name." }),
		namespace: Type.Optional(Type.String({ description: NAMESPACE_DESCRIPTION })),
		container: Type.Optional(
			Type.String({ description: "Defaults to the pod's default container. Empty means not set." }),
		),
		previous: Type.Optional(Type.Boolean()),
		tail: Type.Optional(Type.Integer({ minimum: 0 })),
		since: Type.Optional(
			Type.String({ description: "Only lines newer than a duration like 5s, 2m, or 3h. Empty means not set." }),
		),
		timestamps: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type LogsParams = Static<typeof logsParameters>;

function podError(params: LogsParams): string | undefined {
	if (isObjectName(params.pod)) {
		return undefined;
	}
	return invalidParameter(
		"pod",
		"give one pod name without spaces or slashes",
		"pass flags as separate parameters and list the pods of a workload with k8s_get",
	);
}

function pushValueFlag(flags: KubectlFlag<LogsFlagName>[], name: LogsFlagName, value: string | undefined): void {
	if (isGiven(value)) {
		flags.push({ name, value });
	}
}

function buildFlags(params: LogsParams): KubectlFlag<LogsFlagName>[] {
	const flags: KubectlFlag<LogsFlagName>[] = [];
	pushValueFlag(flags, "--namespace", params.namespace);
	pushValueFlag(flags, "--container", params.container);
	if (params.previous) {
		flags.push({ name: "--previous" });
	}
	pushValueFlag(flags, "--tail", params.tail?.toString());
	pushValueFlag(flags, "--since", params.since);
	if (params.timestamps) {
		flags.push({ name: "--timestamps" });
	}
	return flags;
}

export function buildLogsCall(params: LogsParams, limits: ExecutionLimits): KubectlCall<LogsRequest> {
	const request: LogsRequest = { operation: "logs", flags: buildFlags(params), positionals: [params.pod] };
	return {
		request,
		tool: TOOL_NAME,
		commandLabel: kubectlCommandLabel(request),
		timeoutMs: limits.logsTimeoutMs,
		options: {
			maxLines: limits.replyMaxLines,
			maxBytes: limits.replyMaxBytes,
			selection: "tail",
			keepHeader: false,
		},
	};
}

export const logsSpec: ToolSpec<typeof logsParameters, LogsRequest> = {
	name: TOOL_NAME,
	label: "k8s logs",
	description:
		"'kubectl logs' on the cluster bound to this session: the log of one container in one pod, oldest line first. Long output is cut to the newest lines and saved to a file; the notice says how to read the rest.",
	promptSnippet: "'kubectl logs' on the session cluster: the log of one container in a pod",
	parameters: logsParameters,
	validate: (params) => podError(params) ?? namespaceError(params.namespace),
	buildCall: buildLogsCall,
};
