import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_MAX_BYTES } from "../../shared/store.ts";
import { gateFileRead } from "../src/gate.ts";
import type { FileReadDenialKind, SessionPaths } from "../src/types.ts";

let root: string;
let session: SessionPaths;

async function createFile(filePath: string, size?: number): Promise<string> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, "output\n");
	if (size !== undefined) await truncate(filePath, size);
	return filePath;
}

async function decisionKind(path: string, paths: SessionPaths = session): Promise<"allow" | FileReadDenialKind> {
	const decision = await gateFileRead({ path }, paths);
	return "allow" in decision ? "allow" : decision.deny.kind;
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "files-gate-")));
	session = {
		sessionId: "current",
		cwd: join(root, "workspace"),
		outputDirectory: join(root, "polar-artifacts", "current"),
	};
	await mkdir(session.cwd);
	await mkdir(session.outputDirectory, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("gateFileRead", () => {
	it("allows session files", async () => {
		const getOutput = await createFile(join(session.outputDirectory, "k8s_get-1.txt"));
		const otherToolOutput = await createFile(join(session.outputDirectory, "other_tool-2.txt"));
		const nameStartingWithDots = await createFile(join(session.outputDirectory, "..notes.txt"));

		expect(await decisionKind(getOutput)).toBe("allow");
		expect(await decisionKind(otherToolOutput)).toBe("allow");
		expect(await decisionKind(nameStartingWithDots)).toBe("allow");
		expect(await gateFileRead({ path: "k8s_get-1.txt" }, session)).toStrictEqual({
			allow: { path: getOutput },
		});
	});

	it("denies paths outside the session", async () => {
		const otherSessionOutput = await createFile(join(root, "polar-artifacts", "other", "k8s_get-1.txt"));
		await createFile(join(session.cwd, "notes.txt"));

		expect(await decisionKind(otherSessionOutput)).toBe("outside_session");
		expect(await decisionKind("./notes.txt")).toBe("outside_session");
		expect(await decisionKind("notes.txt")).toBe("unresolved");
	});

	it("rejects traversal, prefix and symlink escapes", async () => {
		const outside = join(root, "outside");
		const secret = await createFile(join(outside, "secret.txt"));
		const prefixSibling = await createFile(`${session.outputDirectory}-evil/secret.txt`);
		await symlink(secret, join(session.outputDirectory, "secret-link.txt"));
		await symlink(outside, join(session.outputDirectory, "outside-link"));

		expect(await decisionKind(`${session.outputDirectory}/../../outside/secret.txt`)).toBe("outside_session");
		expect(await decisionKind(prefixSibling)).toBe("outside_session");
		expect(await decisionKind(join(session.outputDirectory, "secret-link.txt"))).toBe("outside_session");
		expect(await decisionKind("secret-link.txt")).toBe("outside_session");
		expect(await decisionKind(join(session.outputDirectory, "outside-link", "secret.txt"))).toBe("outside_session");
	});

	it("fails closed for unreadable targets", async () => {
		const existingFile = await createFile(join(session.cwd, "notes.txt"));
		const sessionWithoutOutputDirectory = { ...session, outputDirectory: join(root, "polar-artifacts", "unsaved") };
		await symlink(join(root, "missing.txt"), join(session.outputDirectory, "dangling-link.txt"));
		await symlink("/dev/null", join(session.outputDirectory, "device-link"));
		await mkdir(join(session.outputDirectory, "reports"));

		expect(await decisionKind(join(session.outputDirectory, "missing.txt"))).toBe("unresolved");
		expect(await decisionKind(join(session.outputDirectory, "dangling-link.txt"))).toBe("unresolved");
		expect(await decisionKind(existingFile, sessionWithoutOutputDirectory)).toBe("unresolved");
		expect(await decisionKind(session.outputDirectory)).toBe("not_a_regular_file");
		expect(await decisionKind(join(session.outputDirectory, "reports"))).toBe("not_a_regular_file");
		expect(await decisionKind(join(session.outputDirectory, "device-link"))).toBe("not_a_regular_file");
	});

	it("denies non-text files after the boundary check", async () => {
		const binInside = await createFile(join(session.outputDirectory, "k8s_inspect-1.bin"));
		const partInside = await createFile(join(session.outputDirectory, "k8s_logs-2.part"));
		const binOutside = await createFile(join(root, "polar-artifacts", "other", "k8s_inspect-1.bin"));

		const notText = { deny: { kind: "not_a_text_file", message: "File is not a text output file." } };
		expect(await gateFileRead({ path: binInside }, session)).toStrictEqual(notText);
		expect(await gateFileRead({ path: "k8s_inspect-1.bin" }, session)).toStrictEqual(notText);
		expect(await gateFileRead({ path: partInside }, session)).toStrictEqual(notText);
		expect(await gateFileRead({ path: "k8s_logs-2.part" }, session)).toStrictEqual(notText);
		expect(await gateFileRead({ path: binOutside }, session)).toStrictEqual({
			deny: { kind: "outside_session", message: "read is limited to the session output directory" },
		});
	});

	it("limits the file size to 16 MiB", async () => {
		const atLimit = await createFile(join(session.outputDirectory, "k8s_logs-1.txt"), READ_MAX_BYTES);
		const overLimit = await createFile(join(session.outputDirectory, "k8s_logs-2.txt"), READ_MAX_BYTES + 1);
		const outside = await createFile(join(root, "polar-artifacts", "other", "k8s_logs-1.txt"), READ_MAX_BYTES + 1);

		expect(READ_MAX_BYTES).toBe(16_777_216);
		expect(await decisionKind(atLimit)).toBe("allow");
		const tooLarge = { deny: { kind: "too_large", message: "File exceeds the 16 MiB read limit." } };
		expect(await gateFileRead({ path: overLimit, offset: 1, limit: 10 }, session)).toStrictEqual(tooLarge);
		expect(await gateFileRead({ path: "k8s_logs-2.txt" }, session)).toStrictEqual(tooLarge);
		expect(await decisionKind(outside)).toBe("outside_session");
	});

	it("preserves paging on allowed paths", async () => {
		const getOutput = await createFile(join(session.outputDirectory, "k8s_get-1.txt"));
		const linkedOutputDirectory = join(root, "linked-output");
		await symlink(session.outputDirectory, linkedOutputDirectory);
		const linkedSession = { ...session, outputDirectory: linkedOutputDirectory };
		const relativePath = "../linked-output/k8s_get-1.txt";

		expect(await gateFileRead({ path: relativePath, offset: 120, limit: 40 }, linkedSession)).toStrictEqual({
			allow: { path: getOutput, offset: 120, limit: 40 },
		});
		expect(await gateFileRead({ path: relativePath }, linkedSession)).toStrictEqual({
			allow: { path: getOutput },
		});
	});
});
