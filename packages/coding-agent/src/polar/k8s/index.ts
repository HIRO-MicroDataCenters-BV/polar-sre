import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { killProcessGroup } from "../shared/process.ts";
import { buildReply } from "../shared/reply.ts";
import { releaseWhenIdle } from "../shared/runtime.ts";
import { acquireSession } from "../shared/session.ts";
import { createProducerTool } from "../shared/tool.ts";
import {
	type DiscoveryError,
	discoverKubeContexts,
	type KubeContextItem,
	splitKubeconfigPaths,
} from "./src/kubeconfig.ts";
import { runKubectl } from "./src/kubectl.ts";
import { selectKubeContext } from "./src/picker.ts";
import { describeSpec } from "./src/tools/describe.ts";
import { eventsSpec } from "./src/tools/events.ts";
import { getSpec } from "./src/tools/get.ts";
import { inspectSpec } from "./src/tools/inspect.ts";
import { logsSpec } from "./src/tools/logs.ts";
import type { ExecutionLimits, K8sRuntime, KubectlCall, LaunchConfig, SessionHandle } from "./src/types.ts";

const LIMITS: ExecutionLimits = {
	timeoutMs: 60_000,
	logsTimeoutMs: 600_000,
	fileMaxBytes: 2 * 1024 * 1024 * 1024,
	sessionMaxBytes: 8 * 1024 * 1024 * 1024,
	stderrMaxBytes: 1024 * 1024,
	killGraceMs: 1000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
};

export function createRuntime(launch: LaunchConfig, environment: NodeJS.ProcessEnv, handle: SessionHandle): K8sRuntime {
	return {
		launch,
		environment: { ...environment },
		limits: LIMITS,
		kubectlCommand: "kubectl",
		activeProcessGroups: new Set(),
		handle,
		state: "open",
		inFlight: new Set(),
	};
}

function registerTools(pi: ExtensionAPI, runtime: K8sRuntime): void {
	const deps = {
		run: (call: KubectlCall, session: SessionHandle["paths"], signal: AbortSignal | undefined) =>
			runKubectl(call, runtime, session, signal),
		buildReply,
	};
	pi.registerTool(createProducerTool(getSpec, runtime, deps));
	pi.registerTool(createProducerTool(eventsSpec, runtime, deps));
	pi.registerTool(createProducerTool(logsSpec, runtime, deps));
	pi.registerTool(createProducerTool(describeSpec, runtime, deps));
	pi.registerTool(createProducerTool(inspectSpec, runtime, deps));
}

function readKubeconfigFlag(pi: ExtensionAPI): string {
	return (pi.getFlag("k8s-kubeconfig") as string | undefined) ?? "";
}

function formatDiscoveryErrors(errors: readonly DiscoveryError[]): string {
	return errors.map((e) => `${e.kubeconfigPath}: ${e.message}`).join("; ");
}

function stayOff(ctx: ExtensionContext, warning: string): undefined {
	ctx.ui.notify(warning, "warning");
	ctx.ui.setStatus("k8s", "k8s: off (/kubeconfig)");
	return undefined;
}

function readLaunchConfigOrStayOff(pi: ExtensionAPI, ctx: ExtensionContext): LaunchConfig | undefined {
	const context = pi.getFlag("k8s-context");
	if (typeof context !== "string" || context === "") {
		return stayOff(ctx, "k8s: no context selected (tools are off). Run /kubeconfig to select a context.");
	}
	const paths = splitKubeconfigPaths(readKubeconfigFlag(pi));
	const [kubeconfigPath] = paths;
	if (kubeconfigPath === undefined) {
		return stayOff(ctx, "k8s: no kubeconfig file specified (tools are off). Run /kubeconfig to select a context.");
	}
	if (paths.length > 1) {
		return stayOff(
			ctx,
			"k8s: --k8s-kubeconfig lists multiple files (tools are off). Run /kubeconfig to select a context.",
		);
	}
	return { kubeconfigPath, context };
}

function killProcessGroups(processGroups: Set<number>): void {
	for (const pid of processGroups) {
		killProcessGroup(pid, "SIGKILL");
	}
	processGroups.clear();
}

export default function k8sExtension(pi: ExtensionAPI): void {
	let current: K8sRuntime | undefined;
	let shuttingDown = false;

	async function activate(ctx: ExtensionContext, launch: LaunchConfig): Promise<boolean> {
		if (shuttingDown) return false;
		const handle = await acquireSession(ctx.sessionManager.getSessionId(), ctx.cwd);
		if (shuttingDown) {
			await handle.release();
			return false;
		}
		const runtime = createRuntime(launch, process.env, handle);
		registerTools(pi, runtime);
		current = runtime;
		ctx.ui.setStatus("k8s", `k8s: ${launch.context}`);
		return true;
	}

	pi.registerFlag("k8s-kubeconfig", {
		description: "Kubeconfig file(s) for kubectl (default: $KUBECONFIG or ~/.kube/config)",
		type: "string",
		default: process.env.KUBECONFIG || join(homedir(), ".kube", "config"),
	});
	pi.registerFlag("k8s-context", {
		description: "Kubeconfig context for kubectl (optional; select interactively with /kubeconfig)",
		type: "string",
	});

	pi.registerCommand("kubeconfig", {
		description: "Select or switch the active Kubernetes context",
		handler: async (args, ctx) => {
			const paths = splitKubeconfigPaths(readKubeconfigFlag(pi));
			const { items, errors } = await discoverKubeContexts(
				paths,
				current?.kubectlCommand ?? "kubectl",
				current?.environment ?? process.env,
			);

			if (items.length === 0) {
				const details = formatDiscoveryErrors(errors);
				ctx.ui.notify(
					details !== "" ? `k8s: no contexts found (${details})` : "k8s: no contexts found in kubeconfig",
					"error",
				);
				return;
			}

			if (errors.length > 0) {
				ctx.ui.notify(`k8s: failed to read some kubeconfig files (${formatDiscoveryErrors(errors)})`, "warning");
			}

			const query = args.trim();
			const exactMatches = query !== "" ? items.filter((item) => item.context === query) : [];
			let selected: KubeContextItem | undefined;
			if (exactMatches.length === 1) {
				selected = exactMatches[0];
			} else if (!ctx.hasUI) {
				ctx.ui.notify("k8s: /kubeconfig requires interactive mode or an exact context name", "error");
				return;
			} else {
				selected = await selectKubeContext(ctx, items, current?.launch, query !== "" ? query : undefined);
			}

			if (selected === undefined) return;
			if (shuttingDown) {
				ctx.ui.notify("The session is shutting down.", "error");
				return;
			}

			const nextLaunch: LaunchConfig = {
				kubeconfigPath: selected.kubeconfigPath,
				context: selected.context,
			};

			if (current === undefined) {
				if (!(await activate(ctx, nextLaunch))) return;
			} else {
				current.launch = nextLaunch;
				ctx.ui.setStatus("k8s", `k8s: ${selected.context}`);
			}

			ctx.ui.notify(`k8s: context set to "${selected.context}" (${selected.kubeconfigPath})`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		const launch = readLaunchConfigOrStayOff(pi, ctx);
		if (launch === undefined) return;
		await activate(ctx, launch);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		const runtime = current;
		if (runtime === undefined) return;
		current = undefined;
		killProcessGroups(runtime.activeProcessGroups);
		runtime.state = "closing";
		await releaseWhenIdle(runtime);
	});
}
