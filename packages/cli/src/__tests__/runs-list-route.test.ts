import { RunListResponseSchema } from "@stagereview/types/run-summary";
import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";
import { getJson, setupRunRoutesTest } from "./runs-route-harness.js";

const env = setupRunRoutesTest("stage-cli-runs-list-");

describe("GET /api/runs", () => {
	it("returns runs newest-first with chapter counts", async () => {
		const db = getDb({ dbPath: env.dbPath });
		insertChaptersFile(
			db,
			makeFixture({ generatedAt: "2026-04-26T12:00:00.000Z" }),
			makeRepoContext(),
		);
		insertChaptersFile(
			db,
			makeFixture({
				generatedAt: "2026-04-27T12:00:00.000Z",
				chapters: [
					{
						id: "chapter-0",
						order: 1,
						title: "First",
						summary: "First summary",
						hunkRefs: [],
						keyChanges: [],
					},
					{
						id: "chapter-1",
						order: 2,
						title: "Second",
						summary: "Second summary",
						hunkRefs: [],
						keyChanges: [],
					},
					{
						id: "chapter-2",
						order: 3,
						title: "Third",
						summary: "Third summary",
						hunkRefs: [],
						keyChanges: [],
					},
				],
			}),
			makeRepoContext(),
			[{ prNumber: 42, headSha: "2".repeat(40) }],
		);

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, "/api/runs");

		expect(res.status).toBe(200);
		const body = RunListResponseSchema.parse(res.body);
		expect(body.runs).toHaveLength(2);

		const [newest, oldest] = body.runs;
		expect(newest?.generatedAt).toBe("2026-04-27T12:00:00.000Z");
		expect(newest?.chapterCount).toBe(3);
		expect(newest?.prNumbers).toEqual([42]);
		expect(oldest?.generatedAt).toBe("2026-04-26T12:00:00.000Z");
	});

	it("returns an empty list on a fresh DB", async () => {
		const { port } = await env.startWithRoutes();
		const res = await getJson(port, "/api/runs");

		expect(res.status).toBe(200);
		expect(RunListResponseSchema.parse(res.body)).toEqual({ runs: [] });
	});
});
