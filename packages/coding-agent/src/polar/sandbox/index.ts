import { type Static, Type } from "typebox";
import { type AgentToolResult, defineTool, type ExtensionAPI } from "../../core/extensions/types.ts";
import { acquireSession, type SessionHandle } from "../shared/session.ts";
import { describeBytes, READ_MAX_BYTES } from "../shared/store.ts";
import { nulCharacterError } from "../shared/validation.ts";
import { describeCleanupErrors } from "./src/cli.ts";
import { AppleContainerDriver, WORK_PATH } from "./src/driver.ts";
import { buildReply } from "./src/reply.ts";
import { admitCall, shutdownRefusal } from "./src/runner.ts";
import {
	DATA_PATH,
	type RunningCall,
	type SandboxDriverContext,
	type SandboxLimits,
	type SandboxRequest,
	type SandboxRuntime,
	type ToolReply,
} from "./src/types.ts";
import { shutdownRuntime, startRuntime } from "./src/workspace.ts";

const LIMITS: SandboxLimits = {
	timeoutMs: 300_000,
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpus: 4,
	workMaxBytes: 4 * 1024 * 1024 * 1024,
	processMax: 256,
	tmpMaxBytes: 512 * 1024 * 1024,
	fileMaxBytes: 2 * 1024 * 1024 * 1024,
	sessionMaxBytes: 8 * 1024 * 1024 * 1024,
	stderrMaxBytes: 1024 * 1024,
	killGraceMs: 2000,
	commandTimeoutMs: 30_000,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
	shutdownBudgetMs: 10_000,
};

export const DEFAULT_IMAGE = "polar-sandbox:0.1";
const PYTHON_KIT =
	"duckdb, polars, pandas, numpy, orjson, ijson, pyyaml, jmespath, python-dateutil, ciso8601, regex, tabulate, drain3";
const CLI_KIT = "bash, coreutils, gawk, ripgrep, jq, yq, duckdb, miller";

export const RUN_CODE_RULES = [
	`run_code: a session file over the ${describeBytes(READ_MAX_BYTES)} read limit is processed with "run_code" tool from ${DATA_PATH}/<file>.`,
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
		`Session output files are available read-only at ${DATA_PATH}/<file>.`,
		`${WORK_PATH} is writable, ${describeBytes(limits.workMaxBytes)} in size, and keeps files between calls.`,
		`No network. Each call is a fresh process with ${describeBytes(limits.memoryBytes)} of memory, ${minutes} min and ${limits.processMax} processes; stdin is empty.`,
		`stdout over ${limits.replyMaxLines} lines or ${describeBytes(limits.replyMaxBytes)} is cut; the rest is saved as a session file that the reply names, readable with "read" tool up to ${describeBytes(READ_MAX_BYTES)} or with "run_code" tool from ${DATA_PATH}.`,
		`stderr comes back unchanged between [stderr] and [/stderr]; a long stderr shows its tail and is saved whole the same way; over ${describeBytes(limits.stderrMaxBytes)} of stderr the program is stopped.`,
		`Python 3.13 with ${PYTHON_KIT}. CLI: ${CLI_KIT}.`,
	].join(" ");
}

export function createRuntime(image: string, environment: NodeJS.ProcessEnv, handle: SessionHandle): SandboxRuntime {
	const context: SandboxDriverContext = {
		containerCommand: "container",
		image,
		limits: LIMITS,
		environment: { ...environment },
		handle,
		state: "unready",
		owned: new Set(),
		children: new Map(),
		cliStopped: false,
	};
	return Object.assign(context, {
		inFlight: new Set<string>(),
		running: new Set<RunningCall>(),
		driver: new AppleContainerDriver(context),
		activeSandbox: {},
	});
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
	let current: SandboxRuntime | undefined;

	pi.registerFlag("sandbox-image", {
		description: `Image of the sandbox guest (default: ${DEFAULT_IMAGE})`,
		type: "string",
		default: DEFAULT_IMAGE,
	});

	pi.on("session_start", async (_event, ctx) => {
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		const flag = pi.getFlag("sandbox-image");
		const image = typeof flag === "string" && flag !== "" ? flag : DEFAULT_IMAGE;
		const handle = await acquireSession(ctx.sessionManager.getSessionId(), ctx.cwd);
		const runtime = createRuntime(image, process.env, handle);
		current = runtime;
		const readiness = await startRuntime(runtime, warn);
		if (runtime.state !== "unready") return;
		if (!readiness.ready) {
			warn(readiness.message);
			return;
		}
		runtime.state = "open";
		pi.registerTool(createRunCodeTool(runtime));
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (current === undefined) return;
		const runtime = current;
		current = undefined;
		await shutdownRuntime(runtime, event.reason, (message) => ctx.ui.notify(message, "warning"));
	});
}
