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
import execExtension, { DEFAULT_IMAGE } from "../index.ts";
import { FAKE_CONTAINER, type FakeState, fakeState, until } from "./fixtures.ts";

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
const RULE = 'exec: a session file over the 16 MiB read limit is processed with "exec" tool from /data/<file>.';
const ENV_KEYS = ["PATH", "POLAR_ARTIFACTS_DIR", "FAKE_CONTAINER_STATE"];

let root: string;
let bin: string;
let state: FakeState;
let savedEnv: [string, string | undefined][] = [];
let shutdowns: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
	savedEnv = ENV_KEYS.map((key) => [key, process.env[key]]);
	fault.failReplyOnce = false;
	root = await mkdtemp(join(tmpdir(), "exec-extension-"));
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

function fakeContext() {
	const notices: [string, string | undefined][] = [];
	const footer = new Map<string, string | undefined>();
	const context = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setStatus: (key: string, text: string | undefined) => footer.set(key, text),
		},
		sessionManager: { getSessionId: () => SESSION_ID },
		shutdown: () => {},
	};
	return { ctx: context as unknown as ExtensionContext, notices, footer };
}

function loadExtension(flagValues: Record<string, string> = {}) {
	const { ctx, notices, footer } = fakeContext();
	const tools: ToolDefinition<TObject>[] = [];
	const flagDefaults = new Map<string, string | undefined>();
	const handlers = new Map<string, EventHandler>();
	const methods: Record<string, Method> = {
		registerFlag(name: string, options: { default?: string }) {
			flagDefaults.set(name, options.default);
		},
		getFlag(name: string) {
			return flagValues[name] ?? flagDefaults.get(name);
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
	execExtension(pi as unknown as ExtensionAPI);
	const fire = async (eventName: string, event: object) => handlers.get(eventName)?.(event, ctx);
	const extension = {
		ctx,
		tools,
		notices,
		footer,
		flagDefaults,
		startSession: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: (reason: ShutdownReason = "quit") => fire("session_shutdown", { type: "session_shutdown", reason }),
		execute: (callId: string, params: Record<string, unknown>) => {
			const [tool] = tools;
			if (tool === undefined) throw new Error("exec is not registered");
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

async function runCalls(): Promise<string[][]> {
	return (await state.calls()).filter((call) => call[0] === "run" && call.includes("--interactive"));
}

function text(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

describe("exec extension", () => {
	it("offers exec only from a clean state", async () => {
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
				`sandbox is off: leftovers of sandbox stayed; polar-exec-${SESSION_ID}-1-aaaaaaaa (delete: Error: runtime temporarily unavailable; still listed) could not be deleted; delete them with: container delete --force polar-exec-${SESSION_ID}-1-aaaaaaaa`,
			],
		];
		await state.addContainer(`polar-exec-${SESSION_ID}-1-aaaaaaaa`, labels);
		for (const [refusal, knobs, message] of refusals) {
			await setKnobs(knobs);
			const off = loadExtension();
			await off.startSession();
			expect(off.tools, refusal).toEqual([]);
			expect(off.notices, refusal).toEqual([[message, "warning"]]);
			expect(off.footer.get("exec"), refusal).toBeUndefined();
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
		expect(foreign.footer.get("exec")).toBeUndefined();
		expect(await state.containers()).toEqual([]);
		await foreign.shutdown();
		expect(await exists(lockPath())).toBe(false);
		await rm(join(state.directory, "volumes"), { recursive: true, force: true });

		const ready = loadExtension();
		await ready.startSession();
		expect(ready.tools.map((tool) => tool.name)).toEqual(["exec"]);
		expect(ready.tools[0].executionMode).toBe("sequential");
		expect(ready.footer.get("exec")).toBeUndefined();
		expect(ready.notices).toEqual([]);
		expect(await state.volumes()).toEqual([{ name: `polar-work-${SESSION_ID}`, labels, size: "4096M" }]);
		expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
	});

	it("describes the tool from the operator limits and the image flag", async () => {
		const image = "registry.example/polar-exec@sha256:abc";
		const pi = loadExtension({ "exec-image": image });
		await pi.startSession();
		const [tool] = pi.tools;

		expect(pi.flagDefaults.get("exec-image")).toBe(DEFAULT_IMAGE);
		expect(pi.footer.get("exec")).toBeUndefined();
		expect(await state.calls()).toContainEqual(["image", "inspect", image]);
		expect(tool.description).toContain(" Session output files are available read-only at /data/<file>. ");
		for (const phrase of [
			"/data",
			"/work",
			"No network",
			"stdin is empty",
			"duckdb",
			"ripgrep",
			"16 MiB",
			"2 GiB",
			"4 GiB",
			"5 min",
			"256 processes",
			"2000 lines",
			"50 KiB",
			'"read" tool',
			"[stderr] and [/stderr]",
			"over 1 MiB of stderr",
		]) {
			expect(tool.description).toContain(phrase);
		}
		expect(tool.promptSnippet).toBe("run python or bash over the session files in an isolated VM");
		expect(tool.promptGuidelines).toEqual([RULE]);
		for (const item of [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]) {
			expect(item).not.toContain("list_files");
			expect(item).not.toContain("k8s_");
		}
		expect(Object.keys(tool.parameters.properties)).toEqual(["language", "code"]);
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
		expect(await runCalls()).toEqual([]);
		await pi.shutdown();
		expect(await exists(lockPath())).toBe(false);
	});

	it("tells the operator about a leftover container and keeps the program result", async () => {
		const pi = loadExtension();
		await pi.startSession();
		await setKnobs({ DELETE_FAIL: "1" });

		const result = await pi.execute("call-1", { language: "bash", code: "stdout:done" });

		const [run] = await runCalls();
		const name = run[run.indexOf("--name") + 1];
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
					text: "[exec runtime_failed] bash: echo hi\n\nexec is shutting down; no program starts.\n\nThe container runtime failed to run the code. Tell the user.",
				},
			],
			details: undefined,
			isError: true,
		});
		expect(await runCalls()).toEqual([]);
		expect(await exists(lockPath())).toBe(false);
	});

	it("reports at shutdown and releases the handle after the last call", async () => {
		const pi = loadExtension();
		await pi.startSession();
		await setKnobs({ RUN_IGNORES_KILL: "1", DELETE_FAIL: "1" });
		const call = pi.execute("call-1", { language: "bash", code: "hang" });
		await until(async () => (await runCalls()).length === 1);
		const [run] = await runCalls();
		const name = run[run.indexOf("--name") + 1];

		const shutdown = pi.shutdown("reload");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await exists(lockPath())).toBe(true);

		const result = await call;
		expect(text(result)).toMatch(/^\[exec cancelled\] bash: hang\n/);
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
		expect(files.filter((name) => name.startsWith("exec-"))).toEqual([]);
		expect(await state.containers()).toEqual([]);
		await pi.shutdown();
		expect(await exists(lockPath())).toBe(false);
	});
});
