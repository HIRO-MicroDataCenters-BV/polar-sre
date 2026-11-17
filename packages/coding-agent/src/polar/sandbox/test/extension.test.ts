import { randomUUID } from "crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { TObject } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "../../../core/extensions/types.ts";
import sandboxExtension, { DEFAULT_IMAGE, RUN_CODE_RULES } from "../index.ts";
import { BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION, DOWNLOAD_IMAGE_OPTION } from "../src/workspace.ts";
import { FAKE_CONTAINER, FAKE_OCI, type FakeState, fakeState, until } from "./fixtures.ts";

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

const SESSION_ID = randomUUID();
const ENV_KEYS = ["PATH", "POLAR_ARTIFACTS_DIR", "FAKE_CONTAINER_STATE"];

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

function fakeContext(options: { hasUI?: boolean; selectChoice?: string } = {}) {
	const notices: [string, string | undefined][] = [];
	const footer = new Map<string, string | undefined>();
	const selects: [string, string[]][] = [];
	const hasUI = options.hasUI ?? true;
	const context = {
		mode: hasUI ? "tui" : "print",
		hasUI,
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setStatus: (key: string, text: string | undefined) => footer.set(key, text),
			select: async (title: string, items: string[]) => {
				selects.push([title, items]);
				return options.selectChoice;
			},
		},
		sessionManager: { getSessionId: () => SESSION_ID },
		shutdown: () => {},
	};
	return { ctx: context as unknown as ExtensionContext, notices, footer, selects };
}

function loadExtension(
	flagValues: Record<string, string> = {},
	contextOptions: { hasUI?: boolean; selectChoice?: string } = {},
) {
	const flags: Record<string, string> = { "sandbox-driver": "apple-container", ...flagValues };
	const { ctx, notices, footer, selects } = fakeContext(contextOptions);
	const tools: ToolDefinition<TObject>[] = [];
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
			tools.push(tool);
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
	const extension = {
		ctx,
		tools,
		notices,
		footer,
		selects,
		flagDefaults,
		startSession: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: (reason: ShutdownReason = "quit") => fire("session_shutdown", { type: "session_shutdown", reason }),
		execute: (callId: string, params: Record<string, unknown>) => {
			const [tool] = tools;
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
			["readiness", { STATUS_EXIT: "1" }, "sandbox is off: container system status failed: exit 1"],
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
			expect(off.footer.get("sandbox"), refusal).toBeUndefined();
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
		expect(foreign.footer.get("sandbox")).toBeUndefined();
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

	it("turns off without menu when hasUI is false and prompts with ctx.ui.select when hasUI is true", async () => {
		await setKnobs({ IMAGE_MISSING: "1" });
		const headless = loadExtension({}, { hasUI: false });
		await headless.startSession();
		expect(headless.tools).toEqual([]);
		expect(headless.selects).toEqual([]);
		expect(headless.notices).toEqual([
			[
				`sandbox is off: image ${DEFAULT_IMAGE} is not installed (container image inspect ${DEFAULT_IMAGE} failed: Error: image ${DEFAULT_IMAGE} not found)`,
				"warning",
			],
		]);
		await headless.shutdown();

		const built = loadExtension({}, { hasUI: true, selectChoice: BUILD_IMAGE_OPTION });
		await built.startSession();
		expect(built.selects).toEqual([
			[`Sandbox image ${DEFAULT_IMAGE} is not installed`, [BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION]],
		]);
		expect(built.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		await built.shutdown();

		const registry = "registry.example/polar-sandbox@sha256:abc";
		const pulled = loadExtension(
			{ "sandbox-registry-image": registry },
			{ hasUI: true, selectChoice: DOWNLOAD_IMAGE_OPTION },
		);
		await pulled.startSession();
		expect(pulled.selects).toEqual([
			[
				`Sandbox image ${DEFAULT_IMAGE} is not installed`,
				[DOWNLOAD_IMAGE_OPTION, BUILD_IMAGE_OPTION, DISABLE_SANDBOX_OPTION],
			],
		]);
		expect(pulled.tools.map((tool) => tool.name)).toEqual(["run_code"]);
		await pulled.shutdown();
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
});
