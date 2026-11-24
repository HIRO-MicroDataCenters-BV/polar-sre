import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { showImageOperation } from "../src/indicator.ts";
import type { ImageOperationKind } from "../src/types.ts";
import { recordedLines } from "./fixtures.ts";

const BAR = /[━╸─]+/;
const WIDTHS = [48, 60, 80, 100, 120, 160, 240];
const TOTALS = [0.4, 3, 9.9, 42.5, 99.9, 128.5, 788.6, 999.9, 999.99, 1000, 1500, 12000, 48000, 101000];
const DONE_EDGES = [0, 0.04, 0.05, 0.94, 0.95, 1, 9.94, 9.95, 10, 99.94, 99.95, 100, 999.94, 999.95, 1000];
const FRACTIONS = [0.0001, 0.5, 0.9999, 1];

afterEach(() => {
	vi.useRealTimers();
});

function mount(kind: ImageOperationKind = "download") {
	let widget: (Component & { dispose?(): void }) | undefined;
	let renderRequests = 0;
	const ui = {
		setWidget(_key: string, factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined) {
			widget?.dispose?.();
			widget = factory?.(
				{
					requestRender() {
						renderRequests += 1;
					},
				} as unknown as TUI,
				{ fg: (_color, text) => text } as Theme,
			);
		},
	};
	const operation = showImageOperation(ui as unknown as ExtensionUIContext, kind);
	const line = (width = 80) => widget?.render(width)[0]?.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "⠋");
	return { operation, line, renderRequests: () => renderRequests };
}

function columnsOf(line: string) {
	const bar = BAR.exec(line);
	if (!bar) throw new Error(`no bar in "${line}"`);
	const barEnd = bar.index + bar[0].length;
	return {
		width: visibleWidth(line),
		barStart: bar.index,
		barLength: bar[0].length,
		slash: line.indexOf("/", barEnd),
	};
}

function simulatePullLines(totalMegabytes: number): { step: number; text: string }[] {
	const phases: [string, number][] = [
		["Fetching", totalMegabytes * 0.38],
		["Unpacking", totalMegabytes],
	];
	return phases.flatMap(([activity, total], index) => {
		const step = index + 1;
		const dones = [...DONE_EDGES.filter((done) => done <= total), ...FRACTIONS.map((f) => f * total)];
		return [
			{ step, text: `[${step}/2] ${activity} image [0s]` },
			...dones.map((done) => ({
				step,
				text: `[${step}/2] ${activity} image (${done}/${total} MB) [1s]`,
			})),
		];
	});
}

describe("showImageOperation", () => {
	it("formats KB, MB, GB, and layer counts in fixed-width right-aligned units", () => {
		const amountAt = (cliLine: string) => {
			const { operation, line } = mount("download");
			operation.output(cliLine);
			const rendered = line(60) ?? "";
			operation.end();
			const bar = BAR.exec(rendered);
			return bar ? rendered.slice(bar.index + bar[0].length + 2).trimStart() : "";
		};

		expect(amountAt("[1/2] Fetching image (0/788.6 MB)")).toBe("0.0/788.6 MB");
		expect(amountAt("[1/2] Fetching image (9.94/788.6 MB)")).toBe("9.9/788.6 MB");
		expect(amountAt("[1/2] Fetching image (462.9/788.6 MB)")).toBe("462.9/788.6 MB");
		expect(amountAt("[1/2] Fetching image (0.2/0.5 MB)")).toBe("205/512 KB");
		expect(amountAt("[1/2] Fetching image (1500/12000 MB)")).toBe("1.46/11.72 GB");
		expect(amountAt("[1/2] Fetching image (500/999.96 MB)")).toBe("0.49/0.98 GB");
		expect(amountAt("[1/2] Fetching image (500/999.9 MB)")).toBe("500.0/999.9 MB");

		const docker = mount("download");
		docker.operation.output("fea5b91588ca: Pulling fs layer");
		docker.operation.output("fb602ba0b128: Pull complete");
		expect(docker.line(60)).toContain("  1/2 layers");
		docker.operation.end();
	});

	it("keeps bar position, bar width, and slash alignment fixed across digit boundaries", () => {
		for (const width of WIDTHS) {
			for (const total of TOTALS) {
				const { operation, line } = mount("download");
				const inputs = simulatePullLines(total);
				const columns = inputs.map((entry) => {
					operation.output(entry.text);
					return columnsOf(line(width) ?? "");
				});
				operation.end();

				const context = `width ${width}, total ${total} MB`;
				expect(new Set(columns.map((entry) => entry.barStart)).size, `bar start, ${context}`).toBe(1);
				expect(new Set(columns.map((entry) => entry.barLength)).size, `bar length, ${context}`).toBe(1);
				for (const step of [1, 2]) {
					const amounts = columns.filter((_, index) => inputs[index].step === step && columns[index].slash !== -1);
					expect(amounts.length, context).toBeGreaterThan(FRACTIONS.length);
					expect(new Set(amounts.map((entry) => entry.slash)).size, `amount of step ${step}, ${context}`).toBe(1);
					for (const entry of amounts) expect(entry.width, `right edge, ${context}`).toBe(width - 1);
				}
				for (const entry of columns) expect(entry.width, context).toBeLessThanOrEqual(width - 1);
			}
		}
	});

	it("renders half-cell bar progress and drops step/amount cleanly on narrow terminals", () => {
		const { operation, line } = mount("download");
		operation.output("[2/2] Unpacking image (394.3/788.6 MB)");
		expect(line(60)).toBe(` ⠋ Unpacking 2/2  ${"━".repeat(12)}╸${"─".repeat(12)}  394.3/788.6 MB`);
		expect(columnsOf(line(100) ?? "").barLength).toBe(65);
		expect(columnsOf(line(240) ?? "").barLength).toBe(205);

		operation.output("[1/2] Fetching image (75/300 MB)");
		expect(line(43)).toBe(" ⠋ Fetching  1/2  ━━──────   75.0/300.0 MB");
		expect(line(42)).toBe(" ⠋ Fetching   ━━━────────   75.0/300.0 MB");
		expect(line(39)).toBe(" ⠋ Fetching   ━━──────   75.0/300.0 MB");
		expect(line(38)).toBe(" ⠋ Fetching   ━━━━━━─────────────────");
		expect(line(16)).toBe(" ⠋ Fetching   ╸");
		for (let width = 1; width <= 60; width += 1) {
			expect(visibleWidth(line(width) ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
		}
		operation.end();
	});

	it("maintains constant bar bounds across recorded container image pull output and monotonic column growth", () => {
		const recorded = mount("download");
		const lines = recordedLines("container-pull.jsonl").map((entry) => {
			recorded.operation.output(entry);
			return recorded.line(100) ?? "";
		});
		recorded.operation.end();

		const columns = lines.map(columnsOf);
		expect(new Set(columns.map((entry) => `${entry.barStart}+${entry.barLength}`))).toEqual(new Set(["18+65"]));
		expect(lines[0]).toBe(` ⠋ Fetching  1/2  ${"─".repeat(65)}`);
		expect(lines[5]).toBe(` ⠋ Fetching  1/2  ${"━".repeat(7)}${"─".repeat(58)}   14.0/128.5 MB`);
		expect(lines.at(-1)).toBe(` ⠋ Unpacking 2/2  ${"━".repeat(65)}    38.9/38.9 MB`);

		const monotonic = mount("download");
		monotonic.operation.output("[10/12] Transferring image 10%");
		const first = columnsOf(monotonic.line(80) ?? "");
		monotonic.operation.output("[1/12] Fetching image 20%");
		const second = columnsOf(monotonic.line(80) ?? "");
		expect(second.barStart).toBe(first.barStart);
		expect(second.barLength).toBe(first.barLength);
		monotonic.operation.end();
	});

	it("renders plain line with right-aligned elapsed time for builds and unstructured pulls, and stops timer on end", () => {
		vi.useFakeTimers();
		const build = mount("build");
		expect(build.line(30)).toBe(" ⠋ Building          0s");

		vi.advanceTimersByTime(65_000);
		for (const text of [
			"[1/2] STEP 1/8: FROM python:3.13-slim",
			"[1/2] STEP 5/8: RUN pip install 50% (1,0/2,0 MB)",
			"#8 [3/7] RUN pip install ".repeat(9),
			"café 日本語テスト",
		]) {
			build.operation.output(text);
			for (const width of WIDTHS) {
				const rendered = build.line(width) ?? "";
				expect(visibleWidth(rendered), `width ${width}`).toBe(width - 1);
				expect(rendered.endsWith(" 1m 05s")).toBe(true);
			}
		}
		for (let width = 1; width <= 40; width += 1) {
			expect(visibleWidth(build.line(width) ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
		}

		const ticksBeforeEnd = build.renderRequests();
		expect(ticksBeforeEnd).toBeGreaterThan(0);
		build.operation.end();
		expect(build.line()).toBeUndefined();
		vi.advanceTimersByTime(1000);
		expect(build.renderRequests()).toBe(ticksBeforeEnd);
	});

	it("renders Starting status line for service kind without switching to bar and makes end() idempotent", () => {
		let setWidgetCalls = 0;
		let widget: (Component & { dispose?(): void }) | undefined;
		const ui = {
			setWidget(_key: string, factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined) {
				setWidgetCalls += 1;
				widget?.dispose?.();
				widget = factory?.({ requestRender() {} } as unknown as TUI, { fg: (_color, text) => text } as Theme);
			},
		};
		const operation = showImageOperation(ui as unknown as ExtensionUIContext, "service" as ImageOperationKind);
		expect(setWidgetCalls).toBe(1);
		operation.output("[1/2] Installing kernel... 50% (340/680 MB)");
		const rendered = widget?.render(80)[0]?.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "⠋") ?? "";
		expect(rendered).toContain(" ⠋ Starting   ");
		expect(rendered).toContain("Installing kernel...");
		expect(BAR.test(rendered)).toBe(false);

		operation.end();
		expect(setWidgetCalls).toBe(2);
		operation.end();
		expect(setWidgetCalls).toBe(2);
	});
});
