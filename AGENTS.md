# Polar Repository Rules

This repository is the `polar-sre` monorepo (`bin: polar-sre`, `piConfig: { name: "polar-sre", configDir: ".polar-sre" }`), forked from Pi `v1.1.0` (`earendil-works/pi`).

| Scope | Mandatory Reading Gate |
|---|---|
| Polar extensions & tests (`packages/coding-agent/src/polar/**`: `shared/`, `files/`, `k8s/`, `sandbox/`, `test/`) | Read [`packages/coding-agent/src/polar/ARCHITECTURE.md`](packages/coding-agent/src/polar/ARCHITECTURE.md) for task routing and architectural invariants. |
| Any file outside `packages/coding-agent/src/polar/` (`packages/**`, `package.json`, `scripts/**`, upstream sync) | **Mandatory gate:** read [`./CORE.md`](./CORE.md) in full before reading or editing any file outside `packages/coding-agent/src/polar/`. |

## Commands
- **Fast Polar extension tests:** `cd packages/coding-agent && npx vitest --run src/polar`. If you create or modify a test file, run it and iterate on test or implementation until it passes.
- **Full lint, typecheck, and repository contracts:** after code changes (not docs), run `npm run check` (full output, no tail; the pre-commit hook is disabled, so always run `npm run check` explicitly before committing) and fix all errors, warnings, and infos before committing.
- **Full isolated monorepo test suite:** `./test.sh`. Never run the full vitest suite directly without path arguments: it includes e2e tests that activate when endpoint/auth env vars are present.
- **Offline build of all packages and CLI bundle:** `npm run build:offline`
- **Interactive root launchers:** `./fullpolar.sh` (all built-in Polar extensions) and `./polar.sh` (minimal `builtin:files` harness + any `-e` extensions)
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands. Never commit unless the user asks.

## Conversational Style
- Keep answers short and concise. Technical prose only, be direct.
- No emojis in commits, issues, PR comments, or code. No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!").
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary. Inline single-line helpers that have only one call site. Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional. Do not preserve backward compatibility unless the user asks for it.

## Git & Commits
- Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.
- Only commit files YOU changed in THIS session. Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`. Before committing, run `git status` and verify you are only staging your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.
- Never run (destroys other agents' work or bypasses checks): `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.
- If rebase conflicts occur: resolve conflicts only in files you modified; if a conflict is in a file you did not modify, abort and ask the user. Never force push.

## User Override
If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
