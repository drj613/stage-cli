import {
	type ActiveGenerationJobs,
	ActiveGenerationJobsSchema,
	type GenerationJob,
} from "@stagereview/types/generation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { invalidateRunLists } from "./invalidate-run-lists";
import { jsonFetch } from "./use-view-state";

export const ACTIVE_JOBS_QUERY_KEY = ["active-generation-jobs"] as const;
/** Coarser than the resolver's 1 Hz poll — a row badge only names a phase. */
export const POLL_INTERVAL_MS = 3_000;

/**
 * How long until the next poll, or `false` to stop.
 *
 * Idle stops the timer: with nothing in flight there is nothing to learn, and a
 * job started in another tab is picked up by the refetch on window focus. A
 * failure also stops it, rather than hammering a server that just refused —
 * focus resumes that too. Both cases leave the last successful snapshot in the
 * cache, so badges go stale before they go wrong.
 */
export function activeJobsPollInterval(
	jobs: readonly GenerationJob[] | undefined,
	failed: boolean,
): number | false {
	if (failed) return false;
	// Undefined means the first response is still outstanding — nothing to
	// conclude from yet, so keep the timer armed.
	return jobs === undefined || jobs.length > 0 ? POLL_INTERVAL_MS : false;
}

/**
 * Every generation job currently queued or running, for badging pull-request
 * rows.
 *
 * The endpoint returns only non-terminal jobs, so a finished job simply
 * disappears. Every list that shows a row's `runId` has a stale time but no
 * refetch interval — staleness alone never triggers a fetch — so a departure has
 * to invalidate them explicitly, or a row would lose its phase badge and never
 * gain "Chaptered".
 *
 * Returns nothing at all while the poll is in error: a retained snapshot can
 * outlive the run it describes, and a spinner for a job that finished minutes
 * ago is worse than no badge.
 */
export function useActiveJobs(): readonly GenerationJob[] {
	const queryClient = useQueryClient();
	const previousIds = useRef<ReadonlySet<string>>(new Set());

	const { data, isError } = useQuery<ActiveGenerationJobs>({
		queryKey: ACTIVE_JOBS_QUERY_KEY,
		queryFn: async () =>
			ActiveGenerationJobsSchema.parse(await jsonFetch<unknown>("/api/generate")),
		retry: false,
		refetchInterval: (query) =>
			activeJobsPollInterval(query.state.data?.jobs, query.state.status === "error"),
	});

	// Keyed off `data`, which only changes on a successful fetch: a failed poll
	// leaves the last snapshot in the cache, so it can neither fake a departure nor
	// refetch a list that was fine. Only a job we watched leave means a run
	// finished; losing sight of one means nothing.
	const jobs = data?.jobs;
	useEffect(() => {
		if (jobs === undefined) return;
		const current = new Set(jobs.map((activeJob) => activeJob.id));
		const departed = [...previousIds.current].some((id) => !current.has(id));
		previousIds.current = current;
		if (departed) invalidateRunLists(queryClient);
	}, [jobs, queryClient]);

	return isError || jobs === undefined ? [] : jobs;
}

/** The active job for a PR URL, matched case-insensitively as the server does. */
export function findJobForPr(jobs: readonly GenerationJob[], prUrl: string): GenerationJob | null {
	const wanted = prUrl.toLowerCase();
	return jobs.find((activeJob) => activeJob.prUrl.toLowerCase() === wanted) ?? null;
}
