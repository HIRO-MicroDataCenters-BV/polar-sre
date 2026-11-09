# Artifact Bus Contract (`shared/session`, `shared/store`, `files`)

> **Context:** Part of [`extensions/ARCHITECTURE.md`](../ARCHITECTURE.md). Governs session directories, streaming artifact storage, quotas, manifest entries, and the built-in `read` gate.

---

## 1. Session Directory Layout

Each Pi session uses a private directory on disk:
```text
<artifactsRoot>/<sessionId>/
├── lock                                  # PID of the live Pi process holding the session
├── manifest.jsonl                        # Append-only log of published session files
├── k8s_get-1.txt                         # Complete spillover text file
├── k8s_logs-2.truncated.txt              # Truncated spillover text file
├── k8s_inspect-3.bin                     # Raw byte artifact
└── loki_query-4.part                     # In-flight file currently being streamed
```

- **Root path:** `$POLAR_ARTIFACTS_DIR` if set (resolved to an absolute path), otherwise `${XDG_CACHE_HOME:-~/.cache}/polar-artifacts`.
- **Permissions:** directory mode `0700`, file mode `0600`.

---

## 2. Session Lifecycle (`shared/session.ts`)

Process-wide session state is stored in `globalThis[Symbol.for("polar/session-registry@1")]`, keyed by the absolute `outputDirectory`.

### Acquisition (`acquireSession`)
1. The first caller for a `sessionId` creates a `SessionContext`, registers it synchronously before any `await`, and runs `prepare()`:
   - Creates `<outputDirectory>` (`0700`) and writes `<pid>\n` to `lock` (`0600`).
   - Deletes leftover `*.part` files.
   - Truncates any incomplete trailing line in `manifest.jsonl` once at startup.
   - Removes directories of other sessions where `sessionLiveness` is `"ended"` and `mtime` is older than `7 days`.
   - Scans existing published files to initialize `publishedBytes` and `nextFileNumber` (`highestNumber + 1`).
2. Subsequent callers in the same process increment `holders` and await the same `prepare()` promise.

### Release (`handle.release()`)
- Idempotent per `SessionHandle`.
- Decrements `holders`. When `holders` reaches `0`, sets `context.closed = true`, deletes the registry entry, and synchronously removes `lock`.

### Liveness Check (`sessionLiveness`)
- Reads `<root>/<sessionId>/lock`.
- `"ended"`: `ENOENT` on the lock file, or `process.kill(pid, 0)` throws `ESRCH`.
- `"alive"`: `process.kill(pid, 0)` succeeds or throws `EPERM`.
- `"unknown"`: any other filesystem error or non-PID content. Resources of `"alive"` and `"unknown"` sessions are preserved during cleanup.

---

## 3. Streaming Store & Quotas (`shared/store.ts`)

### Operator Limits
| Setting | Value | Scope |
|---|---|---|
| `fileMaxBytes` | `2 GiB` | Maximum bytes written to a single output file |
| `sessionMaxBytes` | `8 GiB` | Maximum bytes across all published and open files in the session |
| `READ_MAX_BYTES` | `16 MiB` | Maximum file size Pi's built-in `read` tool may open |

Live session byte count:
```text
usedBytes = context.publishedBytes + sum(openFile.bytesWritten() for openFile in context.openFiles)
```

### File Naming & Persistence Modes
- `openOutputFile(session, tool, limits)` reserves `n = context.nextFileNumber++` synchronously before its first `await` and opens `<tool>-<n>.part` with `"wx"`.
- `OUTPUT_FILE_NAME` matches `/^(.+)-(\d+)\.(?:part|txt|truncated\.txt|bin)$/`.

Streamed output is finalized in one of two modes:

1. **Spillover Mode (Default)**
   For text output (`stdout` / `stderr`):
   - If the whole `stdout` is in the reply, the `.part` file is deleted via `discardOutputFile(file)`, whatever the status and `stderr`.
   - Otherwise, `finishOutputFile` renames the file to `<tool>-<n>.txt` (`outcome === "complete"`) or `<tool>-<n>.truncated.txt` (`outcome === "truncated"`), appends a manifest entry, and the reply includes a `head` or `tail` excerpt with the file path.
2. **Artifact Mode**
   For raw file transfers (such as `copyOut`):
   - On a complete transfer (exit `0`, no limit reached), `finishOutputFile` renames the file to `<tool>-<n>.bin` (`status: "complete"`) and appends a manifest entry. The reply reports the status, file path, and byte size.
   - On an incomplete transfer (non-zero exit, limit reached, timeout, or cancellation), the `.part` file is deleted via `discardOutputFile(file)` and the reply reports the failure.

### Manifest Log (`manifest.jsonl`)

Each published file appends one JSON line to `manifest.jsonl` through `context.manifestQueue`:

```ts
export interface ManifestEntry {
	v: 1;
	file: string;              // e.g. "k8s_get-1.txt", "k8s_logs-2.truncated.txt", "k8s_inspect-3.bin"
	tool: string;              // e.g. "k8s_get" or "k8s_get-stderr"
	command: string;           // Concise description of the invocation
	size: number;              // Size in bytes on disk
	status: "complete" | "truncated";
	createdAt: string;         // ISO-8601 timestamp
}
```

### Excerpt Reading (`readExcerpt`)
- `readExcerpt(file, selection, windowBytes)` reads up to `windowBytes` from the start (`"head"`) or end (`"tail"`) of a closed file and trims partial lines at the boundary (`wholeLines`).

---

## 4. Artifact Catalog & Read Gate (`files/`)

1. **`list_files` tool**
   - Reads `manifest.jsonl` via `readManifest(handle.paths)` and renders a Markdown table: `| File | Command | Size | Status | Created |`.
   - Uses `prepareLoadout` to append `"Reads files up to 16 MiB."` to Pi's built-in `read` tool description.
2. **Built-in `read` Gate (`files/src/gate.ts`)**
   Evaluates every `tool_call` for `"read"` in this order:
   1. **Path resolution:** A bare filename without `/` resolves inside `session.outputDirectory`; a path containing `/` resolves against `session.cwd`.
   2. **Boundary & regular-file check:** Resolves both the target path and `session.outputDirectory` with `realpath` and checks `stat.isFile()`. Missing paths, non-regular files, and paths outside `session.outputDirectory` are denied with `"read is limited to the session output directory"`.
   3. **Suffix check:** Files not ending in `.txt` (such as `.bin` or `.part`) are denied with `"File is not a text output file."`.
   4. **Size check:** Files with `size > READ_MAX_BYTES` (`16 MiB`) are denied with `"File exceeds the 16 MiB read limit."`.
   5. **Allow:** Rewrites `event.input.path` to the resolved realpath.
