import { type InboxResponse, InboxResponseSchema } from "@stagereview/types/inbox";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { RUNS_QUERY_KEY } from "./use-runs";
import { jsonFetch } from "./use-view-state";

export const INBOX_QUERY_KEY = ["inbox"] as const;

const GENERATION_JOB_ROOT = "generation-job";

/** `gh search prs` is slow and its results move slowly — a minute of staleness is fine. */
const INBOX_STALE_TIME_MS = 60_000;
const JOB_POLL_INTERVAL_MS = 3_000;

export const JOB_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	SUCCEEDED: "succeeded",
	FAILED: "failed",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

const GenerationJobSchema = z.object({
	id: z.string(),
	status: z.enum(JOB_STATUS),
	runId: z.string().nullable(),
	error: z.string().nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

const GenerateAcceptedSchema = z.object({ jobId: z.string() });
const ErrorBodySchema = z.object({ error: z.string() });

export function isTerminalJobStatus(status: JobStatus): boolean {
	return status === JOB_STATUS.SUCCEEDED || status === JOB_STATUS.FAILED;
}

/** PRs waiting on the viewer's review, cross-org, via `gh search prs`. */
export function useInbox() {
	return useQuery<InboxResponse>({
		queryKey: INBOX_QUERY_KEY,
		queryFn: async () => InboxResponseSchema.parse(await jsonFetch<unknown>("/api/inbox")),
		staleTime: INBOX_STALE_TIME_MS,
	});
}

/**
 * Starts a headless generation job. Rejects with the server's own message so
 * "no local clone for this repo" (422) reaches the user verbatim.
 */
async function startGeneration(prUrl: string): Promise<string> {
	const res = await fetch("/api/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prUrl }),
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

export interface ChapterGeneration {
	start: (prUrl: string) => void;
	/** True from the moment generation is requested until the job settles. */
	isRunning: boolean;
	status: JobStatus | null;
	/** Set once the job succeeds — the run is then ready to open. */
	runId: string | null;
	error: string | null;
}

/**
 * Drives one PR's generation: POST, then poll the job until it settles. On
 * success the runs and inbox caches are invalidated so both lists pick up the
 * new run.
 */
export function useChapterGeneration(): ChapterGeneration {
	const queryClient = useQueryClient();
	const [jobId, setJobId] = useState<string | null>(null);

	const {
		mutate,
		isPending,
		error: mutationError,
	} = useMutation({
		mutationFn: startGeneration,
		onSuccess: setJobId,
	});

	const { data: job } = useQuery<GenerationJob>({
		queryKey: [GENERATION_JOB_ROOT, jobId],
		queryFn:
			jobId === null
				? skipToken
				: async () =>
						GenerationJobSchema.parse(
							await jsonFetch<unknown>(`/api/generate/${encodeURIComponent(jobId)}`),
						),
		refetchInterval: (query) =>
			query.state.data && isTerminalJobStatus(query.state.data.status)
				? false
				: JOB_POLL_INTERVAL_MS,
	});

	const succeeded = job?.status === JOB_STATUS.SUCCEEDED;
	useEffect(() => {
		if (!succeeded) return;
		void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
	}, [succeeded, queryClient]);

	const start = useCallback(
		(prUrl: string) => {
			mutate(prUrl);
		},
		[mutate],
	);

	const status = job?.status ?? null;
	const settled = status !== null && isTerminalJobStatus(status);
	const requestError = mutationError instanceof Error ? mutationError.message : null;

	return useMemo(
		() => ({
			start,
			isRunning: isPending || (jobId !== null && !settled),
			status,
			runId: job?.runId ?? null,
			error: requestError ?? job?.error ?? null,
		}),
		[start, isPending, jobId, settled, status, job, requestError],
	);
}
