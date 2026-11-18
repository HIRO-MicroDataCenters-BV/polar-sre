# Kubernetes Deployment (`deploy/k8s`)

Manifests and `Containerfile` in this directory run Polar 24/7 in Kubernetes (`polar --mode rpc --session-dir /sessions`) with `K8sDriver` (`builtin:sandbox`), launching isolated per-session sandbox Pods for `run_code`.

## Cluster Prerequisites

1. **Pod Security `restricted` (`namespace.yaml`):**
   Namespace `polar` enforces `pod-security.kubernetes.io/enforce: restricted`. Both `Deployment/polar` and all dynamically created sandbox/helper Pods run as UID/GID `1000:1000` (`fsGroup: 1000`, `runAsNonRoot: true`), with `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, and `seccompProfile: RuntimeDefault`.
2. **Sandbox `RuntimeClass`:**
   Cluster nodes must provide an isolating `RuntimeClass` (for example `gvisor` or `kata`) matching `POLAR_SANDBOX_K8S_RUNTIME_CLASS` in `deployment.yaml` (default: `gvisor`).
3. **CNI with Enforced `NetworkPolicy` (`networkpolicy.yaml`):**
   `polar-sandbox-deny-all` blocks all ingress and egress traffic for Pods labeled `polar-sandbox: "true"`. The cluster CNI must enforce `NetworkPolicy` (for example Cilium, Calico, or k3s with its network policy controller; plain Flannel without a policy controller does not enforce policies). On every `session_start`, `K8sDriver` launches a short-lived `polar-netprobe-*` Pod that verifies `/work` writability by UID `1000` and attempts a TCP connection to `KUBERNETES_SERVICE_HOST:KUBERNETES_SERVICE_PORT`. If that connection succeeds, `sandbox` disables itself rather than executing code with network access.
4. **Minimal Namespace RBAC (`rbac.yaml`):**
   `ServiceAccount/polar` is bound to `Role/polar-sandbox-runner` in namespace `polar` with permissions limited to `pods` (`create`, `get`, `list`, `watch`, `delete`) and `pods/exec` (`create`, `get`). `pods/log`, `secrets`, and cluster-scoped verbs are not granted.
5. **Shared Storage (`pvc.yaml`):**
   `PersistentVolumeClaim/polar-shared` (`ReadWriteOnce`, `20Gi` by default) backs session transcripts (`subPath: sessions`), Artifact Bus outputs (`subPath: artifacts`), and per-session sandbox workspaces (`subPath: work/<sessionId>`).

## Single-Replica Constraint (`replicas: 1`, `strategy: Recreate`)

`Deployment/polar` must remain at **`replicas: 1`** with **`strategy.type: Recreate`**:

- `polar` and every sandbox/helper Pod it creates mount subdirectories of the same `ReadWriteOnce` PVC (`polar-shared`).
- `K8sDriver` pins all sandbox and helper Pods to the `polar` Pod's node via `nodeSelector` (`kubernetes.io/hostname: $POLAR_SANDBOX_K8S_NODE_NAME`) and attaches `ownerReferences` to `$POLAR_SANDBOX_K8S_POD_UID`.
- Scaling above `1` replica or switching to `RollingUpdate` will stall volume attachment across nodes or cause concurrent Pods to contend on session locks and shared PVC directories.

## Secrets and Environment Variables

### `Secret/polar-env`

`deployment.yaml` imports `Secret/polar-env` via `envFrom` (`optional: true`). Create it in namespace `polar` with LLM provider credentials:

```bash
kubectl -n polar create secret generic polar-env \
  --from-literal=ANTHROPIC_API_KEY='<key>'
```

If `builtin:k8s` inside `polar` should inspect external or local Kubernetes clusters, mount a read-only kubeconfig `Secret` into `Deployment/polar` and set `KUBECONFIG` (or pass `--k8s-kubeconfig` / `--k8s-context` in `args`). `K8sDriver` strips `KUBECONFIG` from its own child `kubectl` calls and uses an isolated `/tmp` kubeconfig generated from `/var/run/secrets/kubernetes.io/serviceaccount`, so observed-cluster kubeconfigs do not affect sandbox Pod management.

### `POLAR_*` Variables in `deployment.yaml`

| Variable | Value in `deployment.yaml` | Purpose |
|---|---|---|
| `POLAR_ARTIFACTS_DIR` | `/artifacts` | Root directory for session Artifact Bus files (`subPath: artifacts` on `polar-shared`) |
| `POLAR_SESSION_TTL_MS` | `86400000` | Retention window (`24h`) before ended session artifact directories are garbage-collected |
| `POLAR_SANDBOX_K8S_PVC` | `polar-shared` | Selects `K8sDriver` when `--sandbox-driver=auto` and names the shared PVC |
| `POLAR_SANDBOX_K8S_RUNTIME_CLASS` | `gvisor` | `runtimeClassName` set on sandbox and helper Pods |
| `POLAR_SANDBOX_K8S_IMAGE` | `polar-sandbox:0.2` (pin to `@sha256` in production) | Guest image for sandbox and helper Pods; keep identical to `initContainers[0].image` (`warm-sandbox-image`) |
| `POLAR_SANDBOX_K8S_POD_NAME` | `metadata.name` (Downward API) | Verified via `kubectl get pod` at startup; used in sandbox `ownerReferences` |
| `POLAR_SANDBOX_K8S_POD_UID` | `metadata.uid` (Downward API) | Verified against the live Pod UID at startup; used in sandbox `ownerReferences` |
| `POLAR_SANDBOX_K8S_NODE_NAME` | `spec.nodeName` (Downward API) | Node hostname used in `nodeSelector` so sandbox Pods co-locate with the `ReadWriteOnce` PVC |

## Building Multi-Arch Images and Pinning `@sha256`

Build and publish `polar-sandbox` **before** `polar`, because `deploy/k8s/Containerfile` compiles the repository (including `REGISTRY_IMAGE` in `packages/coding-agent/src/polar/sandbox/index.ts`). Always record the multi-arch manifest-list digest (`@sha256:...`), not a single-architecture digest.

1. **Build and push `polar-sandbox` (`linux/arm64`, `linux/amd64`):**
   ```bash
   docker buildx build \
     --platform linux/arm64,linux/amd64 \
     --tag ghcr.io/hiro-microdatacenters-bv/polar-sandbox:0.2 \
     --file packages/coding-agent/src/polar/sandbox/image/Containerfile \
     --push \
     packages/coding-agent/src/polar/sandbox/image
   ```
2. **Pin the `polar-sandbox` manifest-list digest (`ghcr.io/hiro-microdatacenters-bv/polar-sandbox@sha256:<SANDBOX_SHA>`):**
   - `packages/coding-agent/src/polar/sandbox/index.ts` -> `REGISTRY_IMAGE`
   - `deploy/k8s/deployment.yaml` -> `initContainers[0].image` (`warm-sandbox-image`) and `POLAR_SANDBOX_K8S_IMAGE`
3. **Build and push `polar` from the repository root (`linux/arm64`, `linux/amd64`):**
   ```bash
   docker buildx build \
     --platform linux/arm64,linux/amd64 \
     --tag ghcr.io/hiro-microdatacenters-bv/polar:0.2 \
     --file deploy/k8s/Containerfile \
     --push \
     .
   ```
4. **Pin the `polar` manifest-list digest (`ghcr.io/hiro-microdatacenters-bv/polar@sha256:<POLAR_SHA>`):**
   - `deploy/k8s/deployment.yaml` -> `containers[0].image` (`polar`)

## Applying Manifests

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/rbac.yaml
kubectl apply -f deploy/k8s/networkpolicy.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
```
