import { ACTIVITY_STATE, type ActivityEntry } from "@stagereview/types/generation";
import { Check, CircleDashed, Loader2, X } from "lucide-react";
import { ACTIVITY_STATE_LABELS } from "@/lib/generation-labels";

/**
 * A `running` entry on a job that has stopped never got its `tool_result` — the
 * agent's `result` event beat it. Not running, not done, not failed: the honest
 * word is that we never saw the end of it.
 */
const UNFINISHED_LABEL = "Didn't finish";

function StateIcon({ state, isRunning }: { state: ActivityEntry["state"]; isRunning: boolean }) {
	if (state === ACTIVITY_STATE.RUNNING) {
		// Nothing may animate on a job that has stopped: a spinner claims work is
		// still happening. A dashed ring reads as unresolved without claiming the
		// step either finished or failed.
		return isRunning ? (
			<Loader2 aria-label={ACTIVITY_STATE_LABELS[state]} className="size-3 shrink-0 animate-spin" />
		) : (
			<CircleDashed
				aria-label={UNFINISHED_LABEL}
				className="size-3 shrink-0 text-muted-foreground"
			/>
		);
	}
	const label = ACTIVITY_STATE_LABELS[state];
	if (state === ACTIVITY_STATE.FAILED) {
		return <X aria-label={label} className="size-3 shrink-0 text-destructive" />;
	}
	return <Check aria-label={label} className="size-3 shrink-0 text-muted-foreground" />;
}

/**
 * The agent's recent tool calls: oldest at the top on screen, newest first in
 * the DOM. `flex-col-reverse` is what inverts the two, and it earns that
 * confusion — a reverse-column scroll box starts scrolled to its own bottom, so
 * the newest row stays visible with no scripted scrolling. Assistive tech
 * follows the DOM and so reads newest first, which is the better order for a
 * live log anyway.
 *
 * A long path is contained by min-w-0 + truncate on the target and clipped by
 * overflow-hidden on the row, which is what stops a 40-character tool name
 * (`shrink-0`, so it cannot truncate) from spilling out sideways.
 *
 * Deliberately not a live region: the poll rewrites these rows every second or
 * two, which a screen reader would read as a stream of interruptions.
 */
export interface ActivityListProps {
	activity: readonly ActivityEntry[];
	/** Whether the job can still advance; a stopped job's rows must not animate. */
	isRunning: boolean;
}

export function ActivityList({ activity, isRunning }: ActivityListProps) {
	if (activity.length === 0) return null;
	return (
		<ul className="flex max-h-40 flex-col-reverse gap-1 overflow-y-auto">
			{[...activity].reverse().map((entry, index) => (
				// A sliding window with no stable id, and an eviction shifts every
				// position, so no key can follow an entry across polls. The index is
				// honest about that, and safe while nothing here animates on identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists on the wire
				<li key={index} className="flex items-center gap-2 overflow-hidden text-xs">
					<StateIcon state={entry.state} isRunning={isRunning} />
					<span className="shrink-0 font-medium text-muted-foreground">{entry.tool}</span>
					{entry.target !== "" && (
						<span className="min-w-0 truncate font-mono text-muted-foreground">{entry.target}</span>
					)}
				</li>
			))}
		</ul>
	);
}
