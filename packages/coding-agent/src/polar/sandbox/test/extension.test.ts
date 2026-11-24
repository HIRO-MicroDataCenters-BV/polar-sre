import { randomUUID } from "crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { TObject } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	RegisteredCommand,
	ToolDefinition,
} from "../../../core/extensions/types.ts";
import sandboxExtension, { DEFAULT_IMAGE, REGISTRY_IMAGE, RUN_CODE_RULES } from "../index.ts";
import { runSandboxCommand } from "../src/command.ts";
import { SandboxController } from "../src/controller.ts";
import { BUILD_IMAGE_OPTION, DOWNLOAD_IMAGE_OPTION, ROOTLESS_DOCKER_UNSUPPORTED } from "../src/driver.ts";
import {
	FAKE_CONTAINER,
	FAKE_OCI,
	type FakeState,
	fakeK8sHost,
	fakeServiceAccountDir,
	fakeState,
	processExists,
	until,
} from "./fixtures.ts";

const fault = vi.hoisted(() => ({ failReplyOnce: false }));
vi.mock(import("../src/reply.ts"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		buildReply: async (...args: Parameters<typeof original.buildReply>) => {
			if (fault.failReplyOnce) {
				fault.failReplyOnce = false;
				throw new Error("the reply failed");
			}
			return original.buildReply(...args);
		},
	};
});

type EventHandler = (event: object, ctx: ExtensionContext) => unknown;
type Method = (...args: never[]) => unknown;
type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
type CommandOption = Omit<RegisteredCommand, "name" | "sourceInfo">;
type SelectHandler = (title: string, items: string[]) => string | undefined | Promise<string | undefined>;

const SESSION_ID = randomUUID();
const ENV_KEYS = ["PATH", "POLAR_ARTIFACTS_DIR", "POLAR_CODING_AGENT_DIR", "FAKE_CONTAINER_STATE"];

let root: string;
let bin: string;
let state: FakeState;
let savedEnv: [string, string | undefined][] = [];
let shutdowns: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
	savedEnv = ENV_KEYS.map((key) => [key, process.env[key]]);
	fault.failReplyOnce = false;
	root = await mkdtemp(join(tmpdir(), "sandbox-extension-"));
	bin = join(root, "bin");
	await mkdir(bin, { recursive: true });
	state = await fakeState();
	await setKnobs();
	process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
	process.env.POLAR_ARTIFACTS_DIR = root;
	process.env.POLAR_CODING_AGENT_DIR = join(root, "agent");
	process.env.FAKE_CONTAINER_STATE = state.directory;
	shutdowns = [];
});

afterEach(async () => {
	for (const shutdown of shutdowns) await shutdown();
	shutdowns = [];
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
	await rm(state.directory, { recursive: true, force: true });
});

async function setKnobs(knobs: Record<string, string> = {}): Promise<void> {
	const exports = Object.entries(knobs).map(([name, value]) => `export FAKE_CONTAINER_${name}=${shellWord(value)}\n`);
	const wrapper = join(bin, "container");
	await writeFile(wrapper, `#!/bin/sh\n${exports.join("")}exec "${process.execPath}" "${FAKE_CONTAINER}" "$@"\n`);
	await chmod(wrapper, 0o755);
}

function shellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

interface FakeContextOptions {
	hasUI?: boolean;
	selectChoice?: string;
	selectChoices?: (string | undefined)[];
	onSelect?: SelectHandler;
	mode?: string;
	sessionId?: string;
}

function fakeContext(options: FakeContextOptions = {}) {
	const notices: [string, string | undefined][] = [];
	const footer = new Map<string, string | undefined>();
	const selects: [string, string[]][] = [];
	const widgets: [string, "shown" | "removed"][] = [];
	const hasUI = options.hasUI ?? true;
	const queue = options.selectChoices ? [...options.selectChoices] : [];
	let selectHandler: SelectHandler | undefined = options.onSelect;
	let fallbackChoice: string | undefined = options.selectChoice;
	let invalidated = false;
	const assertValid = () => {
		if (invalidated) throw new Error("context invalidated");
	};
	const sessionId = options.sessionId ?? SESSION_ID;
	const context = {
		mode: options.mode ?? (hasUI ? "tui" : "print"),
		hasUI,
		cwd: process.cwd(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: (message: string, type?: string) => {
				assertValid();
				notices.push([message, type]);
			},
			setStatus: (key: string, text: string | undefined) => {
				assertValid();
				footer.set(key, text);
			},
			setWidget: (key: string, content: unknown) => {
				assertValid();
				widgets.push([key, content === undefined ? "removed" : "shown"]);
			},
			select: async (title: string, items: string[]) => {
				assertValid();
				selects.push([title, items]);
				if (selectHandler !== undefined) return selectHandler(title, items);
				if (queue.length > 0) return queue.shift();
				return fallbackChoice;
			},
		},
		sessionManager: { getSessionId: () => sessionId },
		shutdown: () => {},
	};
	return {
		ctx: context as unknown as ExtensionContext,
		notices,
		footer,
		selects,
		widgets,
		assertValid,
		invalidate: () => {
			invalidated = true;
		},
		setSelectChoice: (choice: string | undefined) => {
			selectHandler = undefined;
			queue.length = 0;
			fallbackChoice = choice;
		},
		setSelectChoices: (choices: (string | undefined)[]) => {
			selectHandler = undefined;
			queue.length = 0;
			queue.push(...choices);
		},
		setOnSelect: (handler: SelectHandler | undefined) => {
			selectHandler = handler;
		},
	};
}

function loadExtension(flagValues: Record<string, string> = {}, contextOptions: FakeContextOptions = {}) {
	const flags: Record<string, string> = { "sandbox-driver": "apple-container", ...flagValues };
	const {
		ctx,
		notices,
		footer,
		selects,
		widgets,
		assertValid,
		invalidate,
		setSelectChoice,
		setSelectChoices,
		setOnSelect,
	} = fakeContext(contextOptions);
	const toolRegistry = new Map<string, ToolDefinition<TObject>>();
	const commands = new Map<string, CommandOption>();
	const flagDefaults = new Map<string, string | undefined>();
	const handlers = new Map<string, EventHandler>();
	const methods: Record<string, Method> = {
		registerFlag(name: string, options: { default?: string }) {
			flagDefaults.set(name, options.default);
		},
		getFlag(name: string) {
			return flags[name] ?? flagDefaults.get(name);
		},
		registerTool(tool: ToolDefinition<TObject>) {
			assertValid();
			toolRegistry.set(tool.name, tool);
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
			return (...args: never[]) => target[name]?.(...args);
		},
	});
	sandboxExtension(pi as unknown as ExtensionAPI);
	const fire = async (eventName: string, event: object) => handlers.get(eventName)?.(event, ctx);
	const visibleTools = () => [...toolRegistry.values()].filter((tool) => tool.exposure !== "hidden");
	const extension = {
		ctx,
		get tools() {
			return visibleTools();
		},
		toolRegistry,
		commands,
		notices,
		footer,
		selects,
		widgets,
		flagDefaults,
		invalidate,
		setSelectChoice,
		setSelectChoices,
		setOnSelect,
		startSession: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: (reason: ShutdownReason = "quit") => fire("session_shutdown", { type: "session_shutdown", reason }),
		runCommand: async (name = "sandbox", args = "") => {
			const cmd = commands.get(name);
			if (cmd === undefined) throw new Error(`Command /${name} is not registered`);
			await cmd.handler(args, ctx as unknown as ExtensionCommandContext);
		},
		execute: (callId: string, params: Record<string, unknown>) => {
			const [tool] = visibleTools();
			if (tool === undefined) throw new Error("run_code is not registered");
			return tool.execute(callId, params, undefined, undefined, ctx as unknown as ExtensionToolContext);
		},
	};
	shutdowns.push(() => extension.shutdown("quit"));
	return extension;
}

function lockPath(): string {
	return join(root, SESSION_ID, "lock");
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function execCalls(): Promise<string[][]> {
	return (await state.calls()).filter((call) => call[0] === "exec" && call.includes("--interactive"));
}

function text(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

describe("sandbox extension", () => {
	it("offers run_code only from a clean state", async () => {
		const labels = { "polar-session": SESSION_ID, "polar-root": root };
		const refusals: [string, Record<string, string>, string][] = [
			["readiness", { SERVICE_STOPPED: "1" }, "sandbox is off: Apple container service is not running"],
			[
				"unknown listing",
				{ LIST_GARBAGE: "1" },
				"sandbox is off: runtime state could not be established: unreadable listing",
			],
			[
				"leftover",
				{ DELETE_FAIL: "1" },
				`sandbox is off: leftovers of sandbox stayed; polar-sandbox-${SESSION_ID}-1-aaaaaaaa (delete: Error: runtime temporarily unavailable; still listed) could not be deleted; delete them with: container delete --force polar-sandbox-${SESSION_ID}-1-aaaaaaaa`,
			],
		];
		await state.addContainer(`polar-sandbox-${SESSION_ID}-1-aaaaaaaa`, labels);
		for (const [refusal, knobs, message] of refusals) {
			await setKnobs(knobs);
			const off = loadExtension();
			await off.startSession();
			expect(off.tools, refusal).toEqual([]);
			expect(off.notices, refusal).toEqual([[message, "warning"]]);
			expect(off.footer.get("sandbox"), refusal).toBe("sandbox: off, run /sandbox");
			await off.shutdown();
			expect(await exists(lockPath()), refusal).toBe(false);
		}
		await state.addVolume(`polar-work-${SESSION_ID}`, { "polar-session": SESSION_ID, "polar-root": "/elsewhere" });
		await setKnobs();
		const foreign = loadExtension();
		await foreign.startSession();
		expect(foreign.tools).toEqual([]);
		expect(foreign.notices).toEqual([
			[
				`sandbox is off: the volume polar-work-${SESSION_ID} is not this session's: its polar-root label is /elsewhere, expected ${root}`,
				"warning",
			],
		]);
		expect(foreign.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(await state.containers()).toEqual([]);
		await foreign.shutdown();
		expect(await exists(lockPath())).toBe(false);
		await rm(join(state.directory, "volumes"), { recursive: true, force: true });

		const ready = loadExtension();
		await ready.startSession();
		expect(ready.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(ready.tools[0].executionMode).toBe("sequential");
		expect(ready.footer.get("sandbox")).toBeUndefined();
		expect(ready.notices).toEqual([]);
		expect(await state.volumes()).toEqual([{ name: `polar-work-${SESSION_ID}`, labels, size: "4096M" }]);
		expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
		const executed = await ready.execute("call-1", { language: "bash", code: "stdout:ready-ok" });
		expect(executed.isError).toBe(false);
		expect(text(executed)).toContain("ready-ok");
	});

	it("holds the session lock only while the sandbox is active", async () => {
		await setKnobs({ SERVICE_STOPPED: "1" });
		const notReady = loadExtension();
		await notReady.startSession();
		expect(notReady.tools).toEqual([]);
		expect(notReady.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(await exists(join(root, SESSION_ID))).toBe(false);
		await notReady.shutdown();

		await setKnobs({ LIST_GARBAGE: "1" });
		const failed = loadExtension();
		await failed.startSession();
		expect(failed.tools).toEqual([]);
		expect(failed.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(failed.notices).toEqual([
			["sandbox is off: runtime state could not be established: unreadable listing", "warning"],
		]);
		expect(await exists(lockPath())).toBe(false);
		await failed.shutdown();

		await setKnobs();
		const active = loadExtension();
		await active.startSession();
		expect(active.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(active.footer.get("sandbox")).toBeUndefined();
		expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
		await active.shutdown();
		expect(await exists(lockPath())).toBe(false);
	});

	it("releases the lock and offers no tool when the session ends while the sandbox starts", async () => {
		await setKnobs({ DELETE_DELAY_MS: "700" });
		const pi = loadExtension();
		const starting = pi.startSession();
		await until(async () => (await state.calls()).some((call) => call[0] === "delete"));

		await pi.shutdown("reload");
		await starting;

		expect(pi.tools).toEqual([]);
		expect(pi.notices).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
	});

	it("notifies the operator of the OCI driver and isolation boundary on start", async () => {
		const podmanWrapper = join(bin, "podman");
		await writeFile(
			podmanWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=podman\nexport FAKE_OCI_STATE=${shellWord(state.directory)}\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(podmanWrapper, 0o755);
		const dockerWrapper = join(bin, "docker");
		await writeFile(
			dockerWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=docker\nexport FAKE_OCI_STATE=${shellWord(state.directory)}\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(dockerWrapper, 0o755);

		const krun = loadExtension({
			"sandbox-driver": "oci",
			"sandbox-oci-engine": "podman",
			"sandbox-oci-runtime": "krun",
		});
		await krun.startSession();
		expect(krun.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(krun.notices).toEqual([["sandbox: oci (podman/krun)", "info"]]);
		await krun.shutdown();

		const sharedKernel = loadExtension({
			"sandbox-driver": "oci",
			"sandbox-oci-engine": "docker",
		});
		await sharedKernel.startSession();
		expect(sharedKernel.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(sharedKernel.notices).toEqual([["sandbox: oci (docker/runc, shared kernel)", "info"]]);
		await sharedKernel.shutdown();

		// --sandbox-k8s-pvc selects k8s driver even when --sandbox-driver=auto
		const k8sAuto = loadExtension({
			"sandbox-driver": "auto",
			"sandbox-k8s-pvc": "polar-shared",
		});
		expect(k8sAuto.flagDefaults.has("sandbox-k8s-pvc")).toBe(true);
		await k8sAuto.startSession();
		expect(k8sAuto.tools).toEqual([]);
		expect(k8sAuto.notices[0]?.[0]).toContain("POLAR_SANDBOX_K8S_RUNTIME_CLASS is not set");
		await k8sAuto.shutdown();
	});

	it("describes the tool from the operator limits and the image flag", async () => {
		const image = "registry.example/polar-sandbox@sha256:abc";
		const pi = loadExtension({ "sandbox-image": image });
		await pi.startSession();
		const [tool] = pi.tools;

		expect(pi.flagDefaults.get("sandbox-image")).toBe(DEFAULT_IMAGE);
		expect(pi.footer.get("sandbox")).toBeUndefined();
		expect(await state.calls()).toContainEqual(["image", "inspect", image]);
		expect(tool.description).toContain(
			"The host working directory is not mounted inside the VM; only /data and /work are available.",
		);
		expect(tool.description).toContain(
			"Session output files are available read-only at /data/<file> (inspect with ls -la /data).",
		);
		for (const phrase of [
			"/data",
			"/work",
			"ls -la /data",
			"No network",
			"stdin is empty",
			"duckdb",
			"ripgrep",
			"polars.scan_*",
			"1 GiB",
			"16 MiB",
			"2 GiB",
			"4 GiB",
			"5 min",
			"256 processes",
			"2000 lines",
			"50 KiB",
			'"read" tool',
			'"run_code" tool',
			"[stderr] and [/stderr]",
			"over 1 MiB of stderr",
		]) {
			expect(tool.description).toContain(phrase);
		}
		expect(tool.promptSnippet).toBe("run python or bash over the session files in an isolated VM");
		expect(tool.promptGuidelines).toEqual(RUN_CODE_RULES);
		for (const item of [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]) {
			expect(item).not.toContain("list_files");
			expect(item).not.toContain("k8s_");
		}
		expect(Object.keys(tool.parameters.properties)).toEqual(["language", "code"]);
	});

	it("sets footer status and warns without prompting when container is missing or the image is absent", async () => {
		const emptyBin = join(root, "empty-bin");
		await mkdir(emptyBin, { recursive: true });
		const fullPath = process.env.PATH;
		process.env.PATH = emptyBin;
		const missingRuntime = loadExtension({}, { hasUI: true, selectChoice: DOWNLOAD_IMAGE_OPTION });
		await missingRuntime.startSession();
		expect(missingRuntime.tools).toEqual([]);
		expect(missingRuntime.selects).toEqual([]);
		expect(missingRuntime.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(missingRuntime.notices).toEqual([["sandbox is off: Apple container is not installed", "warning"]]);
		await missingRuntime.shutdown();
		process.env.PATH = fullPath;

		await setKnobs({ IMAGE_MISSING: "1" });
		const missingImage = loadExtension({}, { hasUI: true, selectChoice: DOWNLOAD_IMAGE_OPTION });
		await missingImage.startSession();
		expect(missingImage.tools).toEqual([]);
		expect(missingImage.selects).toEqual([]);
		expect(missingImage.widgets).toEqual([]);
		expect(missingImage.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(missingImage.notices).toEqual([
			[
				`sandbox is off: image ${DEFAULT_IMAGE} is not installed (container image inspect ${DEFAULT_IMAGE} failed: Error: image ${DEFAULT_IMAGE} not found)`,
				"warning",
			],
		]);
		expect((await state.calls()).some((call) => call[0] === "image" && call[1] === "pull")).toBe(false);
		await missingImage.shutdown();
	});

	it("registers and executes run_code in non-interactive modes when the host is ready", async () => {
		const headless = loadExtension({}, { hasUI: false });
		await headless.startSession();
		expect(headless.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(headless.selects).toEqual([]);
		expect(headless.notices).toEqual([]);
		expect(headless.footer.get("sandbox")).toBeUndefined();
		const result = await headless.execute("call-1", { language: "bash", code: "stdout:headless-ok" });
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("headless-ok");
		await headless.shutdown();
	});

	it("reports OCI engine reasons for installed engines only and falls back from unsuitable Podman to working Docker", async () => {
		const ociBin = join(root, "oci-bin");
		await mkdir(ociBin, { recursive: true });
		process.env.PATH = ociBin;

		// 1. Both engines missing (ENOENT)
		const neither = loadExtension({ "sandbox-driver": "oci" });
		await neither.startSession();
		expect(neither.tools).toEqual([]);
		expect(neither.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(neither.notices).toEqual([["sandbox is off: neither podman nor docker is installed", "warning"]]);
		await neither.shutdown();

		// 2. Podman missing, Docker installed but unsuitable (rootless)
		const podmanState = await fakeState();
		const dockerState = await fakeState();
		try {
			const dockerWrapper = join(ociBin, "docker");
			const writeOciWrapper = async (
				target: string,
				engine: string,
				engineState: FakeState,
				knobs: Record<string, string>,
			) => {
				const exports = Object.entries(knobs)
					.map(([name, value]) => `export FAKE_OCI_${name}=${shellWord(value)}\n`)
					.join("");
				await writeFile(
					target,
					`#!/bin/sh\nexport FAKE_OCI_ENGINE=${engine}\nexport FAKE_OCI_STATE=${shellWord(engineState.directory)}\n${exports}exec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
				);
				await chmod(target, 0o755);
			};
			await writeOciWrapper(dockerWrapper, "docker", dockerState, { DOCKER_ROOTLESS: "1" });
			const onlyDockerBad = loadExtension({ "sandbox-driver": "oci" });
			await onlyDockerBad.startSession();
			expect(onlyDockerBad.tools).toEqual([]);
			expect(onlyDockerBad.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
			expect(onlyDockerBad.notices).toEqual([[`sandbox is off: ${ROOTLESS_DOCKER_UNSUPPORTED}`, "warning"]]);
			await onlyDockerBad.shutdown();

			// 3. Both installed and both unsuitable -> reasons of both
			const podmanWrapper = join(ociBin, "podman");
			await writeOciWrapper(podmanWrapper, "podman", podmanState, {
				PODMAN_ROOTLESS: "1",
				PODMAN_VERSION: "4.2.1",
			});
			const bothBad = loadExtension({ "sandbox-driver": "oci" });
			await bothBad.startSession();
			expect(bothBad.tools).toEqual([]);
			expect(bothBad.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
			expect(bothBad.notices).toEqual([
				[
					`sandbox is off: rootless Podman >= 4.3 is required for keep-id UID mapping (found 4.2.1); ${ROOTLESS_DOCKER_UNSUPPORTED}`,
					"warning",
				],
			]);
			await bothBad.shutdown();

			// 4. Unsuitable Podman + working Docker -> falls back to Docker and runs code in docker
			await rm(join(podmanState.directory, "calls.jsonl"), { force: true });
			await rm(join(dockerState.directory, "calls.jsonl"), { force: true });
			await writeOciWrapper(dockerWrapper, "docker", dockerState, {});
			const fallback = loadExtension({ "sandbox-driver": "oci" });
			await fallback.startSession();
			expect(fallback.tools.map((tool) => tool.name)).toEqual(["run_code"]);
			expect(fallback.footer.get("sandbox")).toBeUndefined();
			expect(fallback.notices).toEqual([["sandbox: oci (docker/runc, shared kernel)", "info"]]);
			const result = await fallback.execute("call-1", { language: "bash", code: "echo_argv" });
			expect(result.isError).toBe(false);
			expect(text(result)).not.toContain("--userns=keep-id");
			expect(await podmanState.calls()).toEqual([["info", "--format", "{{json .}}"]]);
			const dockerCommands = (await dockerState.calls()).map((call) => call[0]);
			expect(dockerCommands).toContain("info");
			expect(dockerCommands).toContain("image");
			expect(dockerCommands).toContain("volume");
			expect(dockerCommands).toContain("run");
			expect(dockerCommands).toContain("exec");
			await fallback.shutdown();
		} finally {
			await rm(podmanState.directory, { recursive: true, force: true });
			await rm(dockerState.directory, { recursive: true, force: true });
		}
	});

	it("rejects an empty or NUL program before any run", async () => {
		const pi = loadExtension();
		await pi.startSession();

		const empty = await pi.execute("call-1", { language: "python", code: "  \n" });
		expect(empty).toEqual({
			content: [{ type: "text", text: 'Invalid parameter "code": the program is empty.' }],
			details: undefined,
			isError: true,
		});
		const nul = await pi.execute("call-2", { language: "bash", code: "echo \0" });
		expect(nul.isError).toBe(true);
		expect(nul.content).toEqual([
			{ type: "text", text: 'Invalid parameter "code": NUL characters are not allowed.' },
		]);
		expect(await execCalls()).toEqual([]);
		await pi.shutdown();
		expect(await exists(lockPath())).toBe(false);
	});

	it("tells the operator about a leftover container and keeps the program result", async () => {
		const pi = loadExtension();
		await pi.startSession();
		await setKnobs({ SCRUB_FAIL: "1", DELETE_FAIL: "1" });

		const result = await pi.execute("call-1", { language: "bash", code: "stdout:done" });

		const [exec] = await execCalls();
		const name = exec[exec.indexOf("bash") - 1];
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("done");
		expect(text(result)).toContain(
			`[The container ${name} could not be deleted: delete: Error: runtime temporarily unavailable; still listed. Do not rerun the program for this; tell the user.]`,
		);
		expect(pi.notices).toEqual([
			[
				`sandbox: ${name} (delete: Error: runtime temporarily unavailable; still listed) could not be deleted`,
				"warning",
			],
		]);
		expect(await state.containers()).toEqual([name]);
	});

	it("refuses a call while shutting down", async () => {
		const pi = loadExtension();
		await pi.startSession();
		await pi.shutdown("reload");

		const result = await pi.execute("call-1", { language: "bash", code: "echo hi" });

		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "[run_code runtime_failed] bash: echo hi\n\nrun_code is shutting down; no program starts.\n\nThe container runtime failed to run the code. Tell the user.",
				},
			],
			details: undefined,
			isError: true,
		});
		expect(await execCalls()).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
	});

	it("reports at shutdown and releases the handle after the last call", async () => {
		const pi = loadExtension();
		await pi.startSession();
		await setKnobs({ RUN_IGNORES_KILL: "1", DELETE_FAIL: "1" });
		const call = pi.execute("call-1", { language: "bash", code: "hang" });
		await until(async () => (await execCalls()).length === 1);
		const [exec] = await execCalls();
		const name = exec[exec.indexOf("bash") - 1];

		const shutdown = pi.shutdown("reload");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await exists(lockPath())).toBe(true);

		const result = await call;
		expect(text(result)).toMatch(/^\[run_code cancelled\] bash: hang\n/);
		expect(result.isError).toBe(true);
		expect(await exists(lockPath())).toBe(false);
		await shutdown;
		expect(pi.notices).toEqual([
			[
				`sandbox: ${name} (delete: Error: runtime temporarily unavailable; still listed) could not be deleted`,
				"warning",
			],
			[
				`sandbox: ${name} (delete: Error: runtime temporarily unavailable; still listed) could not be deleted at shutdown`,
				"warning",
			],
		]);
		expect(await state.containers()).toEqual([name]);
	});

	it("disposes the ticket and the file when the reply throws", async () => {
		const pi = loadExtension();
		await pi.startSession();
		fault.failReplyOnce = true;

		await expect(pi.execute("call-1", { language: "bash", code: "stdout:done" })).rejects.toThrow("the reply failed");

		const files = await readdir(join(root, SESSION_ID));
		expect(files.filter((name) => name.endsWith(".part"))).toEqual([]);
		expect(files.filter((name) => name.startsWith("run_code-"))).toEqual([]);
		await pi.shutdown();
		expect(await state.containers()).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
	});

	it("downloads or builds a missing image through /sandbox, previews matching CLI commands, and activates run_code in the session", async () => {
		await setKnobs({ IMAGE_MISSING: "1" });
		const pi = loadExtension();
		await pi.startSession();
		expect(pi.tools).toEqual([]);
		expect(pi.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(await exists(lockPath())).toBe(false);

		// 1. Show commands
		pi.setSelectChoice("Show commands");
		await pi.runCommand("sandbox");
		expect(pi.selects.at(-1)?.[1]).toEqual([
			DOWNLOAD_IMAGE_OPTION,
			BUILD_IMAGE_OPTION,
			"Show commands",
			"Disable sandbox",
			"Cancel",
		]);
		const previewNotice = pi.notices.at(-1)?.[0] ?? "";
		expect(previewNotice).toContain(`container image pull --arch arm64 ${REGISTRY_IMAGE}`);
		expect(previewNotice).toContain(`container build --arch arm64 --tag ${DEFAULT_IMAGE} --file `);

		// 2. Download prebuilt image
		pi.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await pi.runCommand("sandbox");
		await until(() => pi.tools.length === 1);
		expect(pi.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		expect(pi.footer.get("sandbox")).toBeUndefined();
		expect(pi.notices).toContainEqual(["sandbox: ready", "info"]);
		expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
		const pullCall = (await state.calls()).find((call) => call[0] === "image" && call[1] === "pull");
		expect(pullCall).toEqual(["image", "pull", "--arch", "arm64", REGISTRY_IMAGE]);
		expect(previewNotice.split("\n")[0]).toBe(`container ${(pullCall ?? []).join(" ")}`);
		const executed = await pi.execute("call-1", { language: "bash", code: "stdout:after-pull" });
		expect(executed.isError).toBe(false);
		expect(text(executed)).toContain("after-pull");
		await pi.shutdown();

		// 3. Build sandbox image locally (and --sandbox-image C pulls C rather than REGISTRY_IMAGE)
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_MISSING: "1" });
		const builder = loadExtension({}, { selectChoice: BUILD_IMAGE_OPTION });
		await builder.startSession();
		await builder.runCommand("sandbox");
		await until(() => builder.tools.length === 1);
		const builderCalls = await state.calls();
		expect(builderCalls.some((call) => call[0] === "image" && call[1] === "pull")).toBe(false);
		const buildCall = builderCalls.find((call) => call[0] === "build");
		expect(buildCall?.slice(0, 5)).toEqual(["build", "--arch", "arm64", "--tag", DEFAULT_IMAGE]);
		expect(previewNotice.split("\n")[1]).toBe(`container ${(buildCall ?? []).join(" ")}`);
		await builder.shutdown();

		// 4. Custom --sandbox-image C downloads C when Download is selected
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_MISSING: "1" });
		const customTag = "registry.example/custom-sandbox:1.0";
		const custom = loadExtension({ "sandbox-image": customTag }, { selectChoice: DOWNLOAD_IMAGE_OPTION });
		await custom.startSession();
		await custom.runCommand("sandbox");
		await until(() => custom.tools.length === 1);
		expect(await state.calls()).toContainEqual(["image", "pull", "--arch", "arm64", customTag]);
		expect((await state.calls()).some((call) => call.includes(REGISTRY_IMAGE ?? ""))).toBe(false);
		await custom.shutdown();
	});

	it("manages a running background setup via /sandbox: Cancel setup, Keep running, and Disable sandbox", async () => {
		const holderPids = async (): Promise<number[]> => {
			const raw = await readFile(join(state.directory, "holders.jsonl"), "utf8").catch(() => "");
			return raw
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => Number(JSON.parse(line)));
		};
		const setupLockDir = () => join(process.env.POLAR_CODING_AGENT_DIR!, "sandbox-setup.lock");

		// 1. Cancel setup
		await setKnobs({ IMAGE_MISSING: "1", PULL_HANG: "1", PULL_SPAWN_HOLDER: "1" });
		const cancelSession = loadExtension();
		await cancelSession.startSession();
		cancelSession.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await cancelSession.runCommand("sandbox");
		await until(async () => (await holderPids()).length === 1);
		const [holderPid] = await holderPids();
		expect(await exists(setupLockDir())).toBe(true);

		cancelSession.setSelectChoice("Cancel setup");
		await cancelSession.runCommand("sandbox");
		expect(cancelSession.selects.at(-1)?.[1]).toEqual(["Cancel setup", "Keep running", "Disable sandbox"]);
		await until(() => !processExists(holderPid));
		expect(await exists(setupLockDir())).toBe(false);
		expect(cancelSession.tools).toEqual([]);
		expect(cancelSession.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		await cancelSession.shutdown();

		// 2. Keep running
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_MISSING: "1" });
		const keepSession = loadExtension();
		await keepSession.startSession();
		keepSession.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await keepSession.runCommand("sandbox");
		keepSession.setSelectChoice("Keep running");
		await keepSession.runCommand("sandbox");
		expect(keepSession.selects.at(-1)?.[1]).toEqual(["Cancel setup", "Keep running", "Disable sandbox"]);
		await until(() => keepSession.tools.length === 1);
		expect(keepSession.notices).toContainEqual(["sandbox: ready", "info"]);
		expect(keepSession.footer.get("sandbox")).toBeUndefined();
		await keepSession.shutdown();

		// 3. Disable sandbox during setup
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_MISSING: "1", PULL_HANG: "1", PULL_SPAWN_HOLDER: "1" });
		const disableSession = loadExtension();
		await disableSession.startSession();
		disableSession.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await disableSession.runCommand("sandbox");
		await until(async () => (await holderPids()).length === 1);
		const [disableHolderPid] = await holderPids();

		disableSession.setSelectChoice("Disable sandbox");
		await disableSession.runCommand("sandbox");
		await until(() => !processExists(disableHolderPid));
		expect(await exists(setupLockDir())).toBe(false);
		expect(disableSession.tools).toEqual([]);
		expect(disableSession.footer.get("sandbox")).toBeUndefined();
		const prefs = JSON.parse(await readFile(join(process.env.POLAR_CODING_AGENT_DIR!, "sandbox.json"), "utf8"));
		expect(prefs.disabled).toBe(true);
		await disableSession.shutdown();
	});

	it("shows driver details, isolation boundary, image, and version when sandbox is ready", async () => {
		// 1. Apple: client version and mismatched client/server versions
		await setKnobs({ CLIENT_VERSION: "1.7.1", SERVER_VERSION: "1.7.1" });
		const apple = loadExtension({}, { selectChoice: "Cancel" });
		await apple.startSession();
		await apple.runCommand("sandbox");
		const [appleTitle, appleItems] = apple.selects.at(-1) ?? ["", []];
		expect(appleTitle).toContain("Driver: apple-container");
		expect(appleTitle).toContain("Boundary: apple-container (microVM)");
		expect(appleTitle).toContain(`Image: ${REGISTRY_IMAGE}`);
		expect(appleTitle).toContain("Version: 1.7.1");
		expect(appleItems).toEqual(["Disable sandbox", "Cancel"]);

		// Mismatched client and server versions
		await setKnobs({ CLIENT_VERSION: "1.7.1", SERVER_VERSION: "1.6.0" });
		apple.setSelectChoice("Cancel");
		await apple.runCommand("sandbox");
		expect(apple.selects.at(-1)?.[0]).toContain("Version: 1.7.1 (service 1.6.0)");
		await apple.shutdown();

		// 2. OCI: Podman and Docker versions, no auto-start toggle
		const podmanWrapper = join(bin, "podman");
		await writeFile(
			podmanWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=podman\nexport FAKE_OCI_PODMAN_VERSION=5.4.0\nexport FAKE_OCI_STATE=${shellWord(state.directory)}\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(podmanWrapper, 0o755);
		const ociPodman = loadExtension(
			{ "sandbox-driver": "oci", "sandbox-oci-engine": "podman" },
			{ selectChoice: "Cancel" },
		);
		await ociPodman.startSession();
		await ociPodman.runCommand("sandbox");
		const [podmanTitle, podmanItems] = ociPodman.selects.at(-1) ?? ["", []];
		expect(podmanTitle).toContain("Driver: oci");
		expect(podmanTitle).toContain("Boundary: oci (podman/crun, shared kernel)");
		expect(podmanTitle).toContain("Version: 5.4.0");
		expect(podmanItems).toEqual(["Disable sandbox", "Cancel"]);
		await ociPodman.shutdown();

		const dockerWrapper = join(bin, "docker");
		await writeFile(
			dockerWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=docker\nexport FAKE_OCI_STATE=${shellWord(state.directory)}\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(dockerWrapper, 0o755);
		const ociDocker = loadExtension(
			{ "sandbox-driver": "oci", "sandbox-oci-engine": "docker" },
			{ selectChoice: "Cancel" },
		);
		await ociDocker.startSession();
		await ociDocker.runCommand("sandbox");
		const [dockerTitle, dockerItems] = ociDocker.selects.at(-1) ?? ["", []];
		expect(dockerTitle).toContain("Boundary: oci (docker/runc, shared kernel)");
		expect(dockerTitle).toContain("Version: 28.5.2");
		expect(dockerItems).toEqual(["Disable sandbox", "Cancel"]);
		await ociDocker.shutdown();

		// 3. k8s: no version line and no auto-start toggle
		const k8sState = await fakeState();
		try {
			const saDir = await fakeServiceAccountDir(root);
			const k8sCtx = fakeContext({ sessionId: "k8s-session", selectChoice: "Cancel" });
			const k8sController = new SandboxController(
				() => fakeK8sHost(k8sState, saDir),
				() => {},
			);
			await k8sController.start(k8sCtx.ctx);
			await runSandboxCommand(k8sController, k8sCtx.ctx);
			const [k8sTitle, k8sItems] = k8sCtx.selects.at(-1) ?? ["", []];
			expect(k8sTitle).toContain("Driver: k8s");
			expect(k8sTitle).toContain("Boundary: k8s (gvisor)");
			expect(k8sTitle).not.toContain("Version:");
			expect(k8sItems).toEqual(["Disable sandbox", "Cancel"]);
			await k8sController.shutdown("quit", k8sCtx.ctx);
		} finally {
			await rm(k8sState.directory, { recursive: true, force: true });
		}
	});

	it("recovers an active session when the host stops being ready without setting footer status and keeps OCI engine pinned", async () => {
		const pi = loadExtension();
		await pi.startSession();
		expect(pi.tools.map((t) => t.name)).toEqual(["run_code"]);
		expect(pi.footer.get("sandbox")).toBeUndefined();

		// Host loses image while session is active; failed recovery warns without setting footer status
		await setKnobs({ IMAGE_MISSING: "1", PULL_FAIL: "1" });
		pi.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await pi.runCommand("sandbox");
		expect(pi.selects.at(-1)?.[0]).toContain(`image ${DEFAULT_IMAGE} is not installed`);
		expect(pi.footer.get("sandbox")).toBeUndefined();
		await until(() => pi.notices.some(([msg, level]) => level === "warning" && msg.includes("pull")));
		expect(pi.footer.get("sandbox")).toBeUndefined();

		// Successful recovery in active session notifies ready and next run_code succeeds
		await setKnobs({ IMAGE_MISSING: "1" });
		pi.setSelectChoice(DOWNLOAD_IMAGE_OPTION);
		await pi.runCommand("sandbox");
		await until(() => pi.notices.some(([msg, level]) => level === "info" && msg === "sandbox: ready"));
		expect(pi.footer.get("sandbox")).toBeUndefined();
		const res = await pi.execute("call-1", { language: "bash", code: "stdout:recovered-ok" });
		expect(res.isError).toBe(false);
		expect(text(res)).toContain("recovered-ok");
		await pi.shutdown();

		// OCI: when podman info fails after activation, OciDriver stays pinned to podman
		const podmanState = await fakeState();
		const dockerState = await fakeState();
		try {
			const writeOci = async (name: string, engineState: FakeState, extra = "") => {
				const target = join(bin, name);
				await writeFile(
					target,
					`#!/bin/sh\nexport FAKE_OCI_ENGINE=${name}\nexport FAKE_OCI_STATE=${shellWord(engineState.directory)}\n${extra}exec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
				);
				await chmod(target, 0o755);
			};
			await writeOci("podman", podmanState);
			await writeOci("docker", dockerState);
			const oci = loadExtension(
				{ "sandbox-driver": "oci", "sandbox-oci-engine": "auto" },
				{ selectChoice: "Cancel" },
			);
			await oci.startSession();
			expect(oci.notices).toEqual([["sandbox: oci (podman/crun, shared kernel)", "info"]]);

			// Make podman info fail and run /sandbox
			await writeOci("podman", podmanState, "export FAKE_OCI_PODMAN_FAIL=1\n");
			await oci.runCommand("sandbox");
			expect(oci.selects.at(-1)?.[0]).toContain("podman info failed");
			expect(oci.footer.get("sandbox")).toBeUndefined();

			// Restore podman; next run_code still runs in podman, never docker
			await writeOci("podman", podmanState);
			const runRes = await oci.execute("call-1", { language: "bash", code: "stdout:still-podman" });
			expect(runRes.isError).toBe(false);
			expect(text(runRes)).toContain("still-podman");
			expect(await dockerState.calls()).toEqual([]);
			await oci.shutdown();
		} finally {
			await rm(podmanState.directory, { recursive: true, force: true });
			await rm(dockerState.directory, { recursive: true, force: true });
		}

		// Image in an active session:
		// (a) Session started with IMAGE_PRESENT: DEFAULT_IMAGE (host.image = polar-sandbox:0.2),
		// then both images become available (diagnosis.image = REGISTRY_IMAGE) -> /sandbox ready screen still shows host.image.
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_PRESENT: DEFAULT_IMAGE });
		const activeLocal = loadExtension({}, { selectChoice: "Cancel" });
		await activeLocal.startSession();
		await setKnobs({});
		await activeLocal.runCommand("sandbox");
		expect(activeLocal.selects.at(-1)?.[0]).toContain(`Image: ${DEFAULT_IMAGE}`);
		await activeLocal.shutdown();

		// (b) Session active on REGISTRY_IMAGE, image disappears, user selects Build:
		// after sandbox: ready, runtime.image updates to DEFAULT_IMAGE so run receives polar-sandbox:0.2 and ready screen shows it.
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({});
		const activeBuilt = loadExtension();
		await activeBuilt.startSession();
		await setKnobs({ IMAGE_MISSING: "1" });
		activeBuilt.setSelectChoice(BUILD_IMAGE_OPTION);
		await activeBuilt.runCommand("sandbox");
		await until(() => activeBuilt.notices.some(([msg, level]) => level === "info" && msg === "sandbox: ready"));
		const builtRun = await activeBuilt.execute("call-1", { language: "bash", code: "echo_argv" });
		expect(builtRun.isError).toBe(false);
		expect(text(builtRun)).toContain(DEFAULT_IMAGE);
		expect(text(builtRun)).not.toContain(REGISTRY_IMAGE ?? "");
		activeBuilt.setSelectChoice("Cancel");
		await activeBuilt.runCommand("sandbox");
		expect(activeBuilt.selects.at(-1)?.[0]).toContain(`Image: ${DEFAULT_IMAGE}`);
		await activeBuilt.shutdown();
	});

	it("disables and re-enables sandbox immediately in a live session and skips probes on start when disabled", async () => {
		const prefsPath = () => join(process.env.POLAR_CODING_AGENT_DIR!, "sandbox.json");

		// 1. Disable -> Enable in the same live session (with a running hot VM)
		const active = loadExtension();
		await active.startSession();
		const firstRun = await active.execute("call-1", { language: "bash", code: "stdout:warm" });
		expect(firstRun.isError).toBe(false);
		expect((await state.containers()).length).toBe(1);
		expect(await exists(lockPath())).toBe(true);

		active.setSelectChoice("Disable sandbox");
		await active.runCommand("sandbox");
		expect(active.tools).toEqual([]);
		expect(active.toolRegistry.get("run_code")?.exposure).toBe("hidden");
		expect(await state.containers()).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
		expect(active.footer.get("sandbox")).toBeUndefined();
		expect(JSON.parse(await readFile(prefsPath(), "utf8")).disabled).toBe(true);

		// Re-enable in the very same session
		active.setSelectChoices(["Enable sandbox", "Cancel"]);
		await active.runCommand("sandbox");
		expect(JSON.parse(await readFile(prefsPath(), "utf8")).disabled).toBe(false);
		expect(active.tools.map((t) => t.name)).toEqual(["run_code"]);
		const sameSessionRun = await active.execute("call-2", {
			language: "bash",
			code: "stdout:reenabled-in-same-session",
		});
		expect(sameSessionRun.isError).toBe(false);
		expect(text(sameSessionRun)).toContain("reenabled-in-same-session");

		// Disable again when sandbox.json write fails (sandbox.json is a directory):
		// still hides run_code, destroys VM, releases session lock, and warns the operator.
		await rm(prefsPath(), { recursive: true, force: true });
		await mkdir(prefsPath(), { recursive: true });
		active.setSelectChoice("Disable sandbox");
		await active.runCommand("sandbox");
		expect(active.tools).toEqual([]);
		expect(active.toolRegistry.get("run_code")?.exposure).toBe("hidden");
		expect(await state.containers()).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
		expect(active.notices.some(([, level]) => level === "warning")).toBe(true);
		await rm(prefsPath(), { recursive: true, force: true });

		// Write disabled: true cleanly for the next subtest
		await writeFile(prefsPath(), JSON.stringify({ disabled: true }));
		await active.shutdown();

		// 2. New session when disabled: CLI is not called, no status or warnings; /sandbox offers Enable sandbox
		await rm(join(state.directory, "calls.jsonl"), { force: true });
		const disabledSession = loadExtension();
		await disabledSession.startSession();
		expect(await state.calls()).toEqual([]);
		expect(disabledSession.tools).toEqual([]);
		expect(disabledSession.notices).toEqual([]);
		expect(disabledSession.footer.get("sandbox")).toBeUndefined();

		disabledSession.setSelectChoice("Cancel");
		await disabledSession.runCommand("sandbox");
		expect(disabledSession.selects.at(-1)?.[1]).toEqual(["Enable sandbox", "Cancel"]);
		expect(await state.calls()).toEqual([]);
		expect(disabledSession.tools).toEqual([]);

		disabledSession.setSelectChoice("Enable sandbox");
		await disabledSession.runCommand("sandbox");
		expect(JSON.parse(await readFile(prefsPath(), "utf8")).disabled).toBe(false);
		expect(disabledSession.tools.map((t) => t.name)).toEqual(["run_code"]);
		const afterEnable = await disabledSession.execute("call-1", { language: "bash", code: "stdout:enabled-again" });
		expect(afterEnable.isError).toBe(false);
		expect(text(afterEnable)).toContain("enabled-again");
		await disabledSession.shutdown();

		// 3. Disable when sandbox is off
		await setKnobs({ SERVICE_STOPPED: "1" });
		const offSession = loadExtension({}, { selectChoice: "Disable sandbox" });
		await offSession.startSession();
		expect(offSession.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		await offSession.runCommand("sandbox");
		expect(offSession.footer.get("sandbox")).toBeUndefined();
		expect(JSON.parse(await readFile(prefsPath(), "utf8")).disabled).toBe(true);
		await offSession.shutdown();
	});

	it("shows activation failure reason and Disable sandbox when an OCI host is ready but activation fails", async () => {
		const podmanWrapper = join(bin, "podman");
		await writeFile(
			podmanWrapper,
			`#!/bin/sh\nexport FAKE_OCI_ENGINE=podman\nexport FAKE_OCI_LIST_GARBAGE=1\nexport FAKE_OCI_STATE=${shellWord(state.directory)}\nexec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
		);
		await chmod(podmanWrapper, 0o755);
		const pi = loadExtension({ "sandbox-driver": "oci", "sandbox-oci-engine": "podman" }, { selectChoice: "Cancel" });
		await pi.startSession();
		expect(pi.tools).toEqual([]);
		expect(pi.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		expect(pi.notices).toEqual([
			["sandbox is off: runtime state could not be established: unreadable listing", "warning"],
		]);
		expect(await exists(lockPath())).toBe(false);

		await pi.runCommand("sandbox");
		const [title, items] = pi.selects.at(-1) ?? ["", []];
		expect(title).toContain("runtime state could not be established: unreadable listing");
		expect(items).toEqual(["Disable sandbox", "Cancel"]);
		expect(await exists(lockPath())).toBe(false);
		await pi.shutdown();
	});

	it("serializes setup with the machine lock and cancels the task if the lock is lost", async () => {
		const holderPids = async (): Promise<number[]> => {
			const raw = await readFile(join(state.directory, "holders.jsonl"), "utf8").catch(() => "");
			return raw
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => Number(JSON.parse(line)));
		};
		const setupLockDir = () => join(process.env.POLAR_CODING_AGENT_DIR!, "sandbox-setup.lock");

		await setKnobs({ IMAGE_MISSING: "1", PULL_HANG: "1", PULL_SPAWN_HOLDER: "1" });
		const first = loadExtension({}, { sessionId: randomUUID(), selectChoice: DOWNLOAD_IMAGE_OPTION });
		const second = loadExtension({}, { sessionId: randomUUID(), selectChoice: DOWNLOAD_IMAGE_OPTION });
		await first.startSession();
		await second.startSession();

		await first.runCommand("sandbox");
		await until(async () => (await holderPids()).length === 1);
		const [holderPid] = await holderPids();

		// Second session gets busy notice and starts no second pull
		await second.runCommand("sandbox");
		expect(second.notices.at(-1)).toEqual(["sandbox: setup is already running in another session", "warning"]);
		expect((await state.calls()).filter((call) => call[0] === "image" && call[1] === "pull").length).toBe(1);

		// Compromising the lock cancels the first session's task without crashing Polar
		await rm(setupLockDir(), { recursive: true, force: true });
		await until(() => !processExists(holderPid), 5000);
		await until(() => first.notices.some(([msg, level]) => level === "warning" && msg.includes("lock")), 5000);
		expect(first.tools).toEqual([]);
		expect(first.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		await first.shutdown();
		await second.shutdown();
	});

	it("waits for background download or deferred activation on session_shutdown and makes no post-shutdown calls", async () => {
		const holderPids = async (): Promise<number[]> => {
			const raw = await readFile(join(state.directory, "holders.jsonl"), "utf8").catch(() => "");
			return raw
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => Number(JSON.parse(line)));
		};
		const setupLockDir = () => join(process.env.POLAR_CODING_AGENT_DIR!, "sandbox-setup.lock");

		// 1. Cancellation before first step: reload shutdown during re-probe under machine lock
		await setKnobs({ IMAGE_MISSING: "1" });
		const beforeStep = loadExtension();
		await beforeStep.startSession();
		beforeStep.setOnSelect(async () => {
			await setKnobs({ IMAGE_MISSING: "1", STATUS_DELAY_MS: "200", PULL_HANG: "1" });
			return DOWNLOAD_IMAGE_OPTION;
		});
		const commandDuringReprobe = beforeStep.runCommand("sandbox");
		await until(async () => (await state.calls()).filter((c) => c[0] === "system" && c[1] === "status").length === 3);
		const reprobeShutdownStart = performance.now();
		await beforeStep.shutdown("reload");
		const reprobeShutdownElapsed = performance.now() - reprobeShutdownStart;
		beforeStep.invalidate();
		await commandDuringReprobe;
		expect(reprobeShutdownElapsed).toBeLessThan(2000);
		expect((await state.calls()).some((c) => c[0] === "image" && c[1] === "pull")).toBe(false);
		expect(await exists(setupLockDir())).toBe(false);
		expect(beforeStep.tools).toEqual([]);

		// 2. Shutdown with reload during image download (and invalidated context after shutdown returns)
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ IMAGE_MISSING: "1", PULL_HANG: "1", PULL_SPAWN_HOLDER: "1" });
		const duringPull = loadExtension({}, { selectChoice: DOWNLOAD_IMAGE_OPTION });
		await duringPull.startSession();
		await duringPull.runCommand("sandbox");
		await until(async () => (await holderPids()).length === 1);
		const [holderPid] = await holderPids();
		expect(await exists(setupLockDir())).toBe(true);

		await duringPull.shutdown("reload");
		duringPull.invalidate();
		expect(processExists(holderPid)).toBe(false);
		expect(await exists(setupLockDir())).toBe(false);
		expect(duringPull.widgets.at(-1)).toEqual(["sandbox-image", "removed"]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(duringPull.tools).toEqual([]);

		// 3. Shutdown with reload during activation after setup task finishes (invalidated context after shutdown)
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		const postSetupLeftover = `polar-sandbox-${SESSION_ID}-1-cccccccc`;
		await state.addContainer(postSetupLeftover, { "polar-session": SESSION_ID, "polar-root": root });
		await setKnobs({ IMAGE_MISSING: "1", DELETE_DELAY_MS: "600" });
		const duringPostSetupActivation = loadExtension({}, { selectChoice: DOWNLOAD_IMAGE_OPTION });
		await duringPostSetupActivation.startSession();
		await duringPostSetupActivation.runCommand("sandbox");
		await until(async () => (await state.calls()).some((call) => call[0] === "delete"));

		await duringPostSetupActivation.shutdown("reload");
		duringPostSetupActivation.invalidate();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(duringPostSetupActivation.tools).toEqual([]);
		expect(await exists(lockPath())).toBe(false);

		// 4. Shutdown during deferred activation from /sandbox (and duplicate /sandbox during activation)
		await rm(state.directory, { recursive: true, force: true });
		state = await fakeState();
		process.env.FAKE_CONTAINER_STATE = state.directory;
		await setKnobs({ SERVICE_STOPPED: "1" });
		const deferred = loadExtension();
		await deferred.startSession();
		expect(deferred.tools).toEqual([]);

		const leftoverName = `polar-sandbox-${SESSION_ID}-1-bbbbbbbb`;
		await state.addContainer(leftoverName, { "polar-session": SESSION_ID, "polar-root": root });
		await setKnobs({ DELETE_DELAY_MS: "700" });

		const activatingCommand = deferred.runCommand("sandbox");
		await until(async () => (await state.calls()).some((call) => call[0] === "delete"));

		// Calling /sandbox again while activating reports starting and does not trigger a second activation
		await deferred.runCommand("sandbox");
		expect(deferred.notices).toContainEqual(["sandbox: starting...", "info"]);

		await deferred.shutdown("reload");
		deferred.invalidate();
		await activatingCommand;
		expect(deferred.tools).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
		expect((await state.calls()).filter((call) => call[0] === "delete").length).toBe(1);
	});

	it("re-probes under the machine lock so a changed diagnosis shows a new screen or uses the new OCI engine", async () => {
		// 1. Diagnosis changed so selected action is no longer offered -> shows new screen without pulling
		await setKnobs({ IMAGE_MISSING: "1" });
		const changed = loadExtension();
		await changed.startSession();
		let selectCalls = 0;
		changed.setOnSelect(async (_title, _items) => {
			selectCalls += 1;
			if (selectCalls === 1) {
				await setKnobs({ SERVICE_STOPPED: "1" });
				return DOWNLOAD_IMAGE_OPTION;
			}
			return "Cancel";
		});
		await changed.runCommand("sandbox");
		expect(selectCalls).toBe(2);
		expect(changed.selects[1]?.[0]).toContain("Apple container service is not running");
		expect((await state.calls()).some((call) => call[0] === "image" && call[1] === "pull")).toBe(false);
		await changed.shutdown();

		// 2. OCI engine changed between menu and lock acquisition -> pulls through the new engine
		const podmanState = await fakeState();
		const dockerState = await fakeState();
		try {
			const writeOci = async (name: string, engineState: FakeState, extra = "") => {
				const target = join(bin, name);
				await writeFile(
					target,
					`#!/bin/sh\nexport FAKE_OCI_ENGINE=${name}\nexport FAKE_OCI_IMAGE_MISSING=1\nexport FAKE_OCI_STATE=${shellWord(engineState.directory)}\n${extra}exec "${process.execPath}" "${FAKE_OCI}" "$@"\n`,
				);
				await chmod(target, 0o755);
			};
			await writeOci("podman", podmanState);
			await writeOci("docker", dockerState);
			const oci = loadExtension({ "sandbox-driver": "oci", "sandbox-oci-engine": "auto" });
			await oci.startSession();
			oci.setOnSelect(async () => {
				await writeOci("podman", podmanState, "export FAKE_OCI_PODMAN_FAIL=1\n");
				return DOWNLOAD_IMAGE_OPTION;
			});
			await oci.runCommand("sandbox");
			await until(() => oci.tools.length === 1);
			expect((await podmanState.calls()).some((call) => call[0] === "image" && call[1] === "pull")).toBe(false);
			expect(await dockerState.calls()).toContainEqual(["image", "pull", REGISTRY_IMAGE]);
			await oci.shutdown();
		} finally {
			await rm(podmanState.directory, { recursive: true, force: true });
			await rm(dockerState.directory, { recursive: true, force: true });
		}
	});

	it("stops the setup chain without looping when an action completes without advancing the diagnosis", async () => {
		await setKnobs({ IMAGE_MISSING: "1", PULL_NO_RECORD: "1" });
		const pi = loadExtension({}, { selectChoice: DOWNLOAD_IMAGE_OPTION });
		await pi.startSession();
		await pi.runCommand("sandbox");

		await until(() =>
			pi.notices.some(([msg, level]) => level === "warning" && msg.includes(`pulled ${REGISTRY_IMAGE}`)),
		);
		const pullCalls = (await state.calls()).filter((call) => call[0] === "image" && call[1] === "pull");
		expect(pullCalls.length).toBe(1);
		expect(pi.tools).toEqual([]);
		expect(pi.footer.get("sandbox")).toBe("sandbox: off, run /sandbox");
		await pi.shutdown();
	});
});
