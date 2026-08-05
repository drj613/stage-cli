// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsedSeconds } from "../use-elapsed";

const START = new Date("2026-08-05T10:00:00Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
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

	it("stops ticking once the start time goes null", () => {
		const { result, rerender } = renderHook(({ startedAt }) => useElapsedSeconds(startedAt), {
			initialProps: { startedAt: START as number | null },
		});

		rerender({ startedAt: null });
		expect(result.current).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
