#!/usr/bin/env bash
# Runs Polar with all built-in Polar extensions enabled (the default of Polar's CLI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--dist" ]]; then
	shift
	CLI="$ROOT/packages/coding-agent/dist/cli.js"
	if [[ ! -f "$CLI" ]]; then
		echo "No build found. Run: npm run build:offline" >&2
		exit 1
	fi
	exec node "$CLI" "$@"
fi

exec "$ROOT/pi-test.sh" "$@"
