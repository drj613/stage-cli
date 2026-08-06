import { describe, expect, it } from "vitest";
import { chainsContaining, tipOf } from "../chain-position";

const chain = (numbers: number[]) => ({
	members: numbers.map((number) => ({
		number,
		title: `PR ${number}`,
		url: `https://github.com/acme/app/pull/${number}`,
		isDraft: false,
	})),
});

describe("chainsContaining", () => {
	it("reports the PR's one-based position and the chain length", () => {
		const found = chainsContaining({ complete: true, chains: [chain([12, 13, 14])] }, 13);
		expect(found).toEqual([{ chain: chain([12, 13, 14]), position: 2, length: 3 }]);
	});

	it("returns every chain a forked PR belongs to", () => {
		const graph = { complete: true, chains: [chain([12, 13]), chain([12, 14])] };
		expect(chainsContaining(graph, 12).map((c) => tipOf(c.chain).number)).toEqual([13, 14]);
	});

	it("returns nothing for a PR outside every chain", () => {
		expect(chainsContaining({ complete: true, chains: [chain([12, 13])] }, 99)).toEqual([]);
	});

	// A position from a truncated `gh pr list` could read 2/3 when it is really
	// 2/5, so an incomplete graph shows no badge rather than a wrong one.
	it("returns nothing when the graph is incomplete", () => {
		expect(chainsContaining({ complete: false, chains: [chain([12, 13])] }, 12)).toEqual([]);
	});
});

describe("tipOf", () => {
	it("returns the last member", () => {
		expect(tipOf(chain([12, 13, 14])).number).toBe(14);
	});
});
