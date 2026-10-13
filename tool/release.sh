#!/bin/bash
# The release, on the owner's Mac, not in CI: build both binaries, sign,
# self-test, notarise, pack, verify the installed copies, and publish to npm.
#   tool/release.sh            everything, publishing last
#   tool/release.sh --dry-run  everything up to `npm publish`, then stop;
#                              it still submits to Apple for notarisation
# Each step is checked before the next and dies with what it read; the steps
# are scripts under tool/release/, runnable on their own. The last line
# printed is the published version, printed only when everything held.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
steps="$root/tool/release"
# shellcheck source=release/lib.sh
. "$steps/lib.sh"

dry_run=false
case "${1:-}" in
"") ;;
--dry-run) dry_run=true ;;
*) die "usage: tool/release.sh [--dry-run]" ;;
esac
cd "$root"
export PRISMA_HIDE_UPDATE_MESSAGE=1
out="$root/build/release"
packages=(board-darwin-arm64 board-darwin-x64 board)

publish_missing() {
	for name in "${packages[@]}"; do
		if published "$name" "$version"; then
			printf 'already published: @chorded/%s@%s\n' "$name" "$version"
			continue
		fi
		tarball="$out/tgz/chorded-$name-$version.tgz"
		[ -f "$tarball" ] || die "no $tarball to publish; nothing of this run is left to resume from"
		npm publish --access public "$tarball" || die "npm publish of $tarball failed"
	done
}

# 1–3. A clean tree, the version not yet published (or a run stopped between
#      publishes to resume), and the owner's npm login: they only read, and
#      tool/release/preflight.sh runs them on its own as well.
if $dry_run; then
	preflight=$("$steps/preflight.sh" --dry-run)
else
	preflight=$("$steps/preflight.sh")
fi
read -r mode version <<<"$preflight"
[ -n "${version:-}" ] || die "preflight gave no version: $preflight"
# A run stopped between publishes is finished from the packages it built,
# without building again.
if [ "$mode" = resume ]; then
	printf 'resuming %s: a platform package is published, @chorded/board is not\n' "$version"
	publish_missing
	printf '%s\n' "$version"
	exit 0
fi

# 4. The signing identity, found before the build.
identity >/dev/null

# 5. Dependencies as locked, and every check.
bun install --frozen-lockfile || die "bun install --frozen-lockfile failed"
bun run check || die "bun run check failed"

# 6. Both binaries, built on this arm64 Mac.
bun run build:arm64 || die "build:arm64 failed"
bun run build:x64 || die "build:x64 failed"
kind=$(file build/darwin-arm64/board)
case "$kind" in *"Mach-O 64-bit executable arm64"*) ;; *) die "build/darwin-arm64/board is $kind" ;; esac
kind=$(file build/darwin-x64/board)
case "$kind" in *"Mach-O 64-bit executable x86_64"*) ;; *) die "build/darwin-x64/board is $kind" ;; esac

# 7. Signed copies, verified, entitlements compared, each self-tested.
rm -rf "$out"
for arch in arm64 x64; do
	mkdir -p "$out/darwin-$arch"
	cp "build/darwin-$arch/board" "$out/darwin-$arch/board"
done
"$steps/sign.sh" "$out/darwin-arm64/board" "$out/darwin-x64/board"
"$steps/selftest.sh" "$out/darwin-arm64/board"
"$steps/selftest.sh" "$out/darwin-x64/board" x86_64
BOARD_BIN="$out/darwin-arm64/board" bun test test/binary.test.ts ||
	die "the smoke test failed on the signed arm64 binary"
BOARD_BIN="$out/darwin-x64/board" BOARD_BIN_ARCH=x86_64 bun test test/binary.test.ts ||
	die "the smoke test failed on the signed x64 binary"

# 8. One zip notarised; both must satisfy codesign's =notarized requirement.
"$steps/notarise.sh" "$out" "$out/darwin-arm64/board" "$out/darwin-x64/board"

# 9. The packages, packed, installed from the tarballs, verified, self-tested.
"$steps/packages.sh" "$out/packages" "$out/darwin-arm64/board" "$out/darwin-x64/board"
mkdir -p "$out/tgz"
cp "$out/packages/tgz/"*.tgz "$out/tgz/"

# 10. A dry run stops here.
if $dry_run; then
	printf 'dry run: @chorded/board %s is packed in %s, not published\n' "$version" "$out/tgz"
	exit 0
fi

# 11. The platform packages, then the main one, whose exact-version
#     optionalDependencies must resolve. Never unpublish.
publish_missing
printf '%s\n' "$version"
