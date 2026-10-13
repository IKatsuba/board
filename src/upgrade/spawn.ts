/**
 * Runs a package manager as a person would type it: the name looked up on
 * the PATH of `env`, never process.execPath; all three stdio inherited, so
 * its progress shows and its prompts (an OTP, corepack) can be answered; the
 * environment passed through unchanged. No timeout, since an install
 * downloads a large tarball over whatever network there is, and no signal
 * handler, so Ctrl-C reaches it as it reaches the manager typed by hand.
 *
 * Resolves when the manager exits 0, rejects naming the argv and the status
 * or signal otherwise. A manager missing from PATH is Bun.spawn's own ENOENT,
 * left for the caller to word.
 */
export async function runManager(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
	const child = Bun.spawn([...argv], {
		env: { ...env },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (child.signalCode !== null) {
		throw new Error(`${argv.join(" ")} was killed by ${child.signalCode}.`);
	}
	if (code !== 0) {
		throw new Error(`${argv.join(" ")} exited with status ${code}.`);
	}
}
