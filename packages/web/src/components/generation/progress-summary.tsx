import type { GenerationModel, JobProgress } from "@stagereview/types/generation";
import { formatDurationSeconds } from "@/lib/format";
import { formatModelLabel } from "@/lib/generation-labels";
import { useElapsedSeconds } from "@/lib/use-elapsed";

export interface ProgressSummaryProps {
	/** Known at enqueue time, and the fallback label until the agent's init event lands. */
	requestedModel: GenerationModel;
	/** Null between the status flip to running and the child process spawning. */
	progress: JobProgress | null;
}

/**
 * `Sonnet 4.5 · 1m 42s · 14 turns`. Elapsed time appears once the process has
 * spawned and the turn count once the agent has taken a turn, so the line grows
 * left to right rather than showing zeroes for a job that has not started.
 *
 * Deliberately not a live region: a polite announcement every second would
 * make the page unusable with a screen reader.
 */
export function ProgressSummary({ requestedModel, progress }: ProgressSummaryProps) {
	const elapsed = useElapsedSeconds(progress?.startedAt ?? null);
	const parts = [formatModelLabel(requestedModel, progress?.resolvedModel ?? null)];
	const duration = elapsed === null ? null : formatDurationSeconds(elapsed);
	if (duration !== null) parts.push(duration);
	const turns = progress?.turns ?? 0;
	if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	return <p className="text-muted-foreground text-xs tabular-nums">{parts.join(" · ")}</p>;
}
