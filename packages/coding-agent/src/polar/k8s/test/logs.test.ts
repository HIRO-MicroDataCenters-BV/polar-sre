import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { kubectlCommandLabel } from "../src/kubectl.ts";
import { buildLogsCall, type LogsParams, logsSpec } from "../src/tools/logs.ts";
import type { KubectlReadRequest, ReplyOptions } from "../src/types.ts";
import { runtime } from "./fixtures.ts";

const namespaceText =
	'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';

describe("k8s_logs", () => {
	it("validates the invocation shape", () => {
		const sevenParameters: LogsParams = {
			pod: "web-0",
			namespace: "shop",
			container: "app",
			previous: true,
			tail: 200,
			since: "5m",
			timestamps: true,
		};
		expect(Value.Check(logsSpec.parameters, sevenParameters)).toBe(true);
		expect(logsSpec.validate(sevenParameters)).toBeUndefined();

		const errorPaths = (args: unknown) => Value.Errors(logsSpec.parameters, args).map((error) => error.instancePath);
		expect(errorPaths({ pod: "web-0", follow: true })).toContain("/follow");
		expect(errorPaths({ pod: "web-0", previous: "yes" })).toEqual(["/previous"]);
		expect(errorPaths({ pod: "web-0", tail: -1 })).toEqual(["/tail"]);

		const onePod =
			'Invalid parameter "pod": give one pod name without spaces or slashes; pass flags as separate parameters and list the pods of a workload with k8s_get.';
		for (const pod of ["pod/web-0", "deploy/web", "web-0 -c app --previous", "web-0\n", "", "-c app"]) {
			expect(logsSpec.validate({ pod }), JSON.stringify(pod)).toBe(onePod);
		}
		expect(logsSpec.validate({ pod: "web-0", namespace: "Shop" })).toBe(namespaceText);
		expect(logsSpec.validate({ pod: "web-0", container: "a b" })).toBeUndefined();
	});

	it("delegates Kubernetes validation", () => {
		const params: LogsParams = {
			pod: "Not_A_DNS_Name",
			namespace: "no-such-namespace",
			container: "no-such",
			previous: true,
			tail: 0,
			since: "5",
			timestamps: true,
		};
		expect(logsSpec.validate(params)).toBeUndefined();
		const call = logsSpec.buildCall(params, runtime.limits);

		const request: KubectlReadRequest = {
			operation: "logs",
			flags: [
				{ name: "--namespace", value: "no-such-namespace" },
				{ name: "--container", value: "no-such" },
				{ name: "--previous" },
				{ name: "--tail", value: "0" },
				{ name: "--since", value: "5" },
				{ name: "--timestamps" },
			],
			positionals: ["Not_A_DNS_Name"],
		};
		expect(call.request).toEqual(request);
		expect(call.tool).toBe("k8s_logs");
		expect(call.commandLabel).toBe(kubectlCommandLabel(request));
	});

	it("sends no defaults", () => {
		const requestOf = (params: LogsParams) => buildLogsCall(params, runtime.limits).request;
		expect(requestOf({ pod: "web-0" })).toEqual({ operation: "logs", flags: [], positionals: ["web-0"] });
		expect(requestOf({ pod: "web-0", previous: false, timestamps: false }).flags).toEqual([]);
		expect(requestOf({ pod: "web-0", namespace: "", container: "", since: "" }).flags).toEqual([]);
	});

	it("keeps the newest lines", () => {
		const newestLines: ReplyOptions = {
			maxLines: runtime.limits.replyMaxLines,
			maxBytes: runtime.limits.replyMaxBytes,
			selection: "tail",
			keepHeader: false,
		};
		expect(buildLogsCall({ pod: "web-0" }, runtime.limits).options).toEqual(newestLines);
		expect(buildLogsCall({ pod: "web-0" }, runtime.limits).timeoutMs).toBe(runtime.limits.logsTimeoutMs);
	});

	it("describes exactly the schema", () => {
		const properties = Object.entries<object>(logsSpec.parameters.properties);
		expect(properties.map(([name]) => name)).toEqual([
			"pod",
			"namespace",
			"container",
			"previous",
			"tail",
			"since",
			"timestamps",
		]);
		expect(logsSpec.description).toBe(
			"'kubectl logs' on the cluster bound to this session: the log of one container in one pod, oldest line first. Long output is cut to the newest lines and saved to a file; the notice says how to read the rest.",
		);
		expect(logsSpec.promptSnippet).toBe("'kubectl logs' on the session cluster: the log of one container in a pod");
		const descriptions = properties.flatMap(([name, schema]) =>
			"description" in schema ? [[name, schema.description]] : [],
		);
		expect(descriptions).toEqual([
			["pod", "Exact pod name."],
			[
				"namespace",
				"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.",
			],
			["container", "Defaults to the pod's default container. Empty means not set."],
			["since", "Only lines newer than a duration like 5s, 2m, or 3h. Empty means not set."],
		]);
		expect(logsSpec.name).toBe("k8s_logs");
		expect(logsSpec.label).toBe("k8s logs");
	});
});
