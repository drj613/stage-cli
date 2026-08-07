import type { StackGraph } from "@stagereview/types/stacks";
import { StackResponseSchema } from "@stagereview/types/stacks";
import { useQueries } from "@tanstack/react-query";

/** A repo whose chains could not be read behaves exactly like one with none. */
const EMPTY: StackGraph = { complete: false, chains: [] };

async function fetchStackGraph(nameWithOwner: string): Promise<StackGraph> {
	const res = await fetch(`/api/stacks/${nameWithOwner}`);
	const parsed = StackResponseSchema.parse(await res.json());
	return parsed.available ? parsed.graph : EMPTY;
}

/**
 * Chain graphs keyed by `owner/repo`, for every repo present in a PR list.
 *
 * One query per distinct repo, issued after the rows have already rendered — a
 * `gh` call takes seconds, and blocking the PR list on it to decorate a few rows
 * would trade the whole page's speed for a badge.
 */
export function useStacks(repositories: readonly string[]): Map<string, StackGraph> {
	const unique = [...new Set(repositories)].sort();
	const results = useQueries({
		queries: unique.map((nameWithOwner) => ({
			queryKey: ["stacks", nameWithOwner],
			staleTime: 60_000,
			queryFn: () => fetchStackGraph(nameWithOwner),
		})),
	});

	const byRepo = new Map<string, StackGraph>();
	unique.forEach((nameWithOwner, i) => {
		const data = results[i]?.data;
		if (data) byRepo.set(nameWithOwner, data);
	});
	return byRepo;
}
