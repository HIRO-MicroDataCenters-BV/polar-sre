import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { type ImageProgress, ProgressReader } from "./progress.ts";
import type { ImageOperation, ImageOperationKind } from "./types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
const WIDGET_KEY = "sandbox-image";

const LEFT_WIDTH = 3;
const GAP_WIDTH = 2;
const RIGHT_MARGIN = 1;
const ACTIVITY_WIDTH = 9;
const ACTIVITY_MAX = 12;
const AMOUNT_WIDTH = 14; // Reserve width up to "99.99/99.99 GB"
const BAR_MIN = 8;
const TITLE_WIDTH = 11;
const ELAPSED_WIDTH = 7;
const GIGABYTES_THRESHOLD_MB = 999.95; // Switch to GB before toFixed(1) rounds to "1000.0 MB"

interface LineWidths {
	activity: number;
	step: number;
	amount: number;
}

interface OperationState {
	kind: ImageOperationKind;
	startedAt: number;
	progress?: ImageProgress;
	measured: boolean;
	widths: LineWidths;
}

function formatAmount(amount: NonNullable<ImageProgress["amount"]>): string {
	if (amount.unit === "layers") {
		const total = String(amount.total);
		return `${String(amount.done).padStart(total.length)}/${total} layers`;
	}
	const [scale, digits, unit] =
		amount.total >= GIGABYTES_THRESHOLD_MB ? [1 / 1024, 2, "GB"] : amount.total < 1 ? [1024, 0, "KB"] : [1, 1, "MB"];
	const total = (amount.total * scale).toFixed(digits);
	return `${(amount.done * scale).toFixed(digits).padStart(total.length)}/${total} ${unit}`;
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function renderBarLine(
	progress: ImageProgress,
	width: number,
	widths: LineWidths,
	spinner: string,
	theme: Theme,
): string {
	const activity = (progress.activity ?? "Working").slice(0, ACTIVITY_MAX);
	const step = progress.step ? `${progress.step.index}/${progress.step.total}` : "";
	const amount = progress.amount ? formatAmount(progress.amount) : "";
	widths.activity = Math.max(widths.activity, activity.length);
	widths.step = Math.max(widths.step, step.length);
	widths.amount = Math.max(widths.amount, amount.length);
	let stepWidth = widths.step;
	let amountWidth = widths.amount;
	const barCells = () =>
		width -
		(LEFT_WIDTH + widths.activity + GAP_WIDTH + RIGHT_MARGIN) -
		(stepWidth > 0 ? 1 + stepWidth : 0) -
		(amountWidth > 0 ? GAP_WIDTH + amountWidth : 0);
	if (barCells() < BAR_MIN) stepWidth = 0;
	if (barCells() < BAR_MIN) amountWidth = 0;
	const cells = Math.max(0, barCells());
	const filledHalves = Math.round((progress.fraction ?? 0) * cells * 2);
	const full = Math.floor(filledHalves / 2);
	const half = filledHalves % 2;
	const bar =
		theme.fg("accent", "━".repeat(full) + (half ? "╸" : "")) + theme.fg("dim", "─".repeat(cells - full - half));
	const paddedActivity = activity.padEnd(widths.activity);
	const paddedStep = stepWidth > 0 ? step.padStart(stepWidth) : "";
	const paddedAmount = amountWidth > 0 && amount !== "" ? amount.padStart(amountWidth) : "";
	return truncateToWidth(
		[
			` ${theme.fg("accent", spinner)} ${theme.fg("muted", paddedActivity)}`,
			paddedStep === "" ? "" : ` ${theme.fg("muted", paddedStep)}`,
			cells > 0 ? `${" ".repeat(GAP_WIDTH)}${bar}` : "",
			paddedAmount === "" ? "" : `${" ".repeat(GAP_WIDTH)}${theme.fg("muted", paddedAmount)}`,
		].join(""),
		width,
	);
}

function renderPlainLine(
	title: string,
	output: string,
	elapsed: string,
	width: number,
	spinner: string,
	theme: Theme,
): string {
	const head = ` ${theme.fg("accent", spinner)} ${theme.fg("muted", title.padEnd(TITLE_WIDTH))}`;
	const tail = theme.fg("muted", elapsed.padStart(ELAPSED_WIDTH));
	const box = width - (LEFT_WIDTH + TITLE_WIDTH + 2 * GAP_WIDTH + ELAPSED_WIDTH + RIGHT_MARGIN);
	if (box < BAR_MIN) return truncateToWidth(`${head}${" ".repeat(GAP_WIDTH)}${tail}`, width);
	const text = truncateToWidth(output, box);
	const padding = " ".repeat(Math.max(0, box - visibleWidth(text)));
	return `${head}${" ".repeat(GAP_WIDTH)}${theme.fg("dim", text)}${padding}${" ".repeat(GAP_WIDTH)}${tail}`;
}

class ProgressLine implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly state: OperationState;
	private readonly timer: NodeJS.Timeout;

	constructor(tui: TUI, theme: Theme, state: OperationState) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.timer = setInterval(() => this.tui.requestRender(), TICK_MS);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	render(width: number): string[] {
		const state = this.state;
		const elapsedMs = Date.now() - state.startedAt;
		const spinner = SPINNER[Math.max(0, Math.floor(elapsedMs / TICK_MS)) % SPINNER.length];
		if (state.measured && state.progress) {
			return [renderBarLine(state.progress, width, state.widths, spinner, this.theme)];
		}
		const title = state.kind === "download" ? "Downloading" : state.kind === "service" ? "Starting" : "Building";
		return [renderPlainLine(title, state.progress?.line ?? "", formatElapsed(elapsedMs), width, spinner, this.theme)];
	}
}

export function showImageOperation(ui: ExtensionUIContext, kind: ImageOperationKind): ImageOperation {
	const state: OperationState = {
		kind,
		startedAt: Date.now(),
		measured: false,
		widths: { activity: ACTIVITY_WIDTH, step: 0, amount: AMOUNT_WIDTH },
	};
	const reader = new ProgressReader();
	let ended = false;
	ui.setWidget(WIDGET_KEY, (tui, theme) => new ProgressLine(tui, theme, state));
	return {
		output(line) {
			if (ended) return;
			const progress = reader.read(line);
			state.progress = progress;
			if (kind === "build" || kind === "service") return; // Keep plain status + elapsed time; [i/n] stage headers are not download progress
			if (progress?.step || progress?.fraction !== undefined || progress?.amount) state.measured = true;
		},
		end: () => {
			if (ended) return;
			ended = true;
			ui.setWidget(WIDGET_KEY, undefined);
		},
	};
}
