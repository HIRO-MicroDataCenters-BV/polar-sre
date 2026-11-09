import { type Static, Type } from "typebox";
import { invalidParameter, isGiven } from "../../../shared/validation.ts";
import { kubectlCommandLabel } from "../kubectl.ts";
import type { ExecutionLimits, GetFlagName, GetRequest, KubectlCall, KubectlFlag, ToolSpec } from "../types.ts";
import { isObjectName, isTypeToken, NAMESPACE_DESCRIPTION, namespaceError } from "../validation.ts";

const TOOL_NAME = "k8s_get";

const GET_GUIDELINES = [
	"k8s_get: when the object name is unknown, list with the default wide output, then narrow with labelSelector or fieldSelector.",
];

const getParameters = Type.Object(
	{
		resource: Type.String({
			description:
				"Resource types: plural, short name, type.group for CRDs, a category like all, or several separated by commas.",
		}),
		name: Type.Optional(Type.String({ description: "Exact object name. Empty means not set." })),
		namespace: Type.Optional(Type.String({ description: NAMESPACE_DESCRIPTION })),
		allNamespaces: Type.Optional(Type.Boolean()),
		labelSelector: Type.Optional(Type.String({ description: "Label selector. Empty means not set." })),
		fieldSelector: Type.Optional(
			Type.String({
				description:
					"Server-side fields only: metadata.name, metadata.namespace; pods: spec.nodeName, status.phase, status.podIP; events: involvedObject.name, involvedObject.kind, reason, type; nodes: spec.unschedulable. Labels and container state are not selectable. Empty means not set.",
			}),
		),
		sortByJsonPath: Type.Optional(
			Type.String({ description: "JSONPath expression to sort by. Empty means not set." }),
		),
		output: Type.Optional(
			Type.String({
				description:
					"wide | yaml | json | name | jsonpath=<expr> | custom-columns=<spec>. Default wide; yaml when name is set. Empty means not set.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type GetParams = Static<typeof getParameters>;

const FILE_OUTPUT_FORMATS = ["jsonpath-file", "go-template-file", "custom-columns-file", "templatefile"];

function resourceError(params: GetParams): string | undefined {
	if (params.resource.split(",").every(isTypeToken)) {
		return undefined;
	}
	return invalidParameter(
		"resource",
		"give resource types only (plural, short name, type.group, a category like all, or a comma list)",
		"pass the object name as name and flags as separate parameters",
	);
}

function nameError(params: GetParams): string | undefined {
	if (!isGiven(params.name) || isObjectName(params.name)) {
		return undefined;
	}
	return invalidParameter(
		"name",
		"give one object name without spaces or slashes",
		"pass the type as resource and flags as separate parameters",
	);
}

function outputError(params: GetParams): string | undefined {
	const format = params.output?.split("=", 1)[0];
	if (format === undefined || !FILE_OUTPUT_FORMATS.includes(format)) {
		return undefined;
	}
	return `Invalid parameter "output": ${format} reads a local file and is not supported.`;
}

function pushValueFlag(flags: KubectlFlag<GetFlagName>[], name: GetFlagName, value: string | undefined): void {
	if (isGiven(value)) {
		flags.push({ name, value });
	}
}

function buildFlags(params: GetParams, output: string): KubectlFlag<GetFlagName>[] {
	const flags: KubectlFlag<GetFlagName>[] = [];
	pushValueFlag(flags, "--namespace", params.namespace);
	if (params.allNamespaces) {
		flags.push({ name: "--all-namespaces" });
	}
	pushValueFlag(flags, "--selector", params.labelSelector);
	pushValueFlag(flags, "--field-selector", params.fieldSelector);
	pushValueFlag(flags, "--sort-by", params.sortByJsonPath);
	pushValueFlag(flags, "--output", output);
	return flags;
}

export function buildGetCall(params: GetParams, limits: ExecutionLimits): KubectlCall<GetRequest> {
	const defaultOutput = isGiven(params.name) ? "yaml" : "wide";
	const output = isGiven(params.output) ? params.output : defaultOutput;
	const request: GetRequest = {
		operation: "get",
		flags: buildFlags(params, output),
		positionals: isGiven(params.name) ? [params.resource, params.name] : [params.resource],
	};
	return {
		request,
		tool: TOOL_NAME,
		commandLabel: kubectlCommandLabel(request),
		timeoutMs: limits.timeoutMs,
		options: {
			maxLines: limits.replyMaxLines,
			maxBytes: limits.replyMaxBytes,
			selection: isGiven(params.sortByJsonPath) ? "tail" : "head",
			keepHeader: output === "wide" || output.startsWith("custom-columns="),
		},
	};
}

export const getSpec: ToolSpec<typeof getParameters, GetRequest> = {
	name: TOOL_NAME,
	label: "k8s get",
	description:
		"'kubectl get' on the cluster bound to this session. Returns stdout as is. Long output is cut and saved to a file; the notice says how to read the rest.",
	promptSnippet: "'kubectl get' on the session cluster, read-only",
	promptGuidelines: GET_GUIDELINES,
	parameters: getParameters,
	validate: (params) =>
		resourceError(params) ?? nameError(params) ?? namespaceError(params.namespace) ?? outputError(params),
	buildCall: buildGetCall,
};
