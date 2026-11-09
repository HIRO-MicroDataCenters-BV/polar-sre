#!/usr/bin/env bash
# Runs the Polar fork of pi from source as the extension harness.
# All harness flags come before the arguments of the caller. So the arguments cannot turn a harness flag
# into plain text (`--` ends the options) or into the value of another option.
# - -nc: no AGENTS.md or CLAUDE.md.
# - -ns: no skills, so the global skills of the user do not reach the agent context.
# - -np: no prompt templates.
# - -ne: no extension discovery and no default built-in extensions. Extensions passed with -e still load.
# - --no-mcp: no MCP servers. This also removes the codemode and tool_search tools.
# - --exclude-tools: removes all built-in tools except read. Extension tools stay active.
#   Do not use --tools: an allowlist also disables extension tools.
#   Do not pass --exclude-tools in the arguments: a repeated one replaces this list.
# - -e builtin:files: the files extension (packages/coding-agent/src/polar/files) is always loaded, so the read
#   policy (the gate on the built-in read and the 16 MiB read limit in its description) applies to every set of
#   extensions. Pi loads a path once, so passing it again in the arguments is harmless.
# Settings, auth and sessions live in ~/.polar/agent (piConfig.configDir in packages/coding-agent/package.json).
# Subcommands (for example `auth`) must be the first argument: run them with ./pi-test.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PI_SKIP_VERSION_CHECK=1

HARNESS_FLAGS=(
	-nc -ns -np -ne --no-mcp
	--exclude-tools bash,edit,write,grep,find,ls,powershell,codemode,tool_search
	-e builtin:files
)

if [[ "${1:-}" == "--dist" ]]; then
	shift
	CLI="$ROOT/packages/coding-agent/dist/cli.js"
	if [[ ! -f "$CLI" ]]; then
		echo "No build found. Run: npm run build:offline" >&2
		exit 1
	fi
	exec node "$CLI" "${HARNESS_FLAGS[@]}" "$@"
fi

exec "$ROOT/pi-test.sh" "${HARNESS_FLAGS[@]}" "$@"
