import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { POLAR_DEFAULT_EXTENSION_SPECIFIERS, polarBuiltInExtensions } from "../../extensions/index.ts";

const EXTENSIONS_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARED = "shared";
const EXTENSIONS = readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && entry.name !== SHARED && entry.name !== "test")
	.map((entry) => entry.name)
	.sort();

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const MOCKED_MODULE = /\bvi\.(?:mock|doMock)\s*\(\s*["']([^"']+)["']/g;

interface ImportEdge {
	from: string;
	to: string;
}

function moduleFiles(area: string): string[] {
	return readdirSync(join(EXTENSIONS_ROOT, area), { recursive: true, encoding: "utf8" })
		.filter((path) => /\.(?:ts|mjs)$/.test(path) && !path.split("/").includes("node_modules"))
		.map((path) => `${area}/${path}`);
}

function readModule(file: string): string {
	return readFileSync(join(EXTENSIONS_ROOT, file), "utf8");
}

function areaOf(file: string): string {
	return file.split("/")[0];
}

function isTest(file: string): boolean {
	return file.split("/").includes("test");
}

function importEdges(file: string): ImportEdge[] {
	const text = readModule(file);
	const specifiers = [STATIC_IMPORT, DYNAMIC_IMPORT, MOCKED_MODULE].flatMap((pattern) =>
		[...text.matchAll(pattern)].map((match) => match[1]),
	);
	return specifiers
		.filter((specifier) => specifier.startsWith("."))
		.map((specifier) => ({
			from: file,
			to: relative(EXTENSIONS_ROOT, resolve(dirname(join(EXTENSIONS_ROOT, file)), specifier)),
		}));
}

function crossesAreas({ from, to }: ImportEdge): boolean {
	const fromArea = areaOf(from);
	const toArea = areaOf(to);
	if (fromArea === SHARED) return EXTENSIONS.includes(toArea);
	return EXTENSIONS.includes(toArea) && toArea !== fromArea;
}

function describeEdge({ from, to }: ImportEdge): string {
	return `${from} -> ${to}`;
}

describe("independence", () => {
	it("extensions and shared import only downwards", () => {
		const edges = [...EXTENSIONS, SHARED].flatMap(moduleFiles).flatMap(importEdges);

		expect(edges.map(describeEdge)).toEqual(
			expect.arrayContaining([
				"files/index.ts -> files/src/gate.ts",
				"shared/test/tool.test.ts -> shared/tool.ts",
				"k8s/test/extension.test.ts -> shared/tool.ts",
			]),
		);
		const crossing = edges.filter(crossesAreas).map(describeEdge);
		expect(crossing, `imports across extensions:\n${crossing.join("\n")}`).toEqual([]);
	});

	it("no extension reads the tool set or hooks a tool of another extension", () => {
		const sources = [...EXTENSIONS, SHARED].flatMap(moduleFiles).filter((file) => !isTest(file));
		const hooksToolCalls = (file: string) => /["'`]tool_call["'`]/.test(readModule(file));

		expect(sources.filter((file) => readModule(file).includes("getActiveTools"))).toEqual([]);
		expect(sources.filter(hooksToolCalls)).toEqual(["files/index.ts"]);
	});

	it("every Polar extension directory is registered as a built-in extension", () => {
		expect(EXTENSIONS).toEqual(["files", "k8s", "sandbox"]);
		expect(polarBuiltInExtensions.map((ext) => ext.name).sort()).toEqual(EXTENSIONS);
		expect(polarBuiltInExtensions.every((ext) => ext.builtin === true)).toBe(true);
		expect([...POLAR_DEFAULT_EXTENSION_SPECIFIERS].sort()).toEqual(EXTENSIONS.map((name) => `builtin:${name}`));
	});
});
