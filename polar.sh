#!/usr/bin/env bash
# Runs Polar from source as the minimal extension harness (builtin:files + any -e passed by the caller).
# Isolation defaults (-nc -ns -np -ne --no-mcp and built-in tool exclusions) are built into Polar's main.ts.
# To run with all built-in Polar extensions enabled by default, use ./fullpolar.sh or the built `polar-sre` CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--dist" ]]; then
	shift
	CLI="$ROOT/packages/coding-agent/dist/cli.js"
	if [[ ! -f "$CLI" ]]; then
		echo "No build found. Run: npm run build:offline" >&2
		exit 1
	fi
	exec node "$CLI" -e builtin:files "$@"
fi

exec "$ROOT/pi-test.sh" -e builtin:files "$@"
