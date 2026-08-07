import type { StackChain } from "@stagereview/types/stacks";
import { chainsContaining, tipOf } from "./chain-position";
import { type PrAddress, type PrResolutionMachine, useResolution } from "./use-pr-resolution";
import { useStacks } from "./use-stacks";

export function stackResolutionQueryKey(address: PrAddress): readonly unknown[] {
	return [
		"stack-resolution",
		address.owner.toLowerCase(),
		address.repo.toLowerCase(),
		address.number,
	];
}

export interface StackResolutionMachine extends PrResolutionMachine {
	/** The chain ending at this address, or null until the graph has loaded. */
	chain: StackChain | null;
}

/**
 * The resolver machine for a whole chain. A chain is identified by its tip, so
 * `address.number` names the tip and the graph supplies the members.
 *
 * The members are needed before generation can start, which is why the machine
 * is handed an empty `prUrls` until the graph arrives — `useResolution` holds
 * off auto-starting rather than POSTing a stack it cannot yet describe.
 */
export function useStackResolution(address: PrAddress): StackResolutionMachine {
	const nameWithOwner = `${address.owner}/${address.repo}`;
	const graph = useStacks([nameWithOwner]).get(nameWithOwner);
	const tipNumber = Number(address.number);

	const chain =
		graph === undefined
			? null
			: (chainsContaining(graph, tipNumber).find((entry) => tipOf(entry.chain).number === tipNumber)
					?.chain ?? null);

	const machine = useResolution({
		queryKey: stackResolutionQueryKey(address),
		path: `/api/stacks/${address.owner}/${address.repo}/${address.number}/resolve`,
		prUrls: chain === null ? [] : chain.members.map((member) => member.url),
	});

	return { ...machine, chain };
}
