import { vi } from "vitest";
import type { K8sRuntime, SessionPaths } from "../src/types.ts";

export const session: SessionPaths = {
	sessionId: "current",
	cwd: "/work",
	outputDirectory: "/tmp/polar-artifacts/current",
};

export function testRuntime(): K8sRuntime {
	return {
		launch: { kubeconfigPath: "/home/operator/.kube/config", context: "staging" },
		environment: {},
		limits: {
			timeoutMs: 30000,
			logsTimeoutMs: 120000,
			fileMaxBytes: 1048576,
			sessionMaxBytes: 4194304,
			stderrMaxBytes: 65536,
			killGraceMs: 2000,
			replyMaxLines: 200,
			replyMaxBytes: 16384,
		},
		kubectlCommand: "kubectl",
		activeProcessGroups: new Set(),
		handle: { paths: session, release: vi.fn(async () => {}) },
		state: "open",
		inFlight: new Set(),
	};
}

export const runtime: K8sRuntime = testRuntime();
