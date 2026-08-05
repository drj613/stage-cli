import { useSyncExternalStore } from "react";

const TICK_MS = 1_000;

/**
 * A single 1 Hz clock for the whole app. One timer and one `Date.now()` per
 * tick, so every subscriber renders the same instant — N cards each owning an
 * interval would drift into showing durations a second apart for the same
 * moment.
 *
 * The timer only runs while someone is subscribed; a module singleton would
 * otherwise tick for the lifetime of the tab with nobody listening.
 */
class Clock {
	#listeners = new Set<() => void>();
	#interval: ReturnType<typeof setInterval> | null = null;
	#now = Date.now();

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		if (this.#interval === null) {
			this.#now = Date.now();
			this.#interval = setInterval(this.#tick, TICK_MS);
		}
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0 && this.#interval !== null) {
				clearInterval(this.#interval);
				this.#interval = null;
			}
		};
	};

	/**
	 * Cached, never a fresh `Date.now()` — React calls this repeatedly per render
	 * and treats an always-changing value as an infinite loop. While the clock is
	 * idle the reading is frozen, so the first frame after a gap with no
	 * subscribers can be stale by the length of that gap. `subscribe` refreshes
	 * it and React re-reads the snapshot right after subscribing, which corrects
	 * the value before the next tick.
	 */
	getSnapshot = (): number => this.#now;

	#tick = () => {
		this.#now = Date.now();
		for (const listener of this.#listeners) listener();
	};
}

const clock = new Clock();

/** No SSR here, but React still wants a server reading to hydrate against. */
const getServerSnapshot = clock.getSnapshot;

const NEVER_SUBSCRIBE = () => () => {};

/**
 * The shared clock's current reading in epoch ms, re-rendering once a second.
 * For durations prefer `useElapsedSeconds`; reach for this only when the caller
 * needs the raw instant, such as measuring against a timestamp it must parse
 * itself.
 */
export function useNow(): number {
	return useSyncExternalStore(clock.subscribe, clock.getSnapshot, getServerSnapshot);
}

/**
 * Seconds since `startedAt` (epoch ms), ticking once a second off the shared
 * clock. A genuine subscription to an external clock, not derived state — the
 * value changes with wall time, not with props.
 *
 * Clamped at zero: a sleeping laptop or an NTP step can put the server's
 * `startedAt` ahead of the browser's clock, and a negative age is never worth
 * rendering. The result is fractional — format it before display.
 *
 * Pass `null` to stop the clock — callers own that decision, so a finished job
 * must switch to its recorded duration rather than leaving this hook ticking.
 */
export function useElapsedSeconds(startedAt: number | null): number | null {
	const start = startedAt !== null && Number.isFinite(startedAt) ? startedAt : null;
	const now = useSyncExternalStore(
		start === null ? NEVER_SUBSCRIBE : clock.subscribe,
		clock.getSnapshot,
		getServerSnapshot,
	);

	return start === null ? null : Math.max(0, (now - start) / 1000);
}
