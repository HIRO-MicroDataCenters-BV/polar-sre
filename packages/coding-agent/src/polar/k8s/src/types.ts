import type { TObject } from "typebox";
import type { ProducerCall, ReplyOptions } from "../../shared/reply.ts";
import type { ProducerLimits, ProducerRuntime } from "../../shared/runtime.ts";
import type { SessionHandle, SessionPaths } from "../../shared/session.ts";
import type { ToolSpec as SharedToolSpec } from "../../shared/tool.ts";

export type { ReplyOptions, SessionHandle, SessionPaths };

export interface LaunchConfig {
	kubeconfigPath: string;
	context: string;
}

export interface ExecutionLimits extends ProducerLimits {
	logsTimeoutMs: number;
}

export interface K8sRuntime extends ProducerRuntime<ExecutionLimits> {
	launch: LaunchConfig;
	environment: NodeJS.ProcessEnv;
	kubectlCommand: string;
}

export type GetFlagName =
	| "--namespace"
	| "--all-namespaces"
	| "--selector"
	| "--field-selector"
	| "--sort-by"
	| "--output";

export type EventsFlagName = "--namespace" | "--all-namespaces" | "--for" | "--types";

export type LogsFlagName = "--namespace" | "--container" | "--previous" | "--tail" | "--since" | "--timestamps";

export type DescribeFlagName = "--namespace" | "--selector" | "--show-events";

export type ExecFlagName = "--namespace" | "--container";

export type KubectlFlagName = GetFlagName | EventsFlagName | LogsFlagName | DescribeFlagName | ExecFlagName;

export interface KubectlFlag<Name extends KubectlFlagName = KubectlFlagName> {
	name: Name;
	value?: string;
}

export interface GetRequest {
	operation: "get";
	flags: readonly KubectlFlag<GetFlagName>[];
	positionals: readonly string[];
}

export interface EventsRequest {
	operation: "events";
	flags: readonly KubectlFlag<EventsFlagName>[];
	positionals: readonly [];
}

export interface LogsRequest {
	operation: "logs";
	flags: readonly KubectlFlag<LogsFlagName>[];
	positionals: readonly [pod: string];
}

export interface DescribeRequest {
	operation: "describe";
	flags: readonly KubectlFlag<DescribeFlagName>[];
	positionals: readonly [target: string];
}

export interface ExecRequest {
	operation: "exec";
	flags: readonly KubectlFlag<ExecFlagName>[];
	pod: string;
	command: readonly string[];
}

export type KubectlReadRequest = GetRequest | EventsRequest | LogsRequest | DescribeRequest | ExecRequest;

export type KubectlOperation = KubectlReadRequest["operation"];

export type KubectlCall<Request extends KubectlReadRequest = KubectlReadRequest> = ProducerCall<Request>;

export type ToolSpec<
	Parameters extends TObject = TObject,
	Request extends KubectlReadRequest = KubectlReadRequest,
> = SharedToolSpec<Parameters, Request, ExecutionLimits>;
