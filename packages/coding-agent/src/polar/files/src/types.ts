export type { SessionHandle, SessionPaths } from "../../shared/session.ts";

export interface FileReadRequest {
	path: string;
	offset?: number;
	limit?: number;
}

export type FileReadDenialKind =
	| "unresolved"
	| "not_a_regular_file"
	| "outside_session"
	| "not_a_text_file"
	| "too_large";

export interface FileReadDenial {
	kind: FileReadDenialKind;
	message: string;
}
