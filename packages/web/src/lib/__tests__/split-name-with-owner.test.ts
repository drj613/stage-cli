import { describe, expect, it } from "vitest";
import { splitNameWithOwner } from "../split-name-with-owner";

describe("splitNameWithOwner", () => {
	it("splits a valid owner/repo pair", () => {
		expect(splitNameWithOwner("octocat/hello-world")).toEqual({
			owner: "octocat",
			repo: "hello-world",
		});
	});

	it("throws on a malformed value", () => {
		expect(() => splitNameWithOwner("not-a-repo")).toThrow();
	});
});
