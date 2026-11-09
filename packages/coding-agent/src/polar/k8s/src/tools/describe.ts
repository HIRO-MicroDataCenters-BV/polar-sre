import { type Static, Type } from "typebox";
import { invalidParameter, isGiven } from "../../../shared/validation.ts";
import { kubectlCommandLabel } from "../kubectl.ts";
import type {
	DescribeFlagName,
	DescribeRequest,
	ExecutionLimits,
	KubectlCall,
	KubectlFlag,
	ToolSpec,
} from "../types.ts";
import { isObjectName, isTypeToken, NAMESPACE_DESCRIPTION, namespaceError } from "../validation.ts";

const TOOL_NAME = "k8s_describe";

const describeParameters = Type.Object(
	{
		resource: Type.String({
			description:
				"One kubectl resource type: plural, short name, type.group for CRDs, or a category like all; no comma list.",
		}),
		name: Type.Optional(Type.String({ description: "Exact object name. Empty means not set." })),
		namespace: Type.Optional(Type.String({ description: NAMESPACE_DESCRIPTION })),
		labelSelector: Type.Optional(Type.String({ description: "Not combined with name. Empty means not set." })),
	},
	{ additionalProperties: false },
);

export type DescribeParams = Static<typeof describeParameters>;

function resourceError(params: DescribeParams): string | undefined {
	if (isTypeToken(params.resource)) {
		return undefined;
	}
	return invalidParameter(
		"resource",
		"give one resource type or category (plural, short name, type.group, or all)",
		"pass the object name as name and flags as separate parameters",
	);
}

function nameError(params: DescribeParams): string | undefined {
	if (!isGiven(params.name) || isObjectName(params.name)) {
		return undefined;
	}
	return invalidParameter(
		"name",
		"give one object name without spaces or slashes",
		"pass the type as resource and flags as separate parameters",
	);
}

function nameWithSelectorError(params: DescribeParams): string | undefined {
	if (!isGiven(params.name) || !isGiven(params.labelSelector)) {
		return undefined;
	}
	return 'Invalid parameter "name": name cannot be combined with labelSelector; give one of them.';
}

function buildFlags(params: DescribeParams): KubectlFlag<DescribeFlagName>[] {
	const flags: KubectlFlag<DescribeFlagName>[] = [];
	if (isGiven(params.namespace)) {
		flags.push({ name: "--namespace", value: params.namespace });
	}
	if (isGiven(params.labelSelector)) {
		flags.push({ name: "--selector", value: params.labelSelector });
	}
	flags.push({ name: "--show-events", value: "true" });
	return flags;
}

export function buildDescribeCall(params: DescribeParams, limits: ExecutionLimits): KubectlCall<DescribeRequest> {
	const target = isGiven(params.name) ? `${params.resource}/${params.name}` : params.resource;
	const request: DescribeRequest = { operation: "describe", flags: buildFlags(params), positionals: [target] };
	return {
		request,
		tool: TOOL_NAME,
		commandLabel: kubectlCommandLabel(request),
		timeoutMs: limits.timeoutMs,
		options: {
			maxLines: limits.replyMaxLines,
			maxBytes: limits.replyMaxBytes,
			selection: "head",
			keepHeader: false,
		},
	};
}

export const describeSpec: ToolSpec<typeof describeParameters, DescribeRequest> = {
	name: TOOL_NAME,
	label: "k8s describe",
	description:
		"'kubectl describe' on the cluster bound to this session: one object by exact name, or every object of a type, events included. Long output is cut to the first lines and saved to a file; the notice says how to read the rest.",
	promptSnippet: "'kubectl describe' on the session cluster: one object by exact name, or every object of a type",
	parameters: describeParameters,
	validate: (params) =>
		resourceError(params) ?? nameError(params) ?? namespaceError(params.namespace) ?? nameWithSelectorError(params),
	buildCall: buildDescribeCall,
};
