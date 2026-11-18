# `polar-sre` (`polar` CLI)

`polar` is a read-only SRE and incident investigation agent CLI. It combines deterministic read-only telemetry producers (`builtin:k8s`), a session-scoped file catalog and `read` gate (`builtin:files`), and a networkless Linux analytics sandbox (`builtin:sandbox`).

## Quick Start

Install from npm (`Node.js >= 22.19.0`):

```bash
npm install -g polar-sre
polar --help
```

Or build from the monorepo root:

```bash
npm ci --ignore-scripts
npm run build:offline
node packages/coding-agent/dist/bundle/cli.js --help
```

Common execution modes:

```bash
# Interactive TUI (configure provider with /login and cluster context with /kubeconfig)
polar

# Single-shot non-interactive investigation
polar --k8s-context prod-eu -p "Check recent Warning events and failing Pods in payments"

# Headless RPC mode: JSONL commands on stdin and events on stdout (used by deploy/k8s)
polar --mode rpc --session-dir /sessions
```

## Polar Extension Flags

| Flag | Default | Description |
|---|---|---|
| `--k8s-kubeconfig <paths>` | `$KUBECONFIG` or `~/.kube/config` | Kubeconfig file or platform-delimited path list for `kubectl` |
| `--k8s-context <name>` | *(saved or off)* | Initial Kubernetes context (or select interactively via `/kubeconfig`) |
| `--sandbox-driver <name>` | `auto` | Sandbox backend: `auto`, `apple-container`, `oci`, or `k8s` |
| `--sandbox-image <ref>` | `polar-sandbox:0.2` | Guest image for `run_code` (`POLAR_SANDBOX_K8S_IMAGE` in `k8s` mode unless overridden) |
| `--sandbox-registry-image <ref>` | *(configured build default)* | Prebuilt registry image offered for pull when missing locally |
| `--sandbox-oci-engine <name>` | `auto` | Linux container engine: `auto` (`podman` then `docker`), `podman`, or `docker` |
| `--sandbox-oci-runtime <name>` | *(engine default)* | Optional Linux OCI runtime (for example `krun` or `runsc`) |
| `--sandbox-k8s-pvc <name>` | `$POLAR_SANDBOX_K8S_PVC` | Shared PVC name enabling the `k8s` sandbox driver |

Run `polar --help` for model selection, session management, thinking level, and provider environment variable options.

## Repository and Documentation

Source code, architecture docs, and Kubernetes deployment manifests:
[https://github.com/HIRO-MicroDataCenters-BV/polar-sre](https://github.com/HIRO-MicroDataCenters-BV/polar-sre)

## License

Forked from [`earendil-works/pi`](https://github.com/earendil-works/pi) (`v1.1.0`). MIT License (`LICENSE`).
