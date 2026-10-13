import { UpgradeCommand } from "@cliffy/command/upgrade";
import { detectManager } from "../upgrade/detect.ts";
import { managerProviders } from "../upgrade/providers.ts";
import type { Deps } from "./io.ts";

/**
 * `board upgrade`: cliffy's command over the one provider of the manager
 * that installed this board, so it upgrades the install it runs from. With
 * none identified it gets npm's, whose hook refuses (cliffy needs one).
 */
export function upgradeCommand(deps: Deps) {
	const { execPath, providers } = deps.upgrade ?? {
		execPath: "",
		providers: managerProviders(deps.environment ?? {}),
	};
	const detected = detectManager(execPath);
	const provider = providers[detected ?? "npm"];
	if (detected === null) provider.unidentified = execPath;
	// standalone: false sends cliffy to the provider's hook instead of its
	// binary swap; no spinner, since the manager writes to the same terminal.
	return new UpgradeCommand({ provider, standalone: false, spinner: false });
}
