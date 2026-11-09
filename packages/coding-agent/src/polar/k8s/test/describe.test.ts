import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { kubectlCommandLabel } from "../src/kubectl.ts";
import { buildDescribeCall, type DescribeParams, describeSpec } from "../src/tools/describe.ts";
import type { DescribeFlagName, KubectlFlag, KubectlReadRequest, ReplyOptions } from "../src/types.ts";
import { runtime } from "./fixtures.ts";

const showEvents: KubectlFlag<DescribeFlagName> = { name: "--show-events", value: "true" };

describe("k8s_describe", () => {
	it("validates the invocation shape", () => {
		const oneObject: DescribeParams = { resource: "pods", name: "web-0", namespace: "shop" };
		const bySelector: DescribeParams = { resource: "deploy", namespace: "shop", labelSelector: "app in (web, api)" };
		expect(Value.Check(describeSpec.parameters, oneObject)).toBe(true);
		expect(Value.Check(describeSpec.parameters, bySelector)).toBe(true);
		for (const accepted of [
			oneObject,
			bySelector,
			{ resource: "nodes" },
			{ resource: "all", namespace: "shop" },
			{ resource: "clusterroles", name: "system:node" },
			{ resource: "certificates.cert-manager.io", name: "web.example.com", namespace: "kube-system" },
		]) {
			expect(describeSpec.validate(accepted)).toBeUndefined();
		}

		const errorPaths = (args: unknown) =>
			Value.Errors(describeSpec.parameters, args).map((error) => error.instancePath);
		expect(errorPaths({ resource: "pods", allNamespaces: true })).toContain("/allNamespaces");
		expect(errorPaths({ resource: "pods", showEvents: false })).toContain("/showEvents");
		expect(errorPaths({ resource: "pods", labelSelector: { app: "web" } })).toEqual(["/labelSelector"]);

		const oneType =
			'Invalid parameter "resource": give one resource type or category (plural, short name, type.group, or all); pass the object name as name and flags as separate parameters.';
		for (const resource of [
			"pod web-0 -n shop",
			"pod/web-0",
			"pods,services",
			"-n shop pods",
			"pods\tweb-0",
			"pods --namespace=shop",
			" pods",
			"",
		]) {
			expect(describeSpec.validate({ resource })).toBe(oneType);
		}

		const oneName =
			'Invalid parameter "name": give one object name without spaces or slashes; pass the type as resource and flags as separate parameters.';
		for (const name of ["pod/web-0", "web-0 -n shop", "web-0\n", "-n shop", "pod/web-0 -n shop"]) {
			expect(describeSpec.validate({ resource: "pods", name })).toBe(oneName);
		}

		const oneNamespace =
			'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';
		for (const namespace of ["Shop", "shop -l app=web", "kube_system", "-shop", "shop-", "a".repeat(64)]) {
			expect(describeSpec.validate({ resource: "pods", namespace })).toBe(oneNamespace);
		}
		expect(describeSpec.validate({ resource: "pods", namespace: "a".repeat(63) })).toBeUndefined();

		expect(describeSpec.validate({ resource: "pods", name: "web-0", labelSelector: "app=web" })).toBe(
			'Invalid parameter "name": name cannot be combined with labelSelector; give one of them.',
		);

		expect(describeSpec.validate({ resource: "pod/web-0", name: "a b", namespace: "Shop" })).toBe(oneType);
		expect(describeSpec.validate({ resource: "pods", name: "a b", namespace: "Shop" })).toBe(oneName);
	});

	it("delegates Kubernetes validation", () => {
		const oneObject: DescribeParams = {
			resource: "certificates.cert-manager.io",
			name: "Not_A_DNS_Name",
			namespace: "no-such-namespace",
		};
		expect(describeSpec.validate(oneObject)).toBeUndefined();
		const objectCall = describeSpec.buildCall(oneObject, runtime.limits);
		const objectRequest: KubectlReadRequest = {
			operation: "describe",
			flags: [{ name: "--namespace", value: "no-such-namespace" }, showEvents],
			positionals: ["certificates.cert-manager.io/Not_A_DNS_Name"],
		};
		expect(objectCall.request).toEqual(objectRequest);
		expect(objectCall.tool).toBe("k8s_describe");
		expect(objectCall.commandLabel).toBe(kubectlCommandLabel(objectRequest));

		const selected: DescribeParams = {
			resource: "certificates.cert-manager.io",
			namespace: "no-such-namespace",
			labelSelector: "app in (web, api),tier!=cache",
		};
		expect(describeSpec.validate(selected)).toBeUndefined();
		const selectedCall = describeSpec.buildCall(selected, runtime.limits);
		const selectedRequest: KubectlReadRequest = {
			operation: "describe",
			flags: [
				{ name: "--namespace", value: "no-such-namespace" },
				{ name: "--selector", value: "app in (web, api),tier!=cache" },
				showEvents,
			],
			positionals: ["certificates.cert-manager.io"],
		};
		expect(selectedCall.request).toEqual(selectedRequest);
		expect(selectedCall.tool).toBe("k8s_describe");
		expect(selectedCall.commandLabel).toBe(kubectlCommandLabel(selectedRequest));
	});

	it("treats empty strings as absent", () => {
		const requestOf = (params: DescribeParams) => buildDescribeCall(params, runtime.limits).request;
		const allEmpty: DescribeParams = { resource: "pods", name: "", namespace: "", labelSelector: "" };
		expect(describeSpec.validate(allEmpty)).toBeUndefined();
		expect(requestOf(allEmpty)).toEqual({ operation: "describe", flags: [showEvents], positionals: ["pods"] });

		const emptySelector: DescribeParams = { resource: "pods", name: "web-0", labelSelector: "" };
		expect(describeSpec.validate(emptySelector)).toBeUndefined();
		expect(requestOf(emptySelector)).toEqual({
			operation: "describe",
			flags: [showEvents],
			positionals: ["pods/web-0"],
		});
	});

	it("always asks for events", () => {
		const requestOf = (params: DescribeParams) => buildDescribeCall(params, runtime.limits).request;
		expect(requestOf({ resource: "pods" })).toEqual({
			operation: "describe",
			flags: [showEvents],
			positionals: ["pods"],
		});
		expect(requestOf({ resource: "pods", name: "web-0" })).toEqual({
			operation: "describe",
			flags: [showEvents],
			positionals: ["pods/web-0"],
		});
		expect(requestOf({ resource: "pods", namespace: "shop", labelSelector: "app=web" }).flags).toEqual([
			{ name: "--namespace", value: "shop" },
			{ name: "--selector", value: "app=web" },
			showEvents,
		]);
	});

	it("keeps the first lines", () => {
		const firstLines: ReplyOptions = {
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "head",
			keepHeader: false,
		};
		const oneObject = buildDescribeCall({ resource: "pods", name: "web-0", namespace: "shop" }, runtime.limits);
		expect(oneObject.options).toEqual(firstLines);
		const everyObject = buildDescribeCall({ resource: "pods", namespace: "shop" }, runtime.limits);
		expect(everyObject.options).toEqual(firstLines);
	});

	it("describes exactly the schema", () => {
		const properties = Object.entries<object>(describeSpec.parameters.properties);
		expect(properties.map(([name]) => name)).toEqual(["resource", "name", "namespace", "labelSelector"]);
		expect(describeSpec.description).toBe(
			"'kubectl describe' on the cluster bound to this session: one object by exact name, or every object of a type, events included. Long output is cut to the first lines and saved to a file; the notice says how to read the rest.",
		);
		expect(describeSpec.promptSnippet).toBe(
			"'kubectl describe' on the session cluster: one object by exact name, or every object of a type",
		);
		const descriptions = properties.flatMap(([name, schema]) =>
			"description" in schema ? [[name, schema.description]] : [],
		);
		expect(descriptions).toEqual([
			[
				"resource",
				"One kubectl resource type: plural, short name, type.group for CRDs, or a category like all; no comma list.",
			],
			["name", "Exact object name. Empty means not set."],
			[
				"namespace",
				"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.",
			],
			["labelSelector", "Not combined with name. Empty means not set."],
		]);
		expect(describeSpec.name).toBe("k8s_describe");
		expect(describeSpec.label).toBe("k8s describe");
	});
});
