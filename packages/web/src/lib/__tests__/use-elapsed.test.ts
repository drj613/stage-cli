// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsedSeconds } from "../use-elapsed";

const START = new Date("2026-08-05T10:00:00Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	// Unmount before the fake clock goes away: the shared clock must release its
	// interval while the timer API that created it still exists.
	cleanup();
	vi.useRealTimers();
});

describe("useElapsedSeconds", () => {
	it("returns null and starts no timer without a start time", () => {
		const { result } = renderHook(() => useElapsedSeconds(null));
		expect(result.current).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("counts up once a second", () => {
		const { result } = renderHook(() => useElapsedSeconds(START));
		expect(result.current).toBe(0);

		act(() => void vi.advanceTimersByTime(1_000));
		expect(result.current).toBe(1);

		act(() => void vi.advanceTimersByTime(2_000));
		expect(result.current).toBe(3);
	});

	it("clamps to zero when the start time is in the future", () => {
		const { result } = renderHook(() => useElapsedSeconds(START + 30_000));
		expect(result.current).toBe(0);

		act(() => void vi.advanceTimersByTime(1_000));
		expect(result.current).toBe(0);
	});

	it("keeps exactly one timer across re-renders", () => {
		const { rerender } = renderHook(() => useElapsedSeconds(START));
		expect(vi.getTimerCount()).toBe(1);

		rerender();
		rerender();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("clears its timer on unmount", () => {
		const { unmount } = renderHook(() => useElapsedSeconds(START));
		expect(vi.getTimerCount()).toBe(1);

		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("measures from the new start time when it changes", () => {
		const { result, rerender } = renderHook(({ startedAt }) => useElapsedSeconds(startedAt), {
			initialProps: { startedAt: START as number | null },
		});

		act(() => void vi.advanceTimersByTime(10_000));
		expect(result.current).toBe(10);

		rerender({ startedAt: START + 4_000 });
		expect(result.current).toBe(6);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("ignores a start time that is not a finite number", () => {
		const { result } = renderHook(() => useElapsedSeconds(Number.NaN));
		expect(result.current).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops ticking once the start time goes null", () => {
		const { result, rerender } = renderHook(({ startedAt }) => useElapsedSeconds(startedAt), {
			initialProps: { startedAt: START as number | null },
		});

		rerender({ startedAt: null });
		expect(result.current).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("useElapsedSeconds — one shared clock", () => {
	it("reads the same tick from hooks mounted at different times", () => {
		const early = renderHook(() => useElapsedSeconds(START));
		act(() => void vi.advanceTimersByTime(1_500));
		const late = renderHook(() => useElapsedSeconds(START));

		expect(late.result.current).toBe(early.result.current);
	});

	it("holds its reading between ticks rather than re-reading the system clock", () => {
		const early = renderHook(() => useElapsedSeconds(START));
		vi.setSystemTime(START + 1_500);
		const late = renderHook(() => useElapsedSeconds(START));

		expect(early.result.current).toBe(0);
		expect(late.result.current).toBe(0);
	});

	it("runs one timer no matter how many subscribers there are", () => {
		renderHook(() => useElapsedSeconds(START));
		renderHook(() => useElapsedSeconds(START + 5_000));
		renderHook(() => useElapsedSeconds(START - 5_000));

		expect(vi.getTimerCount()).toBe(1);
	});

	it("stops the timer once the last subscriber unmounts", () => {
		const first = renderHook(() => useElapsedSeconds(START));
		const second = renderHook(() => useElapsedSeconds(START));

		first.unmount();
		expect(vi.getTimerCount()).toBe(1);

		second.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("runs no timer while every mounted subscriber has no start time", () => {
		renderHook(() => useElapsedSeconds(null));
		renderHook(() => useElapsedSeconds(null));

		expect(vi.getTimerCount()).toBe(0);
	});

	it("reads the current time when a subscriber arrives after an idle gap", () => {
		const first = renderHook(() => useElapsedSeconds(START));
		first.unmount();
		expect(vi.getTimerCount()).toBe(0);

		vi.setSystemTime(START + 30_000);
		const second = renderHook(() => useElapsedSeconds(START));
		expect(second.result.current).toBe(30);
	});
});
