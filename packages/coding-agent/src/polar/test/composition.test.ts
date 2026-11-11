import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { chmod, mkdtemp, realpath, rm, truncate, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "path";
import type { TObject } from "typebox";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolCallEventResult,
	ToolDefinition,
	ToolLoadout,
} from "../../core/extensions/types.ts";
import filesExtension from "../files/index.ts";
import k8sExtension from "../k8s/index.ts";
import sandboxExtension from "../sandbox/index.ts";

type ExtensionName = "files" | "k8s" | "sandbox";
type EventHandler = (event: object, ctx: ExtensionContext) => unknown;
type Text = [origin: string, text: string];

const FACTORIES: Record<ExtensionName, (pi: ExtensionAPI) => void> = {
	files: filesExtension,
	k8s: k8sExtension,
	sandbox: sandboxExtension,
};

const FAKES = {
	container: fileURLToPath(new URL("../sandbox/test/fake-container.mjs", import.meta.url)),
	kubectl: fileURLToPath(new URL("../k8s/test/fake-kubectl.mjs", import.meta.url)),
};
const K8S_FLAGS = { "k8s-kubeconfig": "/tmp/kc", "k8s-context": "staging" };
const K8S_TOOLS = ["k8s_get", "k8s_events", "k8s_logs", "k8s_describe", "k8s_inspect"];
const TOOLS: Record<ExtensionName, string[]> = { files: ["list_files"], k8s: K8S_TOOLS, sandbox: ["run_code"] };
const READ_TOOL = { name: "read", description: "Read the contents of a file." };
const LARGE_FILE = "k8s_logs-9.txt";
const LARGE_FILE_BYTES = 17 * 1024 * 1024;
const SAVED_VARIABLES = [
	"PATH",
	"POLAR_ARTIFACTS_DIR",
	"POLAR_CODING_AGENT_DIR",
	"FAKE_CONTAINER_STATE",
	"FAKE_KUBECTL_STDOUT",
];
const POD_COUNT = 2500;
const PODS = Array.from({ length: POD_COUNT }, (_, index) => `web-${index + 1} 1/1 Running\n`).join("");
const RUN_CODE_LINE_COUNT = 3000;
const LONG_LINE_BYTES = 60_000;

interface LoadedExtension {
	name: ExtensionName;
	tools: ToolDefinition<TObject>[];
	handlers: Map<string, EventHandler[]>;
}

interface Session {
	id: string;
	extensions: LoadedExtension[];
	ctx: ExtensionContext;
	shutdown: ReturnType<typeof vi.fn>;
	notices: [string, string | undefined][];
	statuses: [string, string | undefined][];
	replies: [string, string][];
}

interface StartOptions {
	cwd?: string;
	sandboxOff?: boolean;
}

interface ToolTexts {
	description: string | undefined;
	promptSnippet: string | undefined;
	promptGuidelines: string[] | undefined;
	parameters: TObject;
}

let root: string;
let bin: string;
let temporaryDirectories: string[] = [];
let savedEnvironment: [string, string | undefined][] = [];
let sessions: Session[] = [];

beforeEach(async () => {
	savedEnvironment = SAVED_VARIABLES.map((name) => [name, process.env[name]]);
	root = await mkdtemp(join(tmpdir(), "composition-"));
	bin = await mkdtemp(join(tmpdir(), "composition-bin-"));
	const containerState = await mkdtemp(join(tmpdir(), "composition-container-"));
	temporaryDirectories = [root, bin, containerState];
	await installFake("container");
	await installFake("kubectl");
	process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
	process.env.FAKE_CONTAINER_STATE = containerState;
	process.env.POLAR_ARTIFACTS_DIR = root;
	process.env.POLAR_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
	for (const session of sessions) await shutDown(session);
	sessions = [];
	for (const [name, value] of savedEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

async function installFake(command: keyof typeof FAKES, knobs: Record<string, string> = {}): Promise<void> {
	const exports = Object.entries(knobs).map(
		([name, value]) => `export FAKE_${command.toUpperCase()}_${name}=${shellWord(value)}\n`,
	);
	const path = join(bin, command);
	await writeFile(path, `#!/bin/sh\n${exports.join("")}exec "${process.execPath}" "${FAKES[command]}" "$@"\n`);
	await chmod(path, 0o755);
}

function shellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function loadExtension(name: ExtensionName, flagValues: Record<string, string>): LoadedExtension {
	const tools: ToolDefinition<TObject>[] = [];
	const flagDefaults = new Map<string, unknown>();
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		registerTool: (tool: ToolDefinition<TObject>) => {
			tools.push(tool);
		},
		registerCommand: () => {},
		registerFlag: (flag: string, options: { default?: unknown }) => {
			flagDefaults.set(flag, options.default);
		},
		getFlag: (flag: string) => flagValues[flag] ?? flagDefaults.get(flag),
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	FACTORIES[name](pi as unknown as ExtensionAPI);
	return { name, tools, handlers };
}

async function emit(session: Session, extension: LoadedExtension, event: { type: string; reason: string }) {
	for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, session.ctx);
}

async function startSession(
	names: ExtensionName[],
	flagValues: Record<string, string> = K8S_FLAGS,
	{ cwd = process.cwd(), sandboxOff = false }: StartOptions = {},
) {
	const id = randomUUID();
	const notices: [string, string | undefined][] = [];
	const statuses: [string, string | undefined][] = [];
	const shutdown = vi.fn();
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => id },
		ui: {
			notify: (message: string, type?: string) => {
				notices.push([message, type]);
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push([key, text]);
			},
		},
		shutdown,
	} as unknown as ExtensionContext;
	const session: Session = { id, extensions: [], ctx, shutdown, notices, statuses, replies: [] };
	sessions.push(session);
	session.extensions = names.map((name) => loadExtension(name, flagValues));
	for (const extension of session.extensions) {
		await emit(session, extension, { type: "session_start", reason: "startup" });
	}
	if (names.includes("sandbox")) {
		const started = toolNames(session).includes("run_code");
		expect(started, `sandbox started: ${started}; notices: ${JSON.stringify(notices)}`).toBe(!sandboxOff);
	}
	return session;
}

async function shutDown(session: Session): Promise<void> {
	for (const extension of session.extensions) {
		await emit(session, extension, { type: "session_shutdown", reason: "quit" });
	}
}

function labelOf(session: Session): string {
	return session.extensions.map((extension) => extension.name).join(", ");
}

function lockOf(session: Session): string {
	return join(root, session.id, "lock");
}

function toolNames(session: Session): string[] {
	return session.extensions.flatMap((extension) => extension.tools.map((tool) => tool.name));
}

async function readDecision(session: Session, input: { path: string }): Promise<ToolCallEventResult | undefined> {
	const event = { type: "tool_call", toolCallId: "call-read", toolName: "read", input };
	let decision: ToolCallEventResult | undefined;
	for (const extension of session.extensions) {
		for (const handler of extension.handlers.get("tool_call") ?? []) {
			const result = (await handler(event, session.ctx)) as ToolCallEventResult | undefined;
			if (result === undefined) continue;
			decision = result;
			if (result.block) {
				if (result.reason !== undefined) session.replies.push(["read", result.reason]);
				return result;
			}
		}
	}
	return decision;
}

async function callTool(session: Session, name: string, params: Record<string, unknown>): Promise<string> {
	const tool = session.extensions.flatMap((extension) => extension.tools).find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} is not registered in ${labelOf(session)}`);
	const result = await tool.execute(`call-${name}`, params, undefined, undefined, session.ctx as ExtensionToolContext);
	const text = (result.content[0] as { text: string }).text;
	session.replies.push([name, text]);
	return text;
}

function savedFileOf(session: Session, reply: string): string {
	const label = labelOf(session);
	const named = /Saved as (.+?) \([\d.]+[KM]?B\)/.exec(reply)?.[1];
	if (named === undefined) throw new Error(`${label}: the reply names no saved file:\n${reply.slice(-500)}`);
	expect(isAbsolute(named), `${label}: ${named} is not a full path`).toBe(true);
	expect(dirname(named), label).toBe(join(root, session.id));
	expect(existsSync(named), `${label}: ${named} does not exist`).toBe(true);
	return named;
}

function modelDescriptions(session: Session): Map<string, string> {
	const tools = session.extensions.flatMap((extension) => extension.tools);
	const loadout = { declared: [READ_TOOL, ...tools] } as unknown as ToolLoadout;
	const descriptions = new Map([READ_TOOL, ...tools].map((tool) => [tool.name, tool.description]));
	for (const tool of tools) {
		for (const [name, description] of Object.entries(tool.prepareLoadout?.(loadout)?.descriptions ?? {})) {
			descriptions.set(name, description);
		}
	}
	return descriptions;
}

function toolTexts(session: Session, names: string[]): Record<string, ToolTexts> {
	const tools = session.extensions.flatMap((extension) => extension.tools);
	const descriptions = modelDescriptions(session);
	return Object.fromEntries(
		names.map((name) => {
			const tool = tools.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`${name} is not registered in ${labelOf(session)}`);
			const { promptSnippet, promptGuidelines, parameters } = tool;
			return [name, { description: descriptions.get(name), promptSnippet, promptGuidelines, parameters }];
		}),
	);
}

async function expectReadPolicy(session: Session): Promise<void> {
	const largeFile = join(root, session.id, LARGE_FILE);
	await writeFile(largeFile, "");
	await truncate(largeFile, LARGE_FILE_BYTES);
	expect(await readDecision(session, { path: LARGE_FILE }), labelOf(session)).toEqual({
		block: true,
		reason: "File exceeds the 16 MiB read limit.",
	});
	expect(await readDecision(session, { path: "/etc/passwd" }), labelOf(session)).toEqual({
		block: true,
		reason: "read is limited to the session output directory",
	});
}

function schemaDescriptions(schema: object): string[] {
	return Object.entries(schema).flatMap(([key, value]) => {
		if (key === "description" && typeof value === "string") return [value];
		return typeof value === "object" && value !== null ? schemaDescriptions(value) : [];
	});
}

function textsOf(session: Session): Text[] {
	const texts: Text[] = [["description of read", modelDescriptions(session).get("read") ?? ""]];
	for (const [name, tool] of Object.entries(toolTexts(session, toolNames(session)))) {
		texts.push([`name of ${name}`, name], [`description of ${name}`, tool.description ?? ""]);
		if (tool.promptSnippet !== undefined) texts.push([`snippet of ${name}`, tool.promptSnippet]);
		for (const rule of tool.promptGuidelines ?? []) texts.push([`rule of ${name}`, rule]);
		for (const text of schemaDescriptions(tool.parameters)) texts.push([`parameter description of ${name}`, text]);
	}
	for (const [tool, text] of session.replies) texts.push([`reply of ${tool}`, text]);
	for (const [message, type] of session.notices) texts.push([`${type ?? "info"} notice`, message]);
	for (const [key, text] of session.statuses) texts.push([`status ${key}`, text ?? ""]);
	return texts;
}

function occurrences(texts: Text[], names: string[]): string[] {
	const pattern = new RegExp(`\\b(?:${names.join("|")})\\b`, "g");
	return texts.flatMap(([origin, text]) =>
		[...text.matchAll(pattern)].map((match) => {
			const around = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
			return `${origin}: ${match[0]} in ${JSON.stringify(around)}`;
		}),
	);
}

async function filesAlone(): Promise<Session[]> {
	const files = await startSession(["files"]);
	await callTool(files, "list_files", {});
	const largeFile = join(root, files.id, "large-1.txt");
	await writeFile(largeFile, "");
	await truncate(largeFile, LARGE_FILE_BYTES);
	const outside = await readDecision(files, { path: "/etc/passwd" });
	const tooLarge = await readDecision(files, { path: "large-1.txt" });
	expect([outside?.block, tooLarge?.block]).toEqual([true, true]);
	expect(tooLarge?.reason).not.toBe(outside?.reason);
	await shutDown(files);
	await callTool(files, "list_files", {});
	await readDecision(files, { path: "large-1.txt" });
	return [files];
}

async function k8sAlone(): Promise<Session[]> {
	const k8s = await startSession(["k8s"]);
	const fitting = "NAME READY STATUS\nweb-1 1/1 Running\n";
	await installFake("kubectl", { STDOUT: fitting });
	expect(await callTool(k8s, "k8s_get", { resource: "pods" })).toBe(fitting);
	await installFake("kubectl", { STDOUT: PODS });
	const cutCalls: [string, Record<string, unknown>][] = [
		["k8s_get", { resource: "pods" }],
		["k8s_events", {}],
		["k8s_logs", { pod: "web-1" }],
		["k8s_describe", { resource: "pods", name: "web-1" }],
	];
	for (const [tool, params] of cutCalls) savedFileOf(k8s, await callTool(k8s, tool, params));
	await installFake("kubectl", { STDOUT_BYTES: String(LONG_LINE_BYTES) });
	savedFileOf(k8s, await callTool(k8s, "k8s_get", { resource: "pods", output: "json" }));
	await installFake("kubectl", { EXIT: "1", STDERR: 'Error from server (NotFound): pods "web-0" not found\n' });
	expect(await callTool(k8s, "k8s_get", { resource: "pods", name: "web-0" })).toMatch(/^\[k8s_get failed: exit 1\]/);
	await callTool(k8s, "k8s_get", { resource: "pods/web-1" });
	await shutDown(k8s);
	await callTool(k8s, "k8s_get", { resource: "pods" });
	const off = await startSession(["k8s"], {});
	await shutDown(off);
	return [k8s, off];
}

async function sandboxAlone(): Promise<Session[]> {
	const sandbox = await startSession(["sandbox"]);
	const run = (code: string) => callTool(sandbox, "run_code", { language: "bash", code });
	savedFileOf(sandbox, await run(`stdout_lines:${RUN_CODE_LINE_COUNT}`));
	savedFileOf(sandbox, await run(`stdout_bytes:${LONG_LINE_BYTES}`));
	for (const code of ["exit:0", "exit:3", "exit137", "oom"]) await run(code);
	await run(" ");
	await installFake("container", { RUN_FAILS: "1" });
	await run("stdout:never");
	await installFake("container", { INSPECT_MISSING: "1", DELETE_FAIL: "1", LIST_GARBAGE: "1" });
	await run("exit:3");
	await run("stdout:never");
	await shutDown(sandbox);
	await run("stdout:never");
	expect(sandbox.replies.map(([, reply]) => reply.split("\n", 1)[0])).toEqual([
		`[run_code ok] bash: stdout_lines:${RUN_CODE_LINE_COUNT}`,
		`[run_code ok] bash: stdout_bytes:${LONG_LINE_BYTES}`,
		"[run_code ok] bash: exit:0",
		"[run_code failed: exit 3] bash: exit:3",
		"[run_code failed: exit 137] bash: exit137",
		"[run_code out_of_memory] bash: oom",
		'Invalid parameter "code": the program is empty.',
		"[run_code runtime_failed] bash: stdout:never",
		"[run_code failed: exit 3] bash: exit:3",
		"[run_code runtime_failed] bash: stdout:never",
		"[run_code runtime_failed] bash: stdout:never",
	]);
	await installFake("container", { IMAGE_MISSING: "1" });
	const off = await startSession(["sandbox"], K8S_FLAGS, { sandboxOff: true });
	await shutDown(off);
	return [sandbox, off];
}

describe("extension composition", () => {
	it("the read policy is the same for every set and order", async () => {
		const sets: ExtensionName[][] = [["files"], ["files", "k8s"], ["files", "sandbox"], ["files", "k8s", "sandbox"]];
		const readDescriptions: [string, string | undefined][] = [];
		for (const set of sets) {
			for (const order of [set, [...set].reverse()]) {
				const session = await startSession(order);
				await expectReadPolicy(session);
				readDescriptions.push([labelOf(session), modelDescriptions(session).get("read")]);
				await shutDown(session);
				expect(existsSync(lockOf(session)), `${labelOf(session)}: the lock stays after shutdown`).toBe(false);
			}
		}
		const expected = `${READ_TOOL.description} Reads files up to 16 MiB.`;
		expect(readDescriptions).toEqual(readDescriptions.map(([label]) => [label, expected]));
	});

	it("an extension's texts do not change with another extension", async () => {
		const k8sWithoutSandbox = await startSession(["files", "k8s"]);
		const sandboxWithoutK8s = await startSession(["files", "sandbox"]);
		const all = await startSession(["files", "k8s", "sandbox"]);

		expect(toolTexts(all, K8S_TOOLS)).toEqual(toolTexts(k8sWithoutSandbox, K8S_TOOLS));
		expect(toolTexts(all, ["run_code"])).toEqual(toolTexts(sandboxWithoutK8s, ["run_code"]));
	});

	it("an extension's texts name no other extension", async () => {
		const texts: Record<ExtensionName, Text[]> = {
			files: (await filesAlone()).flatMap(textsOf),
			k8s: (await k8sAlone()).flatMap(textsOf),
			sandbox: (await sandboxAlone()).flatMap(textsOf),
		};
		for (const extension of Object.keys(TOOLS) as ExtensionName[]) {
			for (const name of TOOLS[extension]) {
				expect(occurrences(texts[extension], [name]), `${extension}: ${name}`).not.toEqual([]);
			}
			const others = Object.entries(TOOLS).flatMap(([other, names]) => (other === extension ? [] : names));
			const named = occurrences(texts[extension], others);
			expect(named, `${extension} names a tool of another extension:\n${named.join("\n")}`).toEqual([]);
		}
	});

	it("a k8s configuration error disables only k8s", async () => {
		const session = await startSession(["files", "k8s", "sandbox"], {});

		expect(session.shutdown).not.toHaveBeenCalled();
		expect(session.extensions.find((extension) => extension.name === "k8s")?.tools).toEqual([]);
		expect(toolNames(session)).toEqual(["list_files", "run_code"]);
		await expectReadPolicy(session);
		expect(session.notices).toContainEqual(["kubeconfig: no context selected, run /kubeconfig to select", "warning"]);
	});

	it("a standalone producer's reply names a path that read can open", async () => {
		process.env.FAKE_KUBECTL_STDOUT = PODS;

		const k8s = await startSession(["k8s"]);
		const k8sReply = await callTool(k8s, "k8s_get", { resource: "pods" });
		savedFileOf(k8s, k8sReply);
		expect(k8sReply).not.toMatch(/\blist_files\b/);
		expect(k8sReply).not.toMatch(/\brun_code\b/);

		const sandbox = await startSession(["sandbox"]);
		const sandboxReply = await callTool(sandbox, "run_code", {
			language: "bash",
			code: `stdout_lines:${RUN_CODE_LINE_COUNT}`,
		});
		savedFileOf(sandbox, sandboxReply);
		expect(sandboxReply).not.toMatch(/\bk8s_/);
		expect(sandboxReply).not.toMatch(/\blist_files\b/);

		const withFiles = await startSession(["files", "k8s"]);
		const path = savedFileOf(withFiles, await callTool(withFiles, "k8s_get", { resource: "pods" }));
		const input = { path };
		expect(await readDecision(withFiles, input)).toBeUndefined();
		expect(input.path).toBe(await realpath(path));
	});

	it("a relative root names files by an absolute path from any working directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "composition-cwd-"));
		temporaryDirectories.push(cwd);
		process.env.POLAR_ARTIFACTS_DIR = relative(process.cwd(), root);
		process.env.FAKE_KUBECTL_STDOUT = PODS;

		const k8s = await startSession(["k8s"], K8S_FLAGS, { cwd });
		const named = savedFileOf(k8s, await callTool(k8s, "k8s_get", { resource: "pods" }));
		expect(existsSync(resolve(cwd, named)), `${named} from ${cwd}`).toBe(true);

		const withFiles = await startSession(["files", "k8s"], K8S_FLAGS, { cwd });
		const path = savedFileOf(withFiles, await callTool(withFiles, "k8s_get", { resource: "pods" }));
		const input = { path };
		expect(await readDecision(withFiles, input)).toBeUndefined();
		expect(input.path).toBe(await realpath(path));
	});

	it("producers start without files", async () => {
		const k8s = await startSession(["k8s"]);
		const sandbox = await startSession(["sandbox"]);

		expect(toolNames(k8s)).toEqual(K8S_TOOLS);
		expect(toolNames(sandbox)).toEqual(["run_code"]);
		for (const session of [k8s, sandbox]) {
			const events = session.extensions.flatMap((extension) => [...extension.handlers.keys()]);
			expect(events, labelOf(session)).not.toContain("tool_call");
			await shutDown(session);
			expect(existsSync(lockOf(session)), labelOf(session)).toBe(false);
		}
	});
});
