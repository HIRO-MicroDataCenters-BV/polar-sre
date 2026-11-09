import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { KubeContextItem } from "./kubeconfig.ts";
import type { LaunchConfig } from "./types.ts";

const MAX_VISIBLE_ITEMS = 10;

export function filterKubeContexts(items: readonly KubeContextItem[], query: string): KubeContextItem[] {
	const trimmed = query.trim();
	if (trimmed === "") {
		return [...items];
	}
	return fuzzyFilter(
		[...items],
		trimmed,
		(item) => `${item.context} ${item.cluster} ${item.namespace ?? ""} ${item.kubeconfigPath}`,
	);
}

function isActiveContext(item: KubeContextItem, active: LaunchConfig | undefined): boolean {
	return active !== undefined && item.context === active.context && item.kubeconfigPath === active.kubeconfigPath;
}

function scrollWindowStart(selectedIndex: number, totalItems: number, maxVisible: number): number {
	const centeredStart = selectedIndex - Math.floor(maxVisible / 2);
	const maxStart = Math.max(0, totalItems - maxVisible);
	return Math.max(0, Math.min(centeredStart, maxStart));
}

class KubeContextPicker implements Component, Focusable {
	private readonly items: readonly KubeContextItem[];
	private readonly active: LaunchConfig | undefined;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: KubeContextItem | undefined) => void;
	private readonly input: Input;
	private readonly border: DynamicBorder;
	private filtered: KubeContextItem[];
	private selectedIndex = 0;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		items: readonly KubeContextItem[],
		active: LaunchConfig | undefined,
		initialQuery: string | undefined,
		done: (result: KubeContextItem | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.active = active;
		this.done = done;
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.input = new Input({
			prompt: theme.fg("accent", "Filter: "),
			placeholder: "type to filter contexts...",
			placeholderStyle: (s: string) => theme.fg("muted", s),
		});
		if (initialQuery !== undefined && initialQuery !== "") {
			this.input.setValue(initialQuery);
		}
		this.filtered = filterKubeContexts(this.items, this.input.getValue());
		const activeIdx = this.filtered.findIndex((item) => isActiveContext(item, active));
		if (activeIdx >= 0) {
			this.selectedIndex = activeIdx;
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.border.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			if (this.filtered.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			if (this.filtered.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.filtered[this.selectedIndex];
			if (selected !== undefined) {
				this.done(selected);
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		const previousQuery = this.input.getValue();
		this.input.handleInput(data);
		const nextQuery = this.input.getValue();
		if (nextQuery !== previousQuery) {
			this.filtered = filterKubeContexts(this.items, nextQuery);
			this.selectedIndex = 0;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(...this.border.render(width));
		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(" Select Kubernetes Context")), width));
		for (const line of this.input.render(Math.max(1, width - 1))) {
			lines.push(truncateToWidth(` ${line}`, width));
		}
		lines.push("");

		if (this.filtered.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("muted", "  No matching contexts"), width));
		} else {
			const startIndex = scrollWindowStart(this.selectedIndex, this.filtered.length, MAX_VISIBLE_ITEMS);
			const endIndex = Math.min(this.filtered.length, startIndex + MAX_VISIBLE_ITEMS);

			for (let i = startIndex; i < endIndex; i++) {
				const item = this.filtered[i];
				if (item === undefined) continue;
				const isSelected = i === this.selectedIndex;
				const isActive = isActiveContext(item, this.active);
				const cursor = isSelected ? this.theme.fg("accent", "→") : " ";
				const check = isActive ? this.theme.fg("success", "✓") : " ";
				const name = isSelected
					? this.theme.fg("accent", this.theme.bold(item.context))
					: this.theme.fg("text", item.context);
				const meta = this.theme.fg(
					"muted",
					`[cluster: ${item.cluster || "-"} · ns: ${item.namespace || "-"} · ${item.kubeconfigPath}]`,
				);
				lines.push(truncateToWidth(` ${cursor} ${check} ${name} ${meta}`, width));
			}

			if (this.filtered.length > MAX_VISIBLE_ITEMS) {
				lines.push(
					truncateToWidth(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filtered.length})`), width),
				);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"), width));
		lines.push(...this.border.render(width));
		return lines;
	}
}

export async function selectKubeContext(
	ctx: ExtensionContext,
	items: readonly KubeContextItem[],
	active?: LaunchConfig,
	initialQuery?: string,
): Promise<KubeContextItem | undefined> {
	return ctx.ui.custom<KubeContextItem | undefined>((tui, theme, _keybindings, done) => {
		return new KubeContextPicker(tui, theme, items, active, initialQuery, done);
	});
}
