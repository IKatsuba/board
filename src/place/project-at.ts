/**
 * The project whose directory is `path` or lies above it, the deepest when
 * projects nest. A bare string prefix is not enough: /p/app-two is not under
 * /p/app. Both sides are real paths, so the comparison is exact.
 */
export function projectAt<P extends { directory: string }>(
	projects: Iterable<P>,
	path: string,
): P | null {
	let found: P | null = null;
	for (const project of projects) {
		const dir = project.directory;
		if (path !== dir && !path.startsWith(`${dir}/`)) continue;
		if (found === null || dir.length > found.directory.length) found = project;
	}
	return found;
}
