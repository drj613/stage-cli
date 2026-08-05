// @vitest-environment happy-dom

import { ACTIVITY_STATE, type ActivityEntry } from "@stagereview/types/generation";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityList } from "../activity-list";

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
	return { tool: "Read", target: "src/index.ts", state: ACTIVITY_STATE.DONE, ...overrides };
}

describe("ActivityList", () => {
	it("stops animating a running entry once the job is over", () => {
		const activity = [makeEntry({ state: ACTIVITY_STATE.RUNNING })];

		const { container } = render(<ActivityList activity={activity} isRunning={false} />);

		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
			"Didn't finish",
		);
	});

	it("animates a running entry while the job is still going", () => {
		const activity = [makeEntry({ state: ACTIVITY_STATE.RUNNING })];

		const { container } = render(<ActivityList activity={activity} isRunning />);

		expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
	});

	it("renders the tool alone when the server reported no target", () => {
		const { container } = render(<ActivityList activity={[makeEntry({ target: "" })]} isRunning />);

		// A second span would be an empty element, which the row's gap turns into a
		// dangling separator after the tool name.
		expect(container.querySelectorAll("li > span")).toHaveLength(1);
		expect(container.textContent).toBe("Read");
	});

	it("renders newest first in the DOM so flex-col-reverse shows oldest at the top", () => {
		const activity = ["first.ts", "second.ts", "third.ts"].map((target) => makeEntry({ target }));

		const { container } = render(<ActivityList activity={activity} isRunning />);

		expect([...container.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
			"Readthird.ts",
			"Readsecond.ts",
			"Readfirst.ts",
		]);
		// The inversion is only correct as a pair: without it the reversed DOM order
		// above would render newest at the top.
		expect(container.querySelector("ul")?.className).toContain("flex-col-reverse");
	});

	it("leaves the caller's array untouched", () => {
		const activity = [makeEntry({ target: "a.ts" }), makeEntry({ target: "b.ts" })];

		render(<ActivityList activity={activity} isRunning />);

		expect(activity.map((entry) => entry.target)).toEqual(["a.ts", "b.ts"]);
	});
});
