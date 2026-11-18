import { stripVTControlCharacters } from "util";

export interface ImageProgress {
	activity?: string;
	step?: { index: number; total: number };
	fraction?: number;
	amount?: { done: number; total: number; unit: "megabytes" | "layers" };
	line: string;
}

// container image pull: "[1/2] Fetching image 10% (22 of 97 blobs, 14,0/128,5 MB, 11 KB/s) [5s]"
const STEP = /^\[(\d+)\/(\d+)\]\s+(\S+)/;
const PERCENT = /(?:^|\s)(\d{1,3}(?:[.,]\d+)?)\s?%/;
const SIZES = /(\d[\d.,]*)\s?(?:([KMG]i?B|B))?\s?\/\s?(\d[\d.,]*)\s?([KMG]i?B|B)\b/;
const UNIT_MEGABYTES: Record<string, number> = {
	B: 1 / (1024 * 1024),
	KB: 1 / 1024,
	KiB: 1 / 1024,
	MB: 1,
	MiB: 1,
	GB: 1024,
	GiB: 1024,
};

// docker pull (non-TTY): "fea5b91588ca: Pull complete"
const LAYER = /^([0-9a-f]{12}): (.+)$/;
const LAYER_DOWNLOADED = new Set(["Verifying Checksum", "Download complete", "Extracting"]);
const LAYER_DONE = new Set(["Pull complete", "Already exists"]);

/** Parses locale-formatted byte values ("128,5", "128.5", "1.288,5", "1,288.5"), treating the last separator as decimal. */
export function parseLocaleNumber(text: string): number {
	const last = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
	if (last === -1) return Number(text);
	return Number(`${text.slice(0, last).replace(/[.,]/g, "")}.${text.slice(last + 1)}`);
}

export class ProgressReader {
	private latest: ImageProgress | undefined;
	private readonly layers = new Map<string, number>();

	read(output: string): ImageProgress | undefined {
		const line = stripVTControlCharacters(output).replace(/\t/g, " ").trim();
		if (line === "") return this.latest;
		const layer = LAYER.exec(line);
		const step = STEP.exec(line);
		if (layer) this.latest = this.readLayer(line, layer[1], layer[2]);
		else if (step) this.latest = this.readStep(line, step);
		else this.latest = { ...this.latest, line };
		return this.latest;
	}

	private readStep(line: string, step: RegExpExecArray): ImageProgress {
		const progress: ImageProgress = {
			activity: step[3],
			step: { index: Number(step[1]), total: Number(step[2]) },
			line,
		};
		const sizes = SIZES.exec(line);
		const percent = PERCENT.exec(line);
		if (sizes) {
			const total = parseLocaleNumber(sizes[3]) * UNIT_MEGABYTES[sizes[4]];
			const done = parseLocaleNumber(sizes[1]) * UNIT_MEGABYTES[sizes[2] ?? sizes[4]];
			progress.amount = { done, total, unit: "megabytes" };
		}
		if (progress.amount && progress.amount.total > 0) {
			progress.fraction = Math.min(1, Math.max(0, progress.amount.done / progress.amount.total));
		} else if (percent) {
			const pct = parseLocaleNumber(percent[1]);
			if (pct <= 100) progress.fraction = pct / 100;
		}
		const previous = this.latest;
		if (previous?.step?.index === progress.step?.index) {
			progress.fraction ??= previous?.fraction;
			progress.amount ??= previous?.amount;
		}
		return progress;
	}

	private readLayer(line: string, id: string, state: string): ImageProgress {
		const weight = LAYER_DONE.has(state) ? 1 : LAYER_DOWNLOADED.has(state) ? 0.5 : 0;
		this.layers.set(id, Math.max(this.layers.get(id) ?? 0, weight));
		const weights = [...this.layers.values()];
		return {
			activity: "Pulling",
			fraction: weights.reduce((sum, value) => sum + value, 0) / weights.length,
			amount: { done: weights.filter((value) => value === 1).length, total: weights.length, unit: "layers" },
			line,
		};
	}
}
