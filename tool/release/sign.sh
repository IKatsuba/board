#!/bin/bash
# Signs built boards with the team's Developer ID: hardened runtime, secure
# timestamp, the one entitlement, then --verify --strict and the signed
# entitlements read back and compared with tool/macos/board.entitlements,
# since a binary without its entitlement still passes every functional test.
#   tool/release/sign.sh BINARY...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
entitlements="$here/../macos/board.entitlements"

[ "$#" -gt 0 ] || die "usage: tool/release/sign.sh BINARY..."
id=$(identity)
for binary in "$@"; do
	[ -f "$binary" ] || die "no binary at $binary"
	B=$(dirname "$binary")
	codesign --force --sign "$id" --options runtime --timestamp \
		--entitlements "$entitlements" \
		--identifier dev.katsuba.board "$binary" ||
		die "codesign failed for $binary"
	codesign --verify --strict --verbose=2 "$binary" ||
		die "$binary does not verify"
	codesign -d --entitlements - --xml "$binary" >"$B/entitlements.plist" 2>/dev/null ||
		die "the entitlements of $binary could not be read back"
	got=$(plutil -convert json -o - "$B/entitlements.plist" 2>&1 || true)
	want=$(plutil -convert json -o - "$entitlements")
	[ "$got" = "$want" ] ||
		die "entitlements of $binary differ from tool/macos/board.entitlements: got $got, want $want"
	printf 'signed %s: %s\n' "$binary" "$got"
done
