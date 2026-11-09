import type { ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import execExtension from "../polar/exec/index.ts";
import filesExtension from "../polar/files/index.ts";
import k8sExtension from "../polar/k8s/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const polarBuiltInExtensions: ReadonlyArray<{ name: string; factory: ExtensionFactory; builtin: true }> = [
	{ name: "files", factory: filesExtension, builtin: true },
	{ name: "k8s", factory: k8sExtension, builtin: true },
	{ name: "exec", factory: execExtension, builtin: true },
];

export const POLAR_DEFAULT_EXTENSION_SPECIFIERS: readonly string[] = polarBuiltInExtensions.map(
	(ext) => `builtin:${ext.name}`,
);

export const POLAR_EXCLUDED_BUILTIN_TOOLS = [
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"powershell",
	"codemode",
	"tool_search",
] as const;

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	...polarBuiltInExtensions,
];
