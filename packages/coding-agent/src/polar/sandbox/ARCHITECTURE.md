# Sandbox Architecture (`packages/coding-agent/src/polar/sandbox`)

> **Prerequisites:** Read [`../shared/ARTIFACT-BUS.md`](../shared/ARTIFACT-BUS.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) before modifying `packages/coding-agent/src/polar/sandbox`.

---

## 1. Isolation Model & Hot VM Lifecycle

The `sandbox` extension (`builtin:sandbox`) registers the `run_code` tool, executing Python 3.13 or Bash scripts inside an isolated Linux VM behind the `SandboxDriver` interface (`AppleContainerDriver` on macOS via the `container` CLI).

- **Artifact Bus Mount (`/data`):** Mounts `session.outputDirectory` read-only at `/data` inside the guest. The host working directory (`cwd`) is never mounted inside the VM; only `/data` and `/work` exist.
- **Persistent Workspace (`/work`):** Mounts a per-session volume (`polar-work-<sessionId>`, `4 GiB`) read-write at `/work` (`HOME=/work`). Files in `/work` persist across calls and across VM recreations within the session.
- **Image Lookup & First-Start UX (`workspace.ts`):**
  - Default image tag: `polar-sandbox:0.2` (multi-arch: `linux/arm64` and `linux/amd64`).
  - Lookup order in local cache:
    1. If `--sandbox-image` (or `POLAR_SANDBOX_IMAGE`) is explicitly provided, only that image is checked.
    2. Otherwise, `REGISTRY_IMAGE` / `--sandbox-registry-image` (`POLAR_SANDBOX_REGISTRY_IMAGE`) is checked first (when configured), followed by the local tag `polar-sandbox:0.2`.
  - When the image is not found in local cache:
    - If `ctx.hasUI === false` (non-interactive / headless mode), no menu is shown and `sandbox` immediately disables itself (`sandbox is off: image ... is not installed (...)`).
    - If `ctx.hasUI === true` (interactive TUI), `ctx.ui.select` offers `Download prebuilt image` (only when `REGISTRY_IMAGE` / `--sandbox-registry-image` is set), `Build sandbox image locally (~2 min)` (builds from `getSandboxImageDir()` with a `10 min` timeout), and `Disable sandbox for this session`.
- **Operator Output Quotas:** `fileMaxBytes` is `4 GiB` and `sessionMaxBytes` is `16 GiB`.
- **Lazy Hot Sandbox VM:**
  - The sandbox VM is started lazily on the first `run_code` call in the session (`driver.startSandbox`), not at `session_start`.
  - The VM runs with `--network none`, `--read-only`, `--cap-drop ALL`, `--user 1000:1000`, `2 GiB` RAM, `4` CPUs, `nproc=256`, and a `512 MiB` tmpfs at `/tmp` (without `--init`).
  - PID 1 inside the guest is `bash -c 'echo; while read -r _; do :; done'`. Built-in `read` spawns no child process, survives `kill -9 -1`, reaps zombies, and exits immediately on `stdin` EOF if the host `polar` process exits or is killed with `SIGKILL`.
  - Each `run_code` invocation executes via `container exec --interactive --user 1000:1000 --workdir /work ... bash -c <launcher>` (`spawnCall`). The `300s` per-call timeout starts strictly when `spawnCall` spawns the script, excluding lazy VM boot time.
  - After every completed call, `scrubAfterCall` runs an external `container exec` that kills any remaining processes of `uid 1000`, removes SysV IPC objects (`ipcrm --all`), resets permissions (`chmod -R u+rwX`), deletes all entries under `/tmp`, `/dev/shm`, and `/dev/mqueue`, and verifies that no user processes, temporary files, or SysV IPC objects remain.
  - On timeout, cancellation, output limit, OOM, stopped/missing/unknown container inspection, or `scrubAfterCall` returning `false`, the hot VM is destroyed (`hot.destroy`) and transparently recreated on the next call while preserving `/work`.
- **Sequential Execution:** `executionMode: "sequential"` runs one call at a time per session.
- **UI vs LLM Naming Contract:** No footer status (`ctx.ui.setStatus`) is set. User-facing notifications (`ctx.ui.notify`) refer to the runtime as `sandbox` (`sandbox is off: ...`, `sandbox: ...`), whereas the tool name, `promptGuidelines`, and model-facing replies use `run_code` (`[run_code <status>]`, `run_code-<n>.txt`, `run_code-stderr-<n>.txt`).

---

## 2. File Structure & Layers

Each layer in `packages/coding-agent/src/polar/sandbox/src/` imports only from lower layers:

```text
packages/coding-agent/src/polar/sandbox/
├── ARCHITECTURE.md                  # VM sandbox architecture and layer boundaries
├── index.ts                         # --sandbox-image / --sandbox-registry-image flags, session_start/shutdown wiring, tool registration
├── image/
│   ├── Containerfile                # Multi-arch guest image definition (default tag: polar-sandbox:0.2)
│   ├── requirements.in
│   └── requirements.txt
├── src/
│   ├── types.ts                     # Domain data structures, state types, SandboxDriver & HotSandbox contracts
│   ├── cli.ts                       # Layer 1: Stateless CLI execution, JSON parsing, container cleanup
│   ├── driver.ts                    # Layer 2: AppleContainerDriver and AppleHotSandbox implementation
│   ├── workspace.ts                 # Layer 3: Readiness check, image lookup/pull/build UX, orphan GC, /work volume setup
│   ├── runner.ts                    # Layer 4: Admission, lazy HotSandbox lifecycle, call supervision, OOM & scrub
│   └── reply.ts                     # Layer 5: Reply budget calculation, stdout/stderr store finalization, formatting
└── test/
    ├── fake-container.mjs           # Stateful stand-in for the `container` CLI in tests
    ├── fixtures.ts
    └── *.test.ts
```

### Layer Responsibilities

1. **`src/cli.ts` (Layer 1 — Stateless CLI & Diagnostic Primitives)**
   - Spawns short `container` commands with `commandTimeoutMs` (`30s`) and optional `AbortSignal`, tracking child processes in `runtime.children`.
   - Parses JSON array outputs (`parseListing`, `parseContainers`, `parseVolumes`, including container runtime state) and bounds diagnostic stderr (`boundDiagnostic`: `4 KiB` / `64` lines).
   - Implements `cleanupContainer(runtime, name, deadlineAt)`: runs `container delete --force <name>`, and if non-zero, checks `container list --all --format json` before removing `name` from `runtime.owned`.

2. **`src/driver.ts` (Layer 2 — `SandboxDriver` & `HotSandbox`)**
   - `AppleContainerDriver`: implements runtime readiness (`checkRuntime`, `inspectImage`, `pullImage`, `buildImage`), orphan discovery and deletion (`listSandboxes`, `deleteSandbox`, `manualDeleteCommand`), `/work` volume lifecycle (`listWorkVolumes`, `ensureWorkVolume`, `deleteWorkVolume`), and lazy hot VM startup (`startSandbox`).
   - `AppleHotSandbox`: manages the keepalive `container run -i` process, records the boot-log OOM baseline before spawning `container exec -i ... bash -c <launcher>` (`spawnCall`), computes OOM deltas (`checkOom`), inspects container state (`inspect`: `present` when `running`, `stopped`, `absent`, or `unknown`), scrubs guest processes, files, and SysV IPC after calls (`scrubAfterCall`), and tears down the VM (`destroy`).

3. **`src/workspace.ts` (Layer 3 — Session Workspace & Recovery)**
   - `startRuntime` and `checkReadiness`: checks driver readiness, inspects image candidates (`--sandbox-image` -> `REGISTRY_IMAGE` -> `polar-sandbox:0.2`), runs the interactive `ctx.ui.select` flow (`Download prebuilt image` / `Build sandbox image locally (~2 min)` / `Disable sandbox for this session`) when `ctx.hasUI === true` or disables immediately when `ctx.hasUI === false`, recovers leftover resources under the same `polar-root`, and prepares `/work`.
   - `recoverLeftovers` and `cleanupOwned`: `recoverLeftovers` deletes containers belonging to the current session or to sessions whose `sessionLiveness` is `"ended"`, deletes volumes when the owning session's directory is absent (`ENOENT`), and preserves resources of `"alive"` and `"unknown"` sessions. `cleanupOwned(runtime, deadlineAt, exclude)` deletes owned containers through `runtime.driver.deleteSandbox`.
   - `shutdownRuntime`: closes admission, waits up to `shutdownBudgetMs` (`10s`) for in-flight operations to drain, destroys the active `HotSandbox` and cleans up owned containers, kills remaining CLI processes on `quit`, and releases the session handle when drained.

4. **`src/runner.ts` (Layer 4 — Call Admission & Hot Sandbox Supervision)**
   - `admitCall`: admits a call when `runtime.state === "open"` and records `toolCallId` in `runtime.inFlight`.
   - `SandboxCall`: cleans up leftover owned containers from prior calls (excluding the active warm `HotSandbox`), opens `<outputDirectory>/run_code-<n>.part` via `openOutputFile`, reuses `runtime.activeSandbox.current` (or recreates it once if `spawnCall` reports `{ gone }`, or lazily starts it on the first call), and starts `SandboxRun`.
   - `SandboxRun`: writes the script to `stdin` of the guest launcher (`bash -c 'd="${TMPDIR:-/tmp}/.polar"; mkdir -p "$d" && cat > "$d/program.<ext>" && exec <interpreter> "$d/program.<ext>" </dev/null'`), streams `stdout` into `OpenFile.sink` with backpressure, captures `stderr` up to `1 MiB`, and stops the call on timeout, abort, output limit, or shutdown.
   - On completion: checks OOM delta on exit `137`, inspects container state on non-zero exit, runs `scrubAfterCall` when the VM remains healthy, and destroys the VM whenever stopped, OOM-killed, not `present` on inspection (`stopped`, `absent`, or `unknown`), or when `scrubAfterCall` returns `false`.

5. **`src/reply.ts` (Layer 5 — Sandbox Reply Builder)**
   - Finalizes `result.output` (`discardOutputFile` if a plain `ok` or if the full output fits the reply room; `finishOutputFile` otherwise) and saves oversized `stderr` via `saveBytes` as `run_code-stderr-<n>.txt`.
   - Formats the reply with status line `[run_code <status>] <language>: <first-line>`, `stdout` head excerpt, `[stderr]...[/stderr]` tail excerpt, and notices (`outputLimitNotice`, `cleanupNotice`, `inspectionNotice`, `statusMessage`).
   - Saved file notices point to `"read" tool` (when `<= 16 MiB`) and `"run_code" tool from /data/<file>`.

---

## 3. Guest Image (`packages/coding-agent/src/polar/sandbox/image`)

Build commands (`linux/arm64` and `linux/amd64` via `ARG TARGETARCH` with `sha256` verification of `yq` and `duckdb`, and universal wheel hashes in `requirements.txt`):
```bash
(cd packages/coding-agent/src/polar/sandbox/image && container build --arch arm64 --tag polar-sandbox:0.2 --file Containerfile .)
(cd packages/coding-agent/src/polar/sandbox/image && docker build --platform linux/amd64 --tag polar-sandbox:0.2 --file Containerfile .)
```

- **Python 3.13 kit:** `duckdb`, `polars`, `pandas`, `numpy`, `orjson`, `ijson`, `pyyaml`, `jmespath`, `python-dateutil`, `ciso8601`, `regex`, `tabulate`, `drain3`.
- **CLI kit:** `bash`, `coreutils`, `gawk`, `ripgrep`, `jq`, `yq`, `duckdb`, `miller`.
- Runs as user `1000:1000` (`polar`) under kernel `RLIMIT_NPROC` (`256`).
