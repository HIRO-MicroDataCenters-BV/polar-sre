# Polar (`polar-sre`)

Polar is a read-only SRE and incident investigation agent (`bin: polar`, configuration directory `~/.polar`), built to collect evidence from production systems, inspect logs and resource state, and run local data analysis without mutating observed infrastructure.

## Architecture Overview

Polar separates telemetry collection from file inspection and code execution across a per-session filesystem bus (**Artifact Bus**, stored under `$POLAR_ARTIFACTS_DIR` or `${XDG_CACHE_HOME:-~/.cache}/polar-artifacts/<sessionId>`):

- **Read-only producers (`builtin:k8s`):** Deterministic tools (`k8s_get`, `k8s_describe`, `k8s_logs`, `k8s_events`, `k8s_inspect`) validate structured parameters against explicit `kubectl` flag allowlists. Small text outputs (`<= 50 KiB` and `<= 2000` lines) return inline; larger streams and binary `copyOut` captures are written to the session directory and recorded in `manifest.jsonl`.
- **Session catalog and read gate (`builtin:files`):** Provides `list_files` over `manifest.jsonl` and enforces a `realpath` gate on the built-in `read` tool, restricting reads to regular `.txt` files inside the active session directory up to `16 MiB`.
- **Isolated analytics sandbox (`builtin:sandbox`):** Exposes `run_code` to run Python 3.13 (`duckdb`, `polars`, `pandas`, `numpy`, `orjson`, `ijson`, `pyyaml`, `jmespath`, `drain3`, etc.) and CLI utilities (`rg`, `jq`, `yq`, `duckdb`, `mlr`, `gawk`) in a networkless Linux sandbox. The session directory is mounted read-only at `/data`, a persistent `4 GiB` per-session workspace is mounted at `/work`, and the host working directory is never mounted.

General-purpose host mutation and shell tools (`bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are disabled by default.

## Building and Running from Source

### Prerequisites

- Node.js `>= 22.19.0`
- `kubectl` on `PATH` (required for `builtin:k8s`)
- A local container/VM runtime for `builtin:sandbox` (see [Local Sandbox Setup](#local-sandbox-setup))

### Build

```bash
git clone https://github.com/HIRO-MicroDataCenters-BV/polar-sre.git
cd polar-sre
npm ci --ignore-scripts
npm run build:offline
```

### Launch

Run Polar interactively with all built-in Polar extensions enabled (`builtin:files`, `builtin:k8s`, `builtin:sandbox`):

```bash
./fullpolar.sh
```

Or run the bundled CLI directly after `npm run build:offline`:

```bash
node packages/coding-agent/dist/bundle/cli.js
```

For minimal extension development (`builtin:files` plus explicit `-e builtin:<name>` flags):

```bash
./polar.sh -e builtin:k8s
```

### Provider and Cluster Setup

1. **LLM provider:** Run `/login` inside the TUI or export a provider API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.).
2. **Kubernetes context:** Run `/kubeconfig` inside the TUI to pick a context interactively (persisted in `~/.polar/agent/k8s.json`), or pass `--k8s-kubeconfig <path>` and `--k8s-context <context>` on startup.

## Local Sandbox Setup

`builtin:sandbox` selects a backend via `--sandbox-driver` (`auto` by default):

### macOS (`apple-container`)

Uses Apple's native `container` CLI (`Virtualization.framework` Linux microVM):

1. Install `container` and verify the runtime is started (`container system status`).
2. Launch Polar. When the guest image (`polar-sandbox:0.2`) is not yet in the local cache, Polar prompts to download the prebuilt image (when a registry image is configured), build the image locally (`~2 min`), or disable the sandbox for the current session.

### Linux (`oci`)

Uses rootless Podman `>= 4.3` or standard Docker (`--sandbox-oci-engine auto|podman|docker`):

- **Supported engines:** Rootless Podman `>= 4.3` (`--userns=keep-id:uid=1000,gid=1000`) or standard daemonful Docker. Rootless Docker is rejected because it cannot map host UIDs onto unprivileged read-only bind mounts.
- **Isolation boundary:** Standard `crun`/`runc` containers isolate namespaces, capabilities, and cgroups while sharing the host Linux kernel. For stronger isolation on Linux, configure `krun` or gVisor (`runsc`) and pass `--sandbox-oci-runtime krun` or `--sandbox-oci-runtime runsc`.

## Kubernetes Deployment (24/7 RPC Mode)

Polar can run in-cluster in `--mode rpc` using `K8sDriver` (`--sandbox-driver k8s`), spawning per-session sandbox Pods under Pod Security `restricted`, a dedicated `RuntimeClass` (such as `gvisor` or `kata`), and a `NetworkPolicy` deny-all boundary verified at session start.

Multi-arch (`linux/arm64`, `linux/amd64`) container images are published to:
- `ghcr.io/hiro-microdatacenters-bv/polar-sandbox`
- `ghcr.io/hiro-microdatacenters-bv/polar`

See [`deploy/k8s/README.md`](deploy/k8s/README.md) for cluster prerequisites, single-replica PVC constraints, `Secret` configuration, and multi-arch build and `@sha256` pinning steps.

## Documentation and Development

- Extension architecture and invariants: [`packages/coding-agent/src/polar/ARCHITECTURE.md`](packages/coding-agent/src/polar/ARCHITECTURE.md)
- Repository workflow and coding rules: [`AGENTS.md`](AGENTS.md) and [`CORE.md`](CORE.md)
- CLI flags overview: [`packages/coding-agent/README.md`](packages/coding-agent/README.md)
- Security model and vulnerability reporting: [`SECURITY.md`](SECURITY.md)
- Contribution guidelines: [`CONTRIBUTING.md`](CONTRIBUTING.md)

Verification commands:

```bash
cd packages/coding-agent && npx vitest --run src/polar
npm run check
./test.sh
```

## Origin and License

Polar is forked from [`earendil-works/pi`](https://github.com/earendil-works/pi) (`v1.1.0`).

Licensed under the MIT License. See [`LICENSE`](LICENSE).
