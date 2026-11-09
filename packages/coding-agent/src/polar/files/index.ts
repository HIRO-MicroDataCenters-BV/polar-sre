import { Type } from "typebox";
import {
	type AgentToolResult,
	type ExtensionAPI,
	isToolCallEventType,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "../../core/extensions/types.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { acquireSession } from "../shared/session.ts";
import { type ManifestEntry, readManifest } from "../shared/store.ts";
import { gateFileRead } from "./src/gate.ts";
import type { SessionHandle } from "./src/types.ts";

export const EMPTY_NOTICE = "No output files saved in this session.";

const NOT_STARTED = "The session has not started.";

const READ_LIMIT_SENTENCE = "Reads files up to 16 MiB.";

const TABLE_HEADER = ["| File | Command | Size | Status | Created |", "|---|---|---|---|---|"];

export function renderFileTable(entries: ManifestEntry[]): string {
	if (entries.length === 0) return EMPTY_NOTICE;
	const rows = entries.map(
		(entry) =>
			`| ${entry.file} | ${tableCell(entry.command)} | ${formatSize(entry.size)} | ${entry.status} | ${entry.createdAt} |`,
	);
	return [...TABLE_HEADER, ...rows].join("\n");
}

function tableCell(text: string): string {
	return text.replaceAll("|", "\\|");
}

function textResult(text: string, isError: boolean): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

export function describeRead(loadout: ToolLoadout): ToolLoadoutChanges | undefined {
	const read = loadout.declared.find((tool) => tool.name === "read");
	if (read === undefined) return undefined;
	return { descriptions: { read: `${read.description} ${READ_LIMIT_SENTENCE}` } };
}

export default function filesExtension(pi: ExtensionAPI): void {
	let handle: SessionHandle | undefined;

	pi.registerTool({
		name: "list_files",
		label: "list files",
		description:
			"The output files saved in this session, one row per file: name, the command that produced it, size, status (complete or truncated) and creation time. Read a file with read.",
		promptSnippet: "the output files saved in this session and the commands that produced them",
		parameters: Type.Object({}, { additionalProperties: false }),
		annotations: { readOnlyHint: true },
		prepareLoadout: describeRead,
		async execute() {
			if (handle === undefined) return textResult(NOT_STARTED, true);
			return textResult(renderFileTable(await readManifest(handle.paths)), false);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		handle = await acquireSession(ctx.sessionManager.getSessionId(), ctx.cwd);
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("read", event)) return undefined;
		if (handle === undefined) return { block: true, reason: NOT_STARTED };
		const decision = await gateFileRead(event.input, handle.paths);
		if ("deny" in decision) return { block: true, reason: decision.deny.message };
		event.input.path = decision.allow.path;
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		if (handle === undefined) return;
		await handle.release();
		handle = undefined;
	});
}
