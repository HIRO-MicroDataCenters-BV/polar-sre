import { describe, expect, it } from "vitest";
import { type ImageProgress, ProgressReader, parseLocaleNumber } from "../src/progress.ts";
import { recordedLines } from "./fixtures.ts";

function readAll(lines: string[]): ImageProgress[] {
	const reader = new ProgressReader();
	return lines.flatMap((line) => reader.read(line) ?? []);
}

describe("parseLocaleNumber", () => {
	it("parses dot and comma decimal/thousands formats", () => {
		expect(parseLocaleNumber("128,5")).toBe(128.5);
		expect(parseLocaleNumber("128.5")).toBe(128.5);
		expect(parseLocaleNumber("14,0")).toBe(14);
		expect(parseLocaleNumber("1.250")).toBe(1.25);
		expect(parseLocaleNumber("1,250")).toBe(1.25);
		expect(parseLocaleNumber("1.288,5")).toBe(1288.5);
		expect(parseLocaleNumber("1,288.5")).toBe(1288.5);
		expect(parseLocaleNumber("97")).toBe(97);
	});
});

describe("ProgressReader", () => {
	it("parses recorded container image pull output", () => {
		const progress = readAll(recordedLines("container-pull.jsonl"));

		expect(progress[0]).toEqual({
			activity: "Fetching",
			step: { index: 1, total: 2 },
			line: "[1/2] Fetching image [0s]",
		});
		expect(progress[3].fraction).toBeUndefined();
		expect(progress[3].amount).toBeUndefined();
		expect(progress[5]).toMatchObject({
			activity: "Fetching",
			step: { index: 1, total: 2 },
			fraction: 14 / 128.5,
			amount: { done: 14, total: 128.5, unit: "megabytes" },
		});
		const unpackStart = progress.findIndex((entry) => entry.step?.index === 2);
		expect(progress[unpackStart]).toEqual({
			activity: "Unpacking",
			step: { index: 2, total: 2 },
			line: "[2/2] Unpacking image [14s]",
		});
		expect(progress[unpackStart + 2]).toMatchObject({
			fraction: 1,
			amount: { done: 37.7, total: 37.7, unit: "megabytes" },
		});
		expect(progress.at(-1)).toMatchObject({
			activity: "Unpacking",
			fraction: 1,
			amount: { done: 38.9, total: 38.9, unit: "megabytes" },
		});
	});

	it("tracks layer states in recorded docker pull output", () => {
		const progress = readAll(recordedLines("docker-pull.jsonl"));

		expect(progress[0]).toEqual({ line: "7.4-alpine: Pulling from library/redis" });
		expect(progress[1]).toMatchObject({
			activity: "Pulling",
			fraction: 0,
			amount: { done: 0, total: 1, unit: "layers" },
		});
		const fractions = progress.slice(1).map((entry) => entry.fraction ?? 0);
		expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
		expect(progress.at(-1)).toMatchObject({
			activity: "Pulling",
			fraction: 1,
			amount: { done: 7, total: 7, unit: "layers" },
			line: "docker.io/library/redis:7.4-alpine",
		});
	});

	it("parses byte, kilobyte, gigabyte, and 3-decimal sizes and clamps fraction to 1", () => {
		const read = (line: string) => new ProgressReader().read(line);
		expect(read("[1/2] Fetching image 0% (0 of 9 blobs, 512 B/128,5 MB, 0 B/s) [1s]")).toMatchObject({
			fraction: 512 / (1024 * 1024) / 128.5,
			amount: { done: 512 / (1024 * 1024), total: 128.5, unit: "megabytes" },
		});
		expect(read("[1/2] Fetching image 0% (0 of 9 blobs, 0 B/788.6 MB) [0s]")).toMatchObject({
			fraction: 0,
			amount: { done: 0, total: 788.6, unit: "megabytes" },
		});
		expect(read("[1/2] Fetching image 0% (2 of 4 blobs, 10 KB/1,8 MB, 7 KB/s) [2s]")?.amount).toEqual({
			done: 10 / 1024,
			total: 1.8,
			unit: "megabytes",
		});
		expect(read("[1/2] Fetching image 5% (1 of 9 blobs, 512.0 KiB/1.2 GiB, 3.1 MB/s) [1s]")?.amount).toEqual({
			done: 0.5,
			total: 1228.8,
			unit: "megabytes",
		});
		expect(read("[1/2] Fetching image 50% (4 of 9 blobs, 1.250/2.500 GB) [9s]")).toMatchObject({
			fraction: 0.5,
			amount: { done: 1280, total: 2560, unit: "megabytes" },
		});
		expect(read("[1/2] Fetching image 100% (4 of 4 blobs, 130,0/128,5 MB) [9s]")?.fraction).toBe(1);
		expect(read("[1/2] Fetching image (1/2 iB)")?.amount).toBeUndefined();
	});

	it("falls back to CLI percentage when byte sizes are absent or zero", () => {
		const reader = new ProgressReader();
		expect(reader.read("[2/2] Unpacking image 42,5% [3s]")).toEqual({
			activity: "Unpacking",
			step: { index: 2, total: 2 },
			fraction: 0.425,
			line: "[2/2] Unpacking image 42,5% [3s]",
		});
		expect(reader.read("[2/2] Unpacking image 43% (0,0/0,0 MB) [3s]")?.fraction).toBe(0.43);
	});

	it("strips ANSI/tabs and preserves latest line for unstructured output", () => {
		const reader = new ProgressReader();
		expect(reader.read("  ")).toBeUndefined();
		expect(reader.read("Getting image source signatures")).toEqual({ line: "Getting image source signatures" });
		expect(reader.read("\x1b[32m#8 [3/7] RUN pip install\x1b[0m\t--no-deps")).toEqual({
			line: "#8 [3/7] RUN pip install --no-deps",
		});
		expect(reader.read("")).toEqual({ line: "#8 [3/7] RUN pip install --no-deps" });
	});
});
