# Contributing to Polar

Before reading or modifying code in this repository, read [`AGENTS.md`](AGENTS.md):

- For Polar extensions and tests (`packages/coding-agent/src/polar/**`), read [`packages/coding-agent/src/polar/ARCHITECTURE.md`](packages/coding-agent/src/polar/ARCHITECTURE.md) and the domain `ARCHITECTURE.md` / `PRODUCER.md` / `ARTIFACT-BUS.md` documents it references.
- For any file outside `packages/coding-agent/src/polar/`, read [`CORE.md`](CORE.md) first. Polar is forked from [`earendil-works/pi`](https://github.com/earendil-works/pi) (`v1.1.0`); keep changes to the upstream core minimal and localized so `git apply --3way` remains clean.

## Guidelines

- **Understand your changes:** You must be able to explain every line of your PR and how it interacts with session locking, quotas, and isolation boundaries.
- **Dependencies:** Install dependencies with `npm ci --ignore-scripts` (or `npm install --ignore-scripts`). Direct external dependencies must remain pinned to exact versions; do not add packages with install lifecycle scripts without explicit review.
- **Code rules:** Follow the TypeScript erasable-syntax, top-level import, and asset-resolution rules in [`AGENTS.md`](AGENTS.md). Do not edit `CHANGELOG.md` in feature or fix PRs.
- **Issues:** Keep bug reports and feature proposals short, concrete, and reproducible (exact commit, OS/runtime, steps to reproduce, and observed vs. expected output). For security issues, follow [`SECURITY.md`](SECURITY.md).

## Required Checks Before Submitting a PR

Run the Polar extension test suite, full repository checks, and the isolated monorepo test suite (`./test.sh` requires Rust `1.96.0`, pinned in [`packages/env/daemon/rust-toolchain.toml`](packages/env/daemon/rust-toolchain.toml)):

```bash
(cd packages/coding-agent && npx vitest --run src/polar)
npm run check
npm run build:daemon --workspace packages/env
./test.sh
```

All checks and tests must pass with zero errors or warnings.
