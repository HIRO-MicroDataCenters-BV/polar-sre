import { execFile } from "child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildInspectCall,
	DF_SCRIPT,
	type InspectOperation,
	type InspectParams,
	inspectSpec,
	PROCESSES_SCRIPT,
	SOCKETS_SCRIPT,
} from "../src/tools/inspect.ts";
import { runtime } from "./fixtures.ts";

const REAL_GUEST = process.env.K8S_REAL_GUEST === "1";
const GUEST_IMAGES = ["debian:stable-slim", "alpine"] as const;

const namespaceText =
	'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';

const podText =
	'Invalid parameter "pod": give one pod name without spaces or slashes; pass flags as separate parameters and list the pods of a workload with k8s_get.';

const containerText =
	'Invalid parameter "container": give one container name without spaces or slashes; pass flags as separate parameters.';

describe("k8s_inspect", () => {
	it("describes the schema and rejects unknown or malformed parameters", () => {
		const properties = Object.entries<object>(inspectSpec.parameters.properties);
		expect(properties.map(([name]) => name)).toEqual([
			"pod",
			"namespace",
			"container",
			"operation",
			"path",
			"tailLines",
			"includeHidden",
			"root",
			"nameGlob",
			"type",
			"maxDepth",
			"oneFilesystem",
		]);
		expect(inspectSpec.name).toBe("k8s_inspect");
		expect(inspectSpec.label).toBe("k8s inspect");
		expect(
			inspectSpec.description.startsWith(
				"Fixed read-only operations inside a running container. No shell, no arbitrary commands.",
			),
		).toBe(true);
		expect(inspectSpec.promptSnippet).toBe(
			"Fixed read-only operations inside a running container (read, list, find, copyOut, df, du, processes, sockets)",
		);

		expect(
			Value.Check(inspectSpec.parameters, {
				pod: "web-0",
				namespace: "shop",
				container: "app",
				operation: "find",
				root: "/etc",
				nameGlob: "*.conf",
				type: "file",
				maxDepth: 2,
			}),
		).toBe(true);

		const errorPaths = (args: unknown) =>
			Value.Errors(inspectSpec.parameters, args).map((error) => error.instancePath);
		expect(errorPaths({ pod: "web-0", operation: "read", path: "/etc/hosts", command: "id" })).toContain("/command");
		expect(errorPaths({ pod: "web-0", operation: "shell" })).toEqual(["/operation"]);
		expect(errorPaths({ pod: "web-0", operation: "read", path: "/etc/hosts", tailLines: 0 })).toEqual(["/tailLines"]);
		expect(errorPaths({ pod: "web-0", operation: "find", root: "/etc", maxDepth: -1 })).toEqual(["/maxDepth"]);
		expect(errorPaths({ pod: "web-0", operation: "find", root: "/etc", type: "socket" })).toEqual(["/type"]);
	});

	it("validates common parameters: pod, namespace, and container", () => {
		for (const pod of ["pod/web-0", "deploy/web", "web-0 -c app", "web-0\n", "", "-c", "-dash-first", "--tty"]) {
			expect(inspectSpec.validate({ pod, operation: "processes" }), JSON.stringify(pod)).toBe(podText);
		}
		expect(inspectSpec.validate({ pod: "web-0", namespace: "Shop", operation: "processes" })).toBe(namespaceText);
		for (const container of ["app -i", "pod/app", "app\n", "-i", "--stdin"]) {
			expect(
				inspectSpec.validate({ pod: "web-0", container, operation: "processes" }),
				JSON.stringify(container),
			).toBe(containerText);
		}
		expect(
			inspectSpec.validate({ pod: "web-0", namespace: "", container: "", operation: "processes" }),
		).toBeUndefined();
	});

	it("requires absolute paths for path-based operations and rejects relative paths", () => {
		for (const operation of ["read", "list", "copyOut", "du"] as const) {
			const expected = `Invalid parameter "path": operation "${operation}" requires an absolute path starting with "/"; give a full container path such as /etc/hosts or /var/log.`;
			expect(inspectSpec.validate({ pod: "web-0", operation })).toBe(expected);
			expect(inspectSpec.validate({ pod: "web-0", operation, path: "" })).toBe(expected);
			expect(inspectSpec.validate({ pod: "web-0", operation, path: "etc/hosts" })).toBe(expected);
			expect(inspectSpec.validate({ pod: "web-0", operation, path: "./hosts" })).toBe(expected);
			expect(inspectSpec.validate({ pod: "web-0", operation, path: "/etc/hosts" })).toBeUndefined();
		}

		const expectedRoot =
			'Invalid parameter "root": operation "find" requires an absolute root path starting with "/"; give a full container directory path such as /etc or /var/log.';
		expect(inspectSpec.validate({ pod: "web-0", operation: "find" })).toBe(expectedRoot);
		expect(inspectSpec.validate({ pod: "web-0", operation: "find", root: "" })).toBe(expectedRoot);
		expect(inspectSpec.validate({ pod: "web-0", operation: "find", root: "var/log" })).toBe(expectedRoot);
		expect(inspectSpec.validate({ pod: "web-0", operation: "find", root: "/var/log" })).toBeUndefined();

		expect(inspectSpec.validate({ pod: "web-0", operation: "df" })).toBeUndefined();
		expect(inspectSpec.validate({ pod: "web-0", operation: "df", path: "" })).toBeUndefined();
		expect(inspectSpec.validate({ pod: "web-0", operation: "df", path: "/var" })).toBeUndefined();
		expect(inspectSpec.validate({ pod: "web-0", operation: "df", path: "var" })).toBe(
			'Invalid parameter "path": give an absolute path starting with "/"; give a full container path such as /var or omit path.',
		);
	});

	it("rejects parameters that do not belong to the chosen operation, naming both operation and field", () => {
		const cases: [InspectParams, InspectOperation, string][] = [
			[{ pod: "web-0", operation: "read", path: "/etc/hosts", includeHidden: true }, "read", "includeHidden"],
			[{ pod: "web-0", operation: "read", path: "/etc/hosts", root: "/etc" }, "read", "root"],
			[{ pod: "web-0", operation: "list", path: "/etc", tailLines: 10 }, "list", "tailLines"],
			[{ pod: "web-0", operation: "list", path: "/etc", maxDepth: 1 }, "list", "maxDepth"],
			[{ pod: "web-0", operation: "find", root: "/etc", path: "/etc" }, "find", "path"],
			[{ pod: "web-0", operation: "find", root: "/etc", oneFilesystem: true }, "find", "oneFilesystem"],
			[{ pod: "web-0", operation: "copyOut", path: "/etc/hosts", tailLines: 5 }, "copyOut", "tailLines"],
			[{ pod: "web-0", operation: "df", path: "/var", oneFilesystem: true }, "df", "oneFilesystem"],
			[{ pod: "web-0", operation: "du", path: "/var", includeHidden: false }, "du", "includeHidden"],
			[{ pod: "web-0", operation: "processes", path: "/proc" }, "processes", "path"],
			[{ pod: "web-0", operation: "processes", tailLines: 10 }, "processes", "tailLines"],
			[{ pod: "web-0", operation: "sockets", path: "/proc/net" }, "sockets", "path"],
			[{ pod: "web-0", operation: "sockets", nameGlob: "*.sock" }, "sockets", "nameGlob"],
		];

		for (const [params, operation, field] of cases) {
			const error = inspectSpec.validate(params);
			expect(error).toBe(
				`Invalid parameter "${field}": ${field} is not supported for operation "${operation}"; remove ${field} or use an operation that accepts it.`,
			);
		}

		// Empty optional strings count as not set and do not trigger foreign-field errors.
		expect(
			inspectSpec.validate({
				pod: "web-0",
				operation: "processes",
				path: "",
				root: "",
				nameGlob: "",
			}),
		).toBeUndefined();
	});

	it("builds calls for all 8 operations with expected argv, options, timeouts, and labels", () => {
		const readFull = buildInspectCall(
			{ pod: "web-0", namespace: "shop", container: "app", operation: "read", path: "/etc/hosts" },
			runtime.limits,
		);
		expect(readFull).toEqual({
			request: {
				operation: "exec",
				flags: [
					{ name: "--namespace", value: "shop" },
					{ name: "--container", value: "app" },
				],
				pod: "web-0",
				command: ["cat", "--", "/etc/hosts"],
			},
			tool: "k8s_inspect",
			commandLabel: "kubectl exec web-0 --namespace=shop --container=app -- read /etc/hosts",
			timeoutMs: runtime.limits.timeoutMs,
			options: {
				maxLines: runtime.limits.replyMaxLines,
				maxBytes: runtime.limits.replyMaxBytes,
				selection: "head",
				keepHeader: false,
				mode: "spillover",
			},
		});

		const readTail = buildInspectCall(
			{ pod: "web-0", operation: "read", path: "/var/log/app.log", tailLines: 50 },
			runtime.limits,
		);
		expect(readTail.request.command).toEqual(["tail", "-n", "50", "--", "/var/log/app.log"]);
		expect(readTail.options.selection).toBe("tail");
		expect(readTail.options.mode).toBe("spillover");
		expect(readTail.commandLabel).toBe("kubectl exec web-0 -- read /var/log/app.log tailLines=50");

		const listDefault = buildInspectCall({ pod: "web-0", operation: "list", path: "/var/log" }, runtime.limits);
		expect(listDefault.request.command).toEqual(["ls", "-l", "--", "/var/log"]);
		expect(listDefault.options).toMatchObject({ selection: "head", mode: "spillover", keepHeader: false });
		expect(listDefault.commandLabel).toBe("kubectl exec web-0 -- list /var/log");

		const listHidden = buildInspectCall(
			{ pod: "web-0", operation: "list", path: "/var/log", includeHidden: true },
			runtime.limits,
		);
		expect(listHidden.request.command).toEqual(["ls", "-la", "--", "/var/log"]);
		expect(listHidden.commandLabel).toBe("kubectl exec web-0 -- list /var/log includeHidden=true");

		const findBasic = buildInspectCall({ pod: "web-0", operation: "find", root: "/etc" }, runtime.limits);
		expect(findBasic.request.command).toEqual(["find", "/etc"]);
		expect(findBasic.commandLabel).toBe("kubectl exec web-0 -- find /etc");

		const findFiltered = buildInspectCall(
			{
				pod: "web-0",
				operation: "find",
				root: "/etc",
				maxDepth: 2,
				type: "file",
				nameGlob: "*.conf",
			},
			runtime.limits,
		);
		expect(findFiltered.request.command).toEqual(["find", "/etc", "-maxdepth", "2", "-type", "f", "-name", "*.conf"]);
		expect(findFiltered.commandLabel).toBe("kubectl exec web-0 -- find /etc nameGlob=*.conf type=file maxDepth=2");

		const findSymlink = buildInspectCall(
			{ pod: "web-0", operation: "find", root: "/etc", type: "symlink" },
			runtime.limits,
		);
		expect(findSymlink.request.command).toEqual(["find", "/etc", "-type", "l"]);

		const copyOut = buildInspectCall(
			{ pod: "web-0", namespace: "shop", operation: "copyOut", path: "/tmp/dump.bin" },
			runtime.limits,
		);
		expect(copyOut.request.command).toEqual(["cat", "--", "/tmp/dump.bin"]);
		expect(copyOut.timeoutMs).toBe(runtime.limits.logsTimeoutMs);
		expect(copyOut.options).toEqual({
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "head",
			keepHeader: false,
			mode: "artifact",
		});
		expect(copyOut.commandLabel).toBe("kubectl exec web-0 --namespace=shop -- copyOut /tmp/dump.bin");

		const dfAll = buildInspectCall({ pod: "web-0", operation: "df" }, runtime.limits);
		expect(dfAll.request.command).toEqual(["sh", "-c", DF_SCRIPT, "sh"]);
		expect(dfAll.commandLabel).toBe("kubectl exec web-0 -- df");

		const dfPath = buildInspectCall({ pod: "web-0", operation: "df", path: "/var" }, runtime.limits);
		expect(dfPath.request.command).toEqual(["sh", "-c", DF_SCRIPT, "sh", "/var"]);
		expect(dfPath.commandLabel).toBe("kubectl exec web-0 -- df /var");

		const duBasic = buildInspectCall({ pod: "web-0", operation: "du", path: "/var" }, runtime.limits);
		expect(duBasic.request.command).toEqual(["du", "-k", "--", "/var"]);
		expect(duBasic.commandLabel).toBe("kubectl exec web-0 -- du /var");

		const duBounded = buildInspectCall(
			{ pod: "web-0", operation: "du", path: "/var", maxDepth: 1, oneFilesystem: true },
			runtime.limits,
		);
		expect(duBounded.request.command).toEqual(["du", "-k", "-x", "-d", "1", "--", "/var"]);
		expect(duBounded.commandLabel).toBe("kubectl exec web-0 -- du /var maxDepth=1 oneFilesystem=true");

		const processes = buildInspectCall({ pod: "web-0", operation: "processes" }, runtime.limits);
		expect(processes.request.command).toEqual(["sh", "-c", PROCESSES_SCRIPT, "sh"]);
		expect(PROCESSES_SCRIPT).toContain("IFS=':\t '");
		expect(processes.commandLabel).toBe("kubectl exec web-0 -- processes");

		const sockets = buildInspectCall({ pod: "web-0", operation: "sockets" }, runtime.limits);
		expect(sockets.request.command).toEqual(["sh", "-c", SOCKETS_SCRIPT, "sh"]);
		expect(sockets.commandLabel).toBe("kubectl exec web-0 -- sockets");
	});
});

function runInContainer(
	image: string,
	fixtureDir: string,
	command: readonly string[],
): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		execFile(
			"container",
			["run", "--rm", "--progress", "none", "-v", `${fixtureDir}:/fixture:ro`, image, ...command],
			{ encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
			(error, stdout, stderr) => {
				const exitCode =
					error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? Number(error.code) : 1;
				resolve({ stdout, stderr: stderr.toString("utf8"), exitCode });
			},
		);
	});
}

describe.skipIf(!REAL_GUEST)("k8s_inspect guest commands on real Linux images", () => {
	let fixtureDir: string;
	const rawBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x42]);

	beforeAll(async () => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		fixtureDir = await mkdtemp(join(homedir(), ".cache", "polar-k8s-inspect-"));
		await mkdir(join(fixtureDir, "sub"), { recursive: true });
		await writeFile(join(fixtureDir, "hello.txt"), "line-1\nline-2\nline-3\nline-4\n");
		await writeFile(join(fixtureDir, ".hidden"), "secret\n");
		await writeFile(join(fixtureDir, "sub", "app.conf"), "port=8080\n");
		await writeFile(join(fixtureDir, "raw.bin"), rawBytes);
		await symlink("hello.txt", join(fixtureDir, "hello.link"));
	}, 60_000);

	afterAll(async () => {
		if (fixtureDir !== undefined) {
			await rm(fixtureDir, { recursive: true, force: true });
		}
	});

	for (const image of GUEST_IMAGES) {
		it(`executes all 8 operations on ${image}`, async () => {
			const runOp = (params: InspectParams) => {
				const { command } = buildInspectCall(params, runtime.limits).request;
				return runInContainer(image, fixtureDir, command);
			};

			const readAll = await runOp({ pod: "web-0", operation: "read", path: "/fixture/hello.txt" });
			expect(readAll.exitCode, readAll.stderr).toBe(0);
			expect(readAll.stdout.toString("utf8")).toBe("line-1\nline-2\nline-3\nline-4\n");

			const readTail = await runOp({
				pod: "web-0",
				operation: "read",
				path: "/fixture/hello.txt",
				tailLines: 2,
			});
			expect(readTail.exitCode, readTail.stderr).toBe(0);
			expect(readTail.stdout.toString("utf8")).toBe("line-3\nline-4\n");

			const listVisible = await runOp({ pod: "web-0", operation: "list", path: "/fixture" });
			expect(listVisible.exitCode, listVisible.stderr).toBe(0);
			expect(listVisible.stdout.toString("utf8")).toContain("hello.txt");
			expect(listVisible.stdout.toString("utf8")).toContain("hello.link -> hello.txt");
			expect(listVisible.stdout.toString("utf8")).not.toContain(".hidden");

			const listHidden = await runOp({
				pod: "web-0",
				operation: "list",
				path: "/fixture",
				includeHidden: true,
			});
			expect(listHidden.exitCode, listHidden.stderr).toBe(0);
			expect(listHidden.stdout.toString("utf8")).toContain(".hidden");

			const findConf = await runOp({
				pod: "web-0",
				operation: "find",
				root: "/fixture",
				maxDepth: 2,
				type: "file",
				nameGlob: "*.conf",
			});
			expect(findConf.exitCode, findConf.stderr).toBe(0);
			expect(findConf.stdout.toString("utf8").trim()).toBe("/fixture/sub/app.conf");

			const findSymlink = await runOp({
				pod: "web-0",
				operation: "find",
				root: "/fixture",
				type: "symlink",
			});
			expect(findSymlink.exitCode, findSymlink.stderr).toBe(0);
			expect(findSymlink.stdout.toString("utf8").trim()).toBe("/fixture/hello.link");

			const copyOut = await runOp({ pod: "web-0", operation: "copyOut", path: "/fixture/raw.bin" });
			expect(copyOut.exitCode, copyOut.stderr).toBe(0);
			expect(copyOut.stdout).toEqual(rawBytes);

			const df = await runOp({ pod: "web-0", operation: "df", path: "/fixture" });
			expect(df.exitCode, df.stderr).toBe(0);
			const dfText = df.stdout.toString("utf8");
			expect(dfText).toMatch(/1024-blocks|1K-blocks/);
			expect(dfText).toMatch(/Inodes/i);

			const du = await runOp({
				pod: "web-0",
				operation: "du",
				path: "/fixture",
				maxDepth: 1,
				oneFilesystem: true,
			});
			expect(du.exitCode, du.stderr).toBe(0);
			expect(du.stdout.toString("utf8")).toContain("/fixture/sub");
			expect(du.stdout.toString("utf8")).toContain("/fixture");

			const processes = await runOp({ pod: "web-0", operation: "processes" });
			expect(processes.exitCode, processes.stderr).toBe(0);
			const processesText = processes.stdout.toString("utf8");
			expect(processesText).toMatch(/PID/);
			expect(processesText).toMatch(/PPID/);

			const sockets = await runOp({ pod: "web-0", operation: "sockets" });
			expect(sockets.exitCode, sockets.stderr).toBe(0);
			expect(sockets.stdout.toString("utf8").length).toBeGreaterThan(0);
		}, 120_000);
	}
});
