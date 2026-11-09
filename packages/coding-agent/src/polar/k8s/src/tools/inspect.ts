import { type Static, Type } from "typebox";
import { invalidParameter, isGiven } from "../../../shared/validation.ts";
import { formatFlag } from "../kubectl.ts";
import type {
	ExecFlagName,
	ExecRequest,
	ExecutionLimits,
	KubectlCall,
	KubectlFlag,
	ReplyOptions,
	ToolSpec,
} from "../types.ts";
import { isObjectName, NAMESPACE_DESCRIPTION, namespaceError } from "../validation.ts";

const TOOL_NAME = "k8s_inspect";

export type InspectOperation = "read" | "list" | "find" | "copyOut" | "df" | "du" | "processes" | "sockets";

export type FindEntryType = "file" | "directory" | "symlink";

type OperationField =
	| "path"
	| "tailLines"
	| "includeHidden"
	| "root"
	| "nameGlob"
	| "type"
	| "maxDepth"
	| "oneFilesystem";

const OPERATION_FIELDS: readonly OperationField[] = [
	"path",
	"tailLines",
	"includeHidden",
	"root",
	"nameGlob",
	"type",
	"maxDepth",
	"oneFilesystem",
];

const ALLOWED_FIELDS: Record<InspectOperation, readonly OperationField[]> = {
	read: ["path", "tailLines"],
	list: ["path", "includeHidden"],
	find: ["root", "nameGlob", "type", "maxDepth"],
	copyOut: ["path"],
	df: ["path"],
	du: ["path", "maxDepth", "oneFilesystem"],
	processes: [],
	sockets: [],
};

const FIND_TYPE_FLAG: Record<FindEntryType, string> = {
	file: "f",
	directory: "d",
	symlink: "l",
};

export const DF_SCRIPT = 'df -Pk "$@" && printf \'\\n\' && df -Pi "$@"';

export const PROCESSES_SCRIPT = [
	"if command -v ps >/dev/null 2>&1; then",
	"  ps -eo pid,ppid,user,stat,args 2>/dev/null || ps -o pid,ppid,user,stat,args",
	"elif [ -d /proc ]; then",
	"  printf 'PID\\tPPID\\tUSER\\tSTATE\\tARGS\\n'",
	"  for d in /proc/[0-9]*; do",
	'    [ -r "$d/status" ] || continue',
	"    pid=; ppid=; uid=; state=; name=",
	"    while IFS=':\t ' read -r k v _; do",
	'      case "$k" in',
	"        Name) name=$v ;;",
	"        State) state=$v ;;",
	"        Pid) pid=$v ;;",
	"        PPid) ppid=$v ;;",
	"        Uid) uid=$v; break ;;",
	"      esac",
	'    done < "$d/status"',
	"    args=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null)",
	'    [ -n "$args" ] || args="[$name]"',
	'    printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$pid" "$ppid" "$uid" "$state" "$args"',
	"  done",
	"else",
	'  echo "k8s_inspect processes: neither ps nor /proc is available" >&2',
	"  exit 1",
	"fi",
].join("\n");

export const SOCKETS_SCRIPT = [
	"if command -v ss >/dev/null 2>&1; then",
	"  ss -tuna",
	"elif command -v netstat >/dev/null 2>&1; then",
	"  netstat -tuna",
	"elif [ -d /proc/net ]; then",
	"  found=0",
	"  for f in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6 /proc/net/unix; do",
	'    if [ -r "$f" ]; then',
	"      found=1",
	"      printf '=== %s ===\\n' \"$f\"",
	'      cat "$f"',
	"    fi",
	"  done",
	'  [ "$found" -eq 1 ] || { echo "k8s_inspect sockets: no readable /proc/net socket tables" >&2; exit 1; }',
	"else",
	'  echo "k8s_inspect sockets: neither ss, netstat, nor /proc/net is available" >&2',
	"  exit 1",
	"fi",
].join("\n");

const inspectParameters = Type.Object(
	{
		pod: Type.String({ description: "Exact pod name." }),
		namespace: Type.Optional(Type.String({ description: NAMESPACE_DESCRIPTION })),
		container: Type.Optional(
			Type.String({ description: "Defaults to the pod's default container. Empty means not set." }),
		),
		operation: Type.Unsafe<InspectOperation>({
			type: "string",
			enum: ["read", "list", "find", "copyOut", "df", "du", "processes", "sockets"],
			description: "Read-only diagnostic operation to run inside the container.",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Absolute path in the container (required for read, list, copyOut, du; optional for df). Empty means not set.",
			}),
		),
		tailLines: Type.Optional(Type.Integer({ minimum: 1, description: "Read only the last N lines (for read)." })),
		includeHidden: Type.Optional(Type.Boolean({ description: "Include entries starting with . (for list)." })),
		root: Type.Optional(
			Type.String({
				description: "Absolute root directory path to search under (required for find). Empty means not set.",
			}),
		),
		nameGlob: Type.Optional(
			Type.String({ description: "Filename glob pattern for find (-name). Empty means not set." }),
		),
		type: Type.Optional(
			Type.Unsafe<FindEntryType>({
				type: "string",
				enum: ["file", "directory", "symlink"],
				description: "Entry type filter for find.",
			}),
		),
		maxDepth: Type.Optional(
			Type.Integer({ minimum: 0, description: "Maximum directory traversal depth (for find and du)." }),
		),
		oneFilesystem: Type.Optional(Type.Boolean({ description: "Stay on the same filesystem (for du)." })),
	},
	{ additionalProperties: false },
);

export type InspectParams = Static<typeof inspectParameters>;

function podError(params: InspectParams): string | undefined {
	if (isObjectName(params.pod)) {
		return undefined;
	}
	return invalidParameter(
		"pod",
		"give one pod name without spaces or slashes",
		"pass flags as separate parameters and list the pods of a workload with k8s_get",
	);
}

function containerError(params: InspectParams): string | undefined {
	if (!isGiven(params.container) || isObjectName(params.container)) {
		return undefined;
	}
	return invalidParameter(
		"container",
		"give one container name without spaces or slashes",
		"pass flags as separate parameters",
	);
}

function isFieldSet(params: InspectParams, field: OperationField): boolean {
	const value = params[field];
	return typeof value === "string" ? isGiven(value) : value !== undefined;
}

function unexpectedFieldError(params: InspectParams): string | undefined {
	const allowed = ALLOWED_FIELDS[params.operation];
	for (const field of OPERATION_FIELDS) {
		if (isFieldSet(params, field) && !allowed.includes(field)) {
			return invalidParameter(
				field,
				`${field} is not supported for operation "${params.operation}"`,
				`remove ${field} or use an operation that accepts it`,
			);
		}
	}
	return undefined;
}

function pathError(params: InspectParams): string | undefined {
	switch (params.operation) {
		case "read":
		case "list":
		case "copyOut":
		case "du":
			if (!isGiven(params.path) || !params.path.startsWith("/")) {
				return invalidParameter(
					"path",
					`operation "${params.operation}" requires an absolute path starting with "/"`,
					"give a full container path such as /etc/hosts or /var/log",
				);
			}
			return undefined;
		case "df":
			if (isGiven(params.path) && !params.path.startsWith("/")) {
				return invalidParameter(
					"path",
					'give an absolute path starting with "/"',
					"give a full container path such as /var or omit path",
				);
			}
			return undefined;
		case "find":
			if (!isGiven(params.root) || !params.root.startsWith("/")) {
				return invalidParameter(
					"root",
					'operation "find" requires an absolute root path starting with "/"',
					"give a full container directory path such as /etc or /var/log",
				);
			}
			return undefined;
		case "processes":
		case "sockets":
			return undefined;
	}
}

function buildFlags(params: InspectParams): KubectlFlag<ExecFlagName>[] {
	const flags: KubectlFlag<ExecFlagName>[] = [];
	if (isGiven(params.namespace)) {
		flags.push({ name: "--namespace", value: params.namespace });
	}
	if (isGiven(params.container)) {
		flags.push({ name: "--container", value: params.container });
	}
	return flags;
}

function buildGuestCommand(params: InspectParams): string[] {
	switch (params.operation) {
		case "read":
			return params.tailLines !== undefined
				? ["tail", "-n", String(params.tailLines), "--", params.path as string]
				: ["cat", "--", params.path as string];
		case "list":
			return ["ls", params.includeHidden ? "-la" : "-l", "--", params.path as string];
		case "find":
			return [
				"find",
				params.root as string,
				...(params.maxDepth !== undefined ? ["-maxdepth", String(params.maxDepth)] : []),
				...(isGiven(params.type) ? ["-type", FIND_TYPE_FLAG[params.type]] : []),
				...(isGiven(params.nameGlob) ? ["-name", params.nameGlob] : []),
			];
		case "copyOut":
			return ["cat", "--", params.path as string];
		case "df":
			return isGiven(params.path) ? ["sh", "-c", DF_SCRIPT, "sh", params.path] : ["sh", "-c", DF_SCRIPT, "sh"];
		case "du":
			return [
				"du",
				"-k",
				...(params.oneFilesystem ? ["-x"] : []),
				...(params.maxDepth !== undefined ? ["-d", String(params.maxDepth)] : []),
				"--",
				params.path as string,
			];
		case "processes":
			return ["sh", "-c", PROCESSES_SCRIPT, "sh"];
		case "sockets":
			return ["sh", "-c", SOCKETS_SCRIPT, "sh"];
	}
}

function inspectLabelParts(params: InspectParams): string[] {
	switch (params.operation) {
		case "read":
			return [
				"read",
				params.path as string,
				...(params.tailLines !== undefined ? [`tailLines=${params.tailLines}`] : []),
			];
		case "list":
			return ["list", params.path as string, ...(params.includeHidden ? ["includeHidden=true"] : [])];
		case "find":
			return [
				"find",
				params.root as string,
				...(isGiven(params.nameGlob) ? [`nameGlob=${params.nameGlob}`] : []),
				...(isGiven(params.type) ? [`type=${params.type}`] : []),
				...(params.maxDepth !== undefined ? [`maxDepth=${params.maxDepth}`] : []),
			];
		case "copyOut":
			return ["copyOut", params.path as string];
		case "df":
			return isGiven(params.path) ? ["df", params.path] : ["df"];
		case "du":
			return [
				"du",
				params.path as string,
				...(params.maxDepth !== undefined ? [`maxDepth=${params.maxDepth}`] : []),
				...(params.oneFilesystem ? ["oneFilesystem=true"] : []),
			];
		case "processes":
			return ["processes"];
		case "sockets":
			return ["sockets"];
	}
}

function inspectCommandLabel(params: InspectParams, flags: readonly KubectlFlag<ExecFlagName>[]): string {
	return ["kubectl", "exec", params.pod, ...flags.map(formatFlag), "--", ...inspectLabelParts(params)].join(" ");
}

function buildOptions(params: InspectParams, limits: ExecutionLimits): ReplyOptions {
	const selection = params.operation === "read" && params.tailLines !== undefined ? "tail" : "head";
	const mode = params.operation === "copyOut" ? "artifact" : "spillover";
	return {
		maxLines: limits.replyMaxLines,
		maxBytes: limits.replyMaxBytes,
		selection,
		keepHeader: false,
		mode,
	};
}

export function buildInspectCall(params: InspectParams, limits: ExecutionLimits): KubectlCall<ExecRequest> {
	const flags = buildFlags(params);
	const request: ExecRequest = {
		operation: "exec",
		flags,
		pod: params.pod,
		command: buildGuestCommand(params),
	};
	return {
		request,
		tool: TOOL_NAME,
		commandLabel: inspectCommandLabel(params, flags),
		timeoutMs: params.operation === "copyOut" ? limits.logsTimeoutMs : limits.timeoutMs,
		options: buildOptions(params, limits),
	};
}

export const inspectSpec: ToolSpec<typeof inspectParameters, ExecRequest> = {
	name: TOOL_NAME,
	label: "k8s inspect",
	description:
		"Fixed read-only operations inside a running container. No shell, no arbitrary commands. Long text output is cut and saved to a file; copyOut saves the raw file as an artifact.",
	promptSnippet:
		"Fixed read-only operations inside a running container (read, list, find, copyOut, df, du, processes, sockets)",
	parameters: inspectParameters,
	validate: (params) =>
		podError(params) ??
		namespaceError(params.namespace) ??
		containerError(params) ??
		unexpectedFieldError(params) ??
		pathError(params),
	buildCall: buildInspectCall,
};
