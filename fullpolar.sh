#!/usr/bin/env bash
# Runs polar.sh with all extensions enabled (files + k8s + exec).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--dist" ]]; then
	shift
	exec "$ROOT/polar.sh" --dist -e builtin:k8s -e builtin:exec "$@"
fi

exec "$ROOT/polar.sh" -e builtin:k8s -e builtin:exec "$@"
