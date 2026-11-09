import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Static, Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../../core/extensions/types.ts";
import type { StreamResult } from "../process.ts";
import type { ProducerCall, ToolReply } from "../reply.ts";
import type { ProducerLimits, ProducerRuntime } from "../runtime.ts";
import { acquireSession, type SessionPaths } from "../session.ts";
import { openOutputFile } from "../store.ts";
import { type BuildReply, createProducerTool, type RunProducer, type ToolDeps, type ToolSpec } from "../tool.ts";

const testParameters = Type.Object(
	{
		resource: Type.String(),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

type TestParams = Static<typeof testParameters>;

interface TestRequest {
	operation: "get";
	target: string;
}

const VALIDATION_ERROR = 'Invalid parameter "resource": "bad" is rejected by the test spec.';

const testRequest: TestRequest = {
	operation: "get",
	target: "pods",
};

const testCall: ProducerCall<TestRequest> = {
	request: testRequest,
	tool: "test_tool",
	commandLabel: "test-cli get pods",
	options: { maxLines: 10, maxBytes: 1024, selection: "tail", keepHeader: true },
	timeoutMs: 30000,
};

const buildCalls: [TestParams, ProducerLimits][] = [];

const testSpec: ToolSpec<typeof testParameters, TestRequest> = {
	name: "test_tool",
	label: "test tool",
	description: "A test tool.",
	promptSnippet: "a test tool",
	promptGuidelines: ["test_tool: narrow by name when known."],
	parameters: testParameters,
	validate: (params) =>
		params.resource === "bad" || params.resource.includes("\0") || params.name?.includes("\0")
			? VALIDATION_ERROR
			: undefined,
	buildCall: (...args) => {
		buildCalls.push(args);
		return testCall;
	},
};

const streamResult: StreamResult = { status: "ok", exitCode: 0, stderr: Buffer.alloc(0), elapsedMs: 5 };

const testSession: SessionPaths = {
	sessionId: "current",
	cwd: "/work",
	outputDirectory: "/tmp/polar-artifacts/current",
};

function testRuntime(): ProducerRuntime<ProducerLimits> {
	return {
		limits: {
			timeoutMs: 30000,
			fileMaxBytes: 1048576,
			sessionMaxBytes: 4194304,
			stderrMaxBytes: 65536,
			killGraceMs: 2000,
			replyMaxLines: 200,
			replyMaxBytes: 16384,
		},
		activeProcessGroups: new Set(),
		handle: { paths: testSession, release: vi.fn(async () => {}) },
		state: "open",
		inFlight: new Set(),
	};
}

function recordingDeps(outcome: StreamResult, reply: ToolReply) {
	const runs: Parameters<RunProducer<TestRequest>>[] = [];
	const replyBuilds: Parameters<BuildReply>[] = [];
	const deps: ToolDeps<TestRequest> = {
		run: async (...args) => {
			runs.push(args);
			return outcome;
		},
		buildReply: async (...args) => {
			replyBuilds.push(args);
			return reply;
		},
	};
	return { deps, runs, replyBuilds };
}

function createRecordedTool(
	runtime: ProducerRuntime<ProducerLimits>,
	reply: ToolReply = { text: "pods\n", isError: false },
) {
	const { deps, runs, replyBuilds } = recordingDeps(streamResult, reply);
	buildCalls.length = 0;
	return { tool: createProducerTool(testSpec, runtime, deps), runs, replyBuilds };
}

function execute(tool: ReturnType<typeof createProducerTool>, toolCallId = "call-1", signal?: AbortSignal) {
	return tool.execute(toolCallId, { resource: "pods" }, signal, undefined, {} as ExtensionToolContext);
}

async function runTool(params: TestParams, reply?: ToolReply, signal?: AbortSignal) {
	const runtime = testRuntime();
	const { tool, runs, replyBuilds } = createRecordedTool(runtime, reply);
	const result = await tool.execute("call-1", params, signal, undefined, {} as ExtensionToolContext);
	return { runtime, result, runs, replyBuilds };
}

function startCalls(...toolCallIds: string[]) {
	const runtime = testRuntime();
	const runs: PromiseWithResolvers<StreamResult>[] = [];
	const inFlightAtReply: string[][] = [];
	const deps: ToolDeps<TestRequest> = {
		run: () => {
			const run = Promise.withResolvers<StreamResult>();
			runs.push(run);
			return run.promise;
		},
		buildReply: async () => {
			inFlightAtReply.push([...runtime.inFlight]);
			return { text: "pods\n", isError: false };
		},
	};
	const tool = createProducerTool(testSpec, runtime, deps);
	const calls = toolCallIds.map((toolCallId) => execute(tool, toolCallId));
	return { runtime, release: vi.mocked(runtime.handle.release), runs, inFlightAtReply, calls };
}

function errorResult(text: string) {
	return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const podsResult = { content: [{ type: "text", text: "pods\n" }], details: undefined, isError: false };

describe("createProducerTool", () => {
	it("defines the tool from the spec", () => {
		const { tool } = createRecordedTool(testRuntime());
		expect(tool.name).toBe(testSpec.name);
		expect(tool.label).toBe(testSpec.label);
		expect(tool.description).toBe(testSpec.description);
		expect(tool.promptSnippet).toBe(testSpec.promptSnippet);
		expect(tool.promptGuidelines).toEqual(testSpec.promptGuidelines);
		expect(tool.parameters).toBe(testSpec.parameters);
		expect(tool.annotations).toEqual({ readOnlyHint: true });
	});

	it("rejects NUL characters", async () => {
		for (const [field, params] of [
			["resource", { resource: "po\0ds" }],
			["name", { resource: "pods", name: "web\0-0" }],
		] as const) {
			const { runtime, result, runs, replyBuilds } = await runTool(params);
			expect(result).toEqual(errorResult(`Invalid parameter "${field}": NUL characters are not allowed.`));
			expect(runs).toEqual([]);
			expect(replyBuilds).toEqual([]);
			expect(runtime.inFlight.size).toBe(0);
		}
	});

	it("stops at a validation error", async () => {
		const { runtime, result, runs, replyBuilds } = await runTool({ resource: "bad" });
		expect(result).toEqual(errorResult(VALIDATION_ERROR));
		expect(runs).toEqual([]);
		expect(replyBuilds).toEqual([]);
		expect(runtime.inFlight.size).toBe(0);
	});

	it("runs the call and returns the reply", async () => {
		const signal = new AbortController().signal;
		for (const reply of [
			{ text: "pods\n", isError: false },
			{ text: "[test_tool failed: exit 1] test-cli get pods", isError: true },
		]) {
			const { runtime, result, runs, replyBuilds } = await runTool({ resource: "pods" }, reply, signal);
			expect(buildCalls).toEqual([[{ resource: "pods" }, runtime.limits]]);
			expect(buildCalls[0][1]).toBe(runtime.limits);
			expect(runs).toHaveLength(1);
			expect(runs[0][0]).toBe(testCall);
			expect(runs[0][1]).toBe(runtime.handle.paths);
			expect(runs[0][2]).toBe(signal);
			expect(replyBuilds).toHaveLength(1);
			expect(replyBuilds[0][0]).toBe(streamResult);
			expect(replyBuilds[0][1]).toBe(testCall);
			expect(replyBuilds[0][2]).toBe(runtime.limits);
			expect(replyBuilds[0][3]).toBe(runtime.handle.paths);
			expect(result).toEqual({
				content: [{ type: "text", text: reply.text }],
				details: undefined,
				isError: reply.isError,
			});
			expect(runtime.inFlight.size).toBe(0);
			expect(runtime.state).toBe("open");
			expect(runtime.handle.release).not.toHaveBeenCalled();
		}
	});

	it("refuses a call after closing", async () => {
		for (const state of ["closing", "closed"] as const) {
			const runtime = testRuntime();
			runtime.state = state;
			const { tool, runs, replyBuilds } = createRecordedTool(runtime);
			expect(await execute(tool)).toEqual(errorResult("The session is shutting down."));
			expect(runs).toEqual([]);
			expect(replyBuilds).toEqual([]);
			expect(runtime.inFlight.size).toBe(0);
		}
	});

	it("holds a ticket for the whole call and releases the handle after the last one", async () => {
		const one = startCalls("call-1");
		expect([...one.runtime.inFlight]).toEqual(["call-1"]);
		one.runtime.state = "closing";
		one.runs[0].resolve(streamResult);
		expect(await one.calls[0]).toEqual(podsResult);
		expect(one.inFlightAtReply).toEqual([["call-1"]]);
		expect(one.runtime.inFlight.size).toBe(0);
		expect(one.release).toHaveBeenCalledOnce();
		expect(one.runtime.state).toBe("closed");

		const two = startCalls("call-1", "call-2");
		two.runtime.state = "closing";
		two.runs[0].resolve(streamResult);
		expect(await two.calls[0]).toEqual(podsResult);
		expect([...two.runtime.inFlight]).toEqual(["call-2"]);
		expect(two.release).not.toHaveBeenCalled();
		expect(two.runtime.state).toBe("closing");
		two.runs[1].resolve(streamResult);
		expect(await two.calls[1]).toEqual(podsResult);
		expect(two.release).toHaveBeenCalledOnce();
		expect(two.runtime.state).toBe("closed");

		const together = startCalls("call-1", "call-2");
		together.runtime.state = "closing";
		for (const run of together.runs) run.resolve(streamResult);
		expect(await Promise.all(together.calls)).toEqual([podsResult, podsResult]);
		expect(together.release).toHaveBeenCalledOnce();
		expect(together.runtime.state).toBe("closed");
	});

	it("discards the .part file and releases the ticket when the reply throws", async () => {
		const root = await mkdtemp(join(tmpdir(), "shared-tool-"));
		const handle = await acquireSession("current", root, root);
		try {
			const runtime: ProducerRuntime<ProducerLimits> = { ...testRuntime(), handle };
			const replyFailure = new Error("the reply failed");
			const deps: ToolDeps<TestRequest> = {
				run: async (call, session) => {
					const opened = await openOutputFile(session, call.tool, runtime.limits);
					if (!("opened" in opened)) throw new Error("the session quota refused the test file");
					opened.opened.sink.end("NAME    READY   STATUS\n");
					return { ...streamResult, output: opened.opened };
				},
				buildReply: async () => {
					runtime.state = "closing";
					throw replyFailure;
				},
			};
			const tool = createProducerTool(testSpec, runtime, deps);

			await expect(execute(tool)).rejects.toBe(replyFailure);
			const names = await readdir(handle.paths.outputDirectory);
			expect(names.filter((name) => name.endsWith(".part"))).toEqual([]);
			expect(runtime.inFlight.size).toBe(0);
			expect(runtime.state).toBe("closed");
			expect(names).not.toContain("lock");
		} finally {
			await handle.release();
			await rm(root, { recursive: true, force: true });
		}
	});
});
