import { runProcess, type StreamResult } from "../../shared/process.ts";
import type {
	DescribeFlagName,
	EventsFlagName,
	ExecFlagName,
	GetFlagName,
	K8sRuntime,
	KubectlCall,
	KubectlFlag,
	KubectlFlagName,
	KubectlOperation,
	KubectlReadRequest,
	LaunchConfig,
	LogsFlagName,
	SessionPaths,
} from "./types.ts";
import { isObjectName } from "./validation.ts";

type FlagKind = "value" | "switch";

const GET_FLAGS: Record<GetFlagName, FlagKind> = {
	"--namespace": "value",
	"--all-namespaces": "switch",
	"--selector": "value",
	"--field-selector": "value",
	"--sort-by": "value",
	"--output": "value",
};

const EVENTS_FLAGS: Record<EventsFlagName, FlagKind> = {
	"--namespace": "value",
	"--all-namespaces": "switch",
	"--for": "value",
	"--types": "value",
};

const LOGS_FLAGS: Record<LogsFlagName, FlagKind> = {
	"--namespace": "value",
	"--container": "value",
	"--previous": "switch",
	"--tail": "value",
	"--since": "value",
	"--timestamps": "switch",
};

const DESCRIBE_FLAGS: Record<DescribeFlagName, FlagKind> = {
	"--namespace": "value",
	"--selector": "value",
	"--show-events": "value",
};

const EXEC_FLAGS: Record<ExecFlagName, FlagKind> = {
	"--namespace": "value",
	"--container": "value",
};

const FLAG_TABLES: Record<KubectlOperation, Partial<Record<KubectlFlagName, FlagKind>>> = {
	get: GET_FLAGS,
	events: EVENTS_FLAGS,
	logs: LOGS_FLAGS,
	describe: DESCRIBE_FLAGS,
	exec: EXEC_FLAGS,
};

export async function runKubectl(
	call: KubectlCall,
	runtime: K8sRuntime,
	session: SessionPaths,
	signal: AbortSignal | undefined,
): Promise<StreamResult> {
	const args = kubectlArguments(call.request, runtime.launch);
	const env = kubectlEnvironment(runtime.environment, runtime.launch.kubeconfigPath);
	return runProcess(
		{
			command: runtime.kubectlCommand,
			args,
			env,
			tool: call.tool,
			timeoutMs: call.timeoutMs,
		},
		runtime,
		session,
		signal,
	);
}

function kubectlArguments(request: KubectlReadRequest, launch: LaunchConfig): string[] {
	if (!Object.hasOwn(FLAG_TABLES, request.operation)) {
		throw new Error(`Unsupported kubectl operation: ${request.operation}`);
	}
	for (const flag of request.flags) {
		checkFlag(request.operation, flag);
	}
	if (request.operation === "exec") {
		if (!isObjectName(request.pod)) {
			throw new Error(`Invalid kubectl exec pod name: ${request.pod}`);
		}
		if (request.command.length === 0) {
			throw new Error("Missing command for kubectl exec");
		}
		return [
			`--kubeconfig=${launch.kubeconfigPath}`,
			`--context=${launch.context}`,
			"exec",
			...request.flags.map(formatFlag),
			request.pod,
			"--",
			...request.command,
		];
	}
	return [
		`--kubeconfig=${launch.kubeconfigPath}`,
		`--context=${launch.context}`,
		request.operation,
		...request.flags.map(formatFlag),
		"--",
		...request.positionals,
	];
}

function checkFlag(operation: KubectlOperation, flag: KubectlFlag): void {
	const table = FLAG_TABLES[operation];
	if (!Object.hasOwn(table, flag.name)) {
		throw new Error(`Unsupported kubectl ${operation} flag: ${flag.name}`);
	}
	if (flag.value === undefined && table[flag.name] === "value") {
		throw new Error(`Missing value for kubectl ${operation} flag: ${flag.name}`);
	}
}

export function formatFlag(flag: KubectlFlag): string {
	return flag.value === undefined ? flag.name : `${flag.name}=${flag.value}`;
}

export function kubectlCommandLabel(request: KubectlReadRequest): string {
	if (request.operation === "exec") {
		return ["kubectl", "exec", request.pod, ...request.flags.map(formatFlag), "--", ...request.command].join(" ");
	}
	return ["kubectl", request.operation, ...request.positionals, ...request.flags.map(formatFlag)].join(" ");
}

export function kubectlEnvironment(operatorEnvironment: NodeJS.ProcessEnv, kubeconfigPath: string): NodeJS.ProcessEnv {
	const kept = Object.entries(operatorEnvironment).filter(([name]) => !name.startsWith("KUBECTL_"));
	return { ...Object.fromEntries(kept), KUBECONFIG: kubeconfigPath, KUBERC: "off" };
}
