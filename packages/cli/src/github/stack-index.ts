import type { StackChain, StackGraph, StackMember } from "@stagereview/types/stacks";

/** The fields of a `gh pr list` row the chain graph is built from. */
export interface StackListPr {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	isCrossRepository: boolean;
	headRefName: string;
	baseRefName: string;
}

function toMember(pr: StackListPr): StackMember {
	return { number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft };
}

/**
 * Index PRs by head branch, dropping any branch two PRs claim. A duplicate head
 * makes every chain through it ambiguous, and a wrong chain is worse than none.
 * Cross-repository PRs are excluded outright: a fork can carry a branch named
 * like the upstream's, which would invent a parent that does not exist.
 */
function indexByHead(prs: readonly StackListPr[]): Map<string, StackListPr> {
	const byHead = new Map<string, StackListPr>();
	const duplicated = new Set<string>();
	for (const pr of prs) {
		if (pr.isCrossRepository) continue;
		if (byHead.has(pr.headRefName)) duplicated.add(pr.headRefName);
		byHead.set(pr.headRefName, pr);
	}
	for (const head of duplicated) byHead.delete(head);
	return byHead;
}

/**
 * Walk from `pr` down to the trunk. Returns null when the walk revisits a PR — a
 * cycle means the base relationships are malformed, and no chain through them
 * can be trusted.
 */
function ancestorsOf(pr: StackListPr, byHead: Map<string, StackListPr>): StackListPr[] | null {
	const path: StackListPr[] = [pr];
	const seen = new Set<number>([pr.number]);
	let current = pr;
	for (;;) {
		const parent = byHead.get(current.baseRefName);
		if (!parent) return path.reverse();
		if (seen.has(parent.number)) return null;
		seen.add(parent.number);
		path.push(parent);
		current = parent;
	}
}

/** A chain always has at least two members, so its tip always exists. */
function tipNumber(chain: StackChain): number {
	const tip = chain.members[chain.members.length - 1];
	if (!tip) throw new Error("chain has no members");
	return tip.number;
}

/**
 * Every root-to-leaf chain among these PRs. A chain is identified by its tip, so
 * a stack that forks yields one chain per leaf rather than one ambiguous stack.
 * `capped` is true when the caller's `gh pr list` returned exactly its limit, in
 * which case a member may exist beyond it and the graph is incomplete.
 */
export function buildStackGraph(prs: readonly StackListPr[], capped: boolean): StackGraph {
	const byHead = indexByHead(prs);
	const parentHeads = new Set<string>();
	for (const pr of byHead.values()) {
		if (byHead.has(pr.baseRefName)) parentHeads.add(pr.baseRefName);
	}

	const chains: StackChain[] = [];
	for (const pr of byHead.values()) {
		// Only leaves start a chain — every other PR is covered by a leaf's walk.
		if (parentHeads.has(pr.headRefName)) continue;
		const path = ancestorsOf(pr, byHead);
		if (path === null || path.length < 2) continue;
		chains.push({ members: path.map(toMember) });
	}

	chains.sort((a, b) => tipNumber(a) - tipNumber(b));
	return { complete: !capped, chains };
}
