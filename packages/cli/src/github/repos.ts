import type { BrowseRepo } from "@stagereview/types/browse";
import { z } from "zod";
import { gh } from "./exec.js";

const GhRepoSchema = z.object({
	nameWithOwner: z.string(),
	description: z.string().nullable(),
	updatedAt: z.string(),
});

/**
 * Deliberate cap, not pagination: Browse shows the 200 most recently updated
 * repos under an owner. Owners with more repos see a truncated list; a PR in
 * an omitted repo is still reachable via its /pr/:owner/:repo/:number URL.
 */
const REPO_LIST_LIMIT = 200;

/** Repos under an owner the signed-in user can see, capped at REPO_LIST_LIMIT. Throws on gh failure. */
export async function listOrgRepos(
	owner: string,
	cwd: string,
	isCloned: (nameWithOwner: string) => boolean,
): Promise<BrowseRepo[]> {
	const stdout = await gh(
		[
			"repo",
			"list",
			owner,
			"--limit",
			String(REPO_LIST_LIMIT),
			"--json",
			"nameWithOwner,description,updatedAt",
		],
		cwd,
	);
	const repos = z.array(GhRepoSchema).parse(JSON.parse(stdout));
	return repos.map((repo) => ({ ...repo, cloned: isCloned(repo.nameWithOwner) }));
}
