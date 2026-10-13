# v1-signing: runtime

> **Superseded in part by the owner's answers (recorded by the lead).**
> `allow-unsigned-executable-memory` is accepted. The release runs on the
> owner's Mac as `tool/release.sh [--dry-run]`, after the sibling repository
> chorded's `Scripts/release.sh`, not in CI. It signs with the one Developer
> ID Application identity of team `YQ8ZD2KZ3T` found in the login keychain,
> notarises with `--keychain-profile roost-notary`, and publishes from the
> owner's own npm login. The CI job, its keychain step and every CI secret
> below no longer apply; CI runs only tests and checks. The identifiers are
> `dev.katsuba.board` and `dev.katsuba.board.libsqlite3`, not
> `dev.chorded.*`. No Intel Mac is available: x64 ships verified only under
> Rosetta, a known risk and not a release gate. The design as merged is in
> `docs/design.md`, "Build and distribution", and `docs/decisions.md` 25.


How the two files of the `dart build cli` bundle are signed with Developer
ID, hardened runtime and a secure timestamp, notarised, and published to npm
from one CI job. Everything marked "tried" was run on macOS 26 (arm64) in a
throwaway directory outside the repository, with Dart 3.13.5, `sqlite3`
3.7.0 (SQLite 3.53.4) and a probe program that opens an in-memory database
and runs `select sqlite_version()`, `create table`, `insert` and `select`.
Notarisation was not run: it needs the owner's credentials. It is described,
not faked.

The probe prints `3.53.4`, the bundled library; macOS's own
`/usr/lib/libsqlite3.dylib` is older and is also mapped into the process by
the system frameworks. A run counts as "loads the dylib" only when the
version is `3.53.4`; `DYLD_PRINT_LIBRARIES=1` confirmed
`bundle/lib/libsqlite3.dylib` is the one opened.

## Findings in short

1. **The Dart AOT runtime needs `com.apple.security.cs.allow-unsigned-executable-memory`
   under hardened runtime on arm64.** Without it the process is killed with
   SIGKILL before `main` (exit 137, no output). `allow-jit` is not enough.
2. **`disable-library-validation` is not needed with Developer ID**, because
   the binary and the dylib carry the same Team ID. It is needed only when
   the dylib's Team ID differs from the binary's, which includes every ad hoc
   signature (an ad hoc signature has no Team ID).
3. **Order is dylib first, then the binary**, by convention; the binary's
   signature does not seal the dylib (it is loaded with `dlopen` at run time,
   not linked), so either order verifies. Every `codesign` call needs
   `--force`, because `dart build cli` leaves an ad hoc signature on both
   files. Nothing else in the bundle breaks signing; the rpaths are untouched
   by `codesign`.
4. **npm changes nothing that matters**: the files arrive byte-identical, the
   binary keeps `0755`, the dylib `0644`, no `com.apple.quarantine` is set,
   and `codesign --verify --strict` passes on the installed copy.
5. **One zip notarises both architectures**: notarisation records each
   Mach-O's code directory hash, so a single submission holding all four
   files covers both platform packages.

## Experiments

The bundle as built (`dart build cli -t bin/probe.dart --target-os macos
--target-arch arm64`):

- both files ad hoc signed by the build (`flags=0x2(adhoc)`, no Team ID, no
  hardened runtime);
- the binary does not link `libsqlite3.dylib`: `otool -L` lists only system
  libraries, and the library is `dlopen`ed from `../lib/libsqlite3.dylib`
  relative to the binary's real path;
- the binary carries `LC_RPATH`s `@loader_path/.`, `@loader_path/../../..`,
  `@executable_path/Frameworks` and `@executable_path/..`; the dylib's install
  name is `@rpath/lib/libsqlite3.dylib`. `codesign` leaves all of them as
  they are;
- the only extended attribute is `com.apple.provenance`, which macOS adds to
  any file a process writes and which does not take part in the signature.

### (1) Ad hoc with hardened runtime, arm64

`codesign -f -s - --options runtime --timestamp=none` on the dylib, then on
the binary, with the entitlements listed:

| Binary entitlements | Dylib | Result |
| --- | --- | --- |
| none | ad hoc + runtime | killed, exit 137, no output |
| none | as built | killed, exit 137 |
| none | signature removed | killed, exit 137 |
| none, binary signed before dylib | ad hoc + runtime | killed, exit 137; `codesign --verify --strict` passes on both |
| `allow-jit` | ad hoc + runtime | killed, exit 137 |
| `disable-library-validation` | ad hoc + runtime | killed, exit 137 |
| `allow-jit` + `disable-library-validation` | ad hoc + runtime | killed, exit 137 |
| `disable-executable-page-protection` | ad hoc + runtime | starts; `dlopen` fails: "mapping process and mapped file (non-platform) have different Team IDs" |
| `allow-unsigned-executable-memory` | ad hoc + runtime | starts; `dlopen` fails, same Team ID message |
| `allow-unsigned-executable-memory` + `disable-library-validation` | ad hoc + runtime | **runs**, `sqlite 3.53.4 ok` |

So ad hoc signing with `--options runtime` works only with both
entitlements, and it is not a faithful stand-in for the release: the
library-validation half of it exists only because ad hoc signatures have no
Team ID. Development builds keep the build's own ad hoc signature without
hardened runtime, which runs as it is.

### (2) Developer ID, arm64

The owner's Developer ID Application certificate is in this machine's login
keychain, so the release signature itself was tried (`--timestamp=none`
first, then with `--timestamp`):

| Binary | Dylib | Result |
| --- | --- | --- |
| Developer ID + runtime, `allow-unsigned-executable-memory` | Developer ID + runtime | **runs**, `sqlite 3.53.4 ok` |
| same | as built (ad hoc) | `dlopen` fails: different Team IDs |
| same, with `--timestamp` on both | Developer ID + runtime + `--timestamp` | **runs**; `codesign -dvv` shows `Timestamp=` and the chain Developer ID Application → Developer ID Certification Authority → Apple Root CA |

`codesign --verify --strict --verbose=2` on both files: "valid on disk",
"satisfies its Designated Requirement". `spctl -a -vvv -t exec` on the
binary: `rejected`, `source=Unnotarized Developer ID`, which is what an
un-notarised Developer ID signature should say.

### x64 under Rosetta

The x64 SDK 3.13.5 (the `dartsdk-macos-x64-release.zip` archive) under
`arch -x86_64 dart build cli … --target-arch x64` built the bundle in about
12 s. Signed with Developer ID, hardened runtime and the same entitlement,
it runs (`arch -x86_64 …`, `sqlite 3.53.4 ok`). Signed without any
entitlement it also runs under Rosetta: Rosetta's translated code does not
hit the arm64 executable-memory check. Whether a native Intel Mac kills it
without the entitlement was not tried (no Intel machine); the same
entitlements file is used for both architectures, so the question does not
change the release.

### (4) npm round trip

The Developer ID signed arm64 bundle was put in a package (`os: ["darwin"]`,
`cpu: ["arm64"]`, `files: ["bin", "lib"]`), `npm pack`ed (npm 11.6.2) and
installed from the tarball into a fresh project:

- the tarball stores `bin/probe` as `0755` and `lib/libsqlite3.dylib` as
  `0644`, owner `0:0`, mtime fixed to 1985; the install restores the same
  modes;
- both files are byte-identical to the signed originals (`cmp`);
- the only xattr is `com.apple.provenance`; no `com.apple.quarantine`;
- `codesign --verify --strict` passes on both installed files, and the
  binary runs.

A registry install goes through npm's cache with the same tar extraction,
so it behaves the same; that was not tried against the registry. Since npm
sets no quarantine, Gatekeeper does not assess the binary at all on an npm
install; notarisation matters for a copy that arrives quarantined (the
`.tgz` downloaded from the npm website in a browser and unpacked by
Archive Utility, say), where Gatekeeper looks the ticket up online on first
run, because a bare Mach-O cannot be stapled.

### Zip for notarisation

`ditto -c -k --keepParent` on a directory holding both bundles produced a zip
that, unpacked with `ditto -x -k`, still verifies with `codesign --verify
--strict`. `ditto` adds `._*` AppleDouble entries for the provenance xattr;
they are harmless to the notary service, and `--norsrc --noextattr` drops
them.

## The entitlements file

`tool/macos/board.entitlements` (path to be chosen by whoever writes the
CI), applied to `bin/board` only; the dylib gets no entitlements, since
entitlements apply to the main executable of a process:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
	<true/>
</dict>
</plist>
```

`allow-unsigned-executable-memory` is a hardened-runtime exception the notary
service accepts for Developer ID; it is not a restricted entitlement and
needs no provisioning profile. It is the narrowest key that works:
`disable-executable-page-protection` also gets past the kill but is a
superset, and `allow-jit` does not work.

## Commands

Signing, per architecture, `$ID` being the identity's SHA-1 hash or its
full "Developer ID Application: … (TEAMID)" name and `$KC` the CI keychain:

```sh
B=build/darwin-arm64/bundle
codesign --force --sign "$ID" --keychain "$KC" \
  --options runtime --timestamp \
  --identifier dev.chorded.board.libsqlite3 \
  "$B/lib/libsqlite3.dylib"
codesign --force --sign "$ID" --keychain "$KC" \
  --options runtime --timestamp \
  --entitlements tool/macos/board.entitlements \
  --identifier dev.chorded.board \
  "$B/bin/board"
codesign --verify --strict --verbose=2 "$B/bin/board" "$B/lib/libsqlite3.dylib"
codesign -d --entitlements - "$B/bin/board"   # shows the one key
"$B/bin/board" --version                        # starts under hardened runtime
```

Without `--identifier` the identifier is the file name (`board`,
`libsqlite3`); a reverse-DNS identifier is conventional but not required by
notarisation. The prefix above is a placeholder (see open questions).

The binary needs a self-test that touches SQLite for the "starts" check in
CI; `--version` alone may not open the database. Anything that opens an
in-memory database and reads `sqlite_version()` does (a `board doctor`, or
`board project list` under a temporary `BOARD_DIR`; that belongs to
interfaces).

Notarisation, one submission for both architectures:

```sh
mkdir -p notarize
cp -R build/darwin-arm64/bundle notarize/darwin-arm64
cp -R build/darwin-x64/bundle   notarize/darwin-x64
ditto -c -k --norsrc --noextattr --keepParent notarize board-notarize.zip

# App Store Connect API key (recommended for CI)
xcrun notarytool submit board-notarize.zip \
  --key "$RUNNER_TEMP/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER_ID" \
  --wait --timeout 30m --output-format json > notarize.json
# or Apple ID + app-specific password
xcrun notarytool submit board-notarize.zip \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" --wait --timeout 30m --output-format json

# fail the job unless Accepted; on failure print the log
status=$(jq -r .status notarize.json); id=$(jq -r .id notarize.json)
xcrun notarytool log "$id" --key … --key-id … --issuer …
test "$status" = Accepted
```

After acceptance (online lookup, no staple possible on a bare Mach-O):

```sh
spctl -a -vvv -t exec build/darwin-arm64/bundle/bin/board
# expected: accepted, source=Notarized Developer ID
```

Not tried; before notarisation it says `rejected, source=Unnotarized
Developer ID` (tried). The ticket can take a few minutes to propagate after
`Accepted`, so this check retries for a short while rather than failing at
once. `stapler` is not run: it supports app bundles, disk images and
installer packages, not a bare binary or a zip.

What is published is exactly what was notarised: the npm packages are
assembled from the same two bundle directories after signing, with no
rebuild, no `strip`, and no file rewritten. Any change to either Mach-O
after signing invalidates both the signature and the ticket.

## CI: one job on a macOS arm64 runner

Triggered by a version tag. Steps, in order:

1. **Checkout**; `dart-lang/setup-dart` with the pinned SDK version
   (arm64).
2. **x64 SDK**: download `dartsdk-macos-x64-release.zip` for the same version
   from `storage.googleapis.com/dart-archive/channels/stable/release/<ver>/sdk/`,
   check its published SHA-256, unzip to `$RUNNER_TEMP/dart-x64`. Install
   Rosetta if missing: `softwareupdate --install-rosetta --agree-to-license`
   (idempotent).
3. `dart pub get`; `dart analyze`; `dart format --set-exit-if-changed .`;
   `dart test`.
4. **Build arm64**: `dart build cli -t bin/board.dart --target-os macos
   --target-arch arm64 -o build/darwin-arm64`.
5. **Build x64**: `arch -x86_64 "$RUNNER_TEMP/dart-x64/dart-sdk/bin/dart"
   build cli -t bin/board.dart --target-os macos --target-arch x64
   -o build/darwin-x64` (its own `pub get` under the x64 SDK first, if the
   lock and hooks need it). Check with `file` that both files are x86_64.
6. **Keychain**: create a temporary keychain with a random password, import
   the `.p12` from `APPLE_DEVELOPER_ID_P12_BASE64` /
   `APPLE_DEVELOPER_ID_P12_PASSWORD`, allow `codesign` to use the key
   without a prompt:
   ```sh
   KC="$RUNNER_TEMP/signing.keychain-db"; KCP=$(openssl rand -hex 24)
   security create-keychain -p "$KCP" "$KC"
   security set-keychain-settings -lut 21600 "$KC"
   security unlock-keychain -p "$KCP" "$KC"
   echo "$APPLE_DEVELOPER_ID_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/id.p12"
   security import "$RUNNER_TEMP/id.p12" -k "$KC" \
     -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
   security set-key-partition-list -S apple-tool:,apple: -s -k "$KCP" "$KC"
   security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
   rm "$RUNNER_TEMP/id.p12"
   ID=$(security find-identity -v -p codesigning "$KC" | awk '/Developer ID Application/{print $2; exit}')
   ```
7. **Sign** both architectures with the commands above, dylib then binary;
   verify; run each binary's SQLite self-test (x64 through `arch -x86_64`).
8. **Notarise** the one zip; fail unless `Accepted`; print the log either
   way; `spctl -a -t exec` on both binaries (with a short retry).
9. **Assemble npm packages** from the signed bundles: `@chorded/board-darwin-arm64`
   and `@chorded/board-darwin-x64` each get `bin/board` and
   `lib/libsqlite3.dylib` copied with `cp -p`; `@chorded/board` gets the
   shim. Versions are stamped from the tag.
10. **Check the packages as installed**: `npm pack` each platform package,
    install the tarballs into a scratch project, `codesign --verify
    --strict` the installed files and run the self-test. This catches a
    packaging step that touched the bytes.
11. **Publish**: the two platform packages first, then `@chorded/board`
    (whose exact-version `optionalDependencies` must resolve), with
    `npm publish --access public` (`--provenance` if the job gets
    `id-token: write`). A failure after a platform package is out leaves
    a version the main package never points at; the job is re-run with
    the next patch version, not by unpublishing.
12. **Always**: delete the keychain and `AuthKey.p8`.

Failure outcomes:

| Failure | Outcome |
| --- | --- |
| tests, build, or `file` arch check | job stops; nothing signed or published |
| `codesign` or `--verify` | job stops; usually an expired certificate or a locked keychain |
| the binary is killed (exit 137) after signing | entitlements not applied; job stops before notarisation |
| notary `Invalid` or timeout | job stops; `notarytool log` printed; nothing published |
| `spctl` still `Unnotarized` after retries | job stops; nothing published |
| npm installed-copy check | job stops; nothing published |
| `npm publish` of the main package | platform packages are out under that version, unreachable from the main package; next patch version |

## CI secrets (names only)

- `APPLE_DEVELOPER_ID_P12_BASE64`: the Developer ID Application certificate
  and private key, exported as `.p12`, base64.
- `APPLE_DEVELOPER_ID_P12_PASSWORD`: the `.p12` export password.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8` (the `.p8`
  file's contents, written to `$RUNNER_TEMP/AuthKey.p8`): an App Store
  Connect API key with the Developer role, for `notarytool`.
- `NPM_TOKEN`: an npm automation (or granular publish) token for the
  `@chorded` scope.
- `APPLE_TEAM_ID` as a repository variable, not a secret: used to check
  that the imported identity is the expected one (and by the Apple ID form
  of `notarytool`, if chosen, together with secrets `APPLE_ID` and
  `APPLE_APP_PASSWORD`).

## Open questions for the owner

1. **The entitlement.** `allow-unsigned-executable-memory` lets the process
   map memory writable and executable without a signature; the Dart AOT
   runtime needs it under hardened runtime on arm64, and no narrower key
   works. Accept it, or drop hardened runtime (which notarisation requires)?
   The recommendation is to accept it.
2. **Notarisation credentials**: App Store Connect API key (recommended:
   not tied to a person's Apple ID, no 2FA, revocable on its own) or Apple
   ID + app-specific password.
3. **Signing identifier**: a reverse-DNS prefix for `--identifier`
   (`dev.chorded.board` is a placeholder), or leave the file names.
4. **docs/design.md** still describes Homebrew and GitHub Releases and the
   quarantine note; with npm-only distribution those go, which is the
   lead's edit.
5. **Native Intel**: x64 was run only under Rosetta. One run on an Intel
   Mac before the first release would confirm it, though the shipped
   entitlements already cover the arm64 case and are the same file.
