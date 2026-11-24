import { type Static, Type } from "typebox";
import { type AgentToolResult, defineTool, type ExtensionAPI } from "../../core/extensions/types.ts";
import { describeBytes, READ_MAX_BYTES } from "../shared/store.ts";
import { nulCharacterError } from "../shared/validation.ts";
import { describeCleanupErrors } from "./src/cli.ts";
import { runSandboxCommand } from "./src/command.ts";
import { SandboxController } from "./src/controller.ts";
import {
	AppleContainerDriver,
	K8sDriver,
	type K8sDriverOptions,
	OciDriver,
	UnsupportedSandboxDriver,
	WORK_PATH,
} from "./src/driver.ts";
import { buildImageSpec } from "./src/host.ts";
import { buildReply } from "./src/reply.ts";
import { admitCall, shutdownRefusal } from "./src/runner.ts";
import {
	DATA_PATH,
	type OciEngineChoice,
	type SandboxDriver,
	type SandboxDriverChoice,
	type SandboxDriverContext,
	type SandboxDriverName,
	type SandboxHost,
	type SandboxLimits,
	type SandboxRequest,
	type SandboxRuntime,
	type ToolReply,
} from "./src/types.ts";

const LIMITS: SandboxLimits = {
	timeoutMs: 300_000,
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpus: 4,
	workMaxBytes: 4 * 1024 * 1024 * 1024,
	processMax: 256,
	tmpMaxBytes: 512 * 1024 * 1024,
	fileMaxBytes: 4 * 1024 * 1024 * 1024,
	sessionMaxBytes: 16 * 1024 * 1024 * 1024,
	stderrMaxBytes: 1024 * 1024,
	killGraceMs: 2000,
	commandTimeoutMs: 30_000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
	shutdownBudgetMs: 10_000,
};

export const DEFAULT_IMAGE = "polar-sandbox:0.2";
export const REGISTRY_IMAGE: string | undefined =
	"ghcr.io/hiro-microdatacenters-bv/polar-sandbox@sha256:85b9ef4c8d91fdb57a8d531a62a1b67621c0c1a38cea28257b9ce986d1869ff1";
const PYTHON_KIT =
	"duckdb, polars, pandas, numpy, orjson, ijson, pyyaml, jmespath, python-dateutil, ciso8601, regex, tabulate, drain3";
const CLI_KIT = "bash, coreutils, gawk, ripgrep, jq, yq, duckdb, miller";

export const RUN_CODE_RULES = [
	`run_code: a session file over the ${describeBytes(READ_MAX_BYTES)} read limit is processed with "run_code" tool from ${DATA_PATH}/<file>.`,
	`run_code: the host cwd is not mounted in the VM; only ${DATA_PATH} (read-only, inspect with ls -la ${DATA_PATH}) and ${WORK_PATH} (4 GiB, persistent across calls) exist.`,
	`run_code: stream files over 1 GiB with rg, jq, mlr, duckdb, or polars.scan_* instead of loading whole files into memory.`,
];

const parameters = Type.Object(
	{
		language: Type.Union([Type.Literal("python"), Type.Literal("bash")]),
		code: Type.String({ description: "The program, run as a script by python3 or bash." }),
	},
	{ additionalProperties: false },
);

type RunCodeParams = Static<typeof parameters>;

export function describeRunCode(limits: SandboxLimits): string {
	const minutes = Math.round(limits.timeoutMs / 60_000);
	return [
		`Runs Python or bash code in an isolated Linux VM over the files saved in this session and returns stdout and stderr.`,
		`The host working directory is not mounted inside the VM; only ${DATA_PATH} and ${WORK_PATH} are available.`,
		`Session output files are available read-only at ${DATA_PATH}/<file> (inspect with ls -la ${DATA_PATH}).`,
		`${WORK_PATH} is writable, ${describeBytes(limits.workMaxBytes)} in size, and keeps files between calls.`,
		`No network. Each call is a fresh process with ${describeBytes(limits.memoryBytes)} of memory, ${minutes} min and ${limits.processMax} processes; stdin is empty.`,
		`Stream files over 1 GiB with rg, jq, mlr, duckdb, or polars.scan_* instead of loading them into memory.`,
		`stdout over ${limits.replyMaxLines} lines or ${describeBytes(limits.replyMaxBytes)} is cut; the rest is saved as a session file that the reply names, readable with "read" tool up to ${describeBytes(READ_MAX_BYTES)} or with "run_code" tool from ${DATA_PATH}.`,
		`stderr comes back unchanged between [stderr] and [/stderr]; a long stderr shows its tail and is saved whole the same way; over ${describeBytes(limits.stderrMaxBytes)} of stderr the program is stopped.`,
		`Python 3.13 with ${PYTHON_KIT}. CLI: ${CLI_KIT}.`,
	].join(" ");
}

export interface RuntimeImageOptions {
	registryImage?: string;
	customImage?: boolean;
	driver?: SandboxDriverChoice;
	ociEngine?: OciEngineChoice;
	ociRuntime?: string;
	k8sPvc?: string;
	k8sOptions?: K8sDriverOptions;
	platform?: NodeJS.Platform;
}

function resolveDriverChoice(
	environment: NodeJS.ProcessEnv,
	options: RuntimeImageOptions,
): { name: SandboxDriverName } | { unsupported: string } {
	const choice = options.driver ?? "auto";
	const platform = options.platform ?? process.platform;
	if (choice === "auto") {
		if (typeof environment.POLAR_SANDBOX_K8S_PVC === "string" && environment.POLAR_SANDBOX_K8S_PVC !== "") {
			return { name: "k8s" };
		}
		if (platform === "darwin") return { name: "apple-container" };
		if (platform === "linux") return { name: "oci" };
		return { unsupported: `unsupported platform "${platform}" for --sandbox-driver=auto` };
	}
	if (choice === "apple-container" || choice === "oci" || choice === "k8s") {
		return { name: choice };
	}
	return {
		unsupported: `invalid --sandbox-driver "${String(choice)}"; expected auto, apple-container, oci, or k8s`,
	};
}

export function createHost(
	image: string,
	environment: NodeJS.ProcessEnv,
	options: RuntimeImageOptions = {},
): SandboxHost {
	const env: NodeJS.ProcessEnv = { ...environment };
	if (options.k8sPvc !== undefined && options.k8sPvc !== "") {
		env.POLAR_SANDBOX_K8S_PVC = options.k8sPvc;
	}
	const resolved = resolveDriverChoice(env, options);
	const customImage = options.customImage ?? image !== DEFAULT_IMAGE;
	let containerCommand: string;
	let effectiveImage = image;
	let imageSpec = buildImageSpec(effectiveImage, {
		customImage,
		registryImage: options.registryImage,
		defaultRegistryImage: REGISTRY_IMAGE,
	});
	let createDriver: (context: SandboxDriverContext) => SandboxDriver;
	if ("unsupported" in resolved) {
		containerCommand = "container";
		createDriver = () => new UnsupportedSandboxDriver("oci", resolved.unsupported);
	} else if (resolved.name === "apple-container") {
		containerCommand = "container";
		createDriver = (context) => new AppleContainerDriver(context);
	} else if (resolved.name === "oci") {
		containerCommand = options.ociEngine === "docker" ? "docker" : "podman";
		createDriver = (context) =>
			new OciDriver(context, { engine: options.ociEngine ?? "auto", ociRuntime: options.ociRuntime });
	} else {
		const k8sImage = (env.POLAR_SANDBOX_K8S_IMAGE ?? "").trim();
		containerCommand = "kubectl";
		effectiveImage = !customImage && k8sImage !== "" ? k8sImage : image;
		imageSpec = { candidates: [effectiveImage], build: effectiveImage };
		createDriver = (context) => new K8sDriver(context, { ...options.k8sOptions, customImage });
	}
	const context: SandboxDriverContext = {
		containerCommand,
		image: effectiveImage,
		imageSpec,
		limits: LIMITS,
		environment: env,
		state: "unready",
		owned: new Set(),
		children: new Set(),
		cliStopped: false,
	};
	const driver = createDriver(context);
	return Object.assign(context, { driver });
}

function validate(params: RunCodeParams): string | undefined {
	if (params.code.trim() === "") return 'Invalid parameter "code": the program is empty.';
	return undefined;
}

function textResult(text: string, isError: boolean): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

function replyResult(reply: ToolReply): AgentToolResult<undefined> {
	return textResult(reply.text, reply.isError);
}

export function createRunCodeTool(runtime: SandboxRuntime) {
	return defineTool({
		name: "run_code",
		label: "run_code",
		description: describeRunCode(runtime.limits),
		promptSnippet: "run python or bash over the session files in an isolated VM",
		promptGuidelines: RUN_CODE_RULES,
		parameters,
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const parameterError = nulCharacterError(params) ?? validate(params);
			if (parameterError !== undefined) return textResult(parameterError, true);
			const request: SandboxRequest = { language: params.language, code: params.code };
			const call = admitCall(runtime, request, signal, toolCallId);
			if (call === undefined) {
				return replyResult(await buildReply(shutdownRefusal(), request, runtime.limits, runtime.handle.paths));
			}
			try {
				const result = await call.run();
				if (result.cleanupError !== undefined) {
					ctx?.ui.notify(
						`sandbox: ${describeCleanupErrors([result.cleanupError])} could not be deleted`,
						"warning",
					);
				}
				return replyResult(await buildReply(result, request, runtime.limits, runtime.handle.paths));
			} finally {
				await call.dispose();
			}
		},
	});
}

export default function sandboxExtension(pi: ExtensionAPI): void {
	let current: SandboxController | undefined;

	pi.registerFlag("sandbox-driver", {
		description: 'Sandbox driver: "auto", "apple-container", "oci", or "k8s" (default: auto)',
		type: "string",
		default: "auto",
	});
	pi.registerFlag("sandbox-image", {
		description: `Image of the sandbox guest (default: ${DEFAULT_IMAGE})`,
		type: "string",
		default: DEFAULT_IMAGE,
	});
	pi.registerFlag("sandbox-registry-image", {
		description: "Prebuilt sandbox image in a container registry (for pull)",
		type: "string",
	});
	pi.registerFlag("sandbox-oci-engine", {
		description: 'OCI engine on Linux: "auto", "podman", or "docker" (default: auto)',
		type: "string",
		default: "auto",
	});
	pi.registerFlag("sandbox-oci-runtime", {
		description: "Optional OCI runtime on Linux (e.g. krun or runsc)",
		type: "string",
	});
	pi.registerFlag("sandbox-k8s-pvc", {
		description: "Shared PVC name for the Kubernetes sandbox driver (overrides POLAR_SANDBOX_K8S_PVC)",
		type: "string",
	});

	pi.registerCommand("sandbox", {
		description: "Inspect, set up, or toggle the local analytics sandbox",
		handler: async (_args, ctx) => {
			if (current !== undefined) await runSandboxCommand(current, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("sandbox-image");
		const image = typeof flag === "string" && flag !== "" ? flag : DEFAULT_IMAGE;
		const customImage =
			image !== DEFAULT_IMAGE ||
			process.argv.some((arg) => arg === "--sandbox-image" || arg.startsWith("--sandbox-image="));
		const registryFlag = pi.getFlag("sandbox-registry-image");
		const registryImage = typeof registryFlag === "string" && registryFlag !== "" ? registryFlag : undefined;
		const driverFlag = pi.getFlag("sandbox-driver");
		const driver = typeof driverFlag === "string" && driverFlag !== "" ? (driverFlag as SandboxDriverChoice) : "auto";
		const ociEngineFlag = pi.getFlag("sandbox-oci-engine");
		const ociEngine =
			typeof ociEngineFlag === "string" && ociEngineFlag !== "" ? (ociEngineFlag as OciEngineChoice) : "auto";
		const ociRuntimeFlag = pi.getFlag("sandbox-oci-runtime");
		const ociRuntime = typeof ociRuntimeFlag === "string" && ociRuntimeFlag !== "" ? ociRuntimeFlag : undefined;
		const k8sPvcFlag = pi.getFlag("sandbox-k8s-pvc");
		const k8sPvc = typeof k8sPvcFlag === "string" && k8sPvcFlag !== "" ? k8sPvcFlag : undefined;
		const buildHost = () =>
			createHost(image, process.env, {
				registryImage,
				customImage,
				driver,
				ociEngine,
				ociRuntime,
				k8sPvc,
			});
		const controller = new SandboxController(buildHost, (runtime, options) => {
			const tool = createRunCodeTool(runtime);
			pi.registerTool(options?.hidden ? { ...tool, exposure: "hidden" } : tool);
		});
		current = controller;
		await controller.start(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (current === undefined) return;
		const controller = current;
		current = undefined;
		await controller.shutdown(event.reason, ctx);
	});
}
