#!/bin/bash
# A built board's self-test: `board project add` and `board ls` under a
# temporary BOARD_DIR. ARCH x86_64 runs it under `arch -x86_64` (Rosetta).
#   tool/release/selftest.sh BINARY [ARCH]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

binary=${1:?usage: tool/release/selftest.sh BINARY [ARCH]}
arch=${2:-}
run() {
	if [ -n "$arch" ]; then arch "-$arch" "$binary" "$@"; else "$binary" "$@"; fi
}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/project"
export BOARD_DIR="$scratch/board"
out=$(cd "$scratch/project" && run project add SELF --actor selftest 2>&1) ||
	die "$binary: project add failed: $out"
out=$(cd "$scratch/project" && run ls 2>&1) ||
	die "$binary: ls failed: $out"
printf 'self-tested %s%s\n' "$binary" "${arch:+ under $arch}"
