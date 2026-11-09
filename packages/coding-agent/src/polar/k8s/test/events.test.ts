import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { kubectlCommandLabel } from "../src/kubectl.ts";
import { buildEventsCall, type EventsParams, eventsSpec } from "../src/tools/events.ts";
import type { KubectlReadRequest, ReplyOptions } from "../src/types.ts";
import { runtime } from "./fixtures.ts";

const namespaceText =
	'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';

describe("k8s_events", () => {
	it("validates the invocation shape", () => {
		const fiveParameters: EventsParams = {
			namespace: "shop",
			allNamespaces: false,
			kind: "pod",
			name: "web-0",
			types: "Normal",
		};
		expect(Value.Check(eventsSpec.parameters, fiveParameters)).toBe(true);
		expect(eventsSpec.validate(fiveParameters)).toBeUndefined();

		const errorPaths = (args: unknown) =>
			Value.Errors(eventsSpec.parameters, args).map((error) => error.instancePath);
		expect(errorPaths({ for: "pod/web-0" })).toContain("/for");
		expect(errorPaths({ allNamespaces: "yes" })).toEqual(["/allNamespaces"]);
		expect(errorPaths({ types: "warning" })).toEqual(["/types"]);

		const oneType =
			'Invalid parameter "kind": give one resource type (pod, deployment, pvc, or type.group); pass the object name as name and flags as separate parameters.';
		for (const kind of ["pod/web-0", "pod/", "/web-0", "pod web-0", "pods,svc", "-n shop"]) {
			expect(eventsSpec.validate({ kind, name: "web-0" }), JSON.stringify(kind)).toBe(oneType);
		}
		const oneName =
			'Invalid parameter "name": give one object name without spaces or slashes; pass the type as kind and flags as separate parameters.';
		for (const name of ["web-0 -n shop", "pod/web-0", "web-0\n"]) {
			expect(eventsSpec.validate({ kind: "pod", name }), JSON.stringify(name)).toBe(oneName);
		}
		expect(eventsSpec.validate({ namespace: "Shop" })).toBe(namespaceText);
		expect(eventsSpec.validate({ kind: "pod/web-0" })).toBe(oneType);

		const kindNeedsName = 'Invalid parameter "name": kind needs name; give both or neither.';
		const nameNeedsKind = 'Invalid parameter "kind": name needs kind; give both or neither.';
		expect(eventsSpec.validate({ kind: "pod" })).toBe(kindNeedsName);
		expect(eventsSpec.validate({ kind: "pod", name: "" })).toBe(kindNeedsName);
		expect(eventsSpec.validate({ name: "web-0" })).toBe(nameNeedsKind);
		expect(eventsSpec.validate({ kind: "", name: "web-0" })).toBe(nameNeedsKind);
	});

	it("delegates Kubernetes validation", () => {
		const params: EventsParams = {
			namespace: "no-such-namespace",
			allNamespaces: true,
			kind: "deployments.apps",
			name: "Not_A_DNS_Name",
			types: "Normal",
		};
		expect(eventsSpec.validate(params)).toBeUndefined();
		const call = eventsSpec.buildCall(params, runtime.limits);

		const request: KubectlReadRequest = {
			operation: "events",
			flags: [
				{ name: "--namespace", value: "no-such-namespace" },
				{ name: "--all-namespaces" },
				{ name: "--for", value: "deployments.apps/Not_A_DNS_Name" },
				{ name: "--types", value: "Normal" },
			],
			positionals: [],
		};
		expect(call.request).toEqual(request);
		expect(call.tool).toBe("k8s_events");
		expect(call.commandLabel).toBe(kubectlCommandLabel(request));

		const emptyStrings: EventsParams = { namespace: "", kind: "", name: "" };
		expect(eventsSpec.validate(emptyStrings)).toBeUndefined();
		expect(eventsSpec.buildCall(emptyStrings, runtime.limits).request).toEqual({
			operation: "events",
			flags: [{ name: "--types", value: "Warning" }],
			positionals: [],
		});
	});

	it("applies the Warning default", () => {
		const flagsOf = (params: EventsParams) => buildEventsCall(params, runtime.limits).request.flags;
		expect(flagsOf({})).toEqual([{ name: "--types", value: "Warning" }]);
		expect(flagsOf({ types: "all" })).toEqual([]);
		expect(flagsOf({ types: "Normal" })).toEqual([{ name: "--types", value: "Normal" }]);
		expect(flagsOf({ kind: "pod", name: "web-0" })).toEqual([
			{ name: "--for", value: "pod/web-0" },
			{ name: "--types", value: "Warning" },
		]);
	});

	it("keeps the newest rows", () => {
		const newestRows: ReplyOptions = {
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "tail",
			keepHeader: true,
		};
		const namespaceWide = buildEventsCall({ namespace: "shop" }, runtime.limits);
		expect(namespaceWide.options).toEqual(newestRows);
		const oneObject = buildEventsCall({ namespace: "shop", kind: "pod", name: "web-0" }, runtime.limits);
		expect(oneObject.options).toEqual(newestRows);
	});

	it("describes exactly the schema", () => {
		const properties = Object.entries<object>(eventsSpec.parameters.properties);
		expect(properties.map(([name]) => name)).toEqual(["namespace", "allNamespaces", "kind", "name", "types"]);
		expect(eventsSpec.description).toBe(
			"'kubectl events' on the cluster bound to this session: Warning events by default, newest last. Long output is cut to the newest rows and saved to a file; the notice says how to read the rest.",
		);
		expect(eventsSpec.promptSnippet).toBe("'kubectl events' on the session cluster, Warning by default");
		const descriptions = properties.flatMap(([name, schema]) =>
			"description" in schema ? [[name, schema.description]] : [],
		);
		expect(descriptions).toEqual([
			[
				"namespace",
				"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.",
			],
			[
				"kind",
				"Resource type of one namespaced object: pod, deployment, pvc, or type.group; one type only. Needs name. Empty means not set.",
			],
			["name", "Exact object name; needs kind. Empty means not set."],
			["types", "Default Warning."],
		]);
		expect(eventsSpec.parameters.properties.types).toEqual({
			type: "string",
			enum: ["Warning", "Normal", "all"],
			description: "Default Warning.",
		});
		expect(eventsSpec.name).toBe("k8s_events");
		expect(eventsSpec.label).toBe("k8s events");
	});
});
