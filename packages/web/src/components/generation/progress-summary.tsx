import type { GenerationModel, JobProgress } from "@stagereview/types/generation";
import { formatDurationSeconds } from "@/lib/format";
import { formatModelLabel } from "@/lib/generation-labels";
import { useElapsedSeconds } from "@/lib/use-elapsed";

export interface ProgressSummaryProps {
	/** Known at enqueue time, and the fallback label until the agent's init event lands. */
	requestedModel: GenerationModel;
	/**
	 * Null for the whole queued state, between the flip to running and the child
	 * process spawning, and for a job whose process never spawned at all.
	 */
	progress: JobProgress | null;
	/**
	 * Whether the job can still advance. A terminal job's clock has to stop, so
	 * its duration comes from the recorded timestamps instead of ticking on.
	 */
	isRunning: boolean;
}

/** The run's own duration in seconds, once it recorded one. */
function recordedSeconds(progress: JobProgress | null): number | null {
	if (progress === null || progress.endedAt === null) return null;
	return (progress.endedAt - progress.startedAt) / 1000;
}

/**
 * Whether a snapshot proves no model was ever invoked. The synthetic path builds
 * a run without spawning an agent, so it reports neither a resolved model nor a
 * turn. A real agent run is also modelless for its first seconds — before its
 * init event lands — but by then it has a spawned process, so the two are only
 * told apart by pairing the missing model with a zero turn count.
 */
function usedNoModel(progress: JobProgress): boolean {
	return progress.resolvedModel === null && progress.turns === 0;
}

/**
 * `Sonnet 4.5 · 1m 42s · 14 turns`. Elapsed time appears once the process has
 * spawned and the turn count once the agent has taken a turn, so the line grows
 * left to right rather than showing zeroes for a job that has not started. Once
 * the job is over the same segment holds still at what the run actually took.
 *
 * Deliberately not a live region: a polite announcement every second would
 * make the page unusable with a screen reader.
 */
export function ProgressSummary({ requestedModel, progress, isRunning }: ProgressSummaryProps) {
	// Only a live job subscribes to the clock; a finished one reads its own record.
	const ticking = useElapsedSeconds(isRunning ? (progress?.startedAt ?? null) : null);
	const elapsed = ticking ?? recordedSeconds(progress);
	const parts: string[] = [];
	if (progress === null || !usedNoModel(progress)) {
		parts.push(formatModelLabel(requestedModel, progress?.resolvedModel ?? null));
	}
	const duration = elapsed === null ? null : formatDurationSeconds(elapsed);
	if (duration !== null) parts.push(duration);
	const turns = progress?.turns ?? 0;
	if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	return <p className="text-muted-foreground text-xs tabular-nums">{parts.join(" · ")}</p>;
}
