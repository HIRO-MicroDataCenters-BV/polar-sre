import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { kubectlCommandLabel } from "../src/kubectl.ts";
import { buildGetCall, type GetParams, getSpec } from "../src/tools/get.ts";
import type { KubectlReadRequest } from "../src/types.ts";
import { runtime } from "./fixtures.ts";

const namespaceText =
	'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';

describe("k8s_get", () => {
	it("validates the invocation shape", () => {
		const eightParameters: GetParams = {
			resource: "pods",
			name: "web-0",
			namespace: "shop",
			allNamespaces: false,
			labelSelector: "app=web",
			fieldSelector: "status.phase=Running",
			sortByJsonPath: ".metadata.name",
			output: "json",
		};
		expect(Value.Check(getSpec.parameters, eightParameters)).toBe(true);
		expect(getSpec.validate(eightParameters)).toBeUndefined();

		const errorPaths = (args: unknown) => Value.Errors(getSpec.parameters, args).map((error) => error.instancePath);
		expect(errorPaths({ resource: "pods", container: "app" })).toContain("/container");
		expect(errorPaths({ resource: "pods", allNamespaces: "yes" })).toEqual(["/allNamespaces"]);

		const resourceTypes =
			'Invalid parameter "resource": give resource types only (plural, short name, type.group, a category like all, or a comma list); pass the object name as name and flags as separate parameters.';
		for (const resource of ["pods -n kube-system", "pod/web-0", "pods\tweb-0", "pods\n", "-A pods", "pods,", ""]) {
			expect(getSpec.validate({ resource }), JSON.stringify(resource)).toBe(resourceTypes);
		}
		for (const resource of ["pods,svc", "all", "po", "certificates.cert-manager.io"]) {
			expect(getSpec.validate({ resource }), resource).toBeUndefined();
		}
		const oneName =
			'Invalid parameter "name": give one object name without spaces or slashes; pass the type as resource and flags as separate parameters.';
		expect(getSpec.validate({ resource: "pods", name: "web-0 -n shop" })).toBe(oneName);
		expect(getSpec.validate({ resource: "pods", name: "pod/web-0" })).toBe(oneName);
		expect(getSpec.validate({ resource: "pods", namespace: "Shop" })).toBe(namespaceText);
		expect(getSpec.validate({ resource: "pod/web-0", name: "a b" })).toBe(resourceTypes);
	});

	it("delegates Kubernetes validation", () => {
		const params: GetParams = {
			resource: "certificates.cert-manager.io",
			name: "Not_A_DNS_Name",
			namespace: "no-such-namespace",
			allNamespaces: true,
			labelSelector: "app in (web, api),tier!=cache",
			fieldSelector: "spec.issuerRef.name=letsencrypt",
			sortByJsonPath: "{.status.notAfter}",
			output: "custom-columns=NAME:.metadata.name,EXPIRES:.status.notAfter",
		};
		expect(getSpec.validate(params)).toBeUndefined();
		const call = getSpec.buildCall(params, runtime.limits);

		const request: KubectlReadRequest = {
			operation: "get",
			flags: [
				{ name: "--namespace", value: "no-such-namespace" },
				{ name: "--all-namespaces" },
				{ name: "--selector", value: "app in (web, api),tier!=cache" },
				{ name: "--field-selector", value: "spec.issuerRef.name=letsencrypt" },
				{ name: "--sort-by", value: "{.status.notAfter}" },
				{ name: "--output", value: "custom-columns=NAME:.metadata.name,EXPIRES:.status.notAfter" },
			],
			positionals: ["certificates.cert-manager.io", "Not_A_DNS_Name"],
		};
		const options = {
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "tail",
			keepHeader: true,
		};
		expect(call).toEqual({
			request,
			tool: "k8s_get",
			commandLabel: kubectlCommandLabel(request),
			options,
			timeoutMs: runtime.limits.timeoutMs,
		});

		const secret = buildGetCall(
			{ resource: "secrets", name: "db-credentials", output: "jsonpath={.data.password}" },
			runtime.limits,
		);
		expect(secret.request).toEqual({
			operation: "get",
			flags: [{ name: "--output", value: "jsonpath={.data.password}" }],
			positionals: ["secrets", "db-credentials"],
		});
	});

	it("applies display defaults and rejects file formats", () => {
		const list = buildGetCall({ resource: "pods" }, runtime.limits);
		expect(list.request.flags).toEqual([{ name: "--output", value: "wide" }]);
		expect(list.options).toEqual({
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "head",
			keepHeader: true,
		});

		const named = buildGetCall({ resource: "pods", name: "web-0" }, runtime.limits);
		expect(named.request.flags).toEqual([{ name: "--output", value: "yaml" }]);
		expect(named.options.keepHeader).toBe(false);

		const explicit = buildGetCall({ resource: "pods", output: "name" }, runtime.limits);
		expect(explicit.request.flags).toEqual([{ name: "--output", value: "name" }]);
		expect(explicit.options.keepHeader).toBe(false);

		const sorted = buildGetCall({ resource: "events", sortByJsonPath: ".lastTimestamp" }, runtime.limits);
		expect(sorted.options).toMatchObject({ selection: "tail", keepHeader: true });

		const emptyStrings: GetParams = {
			resource: "pods",
			name: "",
			namespace: "",
			labelSelector: "",
			fieldSelector: "",
			sortByJsonPath: "",
			output: "",
		};
		expect(getSpec.validate(emptyStrings)).toBeUndefined();
		const absent = buildGetCall(emptyStrings, runtime.limits);
		expect(absent.request).toEqual({
			operation: "get",
			flags: [{ name: "--output", value: "wide" }],
			positionals: ["pods"],
		});
		expect(absent.options).toMatchObject({ selection: "head", keepHeader: true });

		const fileOutputs = [
			"jsonpath-file=/etc/passwd",
			"go-template-file=/tmp/template",
			"custom-columns-file=/tmp/columns",
			"templatefile=/tmp/template",
		];
		for (const output of fileOutputs) {
			expect(getSpec.validate({ resource: "pods", output })).toEqual(
				expect.stringContaining('Invalid parameter "output"'),
			);
		}
	});

	it("describes exactly the schema", () => {
		const properties = Object.entries<object>(getSpec.parameters.properties);
		expect(properties.map(([name]) => name)).toEqual([
			"resource",
			"name",
			"namespace",
			"allNamespaces",
			"labelSelector",
			"fieldSelector",
			"sortByJsonPath",
			"output",
		]);
		expect(getSpec.name).toBe("k8s_get");
		expect(getSpec.label).toBe("k8s get");
		expect(getSpec.promptSnippet).toBe("'kubectl get' on the session cluster, read-only");
		expect(getSpec.description).toBe(
			"'kubectl get' on the cluster bound to this session. Returns stdout as is. Long output is cut and saved to a file; the notice says how to read the rest.",
		);
		const descriptions = Object.fromEntries(
			properties.flatMap(([name, schema]) => ("description" in schema ? [[name, schema.description]] : [])),
		);
		expect(Object.keys(descriptions)).toEqual([
			"resource",
			"name",
			"namespace",
			"labelSelector",
			"fieldSelector",
			"sortByJsonPath",
			"output",
		]);
		expect(descriptions.resource).toBe(
			"Resource types: plural, short name, type.group for CRDs, a category like all, or several separated by commas.",
		);
		expect(descriptions.name).toBe("Exact object name. Empty means not set.");
		expect(descriptions.labelSelector).toBe("Label selector. Empty means not set.");
		expect(descriptions.sortByJsonPath).toBe("JSONPath expression to sort by. Empty means not set.");
		expect(descriptions.output).toBe(
			"wide | yaml | json | name | jsonpath=<expr> | custom-columns=<spec>. Default wide; yaml when name is set. Empty means not set.",
		);
		expect(String(descriptions.fieldSelector)).toMatch(/ Empty means not set\.$/);
		expect(descriptions.namespace).toBe(
			"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.",
		);
	});
});
