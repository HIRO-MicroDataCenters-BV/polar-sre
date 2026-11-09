import { describe, expect, it } from "vitest";
import { isObjectName, isTypeToken, NAMESPACE_DESCRIPTION, namespaceError } from "../src/validation.ts";

describe("validation", () => {
	it("accepts one type token", () => {
		for (const token of ["pods", "po", "deployments.apps", "certificates.cert-manager.io", "all", "PodMetrics"]) {
			expect(isTypeToken(token), token).toBe(true);
		}
		for (const pasted of [
			"pods,svc",
			"pod/web-0",
			"pods web-0",
			"pods\tweb-0",
			"pods\n",
			"-n",
			"--all-namespaces",
			"",
			" pods",
		]) {
			expect(isTypeToken(pasted), JSON.stringify(pasted)).toBe(false);
		}
	});

	it("accepts one object name", () => {
		for (const name of ["web-0", "system:node", "web.example.com", "Not_A_DNS_Name"]) {
			expect(isObjectName(name), name).toBe(true);
		}
		for (const pasted of ["web-0 -n shop", "pod/web-0", "web-0\n", "web-0\t", "-dash-first", "-n", "", " "]) {
			expect(isObjectName(pasted), JSON.stringify(pasted)).toBe(false);
		}
	});

	it("checks the namespace name", () => {
		for (const namespace of [undefined, "", "shop", "kube-system", "a", "a1-b2", "a".repeat(63)]) {
			expect(namespaceError(namespace), String(namespace)).toBeUndefined();
		}
		const text =
			'Invalid parameter "namespace": give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit; pass flags as separate parameters.';
		for (const wrong of ["Shop", "kube_system", "-shop", "shop-", "shop -l app=web", "shop\n", "a".repeat(64)]) {
			expect(namespaceError(wrong), JSON.stringify(wrong)).toBe(text);
		}
		expect(NAMESPACE_DESCRIPTION).toBe(
			"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.",
		);
	});
});
