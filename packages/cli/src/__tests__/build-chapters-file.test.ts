import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChaptersFile } from "../build-chapters-file.js";

function writePayload(payload: unknown): string {
	const dir = mkdtempSync(path.join(tmpdir(), "stage-build-chapters-"));
	const file = path.join(dir, "agent-output.json");
	writeFileSync(file, JSON.stringify(payload), "utf8");
	return file;
}

describe("buildChaptersFile schema errors", () => {
	it("reports the agent schema when the payload has no scope", async () => {
		const file = writePayload({
			chapters: [],
			prologue: { motivation: null, outcome: null, complexity: "high" },
		});

		const error = await buildChaptersFile(file, { cwd: process.cwd() }).catch(
			(err: unknown) => err,
		);

		expect(String(error)).toContain("prologue");
		expect(String(error)).not.toContain("scope");
	});

	it("reports the full-file schema when the payload carries a scope", async () => {
		const file = writePayload({ scope: { kind: "nonsense" }, chapters: [] });

		const error = await buildChaptersFile(file, { cwd: process.cwd() }).catch(
			(err: unknown) => err,
		);

		expect(String(error)).toContain("scope");
	});
});
