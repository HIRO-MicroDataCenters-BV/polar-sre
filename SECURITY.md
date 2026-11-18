# Security Policy

Polar (`polar-sre`) is designed as a read-only SRE and incident investigation agent with explicit boundaries around host file access, telemetry collection, and analytical code execution.

## Security Architecture and Isolation Boundaries

### 1. Disabled Host Mutation and Discovery Surface

By default, Polar disables general-purpose host execution and file-mutation tools (`bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, `tool_search`), disables package/update management subcommands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `mcp`), and disables automatic loading of project context files, skills, prompt templates, external extensions, and MCP servers (`-nc -ns -np -ne --no-mcp`).

### 2. Session File Read Gate (`builtin:files`)

Every invocation of the built-in `read` tool is intercepted by `packages/coding-agent/src/polar/files/src/gate.ts`:

- Both the requested path and the active session output directory (`$POLAR_ARTIFACTS_DIR/<sessionId>` or `${XDG_CACHE_HOME:-~/.cache}/polar-artifacts/<sessionId>`) are resolved with `realpath`.
- Symlink escapes, missing files, non-regular files, and any path outside `session.outputDirectory` are denied.
- Only `.txt` session files up to `16 MiB` (`READ_MAX_BYTES`) are permitted; raw `.bin` captures and in-flight `.part` files are rejected.

### 3. Read-Only Kubernetes Producer (`builtin:k8s`)

- `kubectl` runs without a shell, strips inherited `KUBECTL_*` environment variables, and sets `KUBERC=off`.
- Every flag for `get`, `describe`, `logs`, and `events` is validated against a static per-operation allowlist; output formats that read local host files (`jsonpath-file`, `go-template-file`, `custom-columns-file`, `templatefile`) are rejected.
- `k8s_inspect` executes only fixed, structured read-only diagnostic commands (`read`, `list`, `find`, `copyOut`, `df`, `du`, `processes`, `sockets`) inside a target container after validating pod/container/namespace tokens; arbitrary command strings are not accepted.

### 4. Analytics Sandbox (`builtin:sandbox` / `run_code`)

`run_code` executes Python or Bash inside a read-only-rootfs Linux guest with no network, `2 GiB` RAM, `256` max processes, `300s` per-call timeout, and post-call scrubbing of user processes, `/tmp`, `/dev/shm`, `/dev/mqueue`, and SysV IPC objects. The guest runs as `1000:1000` on `apple-container`, rootless Podman, and `k8s`, and as `<hostUid>:<hostGid>` on standard Docker (`0:0` if `polar` itself is launched as `root`). The host working directory (`cwd`) is never mounted; only `session.outputDirectory` (`/data`, read-only) and the session workspace (`/work`, `4 GiB` read-write) are mounted.

Kernel isolation depends on the selected driver and runtime:

- **Hardware VM or user-space kernel boundary:**
  - macOS `apple-container` (`Virtualization.framework` Linux microVM).
  - Linux `oci` with `--sandbox-oci-runtime krun` (libkrun microVM) or `--sandbox-oci-runtime runsc` (gVisor).
  - Kubernetes `k8s` with `POLAR_SANDBOX_K8S_RUNTIME_CLASS` set to `gvisor` or `kata`, Pod Security `restricted`, and CNI-enforced `NetworkPolicy` deny-all (verified at `session_start` by `polar-netprobe`).
- **Shared-kernel container boundary:**
  - Linux `oci` using standard `crun` or `runc` enforces namespaces, `--cap-drop ALL`, `no-new-privileges`, and cgroups, but shares the host Linux kernel (`sandbox: oci (<engine>/<runtime>, shared kernel)`). Use `krun` or `runsc` when kernel-level isolation is required on Linux.

## Operator Trust Boundary and Out of Scope

The `polar` process itself runs with the privileges of the local OS user (or Kubernetes `polar` Pod). The following are within the operator's trust boundary and are out of scope unless a vulnerability in Polar grants that access or crosses an enforced boundary above:

- Prior write access to `~/.polar`, `$POLAR_ARTIFACTS_DIR`, kubeconfig files, shell startup files, or process environment variables.
- Code loaded explicitly by the operator via `-e` / `--extension`, `--skill`, `--prompt-template`, `--theme`, or `--approve`.
- RBAC over-provisioning on the observed Kubernetes kubeconfig supplied to `builtin:k8s` or missing CNI/RBAC enforcement after `session_start` in user-managed clusters.
- Prompt injection via untrusted cluster logs, events, or resource annotations that does not bypass the `files` read gate, `k8s` command/flag restrictions, or `sandbox` isolation boundary.

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities.

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/HIRO-MicroDataCenters-BV/polar-sre/security/advisories/new) on `HIRO-MicroDataCenters-BV/polar-sre`. Include:

- Affected commit SHA or image digest, platform, and sandbox driver/runtime configuration.
- Minimal reproduction steps or proof of concept.
- Which security boundary (`files` read gate, producer allowlist, `sandbox` guest/network/filesystem boundary, or Kubernetes RBAC/Pod isolation) is bypassed and the resulting impact.
