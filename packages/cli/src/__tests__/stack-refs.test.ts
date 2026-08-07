import { describe, expect, it } from "vitest";
import { orderMembersByAncestry } from "../github/stack-refs.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** Ancestry for the chain A → B → C. */
const chain = (ancestor: string, descendant: string) =>
	(ancestor === A && (descendant === B || descendant === C)) ||
	(ancestor === B && descendant === C);

const SHA_FOR = new Map([
	[12, A],
	[13, B],
	[14, C],
]);

function members(prNumbers: number[]) {
	return prNumbers.map((prNumber) => {
		const headSha = SHA_FOR.get(prNumber);
		if (headSha === undefined) throw new Error(`no sha for #${prNumber}`);
		return { prNumber, headSha };
	});
}

describe("orderMembersByAncestry", () => {
	// Every permutation, because the caller's order is explicitly untrusted and a
	// partial-order comparator would only be wrong for some of them.
	it.each([
		[[12, 13, 14]],
		[[12, 14, 13]],
		[[13, 12, 14]],
		[[13, 14, 12]],
		[[14, 12, 13]],
		[[14, 13, 12]],
	])("orders %j bottom-first", (input) => {
		expect(orderMembersByAncestry(members(input), chain).map((m) => m.prNumber)).toEqual([
			12, 13, 14,
		]);
	});

	it("refuses a member that is not stacked on the one below it", () => {
		expect(() => orderMembersByAncestry(members([12, 13]), () => false)).toThrow(
			/#13 is not stacked on #12/,
		);
	});

	it("names the member that needs restacking", () => {
		// A → B holds, but C is off on its own — #14 is the one to restack.
		const partial = (ancestor: string, descendant: string) => ancestor === A && descendant === B;
		expect(() => orderMembersByAncestry(members([12, 13, 14]), partial)).toThrow(/#14/);
	});

	it("refuses duplicate pull requests", () => {
		expect(() =>
			orderMembersByAncestry(
				[
					{ prNumber: 12, headSha: A },
					{ prNumber: 12, headSha: A },
				],
				chain,
			),
		).toThrow(/twice/);
	});

	it("passes a single member straight through", () => {
		expect(orderMembersByAncestry(members([13]), chain)).toEqual([{ prNumber: 13, headSha: B }]);
	});
});
