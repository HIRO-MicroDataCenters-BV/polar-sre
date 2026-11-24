import { deadlineAfter } from "./cli.ts";
import type { HostDiagnosis, ImageSpec, SandboxHost } from "./types.ts";

export const SANDBOX_OFF_STATUS = "sandbox: off, run /sandbox";

export interface BuildImageSpecOptions {
	customImage?: boolean;
	registryImage?: string;
	defaultRegistryImage?: string;
}

export function buildImageSpec(image: string, options: BuildImageSpecOptions = {}): ImageSpec {
	const customImage = options.customImage ?? false;
	const pull = options.registryImage ?? (customImage ? image : options.defaultRegistryImage);
	const candidates = pull !== undefined && pull !== image ? [pull, image] : [image];
	return pull === undefined ? { candidates, build: image } : { candidates, pull, build: image };
}

export function formatDiagnosisWarning(diagnosis: Exclude<HostDiagnosis, { kind: "ready" }>): string {
	switch (diagnosis.kind) {
		case "unsupported":
		case "runtime_missing":
		case "runtime_not_ready":
		case "image_missing":
		case "probe_failed":
			return `sandbox is off: ${diagnosis.reason}`;
	}
}

export async function probeHost(host: SandboxHost): Promise<HostDiagnosis> {
	const runtime = await host.driver.probeRuntime();
	if (runtime.kind !== "ready") return runtime;
	const { candidates, build } = host.imageSpec;
	let lastReason = "";
	for (const candidate of candidates) {
		const inspected = await host.driver.inspectImage(candidate, deadlineAfter(host));
		if (inspected.found) {
			const diagnosis: HostDiagnosis = { kind: "ready", image: candidate };
			if (runtime.version !== undefined) diagnosis.version = runtime.version;
			if (runtime.repair !== undefined) diagnosis.repair = runtime.repair;
			return diagnosis;
		}
		lastReason = inspected.reason;
	}
	const detail = lastReason === "" ? "" : ` (${lastReason})`;
	return {
		kind: "image_missing",
		reason: `image ${build} is not installed${detail}`,
		remedy: host.driver.imageRemedy(host.imageSpec),
	};
}
