import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount: number,
	extensionStatuses: ReadonlyMap<string, string> = new Map(),
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("ends a truncated model name with an ellipsis", () => {
		// The experimental marker shares the stats line with the model name and shifts where the name is cut.
		vi.stubEnv("PI_EXPERIMENTAL", "0");
		const session = createSession({ sessionName: "", modelId: "anthropic/claude-opus-5.5-long-model-name" });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(40)[1])).toBe("12.3%/200k (auto)  anthropic/claude-o...");
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);

		expect(statsLine).toContain("auto \u2022 high \u2192 gpt-5.6-luna \u2022 medium");
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it("updates cached usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120)[1])).toContain("$0.500");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[1])).toContain("$1.000");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$0.000 (sub)");
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});

	it("joins extension statuses with ' · ' and omits empty statuses without dangling separators", () => {
		const session = createSession({ sessionName: "" });
		const statuses = new Map<string, string>([
			["a-empty", "   \n\t  "],
			["d-ansi-empty", theme.fg("dim", "")],
			["k8s", "kubeconfig: prod-eu-west-1"],
			["m-empty", ""],
			["sandbox", "sandbox: off, run /sandbox"],
			["z-empty", "\r\n"],
		]);
		const footer = new FooterComponent(session, createFooterData(1, statuses));

		const lines = footer.render(80);
		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[1])).toContain("12.3%/200k (auto)");
		expect(stripAnsi(lines[2])).toBe("kubeconfig: prod-eu-west-1 · sandbox: off, run /sandbox");

		const emptyOnlyFooter = new FooterComponent(
			session,
			createFooterData(
				1,
				new Map([
					["ansi", theme.fg("dim", "")],
					["k8s", "  \t\n "],
					["sandbox", ""],
				]),
			),
		);
		const emptyOnlyLines = emptyOnlyFooter.render(80);
		expect(emptyOnlyLines).toHaveLength(2);
		expect(stripAnsi(emptyOnlyLines[1])).toContain("12.3%/200k (auto)");
	});

	it("wraps extension statuses across lines without ellipsis and truncates single oversized status", () => {
		const width = 80;
		const session = createSession({ sessionName: "" });
		const clusterStatus = "kubeconfig: arn:aws:eks:eu-west-1:123456789012:cluster/production-main";
		const sandboxStatus = "sandbox: off, run /sandbox";
		const thirdStatus = "extra: ok";
		const footer = new FooterComponent(
			session,
			createFooterData(
				1,
				new Map([
					["1-k8s", clusterStatus],
					["2-sandbox", sandboxStatus],
					["3-extra", thirdStatus],
				]),
			),
		);

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(lines.slice(2).map(stripAnsi)).toEqual([clusterStatus, `${sandboxStatus} · ${thirdStatus}`]);

		const narrowWidth = 40;
		const narrowLines = footer.render(narrowWidth);
		for (const line of narrowLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(narrowWidth);
		}
		expect(stripAnsi(narrowLines[2])).toBe(`${clusterStatus.slice(0, narrowWidth - 3)}...`);
		expect(stripAnsi(narrowLines[3])).toBe(`${sandboxStatus} · ${thirdStatus}`);
	});

	it("measures extension status width with visibleWidth for ANSI codes and wide characters", () => {
		const session = createSession({ sessionName: "" });

		// ANSI codes increase string.length (43 total with separator) while visibleWidth is 33.
		const ansiStatuses = new Map<string, string>([
			["1-k8s", "\x1b[32mkubeconfig: prod\x1b[39m"],
			["2-sandbox", "sandbox: ready"],
		]);
		const ansiFooter = new FooterComponent(session, createFooterData(1, ansiStatuses));
		const ansiLines = ansiFooter.render(33);
		expect(ansiLines).toHaveLength(3);
		expect(visibleWidth(ansiLines[2])).toBe(33);
		expect(stripAnsi(ansiLines[2])).toBe("kubeconfig: prod · sandbox: ready");

		const wrappedAnsiLines = ansiFooter.render(32);
		for (const line of wrappedAnsiLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		}
		expect(wrappedAnsiLines.slice(2).map(stripAnsi)).toEqual(["kubeconfig: prod", "sandbox: ready"]);

		// Wide characters have string.length 26 (55 total with separator <= 60) while visibleWidth is 50 (79 total > 60).
		const wideCluster = `클러스터: ${"한글".repeat(10)}`;
		const sandboxStatus = "sandbox: off, run /sandbox";
		const wideStatuses = new Map<string, string>([
			["1-k8s", wideCluster],
			["2-sandbox", sandboxStatus],
		]);
		const wideFooter = new FooterComponent(session, createFooterData(1, wideStatuses));
		const wideLines = wideFooter.render(60);
		for (const line of wideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
		expect(wideLines.slice(2).map(stripAnsi)).toEqual([wideCluster, sandboxStatus]);
	});
});
