import { formatDistanceToNow } from "date-fns";

/** "opened 3 days ago" — matches hosted Stage's relative-time rendering. */
export function formatTimeAgo(dateString: string): string {
	return formatDistanceToNow(new Date(dateString), { addSuffix: true });
}

/** Compact duration, e.g. "42s", "1m 12s", "1h 5m". Null when not a sane duration. */
export function formatDurationSeconds(seconds: number): string | null {
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	const whole = Math.round(seconds);
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	const remainingSeconds = whole % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Longest error detail a card renders inline; the full text goes in its title. */
export const ERROR_DETAIL_LIMIT = 240;

/**
 * Folds a server error onto one readable line. A schema failure's message is a
 * multi-line JSON dump, which would otherwise fill a card with what reads as a
 * stack trace.
 */
export function clampErrorDetail(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= ERROR_DETAIL_LIMIT) return collapsed;
	return `${collapsed.slice(0, ERROR_DETAIL_LIMIT - 1).trimEnd()}…`;
}

/** Compact elapsed time between two ISO timestamps, e.g. "1m 12s". */
export function formatElapsedTime(
	startedAt: string | null,
	completedAt: string | null,
): string | null {
	if (!startedAt || !completedAt) return null;
	return formatDurationSeconds(
		(new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
	);
}
