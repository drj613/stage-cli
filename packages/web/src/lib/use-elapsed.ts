import { useEffect, useState } from "react";

const TICK_MS = 1_000;

/**
 * Seconds since `startedAt` (epoch ms), ticking once a second. A genuine
 * subscription to an external clock, not derived state — the value changes with
 * wall time, not with props.
 *
 * Clamped at zero: a sleeping laptop or an NTP step can put the server's
 * `startedAt` ahead of the browser's clock, and a negative age is never worth
 * rendering.
 *
 * Pass `null` to stop the clock — callers own that decision, so a finished job
 * must switch to its recorded duration rather than leaving this hook ticking.
 */
export function useElapsedSeconds(startedAt: number | null): number | null {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (startedAt === null) return;
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, [startedAt]);

	return startedAt === null ? null : Math.max(0, (now - startedAt) / 1000);
}
