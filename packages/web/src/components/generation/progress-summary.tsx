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
	 * Whether the job can still advance. A terminal job's clock has to stop, and
	 * the wire carries no end time, so its duration drops off the line rather
	 * than freezing at whichever second the last poll happened to land on.
	 */
	isRunning: boolean;
}

/**
 * `Sonnet 4.5 · 1m 42s · 14 turns`. Elapsed time appears once the process has
 * spawned and the turn count once the agent has taken a turn, so the line grows
 * left to right rather than showing zeroes for a job that has not started.
 *
 * Deliberately not a live region: a polite announcement every second would
 * make the page unusable with a screen reader.
 */
export function ProgressSummary({ requestedModel, progress, isRunning }: ProgressSummaryProps) {
	const elapsed = useElapsedSeconds(isRunning ? (progress?.startedAt ?? null) : null);
	const parts = [formatModelLabel(requestedModel, progress?.resolvedModel ?? null)];
	const duration = elapsed === null ? null : formatDurationSeconds(elapsed);
	if (duration !== null) parts.push(duration);
	const turns = progress?.turns ?? 0;
	if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	return <p className="text-muted-foreground text-xs tabular-nums">{parts.join(" · ")}</p>;
}
