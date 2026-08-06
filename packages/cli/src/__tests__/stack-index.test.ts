import { describe, expect, it } from "vitest";
import { buildStackGraph, type StackListPr } from "../github/stack-index.js";

function pr(over: Partial<StackListPr> & Pick<StackListPr, "number">): StackListPr {
	return {
		title: `PR ${over.number}`,
		url: `https://github.com/acme/app/pull/${over.number}`,
		isDraft: false,
		isCrossRepository: false,
		headRefName: `feat/${over.number}`,
		baseRefName: "main",
		...over,
	};
}

const numbers = (graph: ReturnType<typeof buildStackGraph>) =>
	graph.chains.map((c) => c.members.map((m) => m.number));

describe("buildStackGraph", () => {
	it("chains PRs whose base is another PR's head", () => {
		const graph = buildStackGraph(
			[
				pr({ number: 12, headRefName: "a" }),
				pr({ number: 13, headRefName: "b", baseRefName: "a" }),
				pr({ number: 14, headRefName: "c", baseRefName: "b" }),
			],
			false,
		);
		expect(numbers(graph)).toEqual([[12, 13, 14]]);
		expect(graph.complete).toBe(true);
	});

	it("reports one chain per leaf when a stack forks", () => {
		const graph = buildStackGraph(
			[
				pr({ number: 12, headRefName: "a" }),
				pr({ number: 13, headRefName: "b", baseRefName: "a" }),
				pr({ number: 14, headRefName: "c", baseRefName: "a" }),
			],
			false,
		);
		expect(numbers(graph)).toEqual([
			[12, 13],
			[12, 14],
		]);
	});

	it("ignores a lone PR", () => {
		expect(numbers(buildStackGraph([pr({ number: 12 })], false))).toEqual([]);
	});

	it("excludes cross-repository PRs so a fork's branch cannot invent a parent", () => {
		const graph = buildStackGraph(
			[
				pr({ number: 12, headRefName: "a", isCrossRepository: true }),
				pr({ number: 13, headRefName: "b", baseRefName: "a" }),
			],
			false,
		);
		expect(numbers(graph)).toEqual([]);
	});

	it("drops both PRs when two claim the same head branch", () => {
		const graph = buildStackGraph(
			[
				pr({ number: 12, headRefName: "a" }),
				pr({ number: 99, headRefName: "a" }),
				pr({ number: 13, headRefName: "b", baseRefName: "a" }),
			],
			false,
		);
		expect(numbers(graph)).toEqual([]);
	});

	// A bare 2-cycle has no leaf, so the walk is never entered and the assertion
	// would hold vacuously. The cycle has to be reachable from a real leaf.
	it("survives a cycle reachable from a leaf", () => {
		const graph = buildStackGraph(
			[
				pr({ number: 12, headRefName: "a", baseRefName: "b" }),
				pr({ number: 13, headRefName: "b", baseRefName: "a" }),
				pr({ number: 14, headRefName: "leaf", baseRefName: "a" }),
			],
			false,
		);
		expect(numbers(graph)).toEqual([]);
	});

	it("marks a capped result incomplete", () => {
		expect(buildStackGraph([pr({ number: 12 })], true).complete).toBe(false);
	});
});
