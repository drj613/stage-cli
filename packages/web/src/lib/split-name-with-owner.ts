export interface OwnerRepo {
	owner: string;
	repo: string;
}

/**
 * Splits a GitHub `owner/repo` "nameWithOwner" string into its parts.
 * Throws on anything that isn't exactly one non-empty owner and one
 * non-empty repo — a malformed value here means upstream data is corrupt,
 * and a loud crash beats silently linking to `/pr//repo/123`.
 */
export function splitNameWithOwner(nameWithOwner: string): OwnerRepo {
	const parts = nameWithOwner.split("/");
	const [owner, repo] = parts;
	if (parts.length !== 2 || !owner || !repo) {
		throw new Error(`Expected "owner/repo", got "${nameWithOwner}"`);
	}
	return { owner, repo };
}
