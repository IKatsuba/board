/** A package manager board can upgrade itself through. */
export type Manager = "npm" | "bun" | "pnpm" | "yarn";

/**
 * The rows of the design's table, first match wins. Every manager row needs
 * `@chorded/board-darwin-`, so a Bun or a Node that happens to sit under a
 * global node_modules never matches.
 */
const ROWS: readonly (readonly [RegExp, Manager | null])[] = [
	// npx and bunx are caches, not installs.
	[/\/_npx\/[^/]+\/node_modules\/@chorded\/board-darwin-/, null],
	[/\/bunx-[^/]+\/node_modules\/@chorded\/board-darwin-/, null],
	// $BUN_INSTALL (default ~/.bun), the platform package hoisted.
	[/\/install\/global\/node_modules\/@chorded\/board-darwin-/, "bun"],
	// global/5/… before pnpm 11, global/v11/<hash>-<n>/… from 11.
	[
		/\/global\/[^/]+\/(?:[^/]+\/)?node_modules\/\.pnpm\/@chorded\+board-darwin-/,
		"pnpm",
	],
	// yarn classic's default global folder.
	[/\/yarn\/global\/node_modules\/@chorded\/board-darwin-/, "yarn"],
	// npm under any prefix (nvm, Homebrew, fnm, Volta), nested in the main package.
	[
		/\/lib\/node_modules\/@chorded\/board\/node_modules\/@chorded\/board-darwin-/,
		"npm",
	],
];

/**
 * The manager that installed the running binary, from its real path; null
 * when no supported global installation is identified (a copy, a
 * development build, a local install, npx, bunx, or a layout v1 does not
 * recognise). A guess would install a second board elsewhere.
 */
export function detectManager(realPath: string): Manager | null {
	for (const [pattern, manager] of ROWS) {
		if (pattern.test(realPath)) return manager;
	}
	return null;
}
