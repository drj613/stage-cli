import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRunnerOutput } from "../generation/run-id.js";

describe("parseRunnerOutput", () => {
	it("takes the runId from the agent's last line", () => {
		const runId = randomUUID();
		expect(parseRunnerOutput(`Generated 4 chapters.\nWrote chapters.json\n${runId}\n`)).toBe(runId);
	});

	it("rejects a last line that is not a runId without echoing it", () => {
		// Under stream-json this line is the tail of the agent's prose, which can
		// quote source or file contents — it must not reach an error message.
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).toThrow(
			"Agent did not return a valid runId.",
		);
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).not.toThrow(/abc123/);
	});

	it("rejects a 36-character non-UUID", () => {
		expect(() => parseRunnerOutput("-".repeat(36))).toThrow(/valid runId/);
	});

	it("rejects empty output", () => {
		expect(() => parseRunnerOutput("   \n")).toThrow(/valid runId/);
	});
});
