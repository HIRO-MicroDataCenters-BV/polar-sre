import { realpath, stat } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { READ_MAX_BYTES } from "../../shared/store.ts";
import type { FileReadDenial, FileReadDenialKind, FileReadRequest, SessionPaths } from "./types.ts";

export type GateDecision = { allow: FileReadRequest } | { deny: FileReadDenial };

const DENIAL_MESSAGE = "read is limited to the session output directory";
const NOT_TEXT_MESSAGE = "File is not a text output file.";
const TOO_LARGE_MESSAGE = "File exceeds the 16 MiB read limit.";
const TEXT_SUFFIX = ".txt";

function requestedPath(path: string, session: SessionPaths): string {
	return path.includes(sep) ? resolve(session.cwd, path) : join(session.outputDirectory, path);
}

async function resolveRealPath(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function regularFileSize(filePath: string): Promise<number | undefined> {
	try {
		const stats = await stat(filePath);
		return stats.isFile() ? stats.size : undefined;
	} catch {
		return undefined;
	}
}

function isInside(directory: string, filePath: string): boolean {
	const relativePath = relative(directory, filePath);
	const leavesDirectory = relativePath === ".." || relativePath.startsWith(`..${sep}`);
	return relativePath !== "" && !leavesDirectory && !isAbsolute(relativePath);
}

function deny(kind: FileReadDenialKind, message = DENIAL_MESSAGE): GateDecision {
	return { deny: { kind, message } };
}

export async function gateFileRead(call: FileReadRequest, session: SessionPaths): Promise<GateDecision> {
	const filePath = await resolveRealPath(requestedPath(call.path, session));
	const outputDirectory = await resolveRealPath(session.outputDirectory);
	if (filePath === undefined || outputDirectory === undefined) {
		return deny("unresolved");
	}
	const size = await regularFileSize(filePath);
	if (size === undefined) {
		return deny("not_a_regular_file");
	}
	if (!isInside(outputDirectory, filePath)) {
		return deny("outside_session");
	}
	if (!filePath.endsWith(TEXT_SUFFIX)) {
		return deny("not_a_text_file", NOT_TEXT_MESSAGE);
	}
	if (size > READ_MAX_BYTES) {
		return deny("too_large", TOO_LARGE_MESSAGE);
	}
	return { allow: { ...call, path: filePath } };
}
