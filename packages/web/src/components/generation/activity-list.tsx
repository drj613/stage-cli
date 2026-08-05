import { ACTIVITY_STATE, type ActivityEntry } from "@stagereview/types/generation";
import { Check, Loader2, X } from "lucide-react";
import { ACTIVITY_STATE_LABELS } from "@/lib/generation-labels";

function StateIcon({ state }: { state: ActivityEntry["state"] }) {
	const label = ACTIVITY_STATE_LABELS[state];
	if (state === ACTIVITY_STATE.RUNNING) {
		return <Loader2 aria-label={label} className="size-3 shrink-0 animate-spin" />;
	}
	if (state === ACTIVITY_STATE.FAILED) {
		return <X aria-label={label} className="size-3 shrink-0 text-destructive" />;
	}
	return <Check aria-label={label} className="size-3 shrink-0 text-muted-foreground" />;
}

/**
 * The agent's recent tool calls, oldest first. `flex-col-reverse` over a
 * reversed list keeps the newest entry pinned to the bottom edge without
 * scripted scrolling, and min-w-0 + truncate stop a long path from widening
 * the card.
 *
 * Deliberately not a live region: the poll rewrites these rows every second or
 * two, which a screen reader would read as a stream of interruptions.
 */
export function ActivityList({ activity }: { activity: readonly ActivityEntry[] }) {
	if (activity.length === 0) return null;
	return (
		<ul className="flex max-h-40 flex-col-reverse gap-1 overflow-y-auto">
			{[...activity].reverse().map((entry, index) => (
				// A sliding window with no stable id: an eviction shifts every position,
				// so the key groups a row's text rather than tracking an entry. Safe
				// while nothing here animates on identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists on the wire
				<li key={index} className="flex items-center gap-2 overflow-hidden text-xs">
					<StateIcon state={entry.state} />
					<span className="shrink-0 font-medium text-muted-foreground">{entry.tool}</span>
					{entry.target !== "" && (
						<span className="min-w-0 truncate font-mono text-muted-foreground">{entry.target}</span>
					)}
				</li>
			))}
		</ul>
	);
}
