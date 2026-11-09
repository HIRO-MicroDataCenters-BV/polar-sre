import { type Component, type Focusable, isFocusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { TObject } from "typebox";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	RegisteredCommand,
	ToolDefinition,
} from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { sessionLiveness } from "../../shared/session.ts";
import type { createProducerTool } from "../../shared/tool.ts";
import k8sExtension from "../index.ts";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown;
type CommandOption = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Method = (...args: never[]) => unknown;
type ProducerTool = ReturnType<typeof createProducerTool>;
type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

const FAKE_KUBECTL = fileURLToPath(new URL("./fake-kubectl.mjs", import.meta.url));
const OPERATOR_FLAGS = { "k8s-kubeconfig": "/tmp/kc", "k8s-context": "staging" };
const TOOL_NAMES = ["k8s_get", "k8s_events", "k8s_logs", "k8s_describe", "k8s_inspect"];
const SESSION_ID = randomUUID();
const CWD = process.cwd();
const SAVED_OUTPUT = "NAME    READY   STATUS    RESTARTS   AGE\nweb-0   1/1     Running   0          5d\n";
const ENV_KEYS = [
	"PATH",
	"POLAR_ARTIFACTS_DIR",
	"POLAR_CODING_AGENT_DIR",
	"FAKE_KUBECTL_ECHO",
	"FAKE_KUBECTL_CHILD",
	"FAKE_KUBECTL_DELAY_MS",
	"FAKE_KUBECTL_STDOUT_DELAY_MS",
	"FAKE_KUBECTL_IGNORE_SIGTERM",
	"FAKE_KUBECTL_STDOUT",
];

let root: string;
let savedEnv: [string, string | undefined][] = [];
let shutdowns: (() => Promise<unknown>)[] = [];

function outputDirectory(): string {
	return join(root, SESSION_ID);
}

function lockFile(): string {
	return join(outputDirectory(), "lock");
}

beforeEach(async () => {
	savedEnv = ENV_KEYS.map((key) => [key, process.env[key]]);
	for (const key of ENV_KEYS) {
		if (key.startsWith("FAKE_KUBECTL_")) delete process.env[key];
	}
	root = await mkdtemp(join(tmpdir(), "k8s-extension-"));
	const bin = join(root, "bin");
	await mkdir(bin, { recursive: true });
	const kubectlWrapper = join(bin, "kubectl");
	await writeFile(kubectlWrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_KUBECTL}" "$@"\n`);
	await chmod(kubectlWrapper, 0o755);
	process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
	process.env.POLAR_ARTIFACTS_DIR = root;
	process.env.POLAR_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
	for (const shutdown of shutdowns) await shutdown();
	shutdowns = [];
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function fakeContext(mode: ExtensionContext["mode"] = "tui", drivePicker?: (component: Component & Focusable) => void) {
	const notices: [string, string | undefined][] = [];
	const footer = new Map<string, string | undefined>();
	const ui =
		mode === "tui"
			? {
					notify: (message: string, type?: string) => notices.push([message, type]),
					setStatus: (key: string, text: string | undefined) => footer.set(key, text),
					custom: async <T>(factory: CustomFactory<T>): Promise<T> => {
						let picked: T = undefined as T;
						const tui = { requestRender: vi.fn() } as unknown as TUI;
						const kb = {} as unknown as KeybindingsManager;
						const component = (await factory(tui, fakeTheme(), kb, (result) => {
							picked = result;
						})) as Component & Focusable;
						drivePicker?.(component);
						return picked;
					},
				}
			: { notify: (message: string, type?: string) => notices.push([message, type]), setStatus: () => {} };
	const shutdown = vi.fn();
	const context = {
		mode,
		hasUI: mode === "tui",
		cwd: CWD,
		ui,
		sessionManager: { getSessionId: () => SESSION_ID },
		shutdown,
	};
	return {
		ctx: context as unknown as ExtensionContext,
		shutdown,
		notices,
		footer,
	};
}

function loadExtension(flagValues: Record<string, string>, context = fakeContext()) {
	const calledMethods: string[] = [];
	const tools: ToolDefinition<TObject>[] = [];
	const commands = new Map<string, CommandOption>();
	const flagDefaults = new Map<string, string | undefined>();
	const handlers = new Map<string, EventHandler>();
	const methods: Record<string, Method> = {
		registerFlag(name: string, options: { default?: string }) {
			flagDefaults.set(name, options.default);
		},
		getFlag(name: string) {
			return flagValues[name] ?? flagDefaults.get(name);
		},
		registerTool(tool: ProducerTool) {
			tools.push(tool);
		},
		registerCommand(name: string, options: CommandOption) {
			commands.set(name, options);
		},
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, handler);
		},
	};
	const pi = new Proxy(methods, {
		get(target, name: string) {
			return (...args: never[]) => {
				calledMethods.push(name);
				return target[name]?.(...args);
			};
		},
	});
	k8sExtension(pi as unknown as ExtensionAPI);

	const fire = async (eventName: string, event: object) => handlers.get(eventName)?.(event, context.ctx);
	const shutdown = () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	shutdowns.push(shutdown);
	let callCounter = 0;
	return {
		calledMethods,
		tools,
		commands,
		handlers,
		startSession: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown,
		runCommand: async (name: string, args = "") => {
			const cmd = commands.get(name);
			if (cmd === undefined) throw new Error(`Command /${name} is not registered`);
			await cmd.handler(args, context.ctx as unknown as ExtensionCommandContext);
		},
		execute: (toolName: string, params: Record<string, unknown>) => {
			const tool = tools.find((candidate) => candidate.name === toolName);
			if (tool === undefined) throw new Error(`${toolName} is not registered`);
			callCounter += 1;
			return tool.execute(`call-${callCounter}`, params, undefined, undefined, {} as ExtensionToolContext);
		},
	};
}

async function writeKubeconfig(
	fileName: string,
	contexts: { name: string; cluster?: string; user?: string; namespace?: string }[],
	currentContext = contexts[0]?.name ?? "",
): Promise<string> {
	const path = join(root, fileName);
	await writeFile(
		path,
		JSON.stringify({
			"current-context": currentContext,
			contexts: contexts.map((c) => ({
				name: c.name,
				context: {
					cluster: c.cluster ?? `${c.name}-cluster`,
					user: c.user ?? `${c.name}-user`,
					...(c.namespace ? { namespace: c.namespace } : {}),
				},
			})),
		}),
	);
	return path;
}

async function writeSavedOutput(): Promise<string> {
	const file = join(outputDirectory(), "k8s_get-1.txt");
	await mkdir(outputDirectory(), { recursive: true });
	await writeFile(file, SAVED_OUTPUT);
	return file;
}

async function waitForChildPid(partFile: string): Promise<number> {
	let pid = 0;
	await expect
		.poll(async () => {
			const text = await readFile(partFile, "utf8").catch(() => "");
			const match = /child-pid (\d+)\n/.exec(text);
			pid = match ? Number(match[1]) : 0;
			return pid;
		})
		.toBeGreaterThan(0);
	return pid;
}

describe("k8s extension", () => {
	it("does not touch the tool set", async () => {
		const pi = loadExtension(OPERATOR_FLAGS);
		await pi.startSession();
		await pi.shutdown();

		expect([...pi.handlers.keys()]).not.toContain("tool_call");
		expect(pi.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		expect(pi.tools.map((tool) => tool.prepareLoadout)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(pi.calledMethods).not.toContain("setActiveTools");
		expect(pi.calledMethods).not.toContain("getActiveTools");
	});

	it("model cannot pick the cluster", async () => {
		process.env.FAKE_KUBECTL_ECHO = "1";
		const pi = loadExtension(OPERATOR_FLAGS);
		await pi.startSession();

		expect(pi.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		for (const tool of pi.tools) {
			const parameterNames = Object.keys(tool.parameters.properties);
			expect(parameterNames.filter((name) => /kubeconfig|context/i.test(name))).toEqual([]);
		}

		const reply = await pi.execute("k8s_get", { resource: "pods" });
		const echo = JSON.parse((reply.content[0] as { text: string }).text) as { argv: string[] };
		expect(echo.argv).toContain("--kubeconfig=/tmp/kc");
		expect(echo.argv).toContain("--context=staging");

		const inspectReply = await pi.execute("k8s_inspect", {
			pod: "web-0",
			namespace: "shop",
			container: "app",
			operation: "read",
			path: "/etc/hosts",
		});
		const inspectEcho = JSON.parse((inspectReply.content[0] as { text: string }).text) as { argv: string[] };
		expect(inspectEcho.argv).toEqual([
			"--kubeconfig=/tmp/kc",
			"--context=staging",
			"exec",
			"--namespace=shop",
			"--container=app",
			"web-0",
			"--",
			"cat",
			"--",
			"/etc/hosts",
		]);
	});

	it("stays off without a context or with invalid kubeconfig paths and creates no lock", async () => {
		const contextMissing = { "k8s-kubeconfig": "/tmp/kc" };
		const contextEmpty = { "k8s-kubeconfig": "/tmp/kc", "k8s-context": "" };
		const bothMissingAndMulti = { "k8s-kubeconfig": ["a", "b"].join(delimiter) };
		const kubeconfigEmpty = { "k8s-kubeconfig": "", "k8s-context": "staging" };
		const kubeconfigList = { "k8s-kubeconfig": ["a", "b"].join(delimiter), "k8s-context": "staging" };
		const cases: [Record<string, string>, string][] = [
			[contextMissing, "kubeconfig: no context selected, run /kubeconfig to select"],
			[contextEmpty, "kubeconfig: no context selected, run /kubeconfig to select"],
			[bothMissingAndMulti, "kubeconfig: no context selected, run /kubeconfig to select"],
			[kubeconfigEmpty, "kubeconfig: no kubeconfig file specified, run /kubeconfig to select"],
			[kubeconfigList, "kubeconfig: --k8s-kubeconfig lists multiple files, run /kubeconfig to select"],
		];
		for (const [flags, message] of cases) {
			const context = fakeContext();
			const unbound = loadExtension(flags, context);
			await expect(unbound.startSession()).resolves.toBeUndefined();
			expect(context.shutdown).not.toHaveBeenCalled();
			expect(unbound.tools).toEqual([]);
			expect(context.notices).toEqual([[message, "warning"]]);
			expect(context.footer.get("k8s")).toBe("kubeconfig: off, run /kubeconfig");
			expect(existsSync(lockFile())).toBe(false);
		}
	});

	it("cold-activates via /kubeconfig <exact-name> and cleans up on shutdown", async () => {
		process.env.FAKE_KUBECTL_ECHO = "1";
		const kcA = await writeKubeconfig("kc-a.json", [{ name: "staging" }, { name: "dev" }]);
		const kcB = await writeKubeconfig("kc-b.json", [{ name: "prod", namespace: "payments" }]);

		const context = fakeContext();
		const pi = loadExtension({ "k8s-kubeconfig": [kcA, kcB].join(delimiter) }, context);
		await pi.startSession();

		expect(pi.tools).toEqual([]);
		expect(existsSync(lockFile())).toBe(false);
		expect(context.footer.get("k8s")).toBe("kubeconfig: off, run /kubeconfig");

		await pi.runCommand("kubeconfig", "prod");

		expect(existsSync(lockFile())).toBe(true);
		expect(pi.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		expect(context.footer.get("k8s")).toBe("kubeconfig: prod");
		expect(context.notices).toContainEqual([`kubeconfig: context set to "prod" (${kcB})`, "info"]);

		const reply = await pi.execute("k8s_get", { resource: "pods" });
		const echo = JSON.parse((reply.content[0] as { text: string }).text) as { argv: string[] };
		expect(echo.argv).toContain(`--kubeconfig=${kcB}`);
		expect(echo.argv).toContain("--context=prod");

		await pi.shutdown();
		expect(existsSync(lockFile())).toBe(false);
	});

	it("persists selected context across restarts and stays off if the saved context disappeared", async () => {
		const kc = await writeKubeconfig("kc.json", [{ name: "staging" }, { name: "prod" }]);

		const firstCtx = fakeContext();
		const first = loadExtension({ "k8s-kubeconfig": kc }, firstCtx);
		await first.startSession();
		await first.runCommand("kubeconfig", "prod");
		await first.shutdown();

		// Restart without --k8s-context: picks up saved prod context
		const secondCtx = fakeContext();
		const second = loadExtension({ "k8s-kubeconfig": kc }, secondCtx);
		await second.startSession();
		expect(second.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		expect(secondCtx.footer.get("k8s")).toBe("kubeconfig: prod");
		await second.shutdown();

		// Remove "prod" from kubeconfig -> next start stays off with warning
		await writeKubeconfig("kc.json", [{ name: "staging" }]);
		const thirdCtx = fakeContext();
		const third = loadExtension({ "k8s-kubeconfig": kc }, thirdCtx);
		await third.startSession();
		expect(third.tools).toEqual([]);
		expect(thirdCtx.footer.get("k8s")).toBe("kubeconfig: off, run /kubeconfig");
		expect(thirdCtx.notices).toEqual([
			[`kubeconfig: saved context "prod" was not found in ${kc}, run /kubeconfig to select`, "warning"],
		]);
	});

	it("cold-activates or cancels through the interactive TUI picker", async () => {
		process.env.FAKE_KUBECTL_ECHO = "1";
		const kcA = await writeKubeconfig("kc-a.json", [{ name: "staging", cluster: "eu-1" }]);
		const kcB = await writeKubeconfig("kc-b.json", [{ name: "prod", cluster: "us-1", namespace: "shop" }]);

		// 1. Cancel picker -> stays off and creates no lock
		const cancelContext = fakeContext("tui", (component) => {
			expect(isFocusable(component)).toBe(true);
			component.focused = true;
			expect(component.focused).toBe(true);
			const rendered = component.render(100).join("\n");
			expect(rendered).toContain("Select Kubernetes Context");
			expect(rendered).toContain("staging");
			expect(rendered).toContain("prod");
			component.handleInput?.("\x1b"); // Escape
		});
		const cancelledPi = loadExtension({ "k8s-kubeconfig": [kcA, kcB].join(delimiter) }, cancelContext);
		await cancelledPi.startSession();
		await cancelledPi.runCommand("kubeconfig");

		expect(cancelledPi.tools).toEqual([]);
		expect(existsSync(lockFile())).toBe(false);
		expect(cancelContext.footer.get("k8s")).toBe("kubeconfig: off, run /kubeconfig");

		// 2. Navigate down and press Enter -> activates second item ("prod")
		const selectContext = fakeContext("tui", (component) => {
			component.focused = true;
			component.handleInput?.("\x1b[B"); // Down arrow
			component.handleInput?.("\r"); // Enter
		});
		const selectedPi = loadExtension({ "k8s-kubeconfig": [kcA, kcB].join(delimiter) }, selectContext);
		await selectedPi.startSession();
		await selectedPi.runCommand("kubeconfig");

		expect(existsSync(lockFile())).toBe(true);
		expect(selectedPi.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
		expect(selectContext.footer.get("k8s")).toBe("kubeconfig: prod");

		const reply = await selectedPi.execute("k8s_get", { resource: "pods" });
		const echo = JSON.parse((reply.content[0] as { text: string }).text) as { argv: string[] };
		expect(echo.argv).toContain(`--kubeconfig=${kcB}`);
		expect(echo.argv).toContain("--context=prod");
	});

	it("warns on partial kubeconfig discovery errors and continues with valid contexts", async () => {
		const validKc = await writeKubeconfig("valid.json", [{ name: "staging" }]);
		const missingKc = join(root, "missing.json");

		const context = fakeContext();
		const pi = loadExtension({ "k8s-kubeconfig": [validKc, missingKc].join(delimiter) }, context);
		await pi.startSession();

		await pi.runCommand("kubeconfig", "staging");

		expect(context.notices).toContainEqual([
			expect.stringContaining(`k8s: failed to read some kubeconfig files (${missingKc}:`),
			"warning",
		]);
		expect(context.notices).toContainEqual([`kubeconfig: context set to "staging" (${validKc})`, "info"]);
		expect(context.footer.get("k8s")).toBe("kubeconfig: staging");
		expect(pi.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
	});

	it("switches active context on the fly for subsequent calls while in-flight call finishes with old context", async () => {
		const kcA = await writeKubeconfig("kc-a.json", [{ name: "staging" }, { name: "prod" }], "staging");
		process.env.FAKE_KUBECTL_ECHO = "1";
		process.env.FAKE_KUBECTL_STDOUT_DELAY_MS = "300";
		process.env.FAKE_KUBECTL_DELAY_MS = "300";

		const context = fakeContext();
		const pi = loadExtension(
			{
				"k8s-kubeconfig": kcA,
				"k8s-context": "staging",
			},
			context,
		);
		await pi.startSession();
		expect(pi.tools).toHaveLength(5);

		// Start first call with old context (staging) and wait until its part file is created
		const firstCallPromise = pi.execute("k8s_get", { resource: "pods" });
		const firstPartFile = join(outputDirectory(), "k8s_get-1.part");
		await expect.poll(async () => existsSync(firstPartFile)).toBe(true);

		// Remove delay for subsequent calls and switch active context via /kubeconfig
		delete process.env.FAKE_KUBECTL_STDOUT_DELAY_MS;
		delete process.env.FAKE_KUBECTL_DELAY_MS;

		await pi.runCommand("kubeconfig", "prod");
		expect(pi.tools).toHaveLength(5);
		expect(context.footer.get("k8s")).toBe("kubeconfig: prod");

		const secondReply = await pi.execute("k8s_get", { resource: "pods" });
		const firstReply = await firstCallPromise;

		const firstEcho = JSON.parse((firstReply.content[0] as { text: string }).text) as { argv: string[] };
		const secondEcho = JSON.parse((secondReply.content[0] as { text: string }).text) as { argv: string[] };

		expect(firstEcho.argv).toContain("--context=staging");
		expect(secondEcho.argv).toContain("--context=prod");
	});

	it("reports an error in headless mode when /kubeconfig is called without an exact context match", async () => {
		const kc = await writeKubeconfig("kc.json", [{ name: "staging" }, { name: "prod" }]);
		const headless = fakeContext("print");
		const pi = loadExtension({ "k8s-kubeconfig": kc }, headless);
		await pi.startSession();

		await pi.runCommand("kubeconfig");
		expect(headless.notices).toContainEqual([
			"k8s: /kubeconfig requires interactive mode or an exact context name",
			"error",
		]);
		expect(pi.tools).toEqual([]);
	});

	it("registers no prompt guidelines on k8s tools", async () => {
		const pi = loadExtension(OPERATOR_FLAGS);
		await pi.startSession();

		expect(pi.tools.map((tool) => tool.promptGuidelines)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(pi.tools.map((tool) => tool.prepareLoadout)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("supports TUI and headless modes", async () => {
		const tui = fakeContext("tui");
		await loadExtension(OPERATOR_FLAGS, tui).startSession();
		expect(tui.footer.get("k8s")).toBe("kubeconfig: staging");

		for (const mode of ["print", "json"] as const) {
			const headless = loadExtension(OPERATOR_FLAGS, fakeContext(mode));
			await headless.startSession();
			expect(headless.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		}
	});

	it("kills processes and keeps files at shutdown", async () => {
		const savedFile = await writeSavedOutput();
		process.env.FAKE_KUBECTL_CHILD = "1";
		process.env.FAKE_KUBECTL_DELAY_MS = "60000";
		const pi = loadExtension(OPERATOR_FLAGS);
		await pi.startSession();
		expect(await readFile(lockFile(), "utf8")).toBe(`${process.pid}\n`);

		const call = pi.execute("k8s_get", { resource: "pods" });
		const pid = await waitForChildPid(join(outputDirectory(), "k8s_get-2.part"));

		await pi.shutdown();
		await call;

		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		expect(await readFile(savedFile, "utf8")).toBe(SAVED_OUTPUT);
		await expect(readFile(lockFile())).rejects.toThrow();
		expect(await pi.execute("k8s_get", { resource: "pods" })).toEqual({
			content: [{ type: "text", text: "The session is shutting down." }],
			details: undefined,
			isError: true,
		});
		await expect(pi.shutdown()).resolves.toBeUndefined();
	});

	it("holds the handle until a running call ends", async () => {
		process.env.FAKE_KUBECTL_IGNORE_SIGTERM = "1";
		process.env.FAKE_KUBECTL_STDOUT = "ready\n";
		process.env.FAKE_KUBECTL_DELAY_MS = "60000";
		const pi = loadExtension(OPERATOR_FLAGS);
		await pi.startSession();

		const call = pi.execute("k8s_get", { resource: "pods" });
		const partFile = join(outputDirectory(), "k8s_get-1.part");
		await expect.poll(async () => (await stat(partFile).catch(() => ({ size: 0 }))).size).toBeGreaterThan(0);

		await pi.shutdown();
		expect(existsSync(lockFile())).toBe(true);

		const reply = await call;
		expect((reply.content[0] as { text: string }).text).toMatch(
			/^\[k8s_get failed: signal SIGKILL\] kubectl get pods/,
		);
		const names = await readdir(outputDirectory());
		expect(names.filter((name) => name.endsWith(".part"))).toEqual([]);
		expect(await sessionLiveness(root, SESSION_ID)).toBe("ended");
	});
});
