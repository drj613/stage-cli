import type { QueryClient } from "@tanstack/react-query";
import { REPO_PULLS_QUERY_KEY } from "./use-browse";
import { PULL_REQUESTS_QUERY_ROOT } from "./use-pull-requests";
import { RUNS_QUERY_KEY } from "./use-runs";

/**
 * Refetch every list whose rows depend on which runs exist: the dashboard's
 * pull-request sections, the repo browser's, and the run list.
 *
 * A finished job changes a row's `runId`, and all three queries sit behind a
 * stale time with no refetch interval — staleness alone never triggers a fetch.
 * Miss one and its rows keep the `runId` they were fetched with, so a row that
 * just gained a review shows no badge at all until something else refetches it.
 *
 * Called from both places that learn a job finished: the resolver page watching
 * one job, and the dashboard poll watching the active set.
 */
export function invalidateRunLists(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: [PULL_REQUESTS_QUERY_ROOT] });
	void queryClient.invalidateQueries({ queryKey: REPO_PULLS_QUERY_KEY });
	void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
}
