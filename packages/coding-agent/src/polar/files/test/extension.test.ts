import { mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { TObject } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	ToolDefinition,
	ToolLoadout,
} from "../../../core/extensions/types.ts";
import { sessionPaths } from "../../shared/session.ts";
import { finishOutputFile, openOutputFile, READ_MAX_BYTES } from "../../shared/store.ts";
import filesExtension, { describeRead, EMPTY_NOTICE } from "../index.ts";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown;

const SESSION_ID = "session-1";
const CWD = "/home/operator/project";
const LIMITS = { fileMaxBytes: 1024 * 1024, sessionMaxBytes: 4 * 1024 * 1024 };

let root: string;
let savedEnvironment: string | undefined;
let shutdowns: (() => unknown)[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "polar-files-test-"));
	savedEnvironment = process.env.POLAR_ARTIFACTS_DIR;
	process.env.POLAR_ARTIFACTS_DIR = root;
});

afterEach(async () => {
	for (const shutdown of shutdowns) await shutdown();
	shutdowns = [];
	if (savedEnvironment === undefined) delete process.env.POLAR_ARTIFACTS_DIR;
	else process.env.POLAR_ARTIFACTS_DIR = savedEnvironment;
	await rm(root, { recursive: true, force: true });
});

function loadExtension() {
	const tools: ToolDefinition<TObject>[] = [];
	const handlers = new Map<string, EventHandler>();
	const pi = {
		registerTool: (tool: ToolDefinition<TObject>) => {
			tools.push(tool);
		},
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
		},
	};
	filesExtension(pi as unknown as ExtensionAPI);
	const context = { cwd: CWD, sessionManager: { getSessionId: () => SESSION_ID } } as unknown as ExtensionContext;
	const fire = (event: string) => handlers.get(event)?.({ type: event }, context);
	const listFiles = async () => {
		const result = await tools[0].execute("call-1", {}, undefined as never, undefined as never, undefined as never);
		return { text: (result.content[0] as { text: string }).text, isError: result.isError };
	};
	const callTool = (toolName: string, input: Record<string, unknown>) =>
		handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "call-1", toolName, input }, context) as Promise<
			ToolCallEventResult | undefined
		>;
	shutdowns.push(() => fire("session_shutdown"));
	return { tools, fire, listFiles, callTool };
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function saveFile(tool: string, command: string, text: string): Promise<void> {
	const session = sessionPaths(SESSION_ID, CWD, root);
	const outcome = await openOutputFile(session, tool, LIMITS);
	if (!("opened" in outcome)) throw new Error("refused");
	await pipeline(Readable.from([Buffer.from(text)]), outcome.opened.sink);
	await finishOutputFile(outcome.opened, "complete", { tool, command });
}

function loadout(names: string[]): ToolLoadout {
	return { declared: names.map((name) => ({ name, description: `${name} does things.` })) } as unknown as ToolLoadout;
}

describe("files extension", () => {
	it("defines list_files", () => {
		const { tools } = loadExtension();
		expect(tools).toHaveLength(1);
		const [tool] = tools;
		expect(tool.name).toBe("list_files");
		expect(tool.label).toBe("list files");
		expect(tool.annotations).toEqual({ readOnlyHint: true });
		expect(tool.parameters.properties).toEqual({});
		expect((tool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
		expect(tool.promptSnippet).toBeDefined();
		expect(tool.description).toContain("complete or truncated");
		expect(tool.prepareLoadout).toBe(describeRead);
	});

	it("lists the saved files", async () => {
		const { fire, listFiles } = loadExtension();
		expect(await listFiles()).toEqual({ text: "The session has not started.", isError: true });

		await fire("session_start");
		expect(await listFiles()).toEqual({ text: EMPTY_NOTICE, isError: false });

		await saveFile("k8s_get", "kubectl get pods --namespace=shop", "NAME\n");
		await saveFile("k8s_logs", "kubectl logs web-0 | grep error", "x".repeat(2048));
		const { text, isError } = await listFiles();
		expect(isError).toBe(false);
		const [header, divider, ...rows] = text.split("\n");
		expect(header).toBe("| File | Command | Size | Status | Created |");
		expect(divider).toBe("|---|---|---|---|---|");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(/^\| k8s_get-1\.txt \| kubectl get pods --namespace=shop \| 5B \| complete \| \S+ \|$/);
		expect(rows[1]).toMatch(
			/^\| k8s_logs-2\.txt \| kubectl logs web-0 \\\| grep error \| 2\.0KB \| complete \| \S+ \|$/,
		);
	});

	it("acquires and releases the session", async () => {
		const { fire } = loadExtension();
		const lock = join(root, SESSION_ID, "lock");

		await fire("session_start");
		expect(await readFile(lock, "utf8")).toBe(`${process.pid}\n`);

		await fire("session_shutdown");
		expect(await exists(lock)).toBe(false);
		await fire("session_shutdown");
	});

	it("gates every read by path or by bare name", async () => {
		const { fire, callTool } = loadExtension();
		expect(await callTool("read", { path: "k8s_get-1.txt" })).toEqual({
			block: true,
			reason: "The session has not started.",
		});

		await fire("session_start");
		const outputDirectory = join(root, SESSION_ID);
		const savedFile = join(outputDirectory, "k8s_get-1.txt");
		await writeFile(savedFile, "NAME    READY   STATUS\n");

		const byPath = { path: savedFile, offset: 1, limit: 20 };
		expect(await callTool("read", byPath)).toBeUndefined();
		expect(byPath).toEqual({ path: await realpath(savedFile), offset: 1, limit: 20 });
		expect(await callTool("read", { path: "/etc/passwd" })).toEqual({
			block: true,
			reason: "read is limited to the session output directory",
		});
		const byName = { path: "k8s_get-1.txt" };
		expect(await callTool("read", byName)).toBeUndefined();
		expect(byName.path).toBe(await realpath(savedFile));

		const big = join(outputDirectory, "k8s_logs-2.txt");
		await writeFile(big, "");
		await truncate(big, READ_MAX_BYTES + 1);
		expect(await callTool("read", { path: "k8s_logs-2.txt" })).toEqual({
			block: true,
			reason: "File exceeds the 16 MiB read limit.",
		});

		const write = { path: "k8s_get-1.txt", content: "x" };
		expect(await callTool("write", write)).toBeUndefined();
		expect(write).toEqual({ path: "k8s_get-1.txt", content: "x" });
	});

	it("describes read with the limit", () => {
		const described = { descriptions: { read: "read does things. Reads files up to 16 MiB." } };
		expect(describeRead(loadout(["read", "list_files"]))).toEqual(described);
		expect(describeRead(loadout(["list_files"]))).toBeUndefined();
		for (const others of [["run_code"], ["k8s_get"], ["k8s_get", "run_code"]]) {
			expect(describeRead(loadout(["read", "list_files", ...others]))).toEqual(described);
		}
	});
});
