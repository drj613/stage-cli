import { describe, expect, it } from "vitest";
import { formatDurationSeconds, formatElapsedTime } from "../format";

describe("formatDurationSeconds", () => {
	it("formats seconds", () => {
		expect(formatDurationSeconds(42)).toBe("42s");
	});

	it("formats zero", () => {
		expect(formatDurationSeconds(0)).toBe("0s");
	});

	it("rounds a fractional duration to the nearest second", () => {
		expect(formatDurationSeconds(0.4)).toBe("0s");
		expect(formatDurationSeconds(0.6)).toBe("1s");
		expect(formatDurationSeconds(59.9)).toBe("1m");
	});

	it("formats minutes and seconds", () => {
		expect(formatDurationSeconds(102)).toBe("1m 42s");
	});

	it("drops a zero seconds remainder", () => {
		expect(formatDurationSeconds(120)).toBe("2m");
	});

	it("formats hours", () => {
		expect(formatDurationSeconds(3_900)).toBe("1h 5m");
		expect(formatDurationSeconds(3_600)).toBe("1h");
	});

	it("drops seconds once the duration reaches an hour", () => {
		expect(formatDurationSeconds(3_661)).toBe("1h 1m");
	});

	it("returns null for a negative or non-finite duration", () => {
		expect(formatDurationSeconds(-1)).toBeNull();
		expect(formatDurationSeconds(Number.NaN)).toBeNull();
		expect(formatDurationSeconds(Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe("formatElapsedTime", () => {
	it("formats the gap between two ISO timestamps", () => {
		expect(formatElapsedTime("2026-08-05T10:00:00Z", "2026-08-05T10:01:12Z")).toBe("1m 12s");
	});

	it("returns null when either timestamp is missing", () => {
		expect(formatElapsedTime(null, "2026-08-05T10:00:00Z")).toBeNull();
		expect(formatElapsedTime("2026-08-05T10:00:00Z", null)).toBeNull();
	});

	it("returns null when the timestamps are out of order", () => {
		expect(formatElapsedTime("2026-08-05T10:01:00Z", "2026-08-05T10:00:00Z")).toBeNull();
	});

	it("returns null for an unparseable timestamp", () => {
		expect(formatElapsedTime("not a date", "2026-08-05T10:00:00Z")).toBeNull();
	});
});
