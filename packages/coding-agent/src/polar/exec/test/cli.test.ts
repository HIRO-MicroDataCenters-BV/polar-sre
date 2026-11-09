import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import {
	cleanupContainer,
	cleanupOwned,
	commandFailure,
	containerCommand,
	deadlineAfter,
	parseContainers,
	parseVolumes,
} from "../src/cli.ts";
import { type FakeState, fakeRuntime, fakeState } from "./fixtures.ts";

let root: string;
let handle: SessionHandle;
let state: FakeState;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "exec-cli-"));
	handle = await acquireSession("current", root, root);
	state = await fakeState();
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
	await rm(state.directory, { recursive: true, force: true });
});

describe("cli", () => {
	it("runs a CLI command with the timeout and keeps captured stderr when it times out", async () => {
		const runtime = fakeRuntime(state, handle);
		const inspected = await containerCommand(runtime, ["image", "inspect", "polar-exec:test"]);
		expect(inspected).toEqual({
			code: 0,
			stdout: '[{"id":"polar-exec:test"}]\n',
			stderr: "",
			timedOut: false,
		});
		expect(runtime.children.size).toBe(0);

		const hanging = fakeRuntime(state, handle, { DELETE_HANG: "1" }, { commandTimeoutMs: 250 });
		const outcome = await containerCommand(hanging, ["delete", "--force", "polar-exec-current-1-deadbeef"]);
		expect(outcome).toMatchObject({ code: null, timedOut: true });
		expect(hanging.children.size).toBe(0);

		const timedOut = (stderr: string) => commandFailure({ code: null, stdout: "", stderr, timedOut: true });
		expect(timedOut("")).toBe("timed out");
		expect(timedOut("Error: original runtime failure\n")).toBe("timed out; stderr: Error: original runtime failure");
		expect(timedOut("x".repeat(5000))).toBe(`timed out; stderr: ${"x".repeat(4096)} [904 more bytes not shown]`);
	});

	it("parses list, inspect, and volume JSON and does not take a failed or unreadable listing as an empty one", async () => {
		const labels = { "polar-session": "current", "polar-root": root };
		await state.addContainer("polar-exec-current-1-aaaaaaaa", labels);
		await state.addVolume("polar-work-current", labels);
		const runtime = fakeRuntime(state, handle);

		const listed = await containerCommand(runtime, ["list", "--all", "--format", "json"]);
		expect(parseContainers(listed.stdout)).toEqual([{ name: "polar-exec-current-1-aaaaaaaa", labels }]);
		const inspected = await containerCommand(runtime, ["inspect", "polar-exec-current-1-aaaaaaaa"]);
		expect(parseContainers(inspected.stdout)).toEqual([{ name: "polar-exec-current-1-aaaaaaaa", labels }]);
		const volumes = await containerCommand(runtime, ["volume", "list", "--format", "json"]);
		expect(parseVolumes(volumes.stdout)).toEqual([{ name: "polar-work-current", labels }]);

		const forms: [string, string, string][] = [
			["LIST_FAIL", "1", "Error: list failed"],
			["LIST_GARBAGE", "1", "unreadable"],
			["LIST_JSON", "[{}]", "unreadable"],
			["LIST_JSON", "[null]", "unreadable"],
			["LIST_JSON", "{}", "unreadable"],
		];
		for (const [knob, value, said] of forms) {
			const form = `${knob}=${value}`;
			const broken = fakeRuntime(state, handle, { DELETE_GHOST: "1", [knob]: value });
			const outcome = await cleanupContainer(broken, "polar-exec-current-9-deadbeef", deadlineAfter(broken));
			expect(outcome, form).toEqual({
				removed: false,
				error: {
					container: "polar-exec-current-9-deadbeef",
					message: `delete: Error: delete reported an error after the container went; list: ${said}`,
				},
			});
			expect(broken.owned, form).toEqual(new Set(["polar-exec-current-9-deadbeef"]));
		}
	});

	it("releases a name on delete or confirmed absence and keeps ownership and the runtime's message otherwise", async () => {
		const runtime = fakeRuntime(state, handle);
		await state.addContainer("polar-exec-current-1-aaaaaaaa", { "polar-session": "current", "polar-root": root });
		expect(await cleanupContainer(runtime, "polar-exec-current-1-aaaaaaaa", deadlineAfter(runtime))).toEqual({
			removed: true,
		});
		expect(runtime.owned.size).toBe(0);
		expect(await state.containers()).toEqual([]);

		await state.addContainer("polar-exec-current-2-bbbbbbbb", { "polar-session": "current", "polar-root": root });
		const ghost = fakeRuntime(state, handle, { DELETE_GHOST: "1" });
		expect(await cleanupContainer(ghost, "polar-exec-current-2-bbbbbbbb", deadlineAfter(ghost))).toEqual({
			removed: true,
		});
		expect(ghost.owned.size).toBe(0);
		expect((await state.calls()).slice(-2).map((call) => call[0])).toEqual(["delete", "list"]);

		const name = "polar-exec-current-3-cccccccc";
		await state.addContainer(name, { "polar-session": "current", "polar-root": root });
		const said = "runtime temporarily unavailable\ndetail: the daemon is restarting";
		const spoke = fakeRuntime(state, handle, { DELETE_FAIL: "1", DELETE_FAIL_MESSAGE: said });
		expect(await cleanupContainer(spoke, name, deadlineAfter(spoke))).toEqual({
			removed: false,
			error: { container: name, message: `delete: Error: ${said}; still listed` },
		});
		expect(spoke.owned.has(name)).toBe(true);

		const long = fakeRuntime(state, handle, { DELETE_FAIL: "1", DELETE_FAIL_MESSAGE: "x".repeat(5000) });
		const kept = "x".repeat(4096 - "Error: ".length);
		expect(await cleanupContainer(long, name, deadlineAfter(long))).toEqual({
			removed: false,
			error: { container: name, message: `delete: Error: ${kept} [911 more bytes not shown]; still listed` },
		});
		expect(long.owned.has(name)).toBe(true);

		const lines = fakeRuntime(state, handle, { DELETE_FAIL: "1", DELETE_FAIL_MESSAGE: "x\n".repeat(2200) });
		const whole = `Error: ${"x\n".repeat(2200)}`.trim();
		const first = ["Error: x", ...Array(63).fill("x")].join("\n");
		const omitted = Buffer.byteLength(whole) - Buffer.byteLength(first);
		expect(await cleanupContainer(lines, name, deadlineAfter(lines))).toEqual({
			removed: false,
			error: { container: name, message: `delete: ${first} [${omitted} more bytes not shown]; still listed` },
		});
		expect(await cleanupOwned(lines, deadlineAfter(lines))).toEqual([
			{ container: name, message: `delete: ${first} [${omitted} more bytes not shown]; still listed` },
		]);
		expect(lines.owned.has(name)).toBe(true);
	});

	it("gives up within the shared deadline when the delete hangs", async () => {
		const name = "polar-exec-current-9-deadbeef";
		const expired = fakeRuntime(state, handle);
		expect(await cleanupContainer(expired, name, Date.now() - 1)).toEqual({
			removed: false,
			error: { container: name, message: "no time left" },
		});
		expect(expired.owned.has(name)).toBe(true);

		const hanging = fakeRuntime(state, handle, { DELETE_HANG: "1" }, { commandTimeoutMs: 500 });
		const started = performance.now();
		const outcome = await cleanupContainer(hanging, name, deadlineAfter(hanging));

		expect(outcome).toEqual({
			removed: false,
			error: { container: name, message: "delete: timed out; no time left to list" },
		});
		expect(performance.now() - started).toBeLessThan(3000);
		expect(hanging.owned.has(name)).toBe(true);
	});
});
