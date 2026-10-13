import type { ProviderUpgradeOptions, Versions } from "@cliffy/upgrade";
import { NpmProvider } from "@cliffy/upgrade/provider/npm";
import { Refusal, registryError } from "../errors.ts";
import { shown } from "../visible.ts";
import { installArgv, PACKAGE } from "./argv.ts";
import type { Manager } from "./detect.ts";
import { runManager } from "./spawn.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Upgrades board through the package manager that installed it globally. */
export abstract class NpmManagerProvider extends NpmProvider {
	abstract override readonly name: Manager;

	/**
	 * The real path of a board no supported installation was identified
	 * for; set on the provider mounted in that case, whose hook then refuses.
	 */
	unidentified: string | undefined;

	constructor(private readonly env: Env) {
		super({ package: PACKAGE });
	}

	// An exact version for every manager: under `@*`, which NpmProvider
	// delegates `latest` to, bun leaves an installed board alone and exits 0.
	override async resolveVersion(
		name: string,
		version: string,
	): Promise<string> {
		return version === "latest"
			? (await this.getVersions(name)).latest
			: version;
	}

	// The listing is NpmProvider's; only its failure becomes board's refusal.
	override async getVersions(name: string): Promise<Versions> {
		try {
			return await super.getVersions(name);
		} catch (error) {
			throw new Refusal(registryError(error));
		}
	}

	// Not a permission check: in cliffy 1.3.1 the only caller is the version
	// check on help and `--version`, and `false` keeps it from fetching the
	// registry, so neither ever touches the network.
	override hasRequiredPermissions(): Promise<boolean> {
		return Promise.resolve(false);
	}

	override async upgrade(options: ProviderUpgradeOptions): Promise<void> {
		if (this.unidentified !== undefined) {
			throw new Error(unidentifiedText(this.unidentified, options.to));
		}
		const argv = installArgv(this.name, options.to);
		this.logger.log(`$ ${argv.join(" ")}`);
		try {
			await runManager(argv, this.env);
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") {
				throw new Error(
					`${this.name} is not on PATH. Install ${this.name}, or upgrade board with the manager that installed it (detected: ${this.name}).`,
				);
			}
			throw error;
		}
		// cliffy's success line follows once this returns; this one is printed
		// here, once, since the hook is the last code board runs after the
		// install.
		this.logger.info(
			`From now on, each board command runs the board your PATH finds, which is ${options.to} if PATH leads to the install just upgraded. A running board watch --follow keeps ${options.from} until it is restarted.`,
		);
	}
}

function unidentifiedText(path: string, version: string): string {
	const lines = (["npm", "bun", "pnpm", "yarn"] as const).map((manager) =>
		installArgv(manager, version).join(" "),
	);
	return `board cannot identify a supported global installation from this executable path: ${shown(path)}. If a package manager installed it, upgrade with that manager: ${lines[0]}, ${lines[1]}, ${lines[2]}, or ${lines[3]}. Not recognised: yarn with a custom --global-folder, npm link, and copies outside a manager's global directory.`;
}

export class NpmManager extends NpmManagerProvider {
	override readonly name = "npm";
}

export class BunManager extends NpmManagerProvider {
	override readonly name = "bun";
}

export class PnpmManager extends NpmManagerProvider {
	override readonly name = "pnpm";
}

export class YarnManager extends NpmManagerProvider {
	override readonly name = "yarn";
}

/** One provider per manager, each running its manager in `env`. */
export function managerProviders(
	env: Env,
): Record<Manager, NpmManagerProvider> {
	return {
		npm: new NpmManager(env),
		bun: new BunManager(env),
		pnpm: new PnpmManager(env),
		yarn: new YarnManager(env),
	};
}
