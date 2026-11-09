# Read-Only Producer Contract (`shared/` SDK & `<producer>/`)

> **Context:** Part of [`src/polar/ARCHITECTURE.md`](../ARCHITECTURE.md). Defines the structure and contracts for deterministic, read-only SRE producer extensions (`k8s`, `loki`, `grafana`, `prometheus`, ...).

A producer tool takes typed parameters, builds one fixed command from them, and streams the result. The model never passes shell pipelines, raw flag arrays, or free-form command strings.

---

## 1. Responsibility Split: `shared/` vs `<producer>/`

| Layer | File | Responsibility |
|---|---|---|
| **Shared SDK** | `shared/runtime.ts` | Manages `RuntimeState` (`"open" \| "closing" \| "closed"`), `inFlight: Set<string>`, and `releaseWhenIdle(runtime)` on shutdown. |
| **Shared SDK** | `shared/validation.ts` | Common parameter checks: `nulCharacterError`, `isGiven`, `invalidParameter(field, form, fix)`. |
| **Shared SDK** | `shared/process.ts` | Spawns a CLI command in its own process group (`detached: true`), streams `stdout` into `OpenFile.sink` with backpressure, captures `stderr` up to `stderrMaxBytes`, enforces `timeoutMs` and `AbortSignal` (`SIGTERM` then `SIGKILL` after `killGraceMs`), and returns a `StreamResult`. |
| **Shared SDK** | `shared/reply.ts` | **Phase 1 (Finalize):** in spillover mode reads excerpts from `OpenFile`, discards `.part` if the output fits inline, or publishes via `finishOutputFile` and saves oversized `stderr` via `saveBytes`; in artifact mode publishes a complete transfer as `.bin` or discards an incomplete one.<br>**Phase 2 (Format):** pure synchronous function that composes the status line, excerpts (`head`, `tail`, or `header + tail`), `[stderr]`, and notices within `replyMaxLines` / `replyMaxBytes`. |
| **Shared SDK** | `shared/tool.ts` | Adapts a `ToolSpec` into a Pi `ToolDefinition`: checks `runtime.state`, tracks the `inFlight` ticket, runs `validate`, invokes the transport, runs `buildReply`, and discards any unclosed `OpenFile` in `finally`. |
| **Producer** | `<ext>/index.ts` | Registers CLI flags and optional operator commands, validates launch config on `session_start` (or stays `<ext>: off` until activated via command), acquires session, registers tools, handles live target switching and `session_shutdown`. |
| **Producer** | `<ext>/src/client.ts` | Maps a typed domain request into a `shared/process.ts` call (e.g., `kubectl.ts` in `k8s`). `shared/process.ts` is the only transport; an HTTP transport is added when the first producer needs one. |
| **Producer** | `<ext>/src/validation.ts` | Domain-specific parameter validators (e.g., DNS namespace names, resource tokens, LogQL selectors). |
| **Producer** | `<ext>/src/tools/*.ts` | One file per tool exporting a declarative `ToolSpec`. |

---

## 2. Tool Call Pipeline

```text
1. Admission & Ticket (shared/tool.ts + shared/runtime.ts)
   If runtime.state !== "open", return "The session is shutting down." (isError: true).
   Add toolCallId to runtime.inFlight.
        │
        ▼
2. Parameter Validation (shared/validation.ts + spec.validate)
   Check string parameters for NUL bytes.
   Run spec.validate(params). On failure, return the validation message (isError: true).
        │
        ▼
3. Build Call & Stream to Store (spec.buildCall + client.ts + shared/process.ts)
   Open <tool>-<n>.part via openOutputFile().
   Stream stdout into OpenFile.sink; capture stderr in memory.
   Wait for OpenFile.closed and return StreamResult.
        │
        ▼
4. Finalize Storage & Format Reply (shared/reply.ts)
   Step 4a (I/O):
     • Spillover mode: read head/tail window from OpenFile; if whole output fits reply limits -> discardOutputFile(), else -> finishOutputFile().
     • Artifact mode: if status === "ok" -> finishOutputFile() as .bin; else -> discardOutputFile().
     • If stderr exceeds its reply budget -> saveBytes() as <tool>-stderr-<n>.txt.
   Step 4b (Pure): Render the ToolReply string from plain data structures.
        │
        ▼
5. Dispose & Drain (shared/tool.ts finally block)
   Discard any remaining OpenFile.
   Remove toolCallId from runtime.inFlight; call releaseWhenIdle(runtime).
```

---

## 3. Core Interfaces

### `ToolSpec` (`<ext>/src/tools/<name>.ts`)

```ts
export interface ReplyOptions {
	maxLines: number;
	maxBytes: number;
	selection: "head" | "tail";
	keepHeader: boolean;
	mode?: "spillover" | "artifact";     // Default: "spillover"
}

export interface ProducerCall<Request> {
	request: Request;
	tool: string;
	commandLabel: string;                // Shown in status line and manifest.jsonl
	options: ReplyOptions;
	timeoutMs: number;
}

export interface ToolSpec<
	Parameters extends TObject = TObject,
	Request = unknown,
	Limits extends ProducerLimits = ProducerLimits,
> {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: Parameters;
	validate(params: Static<Parameters>): string | undefined;
	buildCall(params: Static<Parameters>, limits: Limits): ProducerCall<Request>;
}
```

### `StreamResult` (`shared/process.ts`)

```ts
export type StreamStatus = "ok" | "failed" | "timeout" | "cancelled" | "output_limit" | "save_failed";

export interface StreamResult {
	status: StreamStatus;
	exitCode: number | null;
	signal?: NodeJS.Signals;
	output?: OpenFile;
	stderr: Buffer;
	startError?: string;
	limit?: "stdout" | "stderr" | "session";
	elapsedMs: number;
	saveError?: OutputSaveError;
}
```

---

## 4. Parameter & Validation Conventions (`validation.ts`)

1. **Flat Schemas:** Define tool parameters with flat `Type.Object(..., { additionalProperties: false })`.
2. **Optional Strings:** Optional string parameters state `"Empty means not set."` in their description and are checked with `isGiven(value)` (`value !== undefined && value !== ""`).
3. **Validation Error Format:** Use `invalidParameter(field, expectedForm, howToFix)`:
   ```text
   Invalid parameter "<field>": <expected form>; <how to fix>.
   ```
4. **String Enums:** Use `Type.Unsafe<"a" | "b">({ type: "string", enum: ["a", "b"] })` so generated JSON Schema includes `type: "string"`.

---

## 5. Reply Formatting Rules (`shared/reply.ts`)

- **Plain `ok` (Spillover Mode):** When `status === "ok"`, `stderr` is empty, and the full `stdout` fits within `maxLines` (`2000`) and `maxBytes` (`50 KiB`), the reply is the raw `stdout` (or `"[<tool> ok] <commandLabel>\n\n[stdout is empty]"` when empty), and the `.part` file is discarded.
- **Structured Reply (Spillover Mode):** For non-zero status, non-empty `stderr`, or cut `stdout`, the reply contains:
  1. Status line: `[<tool> <status>] <commandLabel>` (`failed: exit <code>` or `failed: signal <SIG>` on failure).
  2. Start failure section (when the process could not start).
  3. `stdout`: whole when it fits (the `.part` file is deleted); otherwise an excerpt (`First N lines shown.`, `Last N lines shown.`, or `Header + last N lines shown.`) with the file notice:
     - `size <= 16 MiB`: `[... Saved as <full-path> (<size>); read it with read, or narrow the request.]`
     - `size > 16 MiB`: `[... Saved as <full-path> (<size>); it is over the 16 MiB read limit; narrow the request.]`
  4. `stderr` section wrapped in `[stderr]\n...\n[/stderr]` (up to half the remaining budget; when cut, saved via `saveBytes` as `<tool>-stderr-<n>.txt` showing the tail).
  5. Outcome notices (output limit reached, timeout in seconds, cancellation, or save failure).
- **Artifact Reply (Artifact Mode):**
  - On `status === "ok"`: `[<tool> ok] <commandLabel>` and `[Saved as <full-path> (<size>).]`.
  - On any other status: status line, `stderr` section if non-empty, and outcome notice (the `.part` file is discarded).
