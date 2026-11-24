# Core Monorepo & Upstream Rules

> **Context:** Part of [`AGENTS.md`](./AGENTS.md). Applies whenever reading or modifying any file outside `packages/coding-agent/src/polar/`.

## Core Integration Points

Keep changes to the core minimal and localized so upstream diffs apply cleanly.

Polar integrates into the monorepo core at:
- `packages/coding-agent/package.json` + `scripts/build-coding-agent-bundle.mjs`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/extensions/index.ts` (`polarBuiltInExtensions`, `POLAR_DEFAULT_EXTENSION_SPECIFIERS`, `POLAR_EXCLUDED_BUILTIN_TOOLS`)
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/rpc-entry.ts`
- `packages/coding-agent/src/cli/{args,auth-command,setup}.ts`
- `packages/coding-agent/src/core/system-prompt.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/ai/src/utils/pi-user-agent.ts`
- `packages/tui/src/tui-main-screen.ts`

## Core-Specific Rules & Testing

- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes. `packages/ai/src/models.generated.ts` may always be included alongside your files when committing.
- Run specific package tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- For testing interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.

## Upstream Sync (`earendil-works/pi`)

- **Base version:** tag `v1.1.0` (`earendil-works/pi`), MIT license (`LICENSE` is preserved).
- **Update policy:** pull from upstream only for security CVEs or concrete product requirements.
- **Update procedure:** generate a diff between tags (`git diff <old-tag> <new-tag>`) in upstream and apply via `git apply --3way`.
