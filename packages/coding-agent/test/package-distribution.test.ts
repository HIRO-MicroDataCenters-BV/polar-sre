import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { "polar-sre": string };
	main?: string;
	types?: string;
	exports?: Record<string, unknown>;
	dependencies: Record<string, string>;
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("exposes only the bundled CLI entrypoint with zero runtime dependencies", () => {
		expect(packageJson.bin["polar-sre"]).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBeUndefined();
		expect(packageJson.types).toBeUndefined();
		expect(packageJson.exports).toBeUndefined();
		expect(packageJson.dependencies).toEqual({});
	});
});
