import type { Manager } from "./detect.ts";

/** The published package a person installs. */
export const PACKAGE = "@chorded/board";

/**
 * The manager's own global install of an exact version. Never `@*` or
 * `@latest`: `bun add -g pkg@*` leaves an installed version alone and exits
 * 0, so the caller always names the version.
 */
export function installArgv(manager: Manager, version: string): string[] {
	const spec = `${PACKAGE}@${version}`;
	switch (manager) {
		case "npm":
			return ["npm", "install", "--global", spec];
		case "bun":
			return ["bun", "add", "--global", spec];
		case "pnpm":
			return ["pnpm", "add", "--global", spec];
		case "yarn":
			return ["yarn", "global", "add", spec];
	}
}
