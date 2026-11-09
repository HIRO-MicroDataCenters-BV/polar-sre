import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverKubeContexts, type KubeContextItem, splitKubeconfigPaths } from "../src/kubeconfig.ts";
import { filterKubeContexts } from "../src/picker.ts";

const FAKE_KUBECTL = fileURLToPath(new URL("./fake-kubectl.mjs", import.meta.url));

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "k8s-kubeconfig-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("splitKubeconfigPaths", () => {
	it("splits by path.delimiter, removes empty segments, and deduplicates in order", () => {
		const raw = ["", "/etc/kube/a", "/etc/kube/b", "", "/etc/kube/a", "/etc/kube/c"].join(delimiter);
		expect(splitKubeconfigPaths(raw)).toEqual(["/etc/kube/a", "/etc/kube/b", "/etc/kube/c"]);
		expect(splitKubeconfigPaths("")).toEqual([]);
	});
});

describe("discoverKubeContexts", () => {
	it("discovers contexts across multiple kubeconfig files", async () => {
		const kcA = join(root, "config-a.json");
		const kcB = join(root, "config-b.json");
		await writeFile(
			kcA,
			JSON.stringify({
				"current-context": "staging-eu",
				contexts: [
					{
						name: "staging-eu",
						context: { cluster: "eu-central-1", user: "dev-user", namespace: "payments" },
					},
					{
						name: "dev-eu",
						context: { cluster: "eu-central-1", user: "dev-user" },
					},
				],
			}),
		);
		await writeFile(
			kcB,
			JSON.stringify({
				"current-context": "prod-us",
				contexts: [
					{
						name: "prod-us",
						context: { cluster: "us-east-1", user: "sre-admin", namespace: "checkout" },
					},
				],
			}),
		);

		const result = await discoverKubeContexts([kcA, kcB], FAKE_KUBECTL, process.env);
		expect(result.errors).toEqual([]);
		expect(result.items).toEqual([
			{
				context: "staging-eu",
				cluster: "eu-central-1",
				user: "dev-user",
				namespace: "payments",
				kubeconfigPath: kcA,
				isCurrentInFile: true,
			},
			{
				context: "dev-eu",
				cluster: "eu-central-1",
				user: "dev-user",
				kubeconfigPath: kcA,
				isCurrentInFile: false,
			},
			{
				context: "prod-us",
				cluster: "us-east-1",
				user: "sre-admin",
				namespace: "checkout",
				kubeconfigPath: kcB,
				isCurrentInFile: true,
			},
		]);
	});

	it("returns both items and errors when some kubeconfig files fail", async () => {
		const validKc = join(root, "valid.json");
		const missingKc = join(root, "missing.json");
		const brokenJsonKc = join(root, "broken.json");
		const failedExitKc = join(root, "failed.json");

		await writeFile(
			validKc,
			JSON.stringify({
				"current-context": "staging",
				contexts: [{ name: "staging", context: { cluster: "c1", user: "u1" } }],
			}),
		);
		await writeFile(brokenJsonKc, "{not-valid-json");
		await writeFile(failedExitKc, "EXIT:1:error: permission denied\n");

		const result = await discoverKubeContexts(
			[validKc, missingKc, brokenJsonKc, failedExitKc],
			FAKE_KUBECTL,
			process.env,
		);

		expect(result.items).toEqual([
			{
				context: "staging",
				cluster: "c1",
				user: "u1",
				kubeconfigPath: validKc,
				isCurrentInFile: true,
			},
		]);
		expect(result.errors).toEqual([
			{
				kubeconfigPath: missingKc,
				message: expect.stringContaining("no such file or directory"),
			},
			{
				kubeconfigPath: brokenJsonKc,
				message: expect.stringContaining("Invalid JSON from kubectl config view"),
			},
			{
				kubeconfigPath: failedExitKc,
				message: "error: permission denied",
			},
		]);
	});

	it("records errors when all kubeconfig files fail or time out", async () => {
		const missingKc = join(root, "none.json");
		const slowKc = join(root, "slow.json");
		await writeFile(slowKc, JSON.stringify({ contexts: [] }));

		const result = await discoverKubeContexts(
			[missingKc, slowKc],
			FAKE_KUBECTL,
			{ ...process.env, FAKE_KUBECTL_CONFIG_DELAY_MS: "500" },
			50,
		);

		expect(result.items).toEqual([]);
		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]?.kubeconfigPath).toBe(missingKc);
		expect(result.errors[1]?.kubeconfigPath).toBe(slowKc);
	});
});

describe("filterKubeContexts", () => {
	const items: KubeContextItem[] = [
		{
			context: "staging-eu",
			cluster: "eks-eu-west",
			user: "admin",
			namespace: "payments",
			kubeconfigPath: "/kube/eu.yaml",
			isCurrentInFile: true,
		},
		{
			context: "prod-us",
			cluster: "gke-us-central",
			user: "sre",
			namespace: "billing",
			kubeconfigPath: "/kube/america.yaml",
			isCurrentInFile: false,
		},
		{
			context: "dev-local",
			cluster: "kind-local",
			user: "dev",
			kubeconfigPath: "/home/dev/.kube/config",
			isCurrentInFile: false,
		},
	];

	it("returns all items on empty or whitespace query", () => {
		expect(filterKubeContexts(items, "")).toEqual(items);
		expect(filterKubeContexts(items, "   ")).toEqual(items);
	});

	it("fuzzy-filters by context, cluster, namespace, and kubeconfigPath", () => {
		expect(filterKubeContexts(items, "prod").map((i) => i.context)).toEqual(["prod-us"]);
		expect(filterKubeContexts(items, "eks-eu").map((i) => i.context)).toEqual(["staging-eu"]);
		expect(filterKubeContexts(items, "payments").map((i) => i.context)).toEqual(["staging-eu"]);
		expect(filterKubeContexts(items, "america.yaml").map((i) => i.context)).toEqual(["prod-us"]);
		expect(filterKubeContexts(items, "nonexistent-cluster")).toEqual([]);
	});
});
