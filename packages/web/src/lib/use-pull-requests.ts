import type { PrFilter, PullRequestListResponse } from "@stagereview/types/pull-requests";
import { PullRequestListResponseSchema } from "@stagereview/types/pull-requests";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export const PULL_REQUESTS_QUERY_ROOT = "pull-requests";

/** `gh search prs` is slow and its results move slowly — a minute of staleness is fine. */
const STALE_TIME_MS = 60_000;

export function usePullRequests(filter: PrFilter) {
	return useQuery<PullRequestListResponse>({
		queryKey: [PULL_REQUESTS_QUERY_ROOT, filter],
		queryFn: async () =>
			PullRequestListResponseSchema.parse(
				await jsonFetch<unknown>(`/api/pull-requests?filter=${filter}`),
			),
		staleTime: STALE_TIME_MS,
	});
}
