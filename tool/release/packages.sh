#!/bin/bash
# Assembles the three npm packages from the signed binaries and the shim,
# packs them, installs the tarballs in a scratch project, and verifies and
# self-tests the installed copy, as a user gets it.
#   tool/release/packages.sh OUT_DIR ARM64_BINARY X64_BINARY
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
root="$here/../.."

out=${1:?usage: tool/release/packages.sh OUT_DIR ARM64_BINARY X64_BINARY}
arm64=${2:?usage: tool/release/packages.sh OUT_DIR ARM64_BINARY X64_BINARY}
x64=${3:?usage: tool/release/packages.sh OUT_DIR ARM64_BINARY X64_BINARY}
rm -rf "$out"
bun "$root/tool/npm-assemble.ts" "$out/npm" "$arm64" "$x64"
mkdir -p "$out/tgz"
for name in board board-darwin-arm64 board-darwin-x64; do
	(cd "$out/npm/$name" && npm pack --pack-destination "$out/tgz" >/dev/null) ||
		die "npm pack of $name failed"
done
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
version=$(plutil -extract version raw "$root/package.json")
(cd "$scratch" && npm init -y >/dev/null && npm install --no-audit --no-fund \
	"$out/tgz/chorded-board-$version.tgz" \
	"$out/tgz/chorded-board-darwin-arm64-$version.tgz" >/dev/null) ||
	die "installing the tarballs failed"
# The x64 package goes into its own scratch project; npm refuses it on an
# arm64 Mac unless forced past the cpu check, which changes nothing in it.
mkdir "$scratch/x64"
(cd "$scratch/x64" && npm init -y >/dev/null && npm install --no-audit --no-fund --force \
	"$out/tgz/chorded-board-darwin-x64-$version.tgz" >/dev/null 2>&1) ||
	die "installing the x64 tarball failed"
check_installed() {
	local installed=$1 built=$2
	cmp -s "$installed" "$built" || die "the installed $installed differs from $built"
	codesign --verify --strict "$installed" || die "the installed $installed does not verify"
	case "$(xattr "$installed")" in *com.apple.quarantine*) die "npm quarantined $installed" ;; esac
}
check_installed "$scratch/node_modules/@chorded/board-darwin-arm64/bin/board" "$arm64"
check_installed "$scratch/x64/node_modules/@chorded/board-darwin-x64/bin/board" "$x64"
"$here/selftest.sh" "$scratch/node_modules/.bin/board"
"$here/selftest.sh" "$scratch/x64/node_modules/@chorded/board-darwin-x64/bin/board" x86_64
printf 'packed %s\n' "$out/tgz"
