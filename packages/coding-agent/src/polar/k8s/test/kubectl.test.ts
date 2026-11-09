import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamResult } from "../../shared/process.ts";
import { acquireSession, type SessionHandle } from "../../shared/session.ts";
import { discardOutputFile, readExcerpt } from "../../shared/store.ts";
import { kubectlCommandLabel, runKubectl } from "../src/kubectl.ts";
import type { ExecutionLimits, K8sRuntime, KubectlCall, KubectlReadRequest, SessionPaths } from "../src/types.ts";

const FAKE_KUBECTL = fileURLToPath(new URL("./fake-kubectl.mjs", import.meta.url));

const listPods: KubectlReadRequest = { operation: "get", flags: [], positionals: ["pods"] };

const testLimits: ExecutionLimits = {
	timeoutMs: 10_000,
	logsTimeoutMs: 10_000,
	fileMaxBytes: 1024 * 1024,
	sessionMaxBytes: 16 * 1024 * 1024,
	stderrMaxBytes: 64 * 1024,
	killGraceMs: 300,
	replyMaxLines: 2000,
	replyMaxBytes: 50 * 1024,
};

let root: string;
let handle: SessionHandle;
let session: SessionPaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "k8s-kubectl-"));
	handle = await acquireSession("current", root, root);
	session = handle.paths;
});

afterEach(async () => {
	await handle.release();
	await rm(root, { recursive: true, force: true });
});

async function outputFiles(): Promise<string[]> {
	return (await readdir(session.outputDirectory)).filter((name) => name !== "lock");
}

function fakeRuntime(knobs: Record<string, string>, limits: Partial<ExecutionLimits> = {}): K8sRuntime {
	const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	for (const [name, value] of Object.entries(knobs)) {
		environment[`FAKE_KUBECTL_${name}`] = value;
	}
	return {
		launch: { kubeconfigPath: "/clusters/test.kubeconfig", context: "test-context" },
		environment,
		limits: { ...testLimits, ...limits },
		kubectlCommand: FAKE_KUBECTL,
		activeProcessGroups: new Set(),
		handle,
		state: "open",
		inFlight: new Set(),
	};
}

function callOf(request: KubectlReadRequest, runtime: K8sRuntime): KubectlCall {
	return {
		request,
		tool: `k8s_${request.operation}`,
		commandLabel: kubectlCommandLabel(request),
		options: { maxLines: 2000, maxBytes: 50 * 1024, selection: "head", keepHeader: false },
		timeoutMs: runtime.limits.timeoutMs,
	};
}

async function run(request: KubectlReadRequest, runtime: K8sRuntime, signal?: AbortSignal) {
	const result = await runKubectl(callOf(request, runtime), runtime, session, signal);
	return { ...result, stdout: await takeOutput(result) };
}

async function takeOutput(result: StreamResult): Promise<string> {
	if (result.output === undefined) return "";
	const { text } = await readExcerpt(result.output, "head", 4 * 1024 * 1024);
	await discardOutputFile(result.output);
	return text;
}

function unchecked(request: {
	operation: string;
	flags: { name: string; value?: string }[];
	positionals?: string[];
	pod?: string;
	command?: string[];
}): KubectlReadRequest {
	return request as KubectlReadRequest;
}

interface Echo {
	argv: string[];
	environment: Record<string, string>;
}

function echoOf(result: { stdout: string }): Echo {
	return JSON.parse(result.stdout);
}

describe("runKubectl", () => {
	it("formats value flags as --flag=value and places positionals after --", async () => {
		const request: KubectlReadRequest = {
			operation: "get",
			flags: [
				{ name: "--namespace", value: "--kubeconfig=/tmp/other" },
				{ name: "--selector", value: "app=web; echo injected" },
				{ name: "--all-namespaces" },
			],
			positionals: ["pods", "--context=other", "$(id)"],
		};
		const result = await run(request, fakeRuntime({ ECHO: "1" }));

		expect(echoOf(result).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"get",
			"--namespace=--kubeconfig=/tmp/other",
			"--selector=app=web; echo injected",
			"--all-namespaces",
			"--",
			"pods",
			"--context=other",
			"$(id)",
		]);

		const podWarnings: KubectlReadRequest = {
			operation: "events",
			flags: [
				{ name: "--namespace", value: "shop" },
				{ name: "--for", value: "pod/web-0" },
				{ name: "--types", value: "Warning" },
			],
			positionals: [],
		};
		const eventsResult = await run(podWarnings, fakeRuntime({ ECHO: "1" }));

		expect(echoOf(eventsResult).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"events",
			"--namespace=shop",
			"--for=pod/web-0",
			"--types=Warning",
			"--",
		]);

		const previousLog: KubectlReadRequest = {
			operation: "logs",
			flags: [
				{ name: "--namespace", value: "x" },
				{ name: "--container", value: "app" },
				{ name: "--previous" },
				{ name: "--tail", value: "200" },
				{ name: "--since", value: "5m" },
				{ name: "--timestamps" },
			],
			positionals: ["web-0"],
		};
		const logsResult = await run(previousLog, fakeRuntime({ ECHO: "1" }));

		expect(echoOf(logsResult).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"logs",
			"--namespace=x",
			"--container=app",
			"--previous",
			"--tail=200",
			"--since=5m",
			"--timestamps",
			"--",
			"web-0",
		]);

		const describeWebPods: KubectlReadRequest = {
			operation: "describe",
			flags: [
				{ name: "--namespace", value: "shop" },
				{ name: "--selector", value: "app=web" },
				{ name: "--show-events", value: "true" },
			],
			positionals: ["pods"],
		};
		const describeResult = await run(describeWebPods, fakeRuntime({ ECHO: "1" }));

		expect(echoOf(describeResult).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"describe",
			"--namespace=shop",
			"--selector=app=web",
			"--show-events=true",
			"--",
			"pods",
		]);

		const execInPod: KubectlReadRequest = {
			operation: "exec",
			flags: [
				{ name: "--namespace", value: "shop" },
				{ name: "--container", value: "app" },
			],
			pod: "web-0",
			command: ["cat", "--", "/etc/hosts"],
		};
		const execResult = await run(execInPod, fakeRuntime({ ECHO: "1" }));

		expect(echoOf(execResult).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"exec",
			"--namespace=shop",
			"--container=app",
			"web-0",
			"--",
			"cat",
			"--",
			"/etc/hosts",
		]);
		expect(kubectlCommandLabel(execInPod)).toBe(
			"kubectl exec web-0 --namespace=shop --container=app -- cat -- /etc/hosts",
		);
	});

	it("refuses flags outside the operation's allowlist before spawn", async () => {
		const runtime = fakeRuntime({});
		const refuse = (request: KubectlReadRequest) => runKubectl(callOf(request, runtime), runtime, session, undefined);
		const deletePods = unchecked({ operation: "delete", flags: [], positionals: ["pods"] });
		const otherCluster = unchecked({
			operation: "get",
			flags: [{ name: "--kubeconfig", value: "/tmp/other" }],
			positionals: ["pods"],
		});
		const getFlagOnEvents = unchecked({
			operation: "events",
			flags: [{ name: "--sort-by", value: ".lastTimestamp" }],
			positionals: [],
		});
		const eventsFlagOnGet = unchecked({
			operation: "get",
			flags: [{ name: "--for", value: "pod/web-0" }],
			positionals: ["pods"],
		});
		const getFlagOnLogs = unchecked({
			operation: "logs",
			flags: [{ name: "--all-namespaces" }],
			positionals: ["web-0"],
		});
		const getFlagOnDescribe = unchecked({
			operation: "describe",
			flags: [{ name: "--all-namespaces" }],
			positionals: ["pods"],
		});
		const getFlagOnExec = unchecked({
			operation: "exec",
			flags: [{ name: "--all-namespaces" }],
			pod: "web-0",
			command: ["cat", "/etc/hosts"],
		});
		const stdinFlagOnExec = unchecked({
			operation: "exec",
			flags: [{ name: "--stdin" }],
			pod: "web-0",
			command: ["cat", "/etc/hosts"],
		});
		const bareContainerOnExec: KubectlReadRequest = {
			operation: "exec",
			flags: [{ name: "--container" }],
			pod: "web-0",
			command: ["cat", "/etc/hosts"],
		};
		const flagAsPodOnExec: KubectlReadRequest = {
			operation: "exec",
			flags: [],
			pod: "--tty",
			command: ["cat", "/etc/hosts"],
		};
		const emptyCommandOnExec: KubectlReadRequest = {
			operation: "exec",
			flags: [],
			pod: "web-0",
			command: [],
		};
		const bareValueFlag: KubectlReadRequest = {
			operation: "get",
			flags: [{ name: "--output" }],
			positionals: ["--kubeconfig=/tmp/other"],
		};
		const bareFor: KubectlReadRequest = { operation: "events", flags: [{ name: "--for" }], positionals: [] };
		await expect(refuse(deletePods)).rejects.toThrow("Unsupported kubectl operation: delete");
		await expect(refuse(otherCluster)).rejects.toThrow("Unsupported kubectl get flag: --kubeconfig");
		await expect(refuse(getFlagOnEvents)).rejects.toThrow("Unsupported kubectl events flag: --sort-by");
		await expect(refuse(eventsFlagOnGet)).rejects.toThrow("Unsupported kubectl get flag: --for");
		await expect(refuse(getFlagOnLogs)).rejects.toThrow("Unsupported kubectl logs flag: --all-namespaces");
		await expect(refuse(getFlagOnDescribe)).rejects.toThrow("Unsupported kubectl describe flag: --all-namespaces");
		await expect(refuse(getFlagOnExec)).rejects.toThrow("Unsupported kubectl exec flag: --all-namespaces");
		await expect(refuse(stdinFlagOnExec)).rejects.toThrow("Unsupported kubectl exec flag: --stdin");
		await expect(refuse(bareContainerOnExec)).rejects.toThrow("Missing value for kubectl exec flag: --container");
		await expect(refuse(flagAsPodOnExec)).rejects.toThrow("Invalid kubectl exec pod name: --tty");
		await expect(refuse(emptyCommandOnExec)).rejects.toThrow("Missing command for kubectl exec");
		await expect(refuse(bareValueFlag)).rejects.toThrow("Missing value for kubectl get flag: --output");
		await expect(refuse(bareFor)).rejects.toThrow("Missing value for kubectl events flag: --for");
		expect(await outputFiles()).toEqual([]);
	});

	it("uses the bound operator environment", async () => {
		const runtime = fakeRuntime({ ECHO: "1", ECHO_ALSO: "AWS_PROFILE" });
		Object.assign(runtime.environment, {
			AWS_PROFILE: "operator",
			KUBECONFIG: "/home/operator/.kube/config",
			KUBERC: "/home/operator/.kube/kuberc",
			KUBECTL_KUBERC: "true",
			KUBECTL_EXTERNAL_DIFF: "meld",
		});
		const echo = echoOf(await run(listPods, runtime));

		expect(echo.environment).toEqual({
			AWS_PROFILE: "operator",
			KUBECONFIG: "/clusters/test.kubeconfig",
			KUBERC: "off",
		});
		expect(echo.argv.slice(0, 2)).toEqual(["--kubeconfig=/clusters/test.kubeconfig", "--context=test-context"]);
		expect(runtime.environment.KUBECTL_KUBERC).toBe("true");
	});

	it("reaches the binary with the expected argv and comes back as a StreamResult", async () => {
		const runtime = fakeRuntime({ ECHO: "1", STDERR: "W1015 warning\n" });
		const outcome: StreamResult = await runKubectl(callOf(listPods, runtime), runtime, session, undefined);

		expect(outcome.status).toBe("ok");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.stderr).toEqual(Buffer.from("W1015 warning\n", "utf8"));
		expect(outcome.output?.path).toBe(join(session.outputDirectory, "k8s_get-1.part"));
		const stdout = await takeOutput(outcome);
		expect(echoOf({ stdout }).argv).toEqual([
			"--kubeconfig=/clusters/test.kubeconfig",
			"--context=test-context",
			"get",
			"--",
			"pods",
		]);
		expect(await outputFiles()).toEqual([]);
	});
});
