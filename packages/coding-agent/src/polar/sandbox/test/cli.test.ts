import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { commandFailure, containerCommand, deadlineAfter, LineSplitter } from "../src/cli.ts";
import { cleanupContainer, inspectionOf, parseContainers, parseVolumes } from "../src/driver.ts";
import type { CommandOutcome } from "../src/types.ts";
import { cleanupOwned } from "../src/workspace.ts";
import { type FakeState, fakeRuntime, fakeState, processExists, until } from "./fixtures.ts";

let root: string;
let handle: SessionHandle;
let state: FakeState;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-cli-"));
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
		const inspected = await containerCommand(runtime, ["image", "inspect", "polar-sandbox:test"]);
		expect(inspected).toEqual({
			code: 0,
			stdout: '[{"id":"polar-sandbox:test"}]\n',
			stderr: "",
			timedOut: false,
		});
		expect(runtime.children.size).toBe(0);

		const hanging = fakeRuntime(state, handle, { DELETE_HANG: "1" }, { commandTimeoutMs: 250 });
		const outcome = await containerCommand(hanging, ["delete", "--force", "polar-sandbox-current-1-deadbeef"]);
		expect(outcome).toMatchObject({ code: null, timedOut: true });
		expect(hanging.children.size).toBe(0);

		const timedOut = (stderr: string) => commandFailure({ code: null, stdout: "", stderr, timedOut: true });
		expect(timedOut("")).toBe("timed out");
		expect(timedOut("Error: original runtime failure\n")).toBe("timed out; stderr: Error: original runtime failure");
		expect(timedOut("x".repeat(5000))).toBe(
			`timedOut; stderr: ${"x".repeat(4096)} [904 more bytes not shown]`.replace("timedOut", "timed out"),
		);
	});

	it("accepts CommandOptions and streams stdout/stderr lines via onLine", async () => {
		const runtime = fakeRuntime(state, handle);
		const lines: string[] = [];
		const pulled = await containerCommand(runtime, ["image", "pull", "registry.example/image"], {
			onLine: (line) => lines.push(line),
		});
		expect(pulled).toMatchObject({ code: 0, stdout: "pulled registry.example/image\n" });
		expect(lines).toEqual(["pulled registry.example/image"]);

		const failed = await containerCommand(fakeRuntime(state, handle, { PULL_FAIL: "1" }), ["image", "pull", "x"], {
			onLine: (line) => lines.push(line),
		});
		expect(failed).toMatchObject({ code: 1, stderr: "Error: pull x failed\n" });
		expect(lines.at(-1)).toBe("Error: pull x failed");

		const hanging = fakeRuntime(state, handle, { DELETE_HANG: "1" });
		const outcome = await containerCommand(hanging, ["delete", "--force", "polar-sandbox-current-1-deadbeef"], {
			timeoutMs: 250,
		});
		expect(outcome).toMatchObject({ code: null, timedOut: true });

		const cancelled = await containerCommand(runtime, ["system", "status"], { signal: AbortSignal.abort() });
		expect(cancelled).toEqual({ code: null, stdout: "", stderr: "cancelled", timedOut: false });
	});

	it("reports the error code of a command that could not start", async () => {
		const runtime = fakeRuntime(state, handle);
		const missing = await containerCommand(runtime, ["system", "status"], { command: "/nonexistent/bin/container" });
		expect(missing).toMatchObject({ code: null, timedOut: false, spawnError: "ENOENT" });
		expect(missing.stderr).toContain("ENOENT");
		expect(runtime.children.size).toBe(0);

		const started = await containerCommand(runtime, ["system", "status"]);
		expect(started.code).toBe(0);
		expect(started.spawnError).toBeUndefined();
	});

	it("returns from a cancelled command and stops its whole process group", async () => {
		const runtime = fakeRuntime(state, handle);
		const cancel = new AbortController();
		let helperPid = 0;
		let outcome: CommandOutcome | undefined;
		void containerCommand(runtime, ["-c", "sleep 30 & echo $!; wait"], {
			command: "sh",
			signal: cancel.signal,
			onLine: (line) => {
				helperPid = Number(line);
			},
		}).then((result) => {
			outcome = result;
		});
		await until(() => helperPid > 0);
		cancel.abort();
		await until(() => outcome !== undefined, 2000);
		expect(outcome).toMatchObject({ code: null, timedOut: false });
		await until(() => !processExists(helperPid), 2000);
		expect(runtime.children.size).toBe(0);
	});

	it("returns from a cancelled command after the kill grace when a process outside its group holds the output", async () => {
		const runtime = fakeRuntime(state, handle);
		const cancel = new AbortController();
		const holder = `setTimeout(() => {}, 30000)`;
		const script = [
			`const { spawn } = require("child_process");`,
			`const options = { detached: true, stdio: ["ignore", "inherit", "inherit"] };`,
			`console.log(spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], options).pid);`,
			holder,
		].join("\n");
		let holderPid = 0;
		let outcome: CommandOutcome | undefined;
		void containerCommand(runtime, ["-e", script], {
			command: process.execPath,
			signal: cancel.signal,
			onLine: (line) => {
				holderPid = Number(line);
			},
		}).then((result) => {
			outcome = result;
		});
		await until(() => holderPid > 0);
		try {
			const cancelledAt = performance.now();
			cancel.abort();
			await until(() => outcome !== undefined, 2000);
			expect(performance.now() - cancelledAt).toBeGreaterThanOrEqual(runtime.limits.killGraceMs - 20);
			expect(outcome).toMatchObject({ code: null, timedOut: false });
			expect(processExists(holderPid)).toBe(true);
			expect(runtime.children.size).toBe(0);
		} finally {
			if (processExists(holderPid)) process.kill(holderPid, "SIGKILL");
		}
	});

	it("returns the whole output of a command that ends normally, including what arrives after its exit", async () => {
		const runtime = fakeRuntime(state, handle);
		const bytes = 4 * 1024 * 1024;
		const printed = await containerCommand(
			runtime,
			["-c", `(sleep 0.2; head -c ${bytes} /dev/zero | tr "\\0" x) & echo first`],
			{ command: "sh" },
		);
		expect(printed.code).toBe(0);
		expect(printed.stdout.length).toBe("first\n".length + bytes);
		expect(printed.stdout.startsWith("first\nxxx")).toBe(true);
		expect(runtime.children.size).toBe(0);
	});

	it("splits stream output on CR and LF across arbitrary UTF-8 byte chunks", () => {
		const lines: string[] = [];
		const splitter = new LineSplitter((line) => lines.push(line));
		const bytes = Buffer.from("[1/2] Fetching 10%\r[1/2] Fetching 20%\r\n\ncafé 日本語\nlast");
		for (const byte of bytes) splitter.write(Buffer.from([byte]));
		expect(lines).toEqual(["[1/2] Fetching 10%", "[1/2] Fetching 20%", "café 日本語"]);
		splitter.end();
		expect(lines).toEqual(["[1/2] Fetching 10%", "[1/2] Fetching 20%", "café 日本語", "last"]);

		const mixed: string[] = [];
		const output = new LineSplitter((line) => mixed.push(`out:${line}`));
		const error = new LineSplitter((line) => mixed.push(`err:${line}`));
		output.write(Buffer.from("layer: Pull"));
		error.write(Buffer.from("[1/2] Fetching\n"));
		output.write(Buffer.from(" complete\n"));
		expect(mixed).toEqual(["err:[1/2] Fetching", "out:layer: Pull complete"]);
	});

	it("parses list, inspect, and volume JSON and does not take a failed or unreadable listing as an empty one", async () => {
		const labels = { "polar-session": "current", "polar-root": root };
		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", labels);
		await state.addVolume("polar-work-current", labels);
		const runtime = fakeRuntime(state, handle);

		const listed = await containerCommand(runtime, ["list", "--all", "--format", "json"]);
		expect(parseContainers(listed.stdout)).toEqual([
			{ name: "polar-sandbox-current-1-aaaaaaaa", labels, state: "stopped" },
		]);
		const inspected = await containerCommand(runtime, ["inspect", "polar-sandbox-current-1-aaaaaaaa"]);
		expect(parseContainers(inspected.stdout)).toEqual([
			{ name: "polar-sandbox-current-1-aaaaaaaa", labels, state: "stopped" },
		]);
		expect(inspectionOf(inspected, "polar-sandbox-current-1-aaaaaaaa")).toEqual({ state: "stopped" });
		expect(
			inspectionOf(
				{
					code: 0,
					stdout: JSON.stringify([
						{ configuration: { id: "polar-sandbox-current-1-aaaaaaaa", labels }, status: "running" },
					]),
					stderr: "",
					timedOut: false,
				},
				"polar-sandbox-current-1-aaaaaaaa",
			),
		).toEqual({ state: "present" });
		expect(
			inspectionOf(
				{
					code: 0,
					stdout: JSON.stringify([{ configuration: { id: "polar-sandbox-current-1-aaaaaaaa", labels } }]),
					stderr: "",
					timedOut: false,
				},
				"polar-sandbox-current-1-aaaaaaaa",
			),
		).toEqual({ state: "unknown", detail: "unreadable answer" });
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
			const outcome = await cleanupContainer(broken, "polar-sandbox-current-9-deadbeef", deadlineAfter(broken));
			expect(outcome, form).toEqual({
				removed: false,
				error: {
					container: "polar-sandbox-current-9-deadbeef",
					message: `delete: Error: delete reported an error after the container went; list: ${said}`,
				},
			});
			expect(broken.owned, form).toEqual(new Set(["polar-sandbox-current-9-deadbeef"]));
		}
	});

	it("releases a name on delete or confirmed absence and keeps ownership and the runtime's message otherwise", async () => {
		const runtime = fakeRuntime(state, handle);
		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", { "polar-session": "current", "polar-root": root });
		expect(await cleanupContainer(runtime, "polar-sandbox-current-1-aaaaaaaa", deadlineAfter(runtime))).toEqual({
			removed: true,
		});
		expect(runtime.owned.size).toBe(0);
		expect(await state.containers()).toEqual([]);

		await state.addContainer("polar-sandbox-current-2-bbbbbbbb", { "polar-session": "current", "polar-root": root });
		const ghost = fakeRuntime(state, handle, { DELETE_GHOST: "1" });
		expect(await cleanupContainer(ghost, "polar-sandbox-current-2-bbbbbbbb", deadlineAfter(ghost))).toEqual({
			removed: true,
		});
		expect(ghost.owned.size).toBe(0);
		expect((await state.calls()).slice(-2).map((call) => call[0])).toEqual(["delete", "list"]);

		const name = "polar-sandbox-current-3-cccccccc";
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
		const name = "polar-sandbox-current-9-deadbeef";
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
