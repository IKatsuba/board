#!/bin/bash
# Notarises the signed boards as one zip with the team-wide App Store
# Connect key in the login keychain, keeps Apple's log beside the build
# whatever the verdict, stops unless Accepted, then checks that each binary
# satisfies the notarized requirement, retrying briefly while the ticket
# propagates. spctl is not the check: `spctl -a -t exec` rejects any bare
# Mach-O as "does not seem to be an app", notarised or not. A bare Mach-O cannot be
# stapled; Gatekeeper looks the ticket up online on a quarantined copy.
#   tool/release/notarise.sh OUT_DIR BINARY...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

out=${1:?usage: tool/release/notarise.sh OUT_DIR BINARY...}
shift
[ "$#" -gt 0 ] || die "usage: tool/release/notarise.sh OUT_DIR BINARY..."
zip="$out/board.zip"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/board"
for binary in "$@"; do
	cp "$binary" "$staging/board/$(basename "$(dirname "$binary")")-board"
done
ditto -c -k --norsrc --noextattr --keepParent "$staging/board" "$zip"
# The result is kept, and Apple's log fetched, before any verdict is judged.
# The JSON result is stdout alone; notarytool's diagnostics are kept apart.
submitted=0
result=$(xcrun notarytool submit "$zip" --keychain-profile roost-notary --wait --output-format json 2>"$out/notarytool-submit.stderr") ||
	submitted=$?
printf '%s\n' "$result" >"$out/notarytool.json"
submission=$(printf '%s' "$result" | plutil -extract id raw - 2>/dev/null || true)
status=$(printf '%s' "$result" | plutil -extract status raw - 2>/dev/null || true)
if [ -n "$submission" ]; then
	for attempt in 1 2 3; do
		if fetched=$(xcrun notarytool log "$submission" --keychain-profile roost-notary "$out/notarytool-log.json" 2>&1); then
			break
		fi
		[ "$attempt" = 3 ] && die "the notarisation log of $submission could not be fetched: $fetched"
		sleep 10
	done
fi
[ "$submitted" = 0 ] || die "notarytool submit exited $submitted: $result $(cat "$out/notarytool-submit.stderr")"
[ "$status" = Accepted ] || die "notarisation of $zip ended $status: $result"
for binary in "$@"; do
	for attempt in 1 2 3 4 5 6; do
		if assessed=$(codesign --verify --strict --test-requirement="=notarized" -vv "$binary" 2>&1); then
			break
		fi
		[ "$attempt" = 6 ] && die "$binary does not satisfy the notarized requirement: $assessed"
		sleep 10
	done
	printf 'notarised %s\n' "$binary"
done
