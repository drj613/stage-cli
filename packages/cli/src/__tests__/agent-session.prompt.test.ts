import { describe, expect, it } from "vitest";
import { promptFor } from "../generation/agent-session.js";
import { JOB } from "./agent-session-fixture.js";

describe("headless agent prompt", () => {
	it("names the repo root every stagereview command must run from", () => {
		const prompt = promptFor(JOB);

		expect(prompt).toContain(JOB.repoRoot);
		expect(prompt).toContain(JOB.prUrls[0]);
	});

	it("passes one --pr flag per stack member", () => {
		const prompt = promptFor({
			...JOB,
			prUrls: ["https://github.com/acme/app/pull/12", "https://github.com/acme/app/pull/13"],
		});

		expect(prompt).toContain(
			"/stage-chapters --pr https://github.com/acme/app/pull/12 --pr https://github.com/acme/app/pull/13",
		);
	});
});
