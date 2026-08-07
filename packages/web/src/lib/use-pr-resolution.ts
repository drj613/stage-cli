import type { GenerateRequest } from "@stagereview/types/generate";
import {
	GenerateAcceptedSchema,
	type GenerationJob,
	GenerationJobSchema,
	isTerminalJobStatus,
	JOB_STATUS,
} from "@stagereview/types/generation";
import {
	PR_RESOLUTION,
	type PrResolution,
	PrResolutionSchema,
} from "@stagereview/types/pull-requests";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { invalidateRunLists } from "./invalidate-run-lists";
import { jsonFetch } from "./use-view-state";

const JOB_POLL_INTERVAL_MS = 1_000;
const ErrorBodySchema = z.object({ error: z.string() });

export interface PrAddress {
	owner: string;
	repo: string;
	number: string;
}

export function prResolutionQueryKey(address: PrAddress): readonly unknown[] {
	return ["pr-resolution", address.owner.toLowerCase(), address.repo.toLowerCase(), address.number];
}

/** Null while no job is adopted — the query is disabled by skipToken then, not by its key. */
function jobQueryKey(jobId: string | null): readonly unknown[] {
	return ["generation-job", jobId];
}

/**
 * Starts a headless generation job. Rejects with the server's own message so
 * "no local clone for this repo" (422) reaches the user verbatim.
 */
async function startGeneration(prUrls: string[]): Promise<string> {
	// Typed against the shared schema so a change to the request shape is a
	// compile error here rather than a runtime 400 from an inline object.
	const body: GenerateRequest = { prUrls };
	const res = await fetch("/api/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const raw: unknown = await res.json();
	if (!res.ok) {
		const parsed = ErrorBodySchema.safeParse(raw);
		throw new Error(
			parsed.success ? parsed.data.error : `POST /api/generate failed: ${res.status}`,
		);
	}
	return GenerateAcceptedSchema.parse(raw).jobId;
}

export interface PrResolutionMachine {
	/** Server-reported resolution; undefined while loading. */
	resolution: PrResolution | undefined;
	resolutionError: unknown;
	/** Live job snapshot while generating (either auto-started or adopted). */
	job: GenerationJob | null;
	/** RunId to navigate to: from a ready resolution or a succeeded job. */
	runId: string | null;
	/** Explicit user action — Regenerate on stale, Retry on failed. */
	generate: () => void;
	/**
	 * Why the job poll stopped, if it did. The poll doesn't retry, so it stays
	 * stopped until something refetches it — a window focus, or Retry. See
	 * deriveResolverView for what the page makes of that.
	 */
	pollError: string | null;
	/** startError, the job's own error, or the resolution's last reported failure, in that precedence. */
	generationError: string | null;
}

/**
 * The resolver state machine (see design doc "Resolver page"). The GET is
 * side-effect free; generating on view is client behavior, and only the
 * needs-generation state auto-POSTs — failed and stale wait for a click, so
 * a refresh never spends an agent session. Double-mount and multi-tab races
 * are safe because the server's activeJobFor dedupes on the canonical PR URL.
 *
 * The component calling this hook MUST be keyed by the normalized PR address
 * (see the resolver page). startedJobId and autoStarted are per-PR state; an
 * in-place route-param change (PR A → PR B) would otherwise leave B polling
 * A's job, suppress B's auto-generation, and let A's still-pending mutation
 * install its jobId after navigation. Remounting on key change resets all of
 * it and orphans the stale mutation callback.
 */
export function usePrResolution(address: PrAddress): PrResolutionMachine {
	const prUrl = `https://github.com/${address.owner}/${address.repo}/pull/${address.number}`;
	return useResolution({
		queryKey: prResolutionQueryKey(address),
		path: `/api/pull-requests/${address.owner}/${address.repo}/${address.number}`,
		prUrls: [prUrl],
	});
}

/** What a resolution is for: where to read it, and what generating would cover. */
export interface ResolutionTarget {
	queryKey: readonly unknown[];
	/** GET path returning a `PrResolution`. */
	path: string;
	/**
	 * The PRs a generation request would chapter. Empty means generation is not
	 * possible yet — a stack page has not loaded its chain — and auto-start waits.
	 */
	prUrls: string[];
}

/**
 * The resolver machine itself, over any target. A single PR and a whole stack
 * differ only in which endpoint reports the state and how many PRs a generate
 * request names, so both share this.
 */
export function useResolution(target: ResolutionTarget): PrResolutionMachine {
	const queryClient = useQueryClient();
	const { queryKey, path } = target;

	// Read through a ref so the auto-start effect does not depend on the identity
	// of a freshly-built array every render.
	const prUrlsRef = useRef(target.prUrls);
	prUrlsRef.current = target.prUrls;
	const canGenerate = target.prUrls.length > 0;

	const resolutionQuery = useQuery<PrResolution>({
		queryKey,
		queryFn: async () => PrResolutionSchema.parse(await jsonFetch<unknown>(path)),
	});
	const resolution = resolutionQuery.data;

	const [startedJobId, setStartedJobId] = useState<string | null>(null);
	const { mutate, error: startError } = useMutation({
		mutationFn: (prUrls: string[]) => startGeneration(prUrls),
		onSuccess: setStartedJobId,
	});

	const autoStarted = useRef(false);
	// Gate on isFetchedAfterMount: a cached needs-generation served synchronously
	// on remount may be stale (the last attempt may have failed or succeeded
	// since), and POSTing from it would spend a second agent session. Only a
	// resolution the server confirmed after this mount may auto-start.
	const needsGeneration =
		resolution?.state === PR_RESOLUTION.NEEDS_GENERATION && resolutionQuery.isFetchedAfterMount;
	useEffect(() => {
		if (!needsGeneration || !canGenerate || autoStarted.current) return;
		autoStarted.current = true;
		mutate(prUrlsRef.current);
	}, [needsGeneration, canGenerate, mutate]);

	const jobId =
		startedJobId ?? (resolution?.state === PR_RESOLUTION.GENERATING ? resolution.jobId : null);

	const { data: job, error: pollError } = useQuery<GenerationJob>({
		queryKey: jobQueryKey(jobId),
		queryFn:
			jobId === null
				? skipToken
				: async () =>
						GenerationJobSchema.parse(
							await jsonFetch<unknown>(`/api/generate/${encodeURIComponent(jobId)}`),
						),
		retry: false,
		refetchInterval: (query) => {
			if (query.state.status === "error") return false;
			const data = query.state.data;
			return data && isTerminalJobStatus(data.status) ? false : JOB_POLL_INTERVAL_MS;
		},
	});

	// The resolution query's cached state predates whichever job just finished
	// (it was "generating" or "failed" when the job started). Invalidate on
	// every terminal outcome — not just success — so the server's view (which
	// already knows about the failed job via latestJobFor) replaces the
	// client's stale one instead of drifting from it.
	const terminal = job !== undefined && isTerminalJobStatus(job.status);
	useEffect(() => {
		if (!terminal) return;
		void queryClient.invalidateQueries({ queryKey });
	}, [terminal, queryClient, queryKey]);

	const succeeded = job?.status === JOB_STATUS.SUCCEEDED;
	useEffect(() => {
		if (!succeeded) return;
		invalidateRunLists(queryClient);
	}, [succeeded, queryClient]);

	const resolvedRunId = resolution?.state === PR_RESOLUTION.READY ? resolution.runId : null;
	// A fresh attempt's own error always wins; only fall back to the server's
	// last-reported failure when nothing from this mount has failed yet.
	const resolvedFailureError = resolution?.state === PR_RESOLUTION.FAILED ? resolution.error : null;

	return {
		resolution,
		resolutionError: resolutionQuery.error,
		job: job ?? null,
		runId: job?.runId ?? resolvedRunId,
		generate: () => {
			// A stopped poll needs something to refetch it, and the server dedupes on
			// the PR, so this Retry may well hand back the same jobId and land on the
			// same key. Without the reset the button would look inert.
			if (jobId !== null) void queryClient.resetQueries({ queryKey: jobQueryKey(jobId) });
			mutate(prUrlsRef.current);
		},
		pollError: pollError?.message ?? null,
		generationError: startError?.message ?? job?.error ?? resolvedFailureError,
	};
}
