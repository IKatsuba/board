#!/bin/bash
# Steps 1–3 of the release, which only read: the tree clean, untracked files
# included (a published build that no commit describes cannot be rebuilt);
# the version from package.json not on npm for @chorded/board, or a run
# stopped between publishes to resume; and the owner's npm login. It prints
# one line, "fresh VERSION" or "resume VERSION", or dies with what it read.
#   tool/release/preflight.sh [--dry-run]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$here/../.."

dry_run=false
case "${1:-}" in
"") ;;
--dry-run) dry_run=true ;;
*) die "usage: tool/release/preflight.sh [--dry-run]" ;;
esac

# 1. The tree, untracked files included.
dirty=$(git status --porcelain --untracked-files=all)
[ -z "$dirty" ] || die "the tree is not clean:
$dirty"

# 2. The version, refused if the main package has it.
version=$(plutil -extract version raw package.json) ||
	die "package.json has no version"
published board "$version" && die "@chorded/board@$version is on npm already"
mode=fresh
for name in board-darwin-arm64 board-darwin-x64; do
	if published "$name" "$version"; then
		$dry_run && die "--dry-run does not resume a stopped publish: @chorded/$name@$version is published"
		mode=resume
		break
	fi
done

# 3. The owner's own npm login, before anything is built or published.
who=$(npm whoami 2>&1) || die "npm whoami failed: $who"
printf '%s %s\n' "$mode" "$version"
