import { describe, expect, it } from "vitest";
import { clampErrorDetail, ERROR_DETAIL_LIMIT } from "../format";

describe("clampErrorDetail", () => {
	it("leaves a short message alone", () => {
		expect(clampErrorDetail("agent exited with code 1")).toBe("agent exited with code 1");
	});

	it("collapses a multi-line dump onto one line", () => {
		const zodish = '[\n  {\n    "code": "invalid_type",\n    "path": ["progress"]\n  }\n]';
		expect(clampErrorDetail(zodish)).toBe('[ { "code": "invalid_type", "path": ["progress"] } ]');
	});

	it("ellipsizes anything past the display limit", () => {
		const clamped = clampErrorDetail("x".repeat(ERROR_DETAIL_LIMIT + 50));

		expect(clamped).toHaveLength(ERROR_DETAIL_LIMIT);
		expect(clamped.endsWith("…")).toBe(true);
	});

	it("trims the surrounding whitespace a wrapped dump arrives with", () => {
		expect(clampErrorDetail("  boom  ")).toBe("boom");
	});
});
