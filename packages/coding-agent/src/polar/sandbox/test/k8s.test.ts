import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { discardOutputFile, readExcerpt } from "../../shared/store.ts";
import { createRuntime } from "../index.ts";
import { deadlineAfter } from "../src/cli.ts";
import {
	type K8sDriver,
	KEEPALIVE_COMMAND,
	k8sExecArguments,
	k8sInspectionOf,
	k8sPodName,
	launcher,
	parseK8sPod,
	parseK8sPods,
	ROOT_HASH_LABEL,
	ROOT_LABEL,
	rootHash,
	SANDBOX_LABEL,
	SCRUB_SCRIPT,
	SESSION_LABEL,
	stripKubectlExecTrailer,
	WORK_LIMIT_EXIT_CODE,
} from "../src/driver.ts";
import { buildReply } from "../src/reply.ts";
import { admitCall, containerName } from "../src/runner.ts";
import type { SandboxLanguage, SandboxResult, SandboxRuntime, SessionPaths } from "../src/types.ts";
import { checkReadiness, shutdownRuntime, startRuntime } from "../src/workspace.ts";
import {
	type FakeState,
	fakeK8sEnvironment,
	fakeK8sRuntime,
	fakeServiceAccountDir,
	fakeState,
	startingK8sRuntime,
	until,
} from "./fixtures.ts";

let root: string;
let saDir: string;
let handle: SessionHandle;
let session: SessionPaths;
let state: FakeState;
let notices: string[];
let callNumber = 0;
const warn = (message: string) => notices.push(message);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-k8s-"));
	saDir = await fakeServiceAccountDir(root);
	handle = await acquireSession("current", root, artifactsRoot());
	session = handle.paths;
	state = await fakeState();
	notices = [];
});

afterEach(async () => {
	await handle.release();
	const dirHash = createHash("sha256").update(saDir).digest("hex").slice(0, 16);
	await rm(join(tmpdir(), `polar-k8s-kubeconfig-${process.pid}-${dirHash}.json`), { force: true });
	await rm(root, { recursive: true, force: true });
	await rm(state.directory, { recursive: true, force: true });
});

function artifactsRoot(): string {
	return join(root, "artifacts");
}

function ownPodLabels(sessionId: string, rootPath = artifactsRoot()): Record<string, string> {
	return {
		[SANDBOX_LABEL]: "true",
		[SESSION_LABEL]: sessionId,
		[ROOT_HASH_LABEL]: rootHash(rootPath),
	};
}

function ownPodAnnotations(rootPath = artifactsRoot()): Record<string, string> {
	return {
		[ROOT_LABEL]: rootPath,
	};
}

async function run(code: string, runtime: SandboxRuntime, language: SandboxLanguage = "python", signal?: AbortSignal) {
	callNumber += 1;
	const call = admitCall(runtime, { language, code }, signal, `k8s-call-${callNumber}`);
	if (call === undefined) throw new Error("the call was not admitted");
	try {
		const result = await call.run();
		return { ...result, stdout: await takeOutput(result) };
	} finally {
		await call.dispose();
	}
}

async function takeOutput(result: SandboxResult): Promise<string> {
	if (result.output === undefined) return "";
	const { text } = await readExcerpt(result.output, "head", 8 * 1024 * 1024);
	await discardOutputFile(result.output);
	return text;
}

describe("K8sDriver selection & readiness", () => {
	it("selects k8s in auto mode when POLAR_SANDBOX_K8S_PVC or --sandbox-k8s-pvc is set and uses POLAR_SANDBOX_K8S_IMAGE unless --sandbox-image is custom", async () => {
		const env = fakeK8sEnvironment(state);
		const autoRuntime = createRuntime("polar-sandbox:0.2", env, handle, {
			driver: "auto",
			k8sOptions: { serviceAccountDir: saDir },
		});
		expect(autoRuntime.driver.name).toBe("k8s");
		expect(autoRuntime.driver.boundaryDescription).toBe("k8s (gvisor)");
		expect(autoRuntime.image).toBe("registry.example/polar-sandbox@sha256:deadbeef");

		const envWithoutPvc = { ...env };
		delete envWithoutPvc.POLAR_SANDBOX_K8S_PVC;
		const flagPvcRuntime = createRuntime("polar-sandbox:0.2", envWithoutPvc, handle, {
			driver: "auto",
			k8sPvc: "custom-pvc",
			k8sOptions: { serviceAccountDir: saDir },
		});
		expect(flagPvcRuntime.driver.name).toBe("k8s");
		expect((flagPvcRuntime.driver as K8sDriver).pvcName).toBe("custom-pvc");

		const customImageRuntime = createRuntime("custom-sandbox:1.0", env, handle, {
			driver: "k8s",
			customImage: true,
			k8sOptions: { serviceAccountDir: saDir },
		});
		expect(customImageRuntime.driver.name).toBe("k8s");
		expect(customImageRuntime.image).toBe("custom-sandbox:1.0");
	});

	it("verifies required env vars, ServiceAccount credentials, self-pod UID, and runs NetworkPolicy probe after recoverLeftovers", async () => {
		// 1. Happy path: checkRuntime (get pod polar-0) -> recoverLeftovers -> ensureWorkVolume (netprobe)
		const readyRuntime = startingK8sRuntime(state, handle, saDir);
		expect(await startRuntime(readyRuntime, warn)).toEqual({ ready: true });
		expect(await state.containers()).toEqual([]);
		const calls = await state.calls();
		expect(calls[0]?.slice(4)).toEqual(["get", "pod", "polar-0", "-o", "json"]);
		const listPodsIdx = calls.findIndex((call) => call.includes("pods") && call.includes("-l"));
		const lastCreateIdx = calls.findLastIndex((call) => call.includes("create"));
		expect(listPodsIdx).toBeGreaterThan(0);
		expect(lastCreateIdx).toBeGreaterThan(listPodsIdx);
		expect(calls.some((call) => call.includes("delete"))).toBe(true);
		expect(calls.some((call) => call.includes("logs"))).toBe(false);

		// 2. Missing required env vars
		for (const missingKey of [
			"POLAR_SANDBOX_K8S_PVC",
			"POLAR_SANDBOX_K8S_RUNTIME_CLASS",
			"POLAR_SANDBOX_K8S_IMAGE",
			"POLAR_SANDBOX_K8S_POD_NAME",
			"POLAR_SANDBOX_K8S_POD_UID",
			"POLAR_SANDBOX_K8S_NODE_NAME",
			"KUBERNETES_SERVICE_HOST",
		]) {
			const missing = startingK8sRuntime(state, handle, saDir, { [missingKey]: "" });
			missing.customImage = false;
			expect(await checkReadiness(missing), missingKey).toEqual({
				ready: false,
				message: `sandbox is off: ${missingKey} is not set`,
				leftovers: [],
			});
		}

		// 3. Missing ServiceAccount directory
		const missingSa = startingK8sRuntime(state, handle, join(root, "nonexistent-sa"));
		const saReadiness = await checkReadiness(missingSa);
		expect(saReadiness.ready).toBe(false);
		if (!saReadiness.ready) {
			expect(saReadiness.message).toContain("serviceaccount credentials");
		}

		// 4. Self-pod UID mismatch
		const uidMismatch = startingK8sRuntime(state, handle, saDir, { SELF_POD_UID: "wrong-uid" });
		expect(await checkReadiness(uidMismatch)).toEqual({
			ready: false,
			message: "sandbox is off: pod UID mismatch for polar-0: expected uid-polar-0, got wrong-uid",
			leftovers: [],
		});

		// 5. Self-pod NotFound and AUTH_FAIL
		const selfMissing = startingK8sRuntime(state, handle, saDir, { SELF_POD_MISSING: "1" });
		expect(await checkReadiness(selfMissing)).toEqual({
			ready: false,
			message:
				'sandbox is off: kubectl get pod polar-0 failed: Error from server (NotFound): pods "polar-0" not found',
			leftovers: [],
		});

		const authFail = startingK8sRuntime(state, handle, saDir, { AUTH_FAIL: "1" });
		expect(await checkReadiness(authFail)).toEqual({
			ready: false,
			message: "sandbox is off: kubectl get pod polar-0 failed: Error from server (Unauthorized): Unauthorized",
			leftovers: [],
		});

		// 6a. /work volume not writable (exit 2) -> probe fails with /work reason
		const workNotWritable = startingK8sRuntime(state, handle, saDir, { WORK_PROBE_FAIL: "1" });
		expect(await startRuntime(workNotWritable, warn)).toEqual({
			ready: false,
			message:
				"sandbox is off: the /work volume (PVC polar-shared subPath work/current) is not writable by uid 1000",
			leftovers: [],
		});
		expect(await state.containers()).toEqual([]);

		// 6b. Unresolvable address (exit 3) -> probe fails with resolution reason
		const gaiError = startingK8sRuntime(state, handle, saDir, { NETPOLICY_EXIT: "3" });
		expect(await startRuntime(gaiError, warn)).toEqual({
			ready: false,
			message: "sandbox is off: network policy probe failed: address 10.43.0.1:443 could not be resolved",
			leftovers: [],
		});
		expect(await state.containers()).toEqual([]);

		// 6c. NetworkPolicy allows egress -> probe in ensureWorkVolume fails and disables sandbox
		const netAllowed = startingK8sRuntime(state, handle, saDir, { NETPOLICY_ALLOW: "1" });
		expect(await startRuntime(netAllowed, warn)).toEqual({
			ready: false,
			message:
				"sandbox is off: NetworkPolicy deny-all is not enforced: sandbox pod connected to 10.43.0.1:443 (exit 1)",
			leftovers: [],
		});
		expect(await state.containers()).toEqual([]);

		// 7. NetworkPolicy probe pod fails to delete -> returns CleanupError and manualDeleteCommand
		const netDeleteFail = startingK8sRuntime(state, handle, saDir, { NETPROBE_DELETE_FAIL: "1" });
		const netDeleteResult = await startRuntime(netDeleteFail, warn);
		expect(netDeleteResult.ready).toBe(false);
		if (!netDeleteResult.ready) {
			expect(netDeleteResult.leftovers).toHaveLength(1);
			const leftoverName = netDeleteResult.leftovers[0].container;
			expect(leftoverName).toMatch(/^polar-netprobe-current-[0-9a-f]{8}$/);
			expect(netDeleteResult.message).toContain(
				`delete them with: kubectl -n polar delete pod --wait=true ${leftoverName}`,
			);
		}
		expect(netDeleteFail.owned.size).toBe(1);
	});

	it("strips external KUBECONFIG from child env, formats IPv6 serviceHost, accepts dotted sessionIds, and reuses a single kubeconfig file in /tmp", async () => {
		const dottedHandle = await acquireSession("session.v1.2", root, artifactsRoot());
		try {
			const runtime1 = startingK8sRuntime(state, dottedHandle, saDir, {
				KUBECONFIG: "/evil/external/kubeconfig",
				KUBERNETES_SERVICE_HOST: "fd00::1",
			});
			runtime1.environment.KUBECONFIG = "/evil/external/kubeconfig";
			runtime1.environment.KUBERNETES_SERVICE_HOST = "fd00::1";
			expect(await startRuntime(runtime1, warn)).toEqual({ ready: true });
			runtime1.state = "open";

			const driver1 = runtime1.driver as K8sDriver;
			const expectedTokenFile = join(saDir, "token");
			const kc1 = JSON.parse(await readFile(driver1.kubeconfigPath, "utf8")) as {
				clusters: { cluster: { server: string } }[];
				users: { user: { tokenFile?: string; token?: string } }[];
			};
			expect(kc1.clusters[0].cluster.server).toBe("https://[fd00::1]:443");
			expect(kc1.users[0].user.tokenFile).toBe(expectedTokenFile);
			expect(kc1.users[0].user.token).toBeUndefined();

			const executed = await run("stdout:clean\nexit:0", runtime1);
			expect(executed).toMatchObject({ status: "ok", exitCode: 0, stdout: "clean\n" });
			expect(runtime1.activeSandbox.current?.name).toMatch(/^polar-sandbox-session-v1-2-1-[0-9a-f]{8}$/);
			await shutdownRuntime(runtime1, "reload", warn);

			// Rotate token and start a second session with the same saDir
			await writeFile(expectedTokenFile, "rotated-k8s-sa-token\n");
			const secondHandle = await acquireSession("session.v1.3", root, artifactsRoot());
			try {
				const runtime2 = startingK8sRuntime(state, secondHandle, saDir);
				runtime2.environment.KUBECONFIG = "/evil/external/kubeconfig";
				expect(await startRuntime(runtime2, warn)).toEqual({ ready: true });
				const driver2 = runtime2.driver as K8sDriver;
				expect(driver2.kubeconfigPath).toBe(driver1.kubeconfigPath);
				const kc2 = JSON.parse(await readFile(driver2.kubeconfigPath, "utf8")) as {
					users: { user: { tokenFile?: string; token?: string } }[];
				};
				expect(kc2.users[0].user.tokenFile).toBe(expectedTokenFile);
				expect(kc2.users[0].user.token).toBeUndefined();

				const dirHash = createHash("sha256").update(saDir).digest("hex").slice(0, 16);
				const prefix = `polar-k8s-kubeconfig-${process.pid}-${dirHash}`;
				const matchingTmpFiles = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix));
				expect(matchingTmpFiles).toEqual([basename(driver1.kubeconfigPath)]);
				await shutdownRuntime(runtime2, "reload", warn);
			} finally {
				await secondHandle.release();
			}
		} finally {
			await dottedHandle.release();
		}
	});

	it("returns Forbidden on kubectl logs in fake-kubectl.mjs", async () => {
		const runtime = fakeK8sRuntime(state, handle, saDir);
		const driver = runtime.driver as K8sDriver;
		const logs = await driver.kubectl(["logs", "sbx-c1"]);
		expect(logs.code).toBe(1);
		expect(logs.stderr).toContain('Error from server (Forbidden): pods "sbx-c1" is forbidden');
		expect(logs.stderr).toContain('cannot get resource "pods/log"');
	});
});

describe("K8sDriver pod specification, DNS-1123 naming, and GC", () => {
	it("normalizes uppercase, underscore, and dot sessionIds to DNS-1123 pod names and sets full restricted securityContext", async () => {
		const mixedHandle = await acquireSession("Session_A1", root, artifactsRoot());
		try {
			const runtime = startingK8sRuntime(state, mixedHandle, saDir);
			expect(await startRuntime(runtime, warn)).toEqual({ ready: true });
			runtime.state = "open";

			expect(containerName("Session_A1", "run_code-1")).toMatch(/^polar-sandbox-Session_A1-1-[0-9a-f]{8}$/);
			expect(k8sPodName("Session_A1.v2")).toBe("session-a1-v2");

			const first = await run("echo_argv", runtime);
			expect(first.status).toBe("ok");
			const echo = JSON.parse(first.stdout) as {
				argv: string[];
				manifest: {
					apiVersion: string;
					kind: string;
					metadata: Record<string, unknown>;
					spec: Record<string, unknown>;
				};
				codeLength: number;
			};

			const name = runtime.activeSandbox.current?.name ?? "";
			expect(name).toMatch(/^polar-sandbox-session-a1-1-[0-9a-f]{8}$/);

			const driver = runtime.driver as K8sDriver;
			expect(echo.argv).toEqual(
				k8sExecArguments(
					driver.kubeconfigPath,
					"polar",
					name,
					"python",
					runtime.limits.workMaxBytes,
					runtime.limits.processMax,
				),
			);

			// Explicit verification of metadata, ownerReferences, volumeMounts, and restricted Pod Security fields
			const { metadata, spec } = echo.manifest;
			expect(echo.manifest.apiVersion).toBe("v1");
			expect(echo.manifest.kind).toBe("Pod");
			expect(metadata.name).toBe(name);
			expect(metadata.namespace).toBe("polar");
			expect(metadata.labels).toEqual({
				"polar-sandbox": "true",
				"polar-session": "Session_A1",
				"polar-root-hash": rootHash(artifactsRoot()),
			});
			expect(metadata.annotations).toEqual({
				"polar-root": artifactsRoot(),
			});
			expect(metadata.ownerReferences).toEqual([
				{
					apiVersion: "v1",
					kind: "Pod",
					name: "polar-0",
					uid: "uid-polar-0",
				},
			]);

			expect(spec.runtimeClassName).toBe("gvisor");
			expect(spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "polar-node-1" });
			expect(spec.restartPolicy).toBe("Never");
			expect(spec.terminationGracePeriodSeconds).toBe(1);
			expect(spec.automountServiceAccountToken).toBe(false);
			expect(spec.enableServiceLinks).toBe(false);
			expect(spec.securityContext).toEqual({
				runAsUser: 1000,
				runAsGroup: 1000,
				runAsNonRoot: true,
				fsGroup: 1000,
				fsGroupChangePolicy: "OnRootMismatch",
				seccompProfile: { type: "RuntimeDefault" },
			});
			const container = (spec.containers as Record<string, unknown>[])[0];
			expect(container.image).toBe(runtime.image);
			expect(container.command).toEqual(["bash", "-c", KEEPALIVE_COMMAND]);
			expect(container.stdin).toBe(true);
			expect(container.workingDir).toBe("/work");
			expect(container.securityContext).toEqual({
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				allowPrivilegeEscalation: false,
				readOnlyRootFilesystem: true,
				capabilities: { drop: ["ALL"] },
				seccompProfile: { type: "RuntimeDefault" },
			});
			expect(container.volumeMounts).toEqual([
				{
					name: "shared",
					mountPath: "/data",
					subPath: "artifacts/Session_A1",
					readOnly: true,
				},
				{
					name: "shared",
					mountPath: "/work",
					subPath: "work/Session_A1",
				},
				{
					name: "tmp",
					mountPath: "/tmp",
				},
			]);
			expect(spec.volumes).toEqual([
				{
					name: "shared",
					persistentVolumeClaim: { claimName: "polar-shared" },
				},
				{
					name: "tmp",
					emptyDir: { medium: "Memory", sizeLimit: "16Mi" },
				},
			]);
			expect(echo.argv.at(-1)).toContain(`ulimit -u ${runtime.limits.processMax}\n`);
			expect(launcher("bash", { workMaxBytes: 4096, processMax: 256 }).startsWith("ulimit -u 256\n")).toBe(true);

			await shutdownRuntime(runtime, "reload", warn);
			expect(await state.containers()).toEqual([]);
		} finally {
			await mixedHandle.release();
		}
	});

	it("fails fast on fatal pod waiting reasons (ImagePullBackOff / ErrImagePull) and cleans up on AbortSignal during waitForPodRunning", async () => {
		for (const reason of ["ImagePullBackOff", "ErrImagePull"]) {
			const waitingRuntime = fakeK8sRuntime(state, handle, saDir, {
				POD_WAITING_REASON: reason,
				POD_WAITING_MESSAGE: `Failed to pull image (${reason})`,
			});
			const result = await run("stdout:never", waitingRuntime);
			expect(result.status).toBe("runtime_failed");
			expect(result.runtimeMessage).toBe(`${reason}: Failed to pull image (${reason})`);
			expect(waitingRuntime.activeSandbox.current).toBeUndefined();
			expect(waitingRuntime.owned.size).toBe(0);
			expect(await state.containers()).toEqual([]);
		}

		// AbortSignal while pod is Pending in ContainerCreating during waitForPodRunning
		const pendingRuntime = fakeK8sRuntime(state, handle, saDir, {
			POD_WAITING_REASON: "ContainerCreating",
			POD_WAITING_MESSAGE: " pulling container layers",
		});
		const controller = new AbortController();
		const runningPromise = run("stdout:never", pendingRuntime, "python", controller.signal);
		await until(async () => (await state.containers()).length === 1);
		controller.abort();
		const cancelled = await runningPromise;
		expect(cancelled.status).toBe("cancelled");
		expect(pendingRuntime.activeSandbox.current).toBeUndefined();
		expect(pendingRuntime.owned.size).toBe(0);
		expect(await state.containers()).toEqual([]);
	});

	it("recovers leftover pods (including stale self-PID locks after container restart) and cleans work/<id> without pods/log", async () => {
		const liveDir = join(artifactsRoot(), "live");
		await mkdir(liveDir, { recursive: true });
		await writeFile(join(liveDir, "lock"), `${process.ppid}\n`);

		const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const endedDir = join(artifactsRoot(), "ended");
		await mkdir(endedDir, { recursive: true });
		await writeFile(join(endedDir, "lock"), `${exitedPid}\n`);

		// Simulate a crashed container restart where the old session lock has PID === process.pid (PID 1 reuse)
		const crashedSelfPidDir = join(artifactsRoot(), "crashed-self");
		await mkdir(crashedSelfPidDir, { recursive: true });
		await writeFile(join(crashedSelfPidDir, "lock"), `${process.pid}\n`);

		const foreignRoot = "/other/artifacts";
		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", ownPodLabels("current"), ownPodAnnotations());
		await state.addContainer("polar-sandbox-live-1-bbbbbbbb", ownPodLabels("live"), ownPodAnnotations());
		await state.addContainer("polar-sandbox-ended-1-cccccccc", ownPodLabels("ended"), ownPodAnnotations());
		await state.addContainer(
			"polar-sandbox-crashed-self-1-dddddddd",
			ownPodLabels("crashed-self"),
			ownPodAnnotations(),
		);
		await state.addContainer("polar-sandbox-gone-1-eeeeeeee", ownPodLabels("gone"), ownPodAnnotations());
		// Same hash label but different annotation (hash collision defense)
		await state.addContainer(
			"polar-sandbox-collision-1-ffffffff",
			ownPodLabels("collision"),
			ownPodAnnotations(foreignRoot),
		);

		await state.addVolume("polar-work-current", { "polar-session": "current" });
		await state.addVolume("polar-work-live", { "polar-session": "live" });
		await state.addVolume("polar-work-ended", { "polar-session": "ended" });
		await state.addVolume("polar-work-crashed-self", { "polar-session": "crashed-self" });
		await state.addVolume("polar-work-gone", { "polar-session": "gone" });

		const runtime = startingK8sRuntime(state, handle, saDir);
		expect(await startRuntime(runtime, warn)).toEqual({ ready: true });

		expect(await state.containers()).toEqual(["polar-sandbox-collision-1-ffffffff", "polar-sandbox-live-1-bbbbbbbb"]);
		expect((await state.volumes()).map((v) => v.name).sort()).toEqual([
			"polar-work-crashed-self",
			"polar-work-current",
			"polar-work-ended",
			"polar-work-live",
		]);
		const calls = await state.calls();
		expect(calls.some((call) => call.includes("logs"))).toBe(false);

		// Verify helper pod manifests (polar-work-ls, polar-work-rm, polar-netprobe):
		// polar-sandbox label, runtimeClassName, writable work mount on rm pod, and host/port + /work mount on probe pod
		interface HelperManifest {
			metadata: { name: string; labels: Record<string, string> };
			spec: {
				runtimeClassName: string;
				containers: {
					command: string[];
					volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[];
				}[];
			};
		}
		const manifests = (await state.manifests()) as unknown as HelperManifest[];
		const lsPod = manifests.find((m) => m.metadata.name.startsWith("polar-work-ls-"));
		const rmPod = manifests.find((m) => m.metadata.name.startsWith("polar-work-rm-"));
		const netprobePod = manifests.find((m) => m.metadata.name.startsWith("polar-netprobe-"));
		expect(lsPod).toBeDefined();
		expect(rmPod).toBeDefined();
		expect(netprobePod).toBeDefined();
		for (const helper of [lsPod, rmPod, netprobePod]) {
			expect(helper?.metadata.labels["polar-sandbox"]).toBe("true");
			expect(helper?.spec.runtimeClassName).toBe("gvisor");
		}
		expect(lsPod?.spec.containers[0].volumeMounts).toContainEqual({
			name: "shared",
			mountPath: "/work-root",
			subPath: "work",
			readOnly: true,
		});
		expect(rmPod?.spec.containers[0].volumeMounts).toContainEqual({
			name: "shared",
			mountPath: "/work-root",
			subPath: "work",
		});
		expect(rmPod?.spec.containers[0].command.slice(3)).toEqual(["polar-work-rm", "gone"]);
		expect(netprobePod?.spec.containers[0].volumeMounts).toContainEqual({
			name: "shared",
			mountPath: "/work",
			subPath: "work/current",
		});
		expect(netprobePod?.spec.containers[0].command[0]).toBe("python3");
		expect(netprobePod?.spec.containers[0].command[2]).toContain("socket.create_connection");
		expect(netprobePod?.spec.containers[0].command.slice(3)).toEqual(["10.43.0.1", "443"]);
	});

	it("parses K8s pod JSON and handles delete/ghost/failure outcomes", async () => {
		expect(parseK8sPod("not json")).toBeUndefined();
		expect(parseK8sPods(JSON.stringify({ items: [{}] }))).toBeUndefined();
		expect(
			k8sInspectionOf(
				{
					code: 1,
					stdout: "",
					stderr: 'Error from server (NotFound): pods "sbx-1" not found\n',
					timedOut: false,
				},
				"sbx-1",
			),
		).toEqual({ state: "absent" });

		await state.addContainer("polar-sandbox-current-1-aaaaaaaa", ownPodLabels("current"), ownPodAnnotations());
		const ghost = fakeK8sRuntime(state, handle, saDir, { DELETE_GHOST: "1" });
		const ghostDriver = ghost.driver as K8sDriver;
		expect(await ghostDriver.deleteSandbox("polar-sandbox-current-1-aaaaaaaa", deadlineAfter(ghost))).toEqual({
			removed: true,
		});
		expect(ghost.owned.size).toBe(0);

		await state.addContainer("polar-sandbox-current-2-bbbbbbbb", ownPodLabels("current"), ownPodAnnotations());
		const failing = fakeK8sRuntime(state, handle, saDir, { DELETE_FAIL: "1" });
		const failingDriver = failing.driver as K8sDriver;
		expect(await failingDriver.deleteSandbox("polar-sandbox-current-2-bbbbbbbb", deadlineAfter(failing))).toEqual({
			removed: false,
			error: {
				container: "polar-sandbox-current-2-bbbbbbbb",
				message: "delete: Error from server: runtime temporarily unavailable; still listed",
			},
		});
		expect(failingDriver.manualDeleteCommand(["polar-sandbox-current-2-bbbbbbbb"])).toBe(
			"kubectl -n polar delete pod --wait=true polar-sandbox-current-2-bbbbbbbb",
		);
	});
});

describe("K8sHotSandbox stderr trailer stripping, OOM (128 & 137), and kill", () => {
	it("strips kubectl exec trailer on non-zero exits (with or without newline) and flushes stderr before closed", async () => {
		expect(
			stripKubectlExecTrailer(Buffer.from("err-partialcommand terminated with exit code 3\n"), 3).toString("utf8"),
		).toBe("err-partial");
		expect(stripKubectlExecTrailer(Buffer.from("command terminated with exit code 3\n"), 3).toString("utf8")).toBe(
			"",
		);
		expect(stripKubectlExecTrailer(Buffer.from("command terminated with exit code 0\n"), 0).toString("utf8")).toBe(
			"command terminated with exit code 0\n",
		);

		const runtime = fakeK8sRuntime(state, handle, saDir);

		// 1. Exit 0 with partial stderr (no newline)
		const exit0Partial = await run("stderr_raw:err-partial\nexit:0", runtime);
		expect(exit0Partial).toMatchObject({ status: "ok", exitCode: 0 });
		expect(exit0Partial.stderr.toString("utf8")).toBe("err-partial");

		// 2. Exit 3 with partial stderr (no newline before trailer)
		const exit3Partial = await run("stdout_raw:out-partial\nstderr_raw:err-partial\nexit:3", runtime);
		expect(exit3Partial).toMatchObject({
			status: "failed",
			exitCode: 3,
			stdout: "out-partial",
			inspection: { state: "present" },
		});
		expect(exit3Partial.stderr.toString("utf8")).toBe("err-partial");

		// 3. Exit 3 with no stderr at all -> trailer stripped to empty buffer
		const exit3NoStderr = await run("exit:3", runtime);
		expect(exit3NoStderr).toMatchObject({
			status: "failed",
			exitCode: 3,
			stdout: "",
			inspection: { state: "present" },
		});
		expect(exit3NoStderr.stderr.toString("utf8")).toBe("");

		// 4. Chunked stderr > 100 bytes with trailer split across small delayed chunks
		const chunkedPayload = `${"E".repeat(135)}-tail`;
		expect(chunkedPayload.length).toBeGreaterThan(100);
		const chunked = await run(`stderr_chunked_trailer:7:5:${chunkedPayload}`, runtime);
		expect(chunked).toMatchObject({
			status: "failed",
			exitCode: 5,
			stdout: "",
			inspection: { state: "present" },
		});
		expect(chunked.stderr.toString("utf8")).toBe(chunkedPayload);
		expect(chunked.stderr.length).toBe(Buffer.byteLength(chunkedPayload));

		// 5. Multi-megabyte stdout integrity
		const bigBytes = 2 * 1024 * 1024;
		const bigRuntime = fakeK8sRuntime(state, handle, saDir, {}, { fileMaxBytes: 4 * 1024 * 1024 });
		const big = await run(`stdout_bytes:${bigBytes}\nexit:0`, bigRuntime);
		expect(big.status).toBe("ok");
		expect(big.stdout.length).toBe(bigBytes);
	});

	it("detects gVisor OOM for both exit codes 128 and 137 (including status propagation lag) and recreates the pod", async () => {
		const runtime = fakeK8sRuntime(state, handle, saDir, { OOM_LAG_POLLS: "3" });

		// 1. Live pod under gVisor (no memory.events file) exiting 128 or 137 by user choice is NOT OOM
		const user128 = await run("stderr:custom 128\nexit128", runtime);
		expect(user128).toMatchObject({
			status: "failed",
			exitCode: 128,
			inspection: { state: "present" },
		});
		expect(user128.oomEvidence).toBeUndefined();
		expect(user128.stderr.toString("utf8")).toBe("custom 128\n");
		const firstPodName = runtime.activeSandbox.current?.name;
		expect(firstPodName).toBeDefined();

		const user137 = await run("stderr:custom 137\nexit137", runtime);
		expect(user137).toMatchObject({
			status: "failed",
			exitCode: 137,
			inspection: { state: "present" },
		});
		expect(user137.oomEvidence).toBeUndefined();
		expect(runtime.activeSandbox.current?.name).toBe(firstPodName);

		// 2. gVisor OOM returning exit code 128 with status lag (3 polls of Running before state.terminated=OOMKilled)
		const oom128 = await run("stdout:allocated 480 MiB\noom_gvisor_128", runtime);
		expect(oom128).toMatchObject({
			status: "out_of_memory",
			exitCode: 128,
			stdout: "allocated 480 MiB\n",
			oomEvidence: "pod state.terminated.reason is OOMKilled",
		});
		expect(oom128.stderr.toString("utf8")).toContain('urpc method "containerManager.WaitPID" failed: EOF');
		expect(oom128.stderr.toString("utf8")).not.toContain("command terminated with exit code 128");
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);

		// 3. Next call transparently creates a new pod and gVisor OOM returning exit code 137 with status lag is also detected
		const oom137 = await run("stdout:allocated 480 MiB\noom_gvisor_137", runtime);
		expect(oom137).toMatchObject({
			status: "out_of_memory",
			exitCode: 137,
			stdout: "allocated 480 MiB\n",
			oomEvidence: "pod state.terminated.reason is OOMKilled",
		});
		expect(oom137.stderr.toString("utf8")).toBe("");
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);

		// 4. Subsequent call runs cleanly on a fresh pod while /work volume remains
		const afterOom = await run("stdout:recovered\nexit:0", runtime);
		expect(afterOom).toMatchObject({ status: "ok", exitCode: 0, stdout: "recovered\n" });
		expect(runtime.activeSandbox.current).toBeDefined();
		expect(runtime.activeSandbox.current?.name).not.toBe(firstPodName);
		expect((await state.volumes()).map((v) => v.name)).toContain("polar-work-current");
		const calls = await state.calls();
		expect(calls.at(-1)?.slice(-3)).toEqual(["bash", "-c", SCRUB_SCRIPT]);
	});

	it("detects in-pod cgroup memory.events oom_kill delta when the pod stays alive (Kata)", async () => {
		const runtime = fakeK8sRuntime(state, handle, saDir, { CGROUP_MEMORY_EVENTS: "1" });

		// 1. Subprocess OOM caught by user script (exit 0) advances baseline
		const survived = await run("stdout:caught\noom_survived\nexit:0", runtime);
		expect(survived).toMatchObject({ status: "ok", exitCode: 0, stdout: "caught\n" });

		// 2. Subsequent exit 137 without a new OOM is reported as failed: exit 137
		const plain137 = await run("exit137", runtime);
		expect(plain137).toMatchObject({
			status: "failed",
			exitCode: 137,
			inspection: { state: "present" },
		});
		expect(plain137.oomEvidence).toBeUndefined();

		// 3. Call with oom_kill delta > 0 and exit 137 is reported as out_of_memory and destroys the pod
		const cgroupOom = await run("stdout:before\noom_cgroup", runtime);
		expect(cgroupOom).toMatchObject({
			status: "out_of_memory",
			exitCode: 137,
			stdout: "before\n",
			oomEvidence: "oom_kill 2 in /sys/fs/cgroup/memory.events",
		});
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);
	});

	it("reports work_limit on exit 199 and deletes the pod immediately on kill() with killGraceMs fallback", async () => {
		const runtime = fakeK8sRuntime(state, handle, saDir, {}, { timeoutMs: 250, killGraceMs: 150 });

		// 1. work_limit (exit 199) keeps the pod warm
		const wlCall = admitCall(runtime, { language: "bash", code: "stdout:part\nwork_limit" }, undefined, "k8s-wl");
		if (wlCall === undefined) throw new Error("not admitted");
		try {
			const wlResult = await wlCall.run();
			expect(wlResult.status).toBe("work_limit");
			expect(wlResult.exitCode).toBe(WORK_LIMIT_EXIT_CODE);
			expect(runtime.activeSandbox.current).toBeDefined();
			const reply = await buildReply(
				wlResult,
				{ language: "bash", code: "stdout:part\nwork_limit" },
				runtime.limits,
				session,
			);
			expect(reply.isError).toBe(true);
			expect(reply.text).toContain("[run_code work_limit]");
		} finally {
			await wlCall.dispose();
		}

		// 2. Direct process.kill() immediately deletes the pod with --wait=true even before SandboxRun destroy()
		const hot = runtime.activeSandbox.current;
		expect(hot).toBeDefined();
		if (hot === undefined) throw new Error("missing hot sandbox");
		const podNameBeforeKill = hot.name;
		expect(await state.containers()).toEqual([podNameBeforeKill]);
		const spawned = await hot.spawnCall("python");
		expect("spawned" in spawned).toBe(true);
		if (!("spawned" in spawned)) throw new Error("expected spawned process");
		spawned.spawned.stdin.end("hang\n");
		spawned.spawned.kill();
		await spawned.spawned.closed;
		await until(async () => (await state.containers()).length === 0);
		const killCalls = await state.calls();
		expect(
			killCalls.some((c) => c.includes("delete") && c.includes(podNameBeforeKill) && c.includes("--wait=true")),
		).toBe(true);
		runtime.activeSandbox.current = undefined;

		// 3. When a warm pod dies externally before the next call, spawnCall returns { gone } and SandboxCall transparently recreates it
		const firstCall = await run("stdout:warm\nexit:0", runtime);
		expect(firstCall.status).toBe("ok");
		const stalePod = runtime.activeSandbox.current as typeof hot | undefined;
		expect(stalePod).toBeDefined();
		if (stalePod === undefined) throw new Error("missing stale pod");
		const stalePodName = stalePod.name;
		await rm(join(state.directory, "containers", `${stalePodName}.json`), { force: true });
		const directGone = await stalePod.spawnCall("python");
		expect("gone" in directGone).toBe(true);
		const recreatedCall = await run("stdout:recreated\nexit:0", runtime);
		expect(recreatedCall).toMatchObject({ status: "ok", exitCode: 0, stdout: "recreated\n" });
		const recreatedPod = runtime.activeSandbox.current as typeof hot | undefined;
		expect(recreatedPod?.name).toBeDefined();
		expect(recreatedPod?.name).not.toBe(stalePodName);

		// 4. Timeout triggers kill() -> deletes pod with --wait=true
		const timedOut = await run("stdout:partial\nhang", runtime);
		expect(timedOut).toMatchObject({ status: "timeout", stdout: "partial\n" });
		expect(runtime.activeSandbox.current).toBeUndefined();
		expect(await state.containers()).toEqual([]);

		// 5. When delete pod ignores killing local exec process, killGraceMs SIGKILL stops local kubectl exec
		const stubborn = fakeK8sRuntime(
			state,
			handle,
			saDir,
			{ RUN_IGNORES_KILL: "1" },
			{ timeoutMs: 200, killGraceMs: 150 },
		);
		const stubbornResult = await run("hang", stubborn);
		expect(stubbornResult.status).toBe("timeout");
		expect(await state.containers()).toEqual([]);
	});

	it("validates deploy/k8s manifests and Containerfile against restricted Pod Security and RBAC contracts", async () => {
		interface K8sContainerSpec {
			name: string;
			command: string[];
			args?: string[];
			stdin?: boolean;
			envFrom?: unknown[];
			resources?: {
				requests?: Record<string, string>;
				limits?: Record<string, string>;
			};
			securityContext: Record<string, unknown>;
			volumeMounts?: { name: string; mountPath: string; subPath?: string }[];
		}
		interface K8sManifestDoc {
			kind: string;
			metadata: { name: string; labels?: Record<string, string> };
			rules?: unknown[];
			spec: {
				accessModes?: string[];
				podSelector?: { matchLabels: Record<string, string> };
				policyTypes?: string[];
				ingress?: unknown[];
				egress?: unknown[];
				replicas?: number;
				strategy?: { type: string };
				template?: {
					spec: {
						securityContext: Record<string, unknown>;
						initContainers: K8sContainerSpec[];
						containers: K8sContainerSpec[];
					};
				};
			};
		}
		const deployDir = fileURLToPath(new URL("../../../../../../deploy/k8s", import.meta.url));
		const parseYaml = async (filename: string) =>
			parseAllDocuments(await readFile(join(deployDir, filename), "utf8")).map(
				(doc) => doc.toJS() as K8sManifestDoc,
			);

		const [ns] = await parseYaml("namespace.yaml");
		expect(ns.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");

		const [pvc] = await parseYaml("pvc.yaml");
		expect(pvc.metadata.name).toBe("polar-shared");
		expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);

		const [netpol] = await parseYaml("networkpolicy.yaml");
		expect(netpol.spec.podSelector?.matchLabels).toEqual({ "polar-sandbox": "true" });
		expect(netpol.spec.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(netpol.spec.ingress).toEqual([]);
		expect(netpol.spec.egress).toEqual([]);

		const rbacDocs = await parseYaml("rbac.yaml");
		const role = rbacDocs.find((doc) => doc.kind === "Role");
		expect(role?.rules).toEqual([
			{ apiGroups: [""], resources: ["pods"], verbs: ["create", "get", "list", "watch", "delete"] },
			{ apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] },
		]);

		const [deployment] = await parseYaml("deployment.yaml");
		expect(deployment.spec.replicas).toBe(1);
		expect(deployment.spec.strategy).toEqual({ type: "Recreate" });
		const podSpec = deployment.spec.template?.spec;
		if (podSpec === undefined) throw new Error("missing pod template spec");
		expect(podSpec.securityContext).toMatchObject({
			runAsUser: 1000,
			runAsGroup: 1000,
			fsGroup: 1000,
			fsGroupChangePolicy: "OnRootMismatch",
			runAsNonRoot: true,
			seccompProfile: { type: "RuntimeDefault" },
		});
		const expectedContainerSec = {
			runAsNonRoot: true,
			runAsUser: 1000,
			runAsGroup: 1000,
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
			seccompProfile: { type: "RuntimeDefault" },
		};
		expect(podSpec.initContainers).toHaveLength(1);
		expect(podSpec.initContainers[0].command).toEqual(["true"]);
		expect(podSpec.initContainers[0].resources).toEqual({
			requests: { cpu: "50m", memory: "64Mi" },
			limits: { cpu: "1", memory: "256Mi" },
		});
		expect(podSpec.initContainers[0].securityContext).toEqual(expectedContainerSec);
		expect(podSpec.containers).toHaveLength(1);
		const polarContainer = podSpec.containers[0];
		expect(polarContainer.command).toEqual(["polar"]);
		expect(polarContainer.args).toEqual(["--mode", "rpc", "--session-dir", "/sessions"]);
		expect(polarContainer.stdin).toBe(true);
		expect(polarContainer.envFrom).toEqual([{ secretRef: { name: "polar-env", optional: true } }]);
		expect(polarContainer.resources).toEqual({
			requests: { cpu: "250m", memory: "512Mi" },
			limits: { cpu: "2", memory: "2Gi" },
		});
		expect(polarContainer.securityContext).toEqual(expectedContainerSec);
		expect(polarContainer.volumeMounts).toContainEqual({
			name: "shared",
			mountPath: "/artifacts",
			subPath: "artifacts",
		});
		expect(polarContainer.volumeMounts).toContainEqual({
			name: "shared",
			mountPath: "/sessions",
			subPath: "sessions",
		});
		expect(polarContainer.volumeMounts?.some((m) => m.subPath === "work")).toBe(false);

		const containerfile = await readFile(join(deployDir, "Containerfile"), "utf8");
		expect(containerfile).toContain("FROM node:22-bookworm-slim@sha256:");
		expect(containerfile).toContain('ENTRYPOINT ["polar"]');
		expect(containerfile).toContain('CMD ["--mode", "rpc", "--session-dir", "/sessions"]');
		expect(containerfile).toContain("sha256sum -c -");
		expect(containerfile).toContain("COPY --from=builder /usr/local/bin/kubectl /usr/local/bin/kubectl");
		expect(containerfile).not.toContain("chown -R 1000:1000 /artifacts /home/polar /tmp");
		expect(containerfile).toContain("USER 1000:1000");
	});
});
