# Sandbox Architecture (`packages/coding-agent/src/polar/sandbox`)

> **Prerequisites:** Read [`../shared/ARTIFACT-BUS.md`](../shared/ARTIFACT-BUS.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) before modifying `packages/coding-agent/src/polar/sandbox`.

---

## 1. Isolation Model & Hot VM Lifecycle

The `sandbox` extension (`builtin:sandbox`) registers the `run_code` tool, executing Python 3.13 or Bash scripts inside an isolated Linux sandbox behind the `SandboxDriver` interface:
- **`AppleContainerDriver` (`apple-container`):** macOS Desktop microVM via the native `container` CLI (`Virtualization.framework`).
- **`OciDriver` (`oci`):** Linux Desktop OCI container via `podman` (rootless `>= 4.3` with `--userns=keep-id:uid=1000,gid=1000 --user 1000:1000`) or standard `docker` (`--user <hostUid>:<hostGid>`), with optional `--sandbox-oci-runtime` (`krun` or `runsc`). Rootless Docker is rejected with an explicit actionable reason.
- **`K8sDriver` (`k8s`):** Kubernetes 24/7 cluster Pod via `kubectl` with an isolated in-cluster kubeconfig, mandatory `runtimeClassName` (`POLAR_SANDBOX_K8S_RUNTIME_CLASS`, e.g. `gvisor` or `kata`), `ownerReferences` to the `polar` Pod, static `NetworkPolicy` deny-all verified once at `session_start` by a startup TCP probe to `KUBERNETES_SERVICE_HOST:KUBERNETES_SERVICE_PORT` (guarding against missing CNI policy enforcement or unapplied manifests; preventing mid-session policy deletion is the responsibility of cluster RBAC), and shared PVC `subPath` mounts (`artifacts/<sessionId>` read-only at `/data` and `work/<sessionId>` read-write at `/work` with `fsGroup: 1000`). Deployment manifests and `Containerfile` for the `polar` Pod live in `deploy/k8s/`.

- **Driver Selection (`--sandbox-driver`):**
  - Default `"auto"`: selects `"k8s"` if `POLAR_SANDBOX_K8S_PVC` or `--sandbox-k8s-pvc` is set, `"apple-container"` on `darwin`, and `"oci"` on `linux`.
  - On `oci` and `k8s` startup, notifies the operator of the selected engine/runtime and isolation boundary (`sandbox: oci (podman/krun)`, `sandbox: oci (docker/runc, shared kernel)`, or `sandbox: k8s (gvisor)`).
- **Artifact Bus Mount (`/data`):** Mounts `session.outputDirectory` read-only at `/data` inside the guest. The host working directory (`cwd`) is never mounted inside the VM; only `/data` and `/work` exist.
- **Persistent Workspace (`/work`):** Mounts a per-session volume (`polar-work-<sessionId>`, `4 GiB`) read-write at `/work` (`HOME=/work`). Files in `/work` persist across calls and across VM recreations within the session.
  - On `apple-container`, the volume is created with `-s 4096M` (hard ext4 block limit returning `ENOSPC`).
  - On `oci` and `k8s` (where named volumes or shared PVC `subPath` directories have no block size limit), `launcher` runs a background `du -sk /work` watchdog that kills the interpreter process group and exits with code `199` (`status: "work_limit"`) if `/work` exceeds `workMaxBytes` (`4 GiB`) and grows beyond its size at the start of the call (`currentBytes > workMaxBytes && currentBytes > initialBytes`). Calls that do not increase `/work` size (such as `rm` to free space) proceed freely.
  - On `k8s`, kubelet creates `work/<sessionId>` on the shared PVC when the sandbox Pod starts. Orphaned `work/<id>` directories of ended sessions are listed via `polar-work-ls-...` and removed synchronously at `session_start` in a batched cleanup Pod (`polar-work-rm-...`) within `commandTimeoutMs` (`30s`), without requiring `pods/log` RBAC permissions. For very large directories, deletion converges across multiple consecutive session starts (up to `30s` each) while the sandbox stays enabled and `run_code` remains operational.
- **Image Lookup & Host Diagnosis (`host.ts`):**
  - Default image tag: `polar-sandbox:0.2` (multi-arch: `linux/arm64` and `linux/amd64`).
  - Candidate resolution in `ImageSpec` (`buildImageSpec`):
    1. No flags: searches `REGISTRY_IMAGE`, then `polar-sandbox:0.2`; `pull` is `REGISTRY_IMAGE`, `build` is `polar-sandbox:0.2`.
    2. `--sandbox-registry-image R`: searches `R`, then `polar-sandbox:0.2`; `pull` is `R`, `build` is `polar-sandbox:0.2`.
    3. `--sandbox-image C`: searches `C`; `pull` is `C`, `build` is `C`.
    4. Both `--sandbox-image C` and `--sandbox-registry-image R`: searches `R`, then `C`; `pull` is `R`, `build` is `C`.
    5. When no registry image is configured (or on `k8s`): `pull` is `undefined` and only `[build]` is searched.
  - `probeHost(host)` runs `host.driver.probeRuntime` and inspects `host.imageSpec.candidates` in order without mutating `host.image` or `host.imageSpec` and without showing startup dialogs.
  - When the runtime or image is not ready, `session_start` sets the footer status `sandbox: off, run /sandbox` (`ctx.ui.setStatus("sandbox", ...)`) and emits a single warning notification (`sandbox is off: <reason>`). When `autoStartService: true` is saved in `sandbox.json` and the default action of the initial diagnosis provides `runQuick` (on `apple-container`, `container system start --disable-kernel-install`), `session_start` runs `runQuickSetup` under the machine lock (waiting up to `3s`) and re-probes once before deciding whether to activate or warn. When `container` is missing (`ENOENT`) on `apple-container`, the driver checks `/usr/sbin/sysctl -n hw.optional.arm64` (`unsupported` on Intel) and `/usr/bin/sw_vers -productVersion`, offering the `foreground` action `install_runtime` (`apple-install.ts`, pinned signed `container-1.7.1-installer-signed.pkg`, verified by SHA-256 and `pkgutil --check-signature` for Team ID `UPBK2H6LZM`, then installed via `/usr/bin/sudo -- /usr/sbin/installer -pkg <path> -target /`) on Apple silicon with macOS `>= 26` and manual instructions on older macOS. For a stopped `apple-container` service, the driver builds an `actions` `Remedy` with `start_service` (`container system start --enable-kernel-install`, `30 min` timeout, plus `runQuick`); on a ready `apple-container` runtime, `probeRuntime` also attaches `repair` (`start_service` without `runQuick`) so `/sandbox` can install a missing Linux kernel after an activation failure. For a missing image, the driver builds an `actions` `Remedy` (`pull_image` when `imageSpec.pull` is set, and `build_image` from `getSandboxImageDir()`, `10 min` timeout; on `apple-container` passes `--arch arm64`).
  - Operator command `/sandbox` (`command.ts`) inspects `HostDiagnosis`, previews CLI commands, runs `foreground` setup actions (downloading the macOS `.pkg` in a `CancellableLoader` dialog via `ctx.ui.custom`, waiting for agent idleness, and pausing TUI to hand off the terminal to `sudo installer`, or printing manual commands when terminal handoff is unavailable in RPC, without a TTY, or while the agent is busy) and `background` setup actions under the machine lock (`setup.ts`) with cancellation (`Cancel setup` / `Keep running` / `Disable sandbox`), activates `run_code` in the live session upon readiness, automatically records `autoStartService: true` in `sandbox.json` after the first `start_service` completion when `autoStartService` was `undefined`, toggles `autoStartService` (`Enable service auto-start` / `Disable service auto-start`) on drivers where `supportsServiceAutoStart` is `true`, and toggles `disabled` (`Disable sandbox` / `Enable sandbox`) in `sandbox.json` (`preferences.ts`). When `disabled: true`, `session_start` skips host probing and leaves the footer status empty; `Disable sandbox` in an active session immediately destroys the VM, releases the session lock, and re-registers `run_code` with `exposure: "hidden"`.
- **Operator Output Quotas:** `fileMaxBytes` is `4 GiB` and `sessionMaxBytes` is `16 GiB`.
- **Lazy Hot Sandbox VM / Container:**
  - The sandbox is started lazily on the first `run_code` call in the session (`driver.startSandbox`), not at `session_start`.
  - Runs with `--network none`, `--read-only`, `--cap-drop ALL`, `2 GiB` RAM (`--memory 2048m --memory-swap 2048m` on `oci`), `4` CPUs (checked against `host.cgroupControllers` in `podman info`), `256` max processes (`--ulimit nproc=256:256` on `apple-container`, `--pids-limit 256` on `oci` with non-gVisor runtimes, and `ulimit -u 256` in `launcher` on `k8s` and `oci` under `runsc`), and a `512 MiB` tmpfs at `/tmp` (without `--init`). On `oci`, also passes `--security-opt=no-new-privileges` and `--security-opt label=disable`.
  - PID 1 inside the guest is `bash -c 'echo; while read -r _; do :; done'`. Built-in `read` spawns no child process, survives `kill -9 -1`, reaps zombies, and exits immediately on `stdin` EOF if the host `polar` process exits or is killed with `SIGKILL`.
  - Each `run_code` invocation executes via `<engine> exec --interactive --user <guestUser> --workdir /work ... bash -c <launcher>` (`spawnCall`). The `300s` per-call timeout starts strictly when `spawnCall` spawns the script, excluding lazy boot time.
  - After every completed call, `scrubAfterCall` runs an external `<engine> exec` that kills any remaining processes of the guest user, removes SysV IPC objects (`ipcrm --all`), resets permissions (`chmod -R u+rwX`), deletes all entries under `/tmp`, `/dev/shm`, and `/dev/mqueue`, and verifies that no user processes, temporary files, or SysV IPC objects remain.
  - On timeout, cancellation, output limit, OOM, stopped/missing/unknown container inspection, or `scrubAfterCall` returning `false`, the hot sandbox is destroyed (`hot.destroy`) and transparently recreated on the next call while preserving `/work`.
- **Sequential Execution:** `executionMode: "sequential"` runs one call at a time per session.
- **UI vs LLM Naming Contract:** When the sandbox is off (host not ready or activation failed), sets the footer status `ctx.ui.setStatus("sandbox", "sandbox: off, run /sandbox")`; when active, clears the footer status (`undefined`). The only widget mounted is the transient `sandbox-image` progress line during service start and image pull/build in TUI mode. User-facing notifications (`ctx.ui.notify`) refer to the runtime as `sandbox` (`sandbox is off: ...`, `sandbox: ...`), whereas the tool name, `promptGuidelines`, and model-facing replies use `run_code` (`[run_code <status>]`, `run_code-<n>.txt`, `run_code-stderr-<n>.txt`).

---

## 2. File Structure & Layers

Each numbered layer in `packages/coding-agent/src/polar/sandbox/src/` imports only from lower layers; `controller.ts` and `command.ts` coordinate Layers 3 and 4 with `preferences.ts` and `indicator.ts`, and are wired to the session events and `/sandbox` command in `index.ts`:

```text
packages/coding-agent/src/polar/sandbox/
├── ARCHITECTURE.md                  # VM sandbox architecture and layer boundaries
├── index.ts                         # --sandbox-driver / --sandbox-image / --sandbox-registry-image / --sandbox-oci-* / --sandbox-k8s-pvc flags, /sandbox command, session_start/shutdown wiring, run_code tool definition
├── image/
│   ├── Containerfile                # Multi-arch guest image definition (default tag: polar-sandbox:0.2)
│   ├── requirements.in
│   └── requirements.txt
├── src/
│   ├── types.ts                     # Domain data structures, HostDiagnosis/Remedy/SetupAction, SandboxDriver & HotSandbox contracts
│   ├── cli.ts                       # Layer 1: Stateless CLI execution in a process group and diagnostic primitives
│   ├── driver.ts                    # Layer 2: Driver barrel exports
│   ├── drivers/
│   │   ├── shared.ts                # Shared guest constants, launcher, version helper, and UnsupportedSandboxDriver
│   │   ├── apple.ts                 # AppleContainerDriver & AppleHotSandbox (`container` microVM)
│   │   ├── apple-install.ts         # Pinned Apple container .pkg download, SHA-256 & pkgutil verification, sudo installer launch, and platform probe
│   │   ├── oci.ts                   # OciDriver & OciHotSandbox (`podman` / `docker`)
│   │   └── k8s.ts                   # K8sDriver & K8sHotSandbox (`kubectl` Pod)
│   ├── host.ts                      # Layer 3: Host diagnosis (`probeHost` -> `HostDiagnosis`), `ImageSpec` resolution, diagnosis texts
│   ├── setup.ts                     # Layer 3: Machine lock, quick service start, and host setup task with rank progression and cancellation
│   ├── workspace.ts                 # Layer 4: Session activation under the session lock (orphan GC, /work volume setup) and shutdown
│   ├── runner.ts                    # Layer 5: Admission, lazy HotSandbox lifecycle, call supervision, OOM, work_limit & scrub
│   ├── reply.ts                     # Layer 6: Reply budget calculation, stdout/stderr store finalization, formatting
│   ├── preferences.ts               # Atomic read and merge update of `sandbox.json` in `getAgentDir()`
│   ├── controller.ts                # Sandbox state of the session: host probe, setup task, activation, disable/enable, footer status, run_code registration, shutdown
│   ├── command.ts                   # `/sandbox` command screens, menus, installer download dialog, and terminal handoff
│   ├── progress.ts                  # CLI pull progress parser (`ProgressReader` -> `ImageProgress`)
│   └── indicator.ts                 # TUI progress line widget (`showImageOperation`: `"download" | "build" | "service"`)
└── test/
    ├── fake-container.mjs           # Stateful stand-in for the `container` CLI in tests
    ├── fake-oci.mjs                 # Stateful stand-in for the `podman` / `docker` CLI in tests
    ├── fake-kubectl.mjs             # Stateful stand-in for the `kubectl` CLI in tests
    ├── fixtures/                    # Recorded non-TTY `container image pull` and `docker pull` output chunks
    ├── fixtures.ts
    └── *.test.ts
```

### Layer Responsibilities

1. **`src/cli.ts` (Layer 1 — Stateless CLI & Diagnostic Primitives)**
   - Spawns short runtime CLI commands with `commandTimeoutMs` (`30s`), optional `AbortSignal`, optional child `env` override, and optional per-line output streaming (`CommandOptions.onLine` via per-stream `LineSplitter`), tracking each command in `runtime.children` (`Set<TrackedChild>`) as `kind: "service"` whose `kill()` sends `SIGKILL` to the process group, destroys `stdout`/`stderr`, and settles the command promise immediately.
   - Each command runs as the leader of its own process group. A command that ends on its own returns on `close`, after all of its output is read. On timeout or abort the whole group receives `SIGTERM` and, after `killGraceMs`, runs the same `kill()` path so the command returns without waiting for a process outside the group that still holds its output.
   - A command that could not be spawned reports the error code in `CommandOutcome.spawnError` (for example `ENOENT`).
   - Provides stream retention (`StreamCapture`), deadline helpers (`deadlineAfter`, `remainingMs`, `firstLine`), and bounded diagnostic formatting (`boundDiagnostic`: `4 KiB` / `64` lines, `DIAGNOSTIC_MAX_BYTES`, `DIAGNOSTIC_MAX_LINES`, `commandFailure`, `describeCleanupErrors`).

2. **`src/driver.ts` & `src/drivers/{shared,apple,apple-install,oci,k8s}.ts` (Layer 2 — `SandboxDriver` & `HotSandbox`)**
   - A driver is built over a `SandboxDriverContext`, which holds no session, stores an immutable `imageSpec` (`candidates`, `pull?`, `build`) alongside the active `image`, and tracks live child handles in `children: Set<TrackedChild>`. Drivers declare `supportsServiceAutoStart`, `probeRuntime()` (`RuntimeProbeResult` with optional `version` and `repair`), and `imageRemedy(imageSpec)` (`Remedy` with `pull_image` / `build_image` actions). Methods that act for a session (`listWorkVolumes`, `ensureWorkVolume`, `deleteWorkVolumes`, `startSandbox`) receive its `SessionPaths` as an argument. Long-lived call and keepalive processes register as `TrackedChild` with `kind: "run"` and `kill: () => child.kill("SIGKILL")`.
   - `src/drivers/shared.ts`: shared guest constants, the guest script `launcher`, volume/label/version helpers, and `UnsupportedSandboxDriver`.
   - `src/driver.ts`: barrel module re-exporting the concrete drivers and shared helpers.
   - `src/drivers/apple.ts` & `src/drivers/apple-install.ts` (`AppleContainerDriver` & `AppleHotSandbox`): macOS microVM implementation via `container` — `probeRuntime` over `container system status --format json` and `container --version` (`>= 1.5.0`, reporting `client.version` or `${client.version} (service ${server.version})` on mismatch, checking Apple silicon via `sysctl -n hw.optional.arm64` and macOS `>= 26` via `/usr/bin/sw_vers -productVersion` on `ENOENT` to offer `install_runtime` or manual instructions / `unsupported`, offering `start_service` with `runQuick` when the service is `unregistered` or `not running`, and attaching `start_service` without `runQuick` as `repair` when `running`), `apple-install.ts` (TUI-independent download of pinned `container-1.7.1-installer-signed.pkg` into a `0700` subdirectory of `getAgentDir()`, streaming SHA-256 and `pkgutil --check-signature` verification for Team ID `UPBK2H6LZM`, and execution of `/usr/bin/sudo -- /usr/sbin/installer -pkg <path> -target /` with a minimal environment, temporary `SIGINT` handler, and `truncateTail` bounding of combined installer output), `imageRemedy` with `--arch arm64`, `/work` volume lifecycle (`-s 4096M`), container force-deletion with post-delete verification, and boot-log OOM delta detection (`logs --boot`).
   - `src/drivers/oci.ts` (`OciDriver` & `OciHotSandbox`): Linux OCI implementation via `podman` or `docker` — pure `parseEngineInfo` (`version.Version` for Podman, `ServerVersion` for Docker), discovers the engine (`podman` then falling back to `docker` in `auto` mode if `podman` is missing or unsuitable, reporting reasons only for installed engines) while `runtime.state === "unready"` and pins the chosen engine and launch parameters once activated, rejects rootless Docker and rootless Podman `< 4.3`, checks `cpu` cgroup delegation in Podman, detects gVisor (`runsc`) to switch process limiting from `--pids-limit` to `launcher` `ulimit -u`, prepares `/work` (`:nocopy`) with `chown`, enforces the soft `work_limit` (`exit 199`), and detects OOM by `oom_kill` delta in `/sys/fs/cgroup/memory.events` or container `State.OOMKilled`.
   - `src/drivers/k8s.ts` (`K8sDriver` & `K8sHotSandbox`): Kubernetes Pod implementation via `kubectl` with an isolated ServiceAccount kubeconfig atomically written to `/tmp` and `KUBECONFIG` stripped from child process environments — verifies `POLAR_SANDBOX_K8S_*` and self-Pod UID in `probeRuntime`, refuses a `sessionId` that cannot name a Pod in `ensureWorkVolume` and `startSandbox` (and starts no `polar-work-ls-*` Pod for it in `listWorkVolumes`), runs the combined `/work` writability + `NetworkPolicy` deny-all probe Pod (`polar-netprobe-*`) in `ensureWorkVolume` (after `recoverLeftovers`), creates sandbox Pods under Pod Security `restricted` (`restartPolicy: Never`, `stdin: true` without `kubectl attach`, `ownerReferences`, `nodeSelector`, `polar-root-hash` label + `polar-root` annotation), deletes the Pod immediately on `kill()`, and performs two-step OOM detection on exit `137` or `128` (`state.terminated.reason === "OOMKilled"` with status-lag polling when the Pod is dead, or `/sys/fs/cgroup/memory.events` `oom_kill` delta when the Pod remains alive).

3. **`src/host.ts` & `src/setup.ts` (Layer 3 — Host Readiness, Diagnosis & Setup)**
   - `buildImageSpec` (`host.ts`): resolves `ImageSpec` (`candidates`, `pull?`, `build`) from `--sandbox-image` and `--sandbox-registry-image` so that every image action produces a candidate searched by `probeHost`.
   - `probeHost` (`host.ts`): probes a `SandboxHost` without mutating `host.image` or `host.imageSpec`, calling `host.driver.probeRuntime` and checking `host.imageSpec.candidates` in order to return a `HostDiagnosis` (`ready` with `image`, `version?`, `repair?`, or `unsupported` / `runtime_missing` / `runtime_not_ready` / `image_missing` / `probe_failed`).
   - Provides `SANDBOX_OFF_STATUS` (`"sandbox: off, run /sandbox"`) and `formatDiagnosisWarning`.
   - `runQuickSetup` and `runHostSetup` (`setup.ts`): `runQuickSetup` waits up to `3s` for the inter-process machine lock (`proper-lockfile` in `getAgentDir()`, `realpath: false`, `stale: 30_000`), re-probes the host, runs the default action's `runQuick` once if still applicable, and returns the resulting `HostDiagnosis` without chaining further actions. `runHostSetup` acquires the machine lock without waiting (`onCompromised` cancels the task), re-probes the host so stale action choices return the new diagnosis instead of running silently, and executes the setup action chain with strict rank progression (`runtime_missing (0) < runtime_not_ready (1) < image_missing (2) < ready (3)`).

4. **`src/workspace.ts` (Layer 4 — Session Workspace & Recovery)**
   - `activateRuntime`: acquires the session lock (`acquireSession`), verifies `host.state === "unready"`, records the chosen tag in `host.image` (leaving `host.imageSpec` intact), runs `recoverLeftovers(host, handle.paths, warn)` and `ensureWorkVolume(host, handle.paths)`, and attaches the session fields (`handle`, `inFlight`, `running`, `activeSandbox`) to the same `host` object via `Object.assign` only after activation succeeds. On any failure or exception, releases `handle` in `finally` without attaching it to `host`.
   - `recoverLeftovers` and `cleanupOwned`: `recoverLeftovers` deletes containers belonging to the current session or to sessions whose `sessionLiveness` is `"ended"`, deletes volumes when the owning session's directory is absent (`ENOENT`), and preserves resources of `"alive"` and `"unknown"` sessions. `cleanupOwned(host, deadlineAt, exclude)` deletes owned containers through `host.driver.deleteSandbox`.
   - `shutdownRuntime`: closes admission, waits up to `shutdownBudgetMs` (`10s`) for in-flight operations to drain, destroys the active `HotSandbox` and cleans up owned containers, kills remaining tracked children on `quit` via `entry.kill()` (without importing `killProcessGroup` or knowing about process groups), and releases the session handle when drained.
   - `shutdownHost`: shuts down a host without an active session. Marks it closing so that a pending operation ends at its next step and waits for that operation within `shutdownBudgetMs`. If the pending activation completed as a runtime and was already closed by `shutdownRuntime` (`host.state === "closed"`), returns immediately; otherwise deletes the containers a failed activation left owned and kills remaining tracked children on `quit` via `entry.kill()`.

5. **`src/runner.ts` (Layer 5 — Call Admission & Hot Sandbox Supervision)**
   - `admitCall`: admits a call when `runtime.state === "open"` and records `toolCallId` in `runtime.inFlight`.
   - `SandboxCall`: cleans up leftover owned containers from prior calls (excluding the active warm `HotSandbox`), opens `<outputDirectory>/run_code-<n>.part` via `openOutputFile`, reuses `runtime.activeSandbox.current` (or recreates it once if `spawnCall` reports `{ gone }`, or lazily starts it on the first call), and starts `SandboxRun`.
   - `SandboxRun`: writes the script to `stdin` of the guest launcher, streams `stdout` into `OpenFile.sink` with backpressure, captures `stderr` up to `1 MiB`, and stops the call on timeout, abort, output limit, or shutdown.
   - On completion: checks OOM delta on exit `137` (and exit `128` on `oci` and `k8s`), inspects container/pod state on non-zero exit, runs `scrubAfterCall` when the VM remains healthy, and destroys the VM whenever stopped, OOM-killed, not `present` on inspection (`stopped`, `absent`, or `unknown`), or when `scrubAfterCall` returns `false`.

6. **`src/reply.ts` (Layer 6 — Sandbox Reply Builder)**
   - Finalizes `result.output` (`discardOutputFile` if a plain `ok` or if the full output fits the reply room; `finishOutputFile` otherwise) and saves oversized `stderr` via `saveBytes` as `run_code-stderr-<n>.txt`.
   - Formats the reply with status line `[run_code <status>] <language>: <first-line>`, `stdout` head excerpt, `[stderr]...[/stderr]` tail excerpt, and notices (`outputLimitNotice`, `cleanupNotice`, `inspectionNotice`, `statusMessage`).
   - Saved file notices point to `"read" tool` (when `<= 16 MiB`) and `"run_code" tool from /data/<file>`.

7. **`src/preferences.ts`, `src/controller.ts` & `src/command.ts` (Session Controller & `/sandbox` Command)**
   - `src/preferences.ts`: reads and atomically updates `sandbox.json` in `getAgentDir()` (`disabled`, `autoStartService`) via a `0600` temporary file and `rename`.
   - `SandboxController` (`src/controller.ts`) holds the sandbox state of one session: `off` → `activating` → `active` → `closing` → `closed` plus `disabled`, and tracks the current transitional operation in `pending` (`Promise<void> | undefined`). It is constructed with a `createHost: () => SandboxHost` factory and a `registerRunCode` callback (supporting `exposure: "hidden"` on disablement).
   - Start (from `off` when no `pending` operation is running): reads `sandbox.json` (moving to `disabled` without probing if `disabled: true`), otherwise runs `probeHost` without startup dialogs (and if `autoStartService: true` and the default action has `runQuick`, runs `runQuickSetup` once); a host that is not ready stays `off`, sets `ctx.ui.setStatus("sandbox", "sandbox: off, run /sandbox")`, emits one warning notification, and acquires no session lock. A ready host is activated via `activateRuntime` with the image from `HostDiagnosis`, then opens the runtime, registers `run_code`, and clears the footer status.
   - Setup task & disable/enable: runs `runHostSetup` in the background while mounting the `sandbox-image` progress widget per step, saves `autoStartService: true` when `start_service` completed and `autoStartService` was `undefined`, activates and notifies `sandbox: ready` when setup completes in `off` (or updates `runtime.image` to the image from `HostDiagnosis` and notifies `sandbox: ready` without touching footer status when recovering in `active`), toggles `autoStartService` when `supportsServiceAutoStart` is `true`, and supports live `Disable sandbox` (cancelling pending setup, shutting down the active runtime, releasing the session lock, hiding `run_code`, and clearing footer status) and `Enable sandbox` (recreating a fresh `SandboxHost` via `createHost()`).
   - Notifications (`ctx.ui.notify`), footer status updates (`ctx.ui.setStatus`), activation `warn`, and `registerRunCode` are guarded by `isAlive()` (`state !== "closing" && state !== "closed"`). If activation finishes after the session began shutting down or was disabled, the controller closes the late `runtime` through `shutdownRuntime` and registers nothing.
   - Shutdown: moves to `closing`, immediately disposes any active progress widget, aborts any running quick service start or setup task, waits for `pending` and closes the active runtime or host within `shutdownBudgetMs`, and moves to `closed` when the handler returns.
   - `src/command.ts` (`runSandboxCommand`): implements the `/sandbox` screens and menus over `SandboxController`, plus the `CancellableLoader` download dialog (`ctx.ui.custom`, titled by `action.title ?? action.label`), agent-idle wait (`ctx.waitForIdle`), and TUI pause/resume terminal handoff (`drainInput`, `tui.stop`, `tui.start`, `requestRender(true)`) for `foreground` setup actions.

8. **`src/progress.ts` & `src/indicator.ts` (UI Helpers — Progress Widget)**
   - `src/progress.ts` (`ProgressReader`): pure parser (no TUI/theme imports) extracting step, completion fraction, and byte/layer counts from `container image pull` and non-TTY `docker pull` output lines, falling back to the latest sanitized text line.
   - `src/indicator.ts` (`showImageOperation`): mounts and idempotently disposes the `sandbox-image` TUI widget above the editor for `"download"`, `"build"`, and `"service"` operations, rendering either a fixed-column progress bar or a right-aligned elapsed-time status line.

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
