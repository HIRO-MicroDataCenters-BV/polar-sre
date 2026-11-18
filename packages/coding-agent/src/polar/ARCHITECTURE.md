# Extensions Architecture

Polar extensions provide a modular toolset for agentic SRE diagnostics. Producer extensions collect read-only telemetry and state; `files` and `sandbox` inspect and process saved outputs across a shared filesystem bus (**Artifact Bus**).

---

## 1. Reading Order by Task

| Task | Required Reading |
|---|---|
| Create or modify a read-only producer (`k8s`, `loki`, `grafana`, ...) | 1. [`shared/PRODUCER.md`](shared/PRODUCER.md)<br>2. `<producer>/ARCHITECTURE.md`<br>3. [`shared/ARTIFACT-BUS.md`](shared/ARTIFACT-BUS.md) (when working on artifact mode, quotas, or the manifest) |
| Modify session locking, quotas, `manifest.jsonl`, or the `files` extension | 1. [`shared/ARTIFACT-BUS.md`](shared/ARTIFACT-BUS.md) |
| Modify the `sandbox` VM extension | 1. [`sandbox/ARCHITECTURE.md`](sandbox/ARCHITECTURE.md)<br>2. [`shared/ARTIFACT-BUS.md`](shared/ARTIFACT-BUS.md) |

When creating any new extension directory `packages/coding-agent/src/polar/<name>/`, register it in `packages/coding-agent/src/extensions/index.ts` (`polarBuiltInExtensions`); it is then automatically included in `POLAR_DEFAULT_EXTENSION_SPECIFIERS` (`builtin:<name>`).

---

## 2. System Topology

```text
  [ Read-Only Producer Extensions ]
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │   k8s   │   │  loki   │   │ grafana │   (standalone, independently enabled)
   └────┬────┘   └────┬────┘   └────┬────┘
        │             │             │
        ▼             ▼             ▼
 ════════════════════════════════════════════════════════════════
  SHARED: Producer SDK + Artifact Bus (packages/coding-agent/src/polar/shared/)
  • Small text output (<= 50 KiB & <= 2000 lines) -> returned inline, .part deleted
  • Large text output                             -> published as .txt + manifest.jsonl
  • Artifact transfer (raw bytes)                 -> published as .bin + manifest.jsonl
 ════════════════════════════════════════════════════════════════
                │                              │
                ▼                              ▼
       ┌─────────────────┐            ┌─────────────────┐
       │      files      │            │     sandbox     │
       │ • list_files    │            │ • run_code      │
       │ • read gate     │            │ • /data:ro      │
       │   (<= 16 MiB,   │            │ • /work volume  │
       │    *.txt only)  │            │ • Python & CLI  │
       │                 │            │   analytics VM  │
       └─────────────────┘            └─────────────────┘
             [ Artifact Consumers & Analysis ]
```

### Module Roles

1. **`shared/` (Core Infrastructure & Producer SDK)**
   Manages session directory locking, streaming file storage, quotas, manifest logging, and the execution/reply pipeline for read-only producer tools.
2. **`files/` (Artifact Catalog & Read Gate)**
   Provides `list_files` over `manifest.jsonl` and restricts Pi's built-in `read` tool to `.txt` files inside the active session directory up to `16 MiB`.
3. **`<producer>/` (`k8s`, `loki`, `grafana`, ...)**
   Standalone, deterministic, read-only toolsets. Each producer validates structured tool parameters, streams output into `shared/store.ts`, and formats replies through `shared/reply.ts`.
4. **`sandbox/` (Local VM / Container / Kubernetes Sandbox)**
   An isolated Linux sandbox (`AppleContainerDriver` on macOS via `container`, `OciDriver` on Linux via `podman` / `docker`, and `K8sDriver` in Kubernetes clusters via `kubectl` behind `SandboxDriver`) with Python and CLI analytics tools, exposed as the `run_code` tool. Mounts the session artifact directory read-only at `/data` and a persistent per-session volume at `/work`. Keeps a hot sandbox per session (lazily started on the first `run_code` call and scrubbed after each call) and writes its own large `stdout`/`stderr` outputs to the Artifact Bus.

---

## 3. Canonical Directory Tree

```text
packages/coding-agent/src/polar/
├── ARCHITECTURE.md                  # System topology, file tree, invariants
│
├── shared/                          # Core layer & Producer SDK
│   ├── ARTIFACT-BUS.md              # Session, store, manifest, and files gate contract
│   ├── PRODUCER.md                  # Blueprint for read-only producer extensions
│   ├── session.ts                   # Session registry, lock file, stale session GC
│   ├── store.ts                     # Streaming file writer (.part -> .txt / .truncated.txt / .bin), quotas, manifest, excerpts
│   ├── runtime.ts                   # Extension state (open/closing/closed) and in-flight call tracking
│   ├── process.ts                   # Streaming CLI runner (stdout -> OpenFile.sink, stderr capture, process group kill)
│   ├── reply.ts                     # Two-phase reply pipeline: storage finalization + pure text formatting
│   ├── tool.ts                      # ToolSpec -> Pi ToolDefinition adapter (NUL check, in-flight ticket, cleanup)
│   ├── validation.ts                # Common parameter validation primitives
│   └── test/                        # Unit tests for shared modules
│
├── files/                           # Session file catalog and built-in read gate
│   ├── index.ts                     # Registers list_files and the tool_call hook on read
│   ├── src/
│   │   ├── gate.ts                  # Realpath boundary, regular-file check, .txt suffix check, 16 MiB limit
│   │   └── types.ts
│   └── test/
│
├── k8s/                             # Read-only Kubernetes producer extension
│   ├── ARCHITECTURE.md              # Kubernetes domain contract and tool specifications
│   ├── index.ts                     # --k8s-kubeconfig and --k8s-context flags, /kubeconfig command, lifecycle, tool registration
│   ├── src/
│   │   ├── types.ts                 # Kubectl request and flag types
│   │   ├── kubeconfig.ts            # Kubeconfig path splitting and kubectl config view context discovery
│   │   ├── kubectl.ts               # Kubectl argv/env construction, flag allowlist check, process execution
│   │   ├── picker.ts                # Fuzzy context filtering and interactive TUI picker
│   │   ├── validation.ts            # Kubernetes-specific parameter validators (DNS names, resource tokens)
│   │   └── tools/                   # Declarative tool specifications
│   │       ├── get.ts               # k8s_get
│   │       ├── describe.ts          # k8s_describe
│   │       ├── logs.ts              # k8s_logs
│   │       ├── events.ts            # k8s_events
│   │       └── inspect.ts           # k8s_inspect (deterministic in-container diagnostics)
│   └── test/
│
├── <producer>/                      # Any read-only producer extension (loki, grafana, prometheus, ...)
│   ├── ARCHITECTURE.md              # Domain contract (endpoints, query rules, tool table)
│   ├── index.ts                     # Connection flags, lifecycle, tool registration
│   ├── src/
│   │   ├── types.ts
│   │   ├── client.ts                # Transport wired to shared/process.ts
│   │   ├── validation.ts            # Domain-specific parameter validators
│   │   └── tools/                   # One file per ToolSpec
│   └── test/
│
├── sandbox/                         # Isolated local VM / container sandbox extension (`run_code`)
│   ├── ARCHITECTURE.md              # Sandbox architecture and internal layer boundaries
│   ├── index.ts                     # --sandbox-driver / --sandbox-image / --sandbox-registry-image / --sandbox-oci-* / --sandbox-k8s-pvc flags, startup readiness, shutdown, tool registration
│   ├── image/
│   │   ├── Containerfile
│   │   ├── requirements.in
│   │   └── requirements.txt
│   ├── src/
│   │   ├── types.ts                 # Domain types and `SandboxDriver` / `HotSandbox` contracts
│   │   ├── cli.ts                   # Layer 1: Stateless CLI execution and diagnostic primitives
│   │   ├── driver.ts                # Layer 2: Driver barrel exports
│   │   ├── drivers/
│   │   │   ├── shared.ts            # Shared guest constants, launcher, and UnsupportedSandboxDriver
│   │   │   ├── apple.ts             # AppleContainerDriver & AppleHotSandbox (`container` microVM)
│   │   │   ├── oci.ts               # OciDriver & OciHotSandbox (`podman` / `docker`)
│   │   │   └── k8s.ts               # K8sDriver & K8sHotSandbox (`kubectl` Pod)
│   │   ├── workspace.ts             # Layer 3: Readiness check, image lookup/pull/build UX, orphan GC, /work volume setup
│   │   ├── runner.ts                # Layer 4: Lazy hot VM lifecycle, `spawnCall` supervision, OOM delta & work_limit check, scrub
│   │   ├── reply.ts                 # Layer 5: Sandbox reply formatting (with OOM, work_limit, inspection, and cleanup notices)
│   │   ├── progress.ts              # CLI pull progress parser (`container` and `docker` output)
│   │   └── indicator.ts             # TUI single-line progress widget for image pull and build
│   └── test/
│
└── test/                            # Cross-extension architectural tests
    ├── composition.test.ts          # Verifies extensions compose in any subset and load order
    └── independence.test.ts         # Enforces the import graph and extension isolation
```

---

## 4. Invariants

Enforced by `test/independence.test.ts` and `test/composition.test.ts`:

1. **Import Graph**
   - `files/`, `sandbox/`, and `<producer>/` import only from `../shared/*`, host types/utilities in `packages/coding-agent/src/` (`../../config.ts`, `../../core/*`, `../../modes/*`), Node built-ins, and declared npm packages.
   - `shared/` imports only from `./*`, host types/utilities in `packages/coding-agent/src/` (`../../core/*`), Node built-ins, and declared npm packages.
   - Cross-extension imports are prohibited.
2. **Built-in Extension Registration**
   - Every Polar extension directory under `packages/coding-agent/src/polar/<name>/` must be registered in `polarBuiltInExtensions` (`packages/coding-agent/src/extensions/index.ts`) with `builtin: true` and exposed in `POLAR_DEFAULT_EXTENSION_SPECIFIERS` as `builtin:<name>` (verified by `every Polar extension directory is registered as a built-in extension` in `test/independence.test.ts`).
3. **Extension Isolation**
   - Extensions do not call `getActiveTools` or inspect which other extensions are loaded.
   - Tool names, descriptions, prompt snippets, prompt guidelines, parameter descriptions, status lines, notices, and replies of an extension do not reference tool names belonging to other extensions (`list_files`, `run_code`, `k8s_*`, `loki_*`, etc.).
   - Producers reference saved files by their full path in the session directory and may mention Pi's built-in `read` tool. Only `sandbox` references `/data/<file>`.
4. **Graceful Disablement**
   - Missing or incomplete operator configuration at `session_start` notifies the operator, sets a footer status (for example, `kubeconfig: off, run /kubeconfig` for `k8s`, or sets no footer status at all, as in `sandbox`), acquires no session lock, and leaves that extension's tools unregistered while the session and other extensions continue normally.
   - Producer extensions may support deferred activation and live target switching during the session via an operator command.
5. **Streaming Output**
   - Primary output streams directly into an `OpenFile.sink` managed by `shared/store.ts` rather than buffering full payloads in memory.
6. **Storage Finalization Before Formatting**
   - `OpenFile` publication (`finishOutputFile`) or deletion (`discardOutputFile`) completes in the storage finalization step before reply formatting. Formatting functions operate on plain data structures without filesystem I/O.
