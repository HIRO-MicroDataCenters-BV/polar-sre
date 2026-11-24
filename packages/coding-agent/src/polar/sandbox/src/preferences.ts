import { randomBytes } from "crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { getAgentDir } from "../../../config.ts";

export interface SandboxPreferences {
	disabled?: boolean;
	autoStartService?: boolean;
}

const PREFERENCES_FILE = "sandbox.json";

function preferencesPath(): string {
	return join(getAgentDir(), PREFERENCES_FILE);
}

async function readRawPreferences(path: string): Promise<Record<string, unknown>> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? { ...(parsed as Record<string, unknown>) }
			: {};
	} catch {
		return {};
	}
}

function toPreferences(raw: Record<string, unknown>): SandboxPreferences {
	const preferences: SandboxPreferences = {};
	if (typeof raw.disabled === "boolean") preferences.disabled = raw.disabled;
	if (typeof raw.autoStartService === "boolean") preferences.autoStartService = raw.autoStartService;
	return preferences;
}

export async function readSandboxPreferences(): Promise<SandboxPreferences> {
	return toPreferences(await readRawPreferences(preferencesPath()));
}

export async function updateSandboxPreferences(patch: Partial<SandboxPreferences>): Promise<SandboxPreferences> {
	const dir = getAgentDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const targetPath = join(dir, PREFERENCES_FILE);
	const current = await readRawPreferences(targetPath);
	if (patch.disabled !== undefined) current.disabled = patch.disabled;
	if (patch.autoStartService !== undefined) current.autoStartService = patch.autoStartService;
	const tmpPath = join(dir, `.${PREFERENCES_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(tmpPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(tmpPath, 0o600);
		await rename(tmpPath, targetPath);
	} catch (error) {
		await rm(tmpPath, { force: true });
		throw error;
	}
	return toPreferences(current);
}
