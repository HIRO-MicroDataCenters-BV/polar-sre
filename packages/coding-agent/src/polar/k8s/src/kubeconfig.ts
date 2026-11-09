import { execFile } from "child_process";
import { delimiter } from "path";
import { kubectlEnvironment } from "./kubectl.ts";

export interface KubeContextItem {
	context: string;
	cluster: string;
	user: string;
	namespace?: string;
	kubeconfigPath: string;
	isCurrentInFile: boolean;
}

export interface DiscoveryError {
	kubeconfigPath: string;
	message: string;
}

export interface DiscoveryResult {
	items: KubeContextItem[];
	errors: DiscoveryError[];
}

interface RawContextEntry {
	name?: unknown;
	context?: {
		cluster?: unknown;
		user?: unknown;
		namespace?: unknown;
	} | null;
}

interface RawConfigView {
	"current-context"?: unknown;
	contexts?: unknown;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_CONFIG_BUFFER_BYTES = 16 * 1024 * 1024;

export function splitKubeconfigPaths(value: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const segment of value.split(delimiter)) {
		if (segment === "" || seen.has(segment)) continue;
		seen.add(segment);
		result.push(segment);
	}
	return result;
}

export async function discoverKubeContexts(
	paths: readonly string[],
	kubectlCommand = "kubectl",
	env: NodeJS.ProcessEnv = process.env,
	timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
): Promise<DiscoveryResult> {
	const items: KubeContextItem[] = [];
	const errors: DiscoveryError[] = [];

	for (const kubeconfigPath of paths) {
		try {
			const stdout = await runConfigView(kubeconfigPath, kubectlCommand, env, timeoutMs);
			const parsed = parseConfigView(stdout, kubeconfigPath);
			items.push(...parsed);
		} catch (error) {
			errors.push({
				kubeconfigPath,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { items, errors };
}

function runConfigView(
	kubeconfigPath: string,
	kubectlCommand: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			kubectlCommand,
			[`--kubeconfig=${kubeconfigPath}`, "config", "view", "--output=json"],
			{
				env: kubectlEnvironment(env, kubeconfigPath),
				signal: AbortSignal.timeout(timeoutMs),
				maxBuffer: MAX_CONFIG_BUFFER_BYTES,
			},
			(error, stdout, stderr) => {
				if (error) {
					const stderrText = stderr.trim();
					if (stderrText !== "") {
						reject(new Error(stderrText));
						return;
					}
					reject(new Error(error.message));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

function parseConfigView(stdout: string, kubeconfigPath: string): KubeContextItem[] {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`Invalid JSON from kubectl config view: ${(error as Error).message}`);
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("Invalid config view output: expected a JSON object");
	}

	const config = raw as RawConfigView;
	const currentContext = typeof config["current-context"] === "string" ? config["current-context"] : "";
	const rawContexts = config.contexts;

	if (rawContexts === undefined || rawContexts === null) {
		return [];
	}
	if (!Array.isArray(rawContexts)) {
		throw new Error("Invalid config view output: contexts must be an array");
	}

	const items: KubeContextItem[] = [];
	for (const entry of rawContexts as RawContextEntry[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const name = typeof entry.name === "string" ? entry.name : "";
		if (name === "") continue;
		const details = typeof entry.context === "object" && entry.context !== null ? entry.context : {};
		const cluster = typeof details.cluster === "string" ? details.cluster : "";
		const user = typeof details.user === "string" ? details.user : "";
		const namespace =
			typeof details.namespace === "string" && details.namespace !== "" ? details.namespace : undefined;

		items.push({
			context: name,
			cluster,
			user,
			...(namespace !== undefined ? { namespace } : {}),
			kubeconfigPath,
			isCurrentInFile: name === currentContext,
		});
	}

	return items;
}
