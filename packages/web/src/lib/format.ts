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
