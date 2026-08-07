import {
	type ResolvedScope,
	type ResolveScopeOptions,
	readRepoContext,
	resolveCommittedComparison,
	resolveScope,
} from "./git.js";
import {
	fetchBranch,
	fetchStackHeads,
	gitIsAncestor,
	orderMembersByAncestry,
	type PullRequestHead,
	parsePullRequestRef,
	readPullRequestHead,
	resolvePullRequestRefs,
} from "./github/index.js";
import type { RunMember } from "./runs/run-members.js";

/**
 * Everything needed to scope a diff from the command line: the local-ref modes
 * understood by {@link resolveScope}, plus optional GitHub PR references that
 * supersede them. More than one reference means a stack, reviewed as one diff.
 */
export interface DiffScopeOptions extends ResolveScopeOptions {
	/** PR numbers or github.com PR URLs to review instead of a local-ref diff. */
	prRefs?: string[];
}

export interface ResolvedDiffScope extends ResolvedScope {
	/** The reviewed PRs in stack order, bottom first. Empty for a local-ref scope. */
	members: RunMember[];
}

/**
 * Resolve a diff scope for `prep`/`show`/`import`. `--pr` references resolve the
 * base/head from the PRs themselves (fetching their commits locally); otherwise
 * the scope comes from the local-ref heuristics in {@link resolveScope}.
 */
export async function resolveDiffScope(options: DiffScopeOptions): Promise<ResolvedDiffScope> {
	const prRefs = options.prRefs ?? [];
	if (prRefs.length === 0) {
		return { ...resolveScope(options), members: [] };
	}

	const { root, originUrl } = readRepoContext(options.cwd);
	if (prRefs.length === 1) {
		const ref = prRefs[0];
		if (ref === undefined) throw new Error("Expected a PR reference.");
		const { number, baseSha, headSha } = await resolvePullRequestRefs(root, originUrl, ref);
		return {
			...resolveCommittedComparison(options.cwd, baseSha, headSha),
			members: [{ prNumber: number, headSha }],
		};
	}

	return resolveStackScope(root, originUrl, options.cwd, prRefs);
}

/**
 * Resolve several PRs to the diff of the whole stack: the merge base of the
 * bottom member's base branch and the tip's head, through to that head.
 *
 * The bottom is discovered by ancestry, not by argument order, so its base
 * branch can only be fetched after ordering — fetching the first argument's base
 * would often fetch another member's head branch and leave the trunk stale.
 */
async function resolveStackScope(
	root: string,
	originUrl: string | null,
	cwd: string,
	prRefs: readonly string[],
): Promise<ResolvedDiffScope> {
	const numbers = prRefs.map((ref) => parsePullRequestRef(originUrl, ref));
	const views = await Promise.all(numbers.map((n) => readPullRequestHead(root, n)));

	await fetchStackHeads(
		root,
		views.map((v) => v.number),
	);
	const members = orderMembersByAncestry(
		views.map((v) => ({ prNumber: v.number, headSha: v.headSha })),
		gitIsAncestor(root),
	);

	const bottom = members[0];
	const tip = members[members.length - 1];
	if (bottom === undefined || tip === undefined) throw new Error("Stack resolved to no members.");
	const bottomView = views.find((v) => v.number === bottom.prNumber);
	if (bottomView === undefined) throw new Error("Lost the bottom member while ordering.");

	await fetchBranch(root, bottomView.baseRefName);
	return {
		...resolveCommittedComparison(cwd, `origin/${bottomView.baseRefName}`, tip.headSha),
		members,
	};
}

/**
 * Resolve `--pr` references to members without computing a diff. Used when the
 * scope comes from elsewhere (a complete chapters file carries its own) but the
 * run still needs to record which PRs it targets, in a trustworthy order.
 */
export async function membersFromRefs(
	cwd: string,
	prRefs: readonly string[],
): Promise<RunMember[]> {
	if (prRefs.length === 0) return [];
	const { root, originUrl } = readRepoContext(cwd);
	const views: PullRequestHead[] = await Promise.all(
		prRefs
			.map((ref) => parsePullRequestRef(originUrl, ref))
			.map((n) => readPullRequestHead(root, n)),
	);
	const members = views.map((v) => ({ prNumber: v.number, headSha: v.headSha }));
	if (members.length === 1) return members;

	// The file's own scope is trusted, but the member order still is not — the
	// same ancestry guard applies so a broken stack is refused here too.
	await fetchStackHeads(
		root,
		views.map((v) => v.number),
	);
	return orderMembersByAncestry(members, gitIsAncestor(root));
}
