import { type RunListResponse, RunListResponseSchema } from "@stagereview/types/run-summary";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export const RUNS_QUERY_KEY = ["runs"] as const;

/** Every run Stage has imported, newest first (ordering comes from the server). */
export function useRuns() {
	return useQuery<RunListResponse>({
		queryKey: RUNS_QUERY_KEY,
		// Parse at the boundary so server-side schema drift surfaces as a query
		// error here, not as a render crash in the list.
		queryFn: async () => RunListResponseSchema.parse(await jsonFetch<unknown>("/api/runs")),
	});
}
