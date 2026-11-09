# Kubernetes Extension Architecture (`extensions/k8s`)

> **Prerequisites:** Read [`../shared/PRODUCER.md`](../shared/PRODUCER.md) before modifying `extensions/k8s`. Read [`../shared/ARTIFACT-BUS.md`](../shared/ARTIFACT-BUS.md) when working on `copyOut` or file storage.

---

## 1. Lifecycle, Operator Flags & `/kubeconfig` (`index.ts`)

- `--k8s-kubeconfig`: kubeconfig file path or `path.delimiter`-separated path list (default: `$KUBECONFIG` or `~/.kube/config`).
- `--k8s-context`: optional initial kubeconfig context name.
- On `session_start` (checking `context` first, `kubeconfig` second):
  - If `--k8s-context` is missing or empty, or if `--k8s-kubeconfig` does not resolve to a single file (empty or multiple files), does not acquire a session handle (`lock` is not created), registers no tools, sets status to `k8s: off (/kubeconfig)`, and notifies the operator with a warning to run `/kubeconfig`.
  - If `--k8s-context` is set and `--k8s-kubeconfig` resolves to a single file, acquires a session handle, creates `K8sRuntime`, registers the `k8s_*` tools, and sets status to `k8s: <context>`.
- `/kubeconfig [query]` command:
  - Splits `--k8s-kubeconfig` via `splitKubeconfigPaths` and discovers contexts from each file with `kubectl --kubeconfig=<path> config view --output=json` (`discoverKubeContexts`, `5_000` ms timeout).
  - Selects an exact match when `query` uniquely matches `item.context`, or opens the interactive fuzzy TUI picker (`selectKubeContext`).
  - **Cold activation:** if no runtime is active yet, acquires the session handle, creates `K8sRuntime`, and registers the `k8s_*` tools.
  - **Live context switch:** if a runtime is already open, updates `runtime.launch` for subsequent tool calls while in-flight calls complete in their original context.
- On `session_shutdown`: marks the extension as shutting down, sends `SIGKILL` to active `kubectl` process groups (`-pid`), sets `runtime.state = "closing"`, and calls `releaseWhenIdle(runtime)`.

---

## 2. File Structure

```text
extensions/k8s/
├── ARCHITECTURE.md                  # Domain contract and tool specifications
├── index.ts                         # Flags, /kubeconfig command, lifecycle, tool registration
├── src/
│   ├── types.ts                     # Request types, allowed flag unions, limits
│   ├── kubeconfig.ts                # Path list splitting and kubectl config view context discovery
│   ├── kubectl.ts                   # Kubectl argv/env construction, flag allowlist check, process execution
│   ├── picker.ts                    # Fuzzy context filtering and interactive TUI picker
│   ├── validation.ts                # DNS namespace, resource token, and object name validators
│   └── tools/
│       ├── get.ts                   # k8s_get
│       ├── describe.ts              # k8s_describe
│       ├── logs.ts                  # k8s_logs
│       ├── events.ts                # k8s_events
│       └── inspect.ts               # k8s_inspect (deterministic in-container diagnostics)
└── test/
    ├── fake-kubectl.mjs             # Scriptable stand-in for kubectl in tests
    ├── fixtures.ts
    └── *.test.ts
```

---

## 3. Transport Rules (`src/kubectl.ts`)

1. **Environment:** Removes all `KUBECTL_*` variables from the inherited environment and sets `KUBECONFIG=<kubeconfigPath>` and `KUBERC=off`.
2. **Arguments:**
   - Read operations (`get`, `events`, `logs`, `describe`):
     ```text
     kubectl --kubeconfig=<path> --context=<ctx> <operation> <formatted-flags...> -- <positionals...>
     ```
   - In-container execution (`exec`, where the first `--` separates `<pod>` from the guest command):
     ```text
     kubectl --kubeconfig=<path> --context=<ctx> exec <formatted-flags...> <pod> -- <command...>
     ```
   - Every flag is checked against the operation's `FLAG_TABLES` allowlist.
   - Value flags are formatted as `--flag=value`.
   - For `exec`, `<pod>` is checked with `isObjectName` (cannot start with `-`) before placement prior to `--`.

---

## 4. Cluster Inspection Tools

| Tool | Operation | Reply Selection | Header Kept | Rules |
|---|---|---|---|---|
| `k8s_get` | `get` | `tail` when `sortByJsonPath` is set, else `head` | `true` for `wide` and `custom-columns=*` | Default output is `wide` when listing and `yaml` when `name` is set. Rejects local file output formats (`jsonpath-file`, `go-template-file`, `custom-columns-file`, `templatefile`). |
| `k8s_describe` | `describe` | `head` | `false` | Passes target as `resource/name` when `name` is set. Always sets `--show-events=true`. Rejects `name` combined with `labelSelector`. |
| `k8s_logs` | `logs` | `tail` | `false` | Requires an exact `pod` name (`isObjectName`). Uses `logsTimeoutMs` (`600s`). |
| `k8s_events` | `events` | `tail` | `true` | Defaults `types` to `"Warning"` (`"all"` omits `--types`). Requires `kind` and `name` to be provided together (`--for=kind/name`) or both omitted. |

---

## 5. In-Container Diagnostics Tool (`k8s_inspect`)

`k8s_inspect` runs fixed, read-only operations inside a running container: a structured `operation` with parameters becomes one `kubectl exec` call. The tool description opens with: `Fixed read-only operations inside a running container. No shell, no arbitrary commands.`

### Common Parameters
- `pod`: exact pod name (`isObjectName`).
- `namespace`: optional DNS label namespace.
- `container`: optional container name (defaults to the pod's default container).
- `operation`: one of the eight operations below.

### Operations

| Operation | Operation-Specific Parameters | Mode & Selection | Behavior |
|---|---|---|---|
| `read` | `path`, optional `tailLines` | Spillover (`head`, or `tail` when `tailLines` is set) | Streams a text file from the container. |
| `list` | `path`, optional `includeHidden` | Spillover (`head`) | Lists a directory or single path with file type, mode, UID/GID, size, mtime, and symlink target. |
| `find` | `root`, optional `nameGlob`, `type`, `maxDepth` | Spillover (`head`) | Searches for files or directories under `root` within bounded depth. |
| `copyOut` | `path` | Artifact (`logsTimeoutMs`) | Streams a container file as raw bytes into `k8s_inspect-<n>.bin` and returns the saved file path and size. |
| `df` | optional `path` | Spillover (`head`) | Reports filesystem byte and inode usage. |
| `du` | `path`, optional `maxDepth`, `oneFilesystem` | Spillover (`head`) | Reports directory disk usage within bounded depth. |
| `processes` | *(none)* | Spillover (`head`) | Lists running processes in the container (`PID`, `PPID`, `USER`, `STATE`, `ARGS`). |
| `sockets` | *(none)* | Spillover (`head`) | Lists listening sockets and active network connections in the pod network namespace. |

### `k8s_inspect` Rules
1. **Guest Commands:** Built from POSIX/BusyBox utilities or `/proc` reads; missing in-container utilities are reported explicitly.
2. **`copyOut` Transfer:** Uses `logsTimeoutMs` (`600s`) and `mode: "artifact"`. Complete transfers (`status === "ok"`) are published as `.bin`; incomplete transfers discard the `.part` file and return an error reply.
