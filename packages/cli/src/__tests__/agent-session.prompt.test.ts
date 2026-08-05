import { describe, expect, it } from "vitest";
import { promptFor } from "../generation/agent-session.js";
import { JOB } from "./agent-session-fixture.js";

describe("headless agent prompt", () => {
	it("names the repo root every stagereview command must run from", () => {
		const prompt = promptFor(JOB);

		expect(prompt).toContain(JOB.repoRoot);
		expect(prompt).toContain(JOB.prUrl);
	});
});
