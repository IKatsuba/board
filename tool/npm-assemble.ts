// Assembles the three npm packages from the templates under npm/, the
// shim and two built binaries, with the repository's version written into
// each and into the main package's exact optionalDependencies:
//   bun tool/npm-assemble.ts OUT_DIR ARM64_BINARY X64_BINARY
// The release runs it on the signed binaries; a test runs it on any build.
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [out, arm64, x64] = process.argv.slice(2);
if (out === undefined || arm64 === undefined || x64 === undefined) {
	console.error(
		"usage: bun tool/npm-assemble.ts OUT_DIR ARM64_BINARY X64_BINARY",
	);
	process.exit(64);
}
const root = join(import.meta.dir, "..");
const { version } = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
) as {
	version: string;
};

function write(name: string, edit: (pkg: Record<string, unknown>) => void) {
	const pkg = JSON.parse(
		readFileSync(join(root, "npm", name, "package.json"), "utf8"),
	);
	pkg.version = version;
	edit(pkg);
	mkdirSync(join(out as string, name, "bin"), { recursive: true });
	writeFileSync(
		join(out as string, name, "package.json"),
		`${JSON.stringify(pkg, null, "\t")}\n`,
	);
	// npm packs a LICENSE beside package.json whatever `files` says; each
	// package is published on its own, so each carries the text.
	copyFileSync(join(root, "LICENSE"), join(out as string, name, "LICENSE"));
}

write("board", (pkg) => {
	pkg.optionalDependencies = Object.fromEntries(
		Object.keys(pkg.optionalDependencies as object).map((dep) => [
			dep,
			version,
		]),
	);
});
copyFileSync(
	join(root, "npm", "board", "bin", "board.js"),
	join(out, "board", "bin", "board.js"),
);
chmodSync(join(out, "board", "bin", "board.js"), 0o755);
for (const [arch, binary] of [
	["arm64", arm64],
	["x64", x64],
] as const) {
	write(`board-darwin-${arch}`, () => {});
	const target = join(out, `board-darwin-${arch}`, "bin", "board");
	copyFileSync(binary, target);
	chmodSync(target, 0o755);
}
console.log(`assembled @chorded/board ${version} in ${out}`);
