import { GENERATION_MODEL } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { formatModelLabel } from "../generation-labels";

describe("formatModelLabel", () => {
	it("falls back to the requested alias before the init event resolves a model", () => {
		expect(formatModelLabel(GENERATION_MODEL.SONNET, null)).toBe("Sonnet");
	});

	it("shortens a dated model id to family and version", () => {
		expect(formatModelLabel(GENERATION_MODEL.SONNET, "claude-sonnet-4-5-20250929")).toBe(
			"Sonnet 4.5",
		);
	});

	it("shortens the older family-last naming scheme the same way", () => {
		expect(formatModelLabel(GENERATION_MODEL.HAIKU, "claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
	});

	it("keeps the family alone when the id carries no version", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "claude-opus-latest")).toBe("Opus");
	});

	it("falls back to the requested alias when the id has no recognizable family", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "custom-endpoint-01")).toBe("Opus");
	});

	it("falls back to the requested alias for an empty id", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "")).toBe("Opus");
	});
});
