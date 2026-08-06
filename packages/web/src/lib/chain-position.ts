import type { StackChain, StackGraph, StackMember } from "@stagereview/types/stacks";

export interface ChainPosition {
	chain: StackChain;
	/** One-based place in the chain, bottom first. */
	position: number;
	length: number;
}

/** A chain always has at least two members, so its tip always exists. */
export function tipOf(chain: StackChain): StackMember {
	const tip = chain.members[chain.members.length - 1];
	if (!tip) throw new Error("chain has no members");
	return tip;
}

/**
 * Every chain this PR sits in, with its place in each. A forked stack puts a PR
 * in more than one chain, hence a list.
 *
 * An incomplete graph returns nothing: a position derived from a truncated
 * `gh pr list` could read 2/3 when it is really 2/5, and a badge that is quietly
 * wrong is worse than no badge at all.
 */
export function chainsContaining(graph: StackGraph, prNumber: number): ChainPosition[] {
	if (!graph.complete) return [];
	return graph.chains.flatMap((chain) => {
		const index = chain.members.findIndex((member) => member.number === prNumber);
		if (index === -1) return [];
		return [{ chain, position: index + 1, length: chain.members.length }];
	});
}
