# Exec Sandbox Architecture (`packages/coding-agent/src/polar/exec`)

> **Prerequisites:** Read [`../shared/ARTIFACT-BUS.md`](../shared/ARTIFACT-BUS.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) before modifying `packages/coding-agent/src/polar/exec`.

---

## 1. Isolation Model & UI vs LLM Contract

The `exec` extension runs Python 3.13 or Bash scripts inside an isolated Linux VM via the `container` CLI.

- **Artifact Bus Mount (`/data`):** Mounts `session.outputDirectory` read-only at `/data` inside the guest.
- **Persistent Workspace (`/work`):** Mounts a per-session volume (`polar-work-<sessionId>`, `4 GiB`) read-write at `/work` (`HOME=/work`). Files in `/work` persist across calls within the session.
- **Per-Call Limits:** Each call runs in a fresh container (`--network none`, `--read-only`, `--cap-drop ALL`, `--user 1000:1000`, `2 GiB` RAM, `4` CPUs, `nproc=256`, `512 MiB` tmpfs at `/tmp`, `300s` timeout).
- **Sequential Execution:** `executionMode: "sequential"` runs one call at a time per session.
- **UI vs LLM Naming Contract:** No footer status (`ctx.ui.setStatus`) is set. User-facing notifications (`ctx.ui.notify`) refer to the runtime as `sandbox` (`sandbox is off: ...`, `sandbox: ...`), whereas the tool name, `promptGuidelines`, and model-facing replies remain `exec`.

---

## 2. File Structure & Layers

Each layer in `packages/coding-agent/src/polar/exec/src/` imports only from lower layers:

```text
packages/coding-agent/src/polar/exec/
├── ARCHITECTURE.md                  # VM sandbox architecture and layer boundaries
├── index.ts                         # --exec-image flag, session_start/shutdown wiring, tool registration
├── image/
│   ├── Containerfile                # Guest image definition (default tag: polar-exec:0.2)
│   ├── requirements.in
│   └── requirements.txt
├── src/
│   ├── types.ts                     # Data structures and state types
│   ├── cli.ts                       # Layer 1: Stateless `container` CLI execution and JSON parsing
│   ├── workspace.ts                 # Layer 2: Readiness check, orphan container/volume GC, /work volume setup
│   ├── runner.ts                    # Layer 3: Admission, `container run` supervision, OOM check, container cleanup
│   └── reply.ts                     # Layer 4: Reply budget calculation, stdout/stderr store finalization, formatting
└── test/
    ├── fake-container.mjs           # Stateful stand-in for the `container` CLI in tests
    ├── fixtures.ts
    └── *.test.ts
```

### Layer Responsibilities

1. **`src/cli.ts` (Layer 1 — Stateless CLI Adapter)**
   - Spawns short `container` commands (`system status`, `image inspect`, `list`, `inspect`, `kill`, `delete`, `volume *`, `logs --boot`) with `commandTimeoutMs` (`30s`), tracking child processes in `runtime.children`.
   - Parses JSON array outputs (`parseListing`, `parseContainers`, `parseVolumes`) and bounds diagnostic stderr (`boundDiagnostic`: `4 KiB` / `64` lines).
   - Implements `cleanupContainer(runtime, name, deadlineAt)` and `cleanupOwned(runtime, deadlineAt)`: runs `container delete --force <name>`, and if non-zero, checks `container list --all --format json` before removing `name` from `runtime.owned`.
   - Holds no session or runtime state and does not touch `/work` or `ExecRun`.

2. **`src/workspace.ts` (Layer 2 — Session Workspace & Recovery)**
   - `startRuntime`: checks `container system status` and `container image inspect <image>`, recovers leftover resources under the same `polar-root` label, and prepares `/work`.
   - `recoverLeftovers`: deletes containers belonging to the current session or to sessions whose `sessionLiveness` is `"ended"`. Deletes volumes when the owning session's directory is absent (`ENOENT`). Preserves resources of `"alive"` and `"unknown"` sessions.
   - `ensureWorkVolume`: inspects or creates `polar-work-<sessionId>` with `polar-session` and `polar-root` labels, then runs a root container (`chown 1000:1000 /work`) to set guest ownership.
   - `shutdownRuntime`: closes admission, waits up to `shutdownBudgetMs` (`10s`) for in-flight operations to drain, cleans up owned containers, kills remaining CLI processes on `quit`, and releases the session handle when drained.

3. **`src/runner.ts` (Layer 3 — Call Admission & `container run` Supervision)**
   - `admitCall`: admits a call when `runtime.state === "open"` and records `toolCallId` in `runtime.inFlight`.
   - `ExecCall`: cleans up leftover owned containers from prior calls (failing with `runtime_failed` if any remain), opens `<outputDirectory>/exec-<n>.part` via `openOutputFile`, and spawns `container run`.
   - `ExecRun`: writes the script to `stdin` of the guest launcher (`cat > "$TMPDIR/.polar/program.<ext>" && exec <interpreter> ... </dev/null`), streams `stdout` into `OpenFile.sink` with backpressure, captures `stderr` up to `1 MiB`, and stops the container on timeout, abort, output limit, or shutdown via `container kill <name>` followed by `SIGKILL` after `killGraceMs` (`2s`).
   - On non-zero exit: for `exitCode === 137`, checks `container logs --boot <name>` for a kernel OOM line (`out_of_memory`); otherwise inspects container presence (`present | absent | unknown`) before deleting the container via `cleanupContainer`.

4. **`src/reply.ts` (Layer 4 — Sandbox Reply Builder)**
   - Finalizes `result.output` (`discardOutputFile` if a plain `ok` or if the full output fits the reply room; `finishOutputFile` otherwise) and saves oversized `stderr` via `saveBytes` as `exec-stderr-<n>.txt`.
   - Formats the reply with status line `[exec <status>] <language>: <first-line>`, `stdout` head excerpt, `[stderr]...[/stderr]` tail excerpt, and notices (`outputLimitNotice`, `cleanupNotice`, `inspectionNotice`, `statusMessage`).
   - Saved file notices point to `"read" tool` (when `<= 16 MiB`) and `"exec" tool from /data/<file>`.

---

## 3. Guest Image (`packages/coding-agent/src/polar/exec/image`)

Build command:
```bash
(cd packages/coding-agent/src/polar/exec/image && container build --arch arm64 --tag polar-exec:0.2 --file Containerfile .)
```

- **Python 3.13 kit:** `duckdb`, `polars`, `pandas`, `numpy`, `orjson`, `ijson`, `pyyaml`, `jmespath`, `python-dateutil`, `ciso8601`, `regex`, `tabulate`, `drain3`.
- **CLI kit:** `bash`, `coreutils`, `gawk`, `ripgrep`, `jq`, `yq`, `duckdb`, `miller`.
- Runs as user `1000:1000` under kernel `RLIMIT_NPROC` (`256`).
