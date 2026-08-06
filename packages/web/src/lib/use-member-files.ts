import { MemberFilesResponseSchema } from "@stagereview/types/stacks";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

/**
 * Which member PRs changed each file in a stack run, so the comment composer can
 * offer only the PRs that actually touched the file in front of the reviewer.
 *
 * Only fetched for a stack — a single-PR run has one possible target and the
 * extra git work would buy nothing.
 */
export function useMemberFiles(runId: string, enabled: boolean): ReadonlyMap<string, number[]> {
	const { data } = useQuery({
		queryKey: ["member-files", runId],
		enabled: enabled && runId !== "",
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () =>
			MemberFilesResponseSchema.parse(
				await jsonFetch<unknown>(`/api/runs/${encodeURIComponent(runId)}/member-files`),
			),
	});
	return new Map(Object.entries(data?.filePullRequests ?? {}));
}
