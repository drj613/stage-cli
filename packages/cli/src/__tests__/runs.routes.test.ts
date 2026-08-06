import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";
import { getJson, setupRunRoutesTest } from "./runs-route-harness.js";

const env = setupRunRoutesTest("stage-cli-routes-");

describe("runs API", () => {
	it("GET /api/runs/:runId/chapters returns chapters with nested keyChanges sorted by chapterIndex", async () => {
		const db = getDb({ dbPath: env.dbPath });
		const fixture = makeFixture({
			chapters: [
				{
					id: "chapter-0",
					order: 2,
					title: "Second",
					summary: "Second summary",
					hunkRefs: [],
					keyChanges: [],
				},
				{
					id: "chapter-1",
					order: 1,
					title: "First",
					summary: "First summary",
					hunkRefs: [{ filePath: "a.ts", oldStart: 1 }],
					keyChanges: [
						{
							content: "Question?",
							lineRefs: [{ filePath: "a.ts", side: "additions", startLine: 1, endLine: 2 }],
						},
					],
				},
			],
		});
		const { runId } = insertChaptersFile(db, fixture, makeRepoContext());

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, `/api/runs/${runId}/chapters`);

		expect(res.status).toBe(200);
		const body = res.body as {
			run: { id: string };
			chapters: Array<{
				order: number;
				title: string;
				keyChanges: Array<{ content: string }>;
			}>;
		};
		expect(body.run.id).toBe(runId);
		expect(body.chapters).toHaveLength(2);
		expect(body.chapters[0]?.order).toBe(1);
		expect(body.chapters[0]?.title).toBe("First");
		expect(body.chapters[0]?.keyChanges).toHaveLength(1);
		expect(body.chapters[0]?.keyChanges[0]).toMatchObject({ content: "Question?" });
		expect(body.chapters[1]?.order).toBe(2);
		expect(body.chapters[1]?.keyChanges).toHaveLength(0);
	});

	it("returns key_change rows in insertion order (matching hosted stage's natural query order)", async () => {
		const db = getDb({ dbPath: env.dbPath });
		const fixture = makeFixture({
			chapters: [
				{
					id: "chapter-0",
					order: 1,
					title: "Multi-key-change",
					summary: "Insertion-order check",
					hunkRefs: [],
					keyChanges: [
						{
							content: "first",
							lineRefs: [{ filePath: "a.ts", side: "additions", startLine: 1, endLine: 1 }],
						},
						{
							content: "second",
							lineRefs: [{ filePath: "a.ts", side: "additions", startLine: 2, endLine: 2 }],
						},
						{
							content: "third",
							lineRefs: [{ filePath: "a.ts", side: "additions", startLine: 3, endLine: 3 }],
						},
					],
				},
			],
		});
		const { runId } = insertChaptersFile(db, fixture, makeRepoContext());

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, `/api/runs/${runId}/chapters`);

		const body = res.body as {
			chapters: Array<{ keyChanges: Array<{ content: string }> }>;
		};
		expect(body.chapters[0]?.keyChanges.map((k) => k.content)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("omits the denormalized chapter.keyChanges content array from the response", async () => {
		const db = getDb({ dbPath: env.dbPath });
		const { runId } = insertChaptersFile(db, makeFixture(), makeRepoContext());

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, `/api/runs/${runId}/chapters`);

		const body = res.body as { chapters: Array<{ keyChanges: unknown[] }> };
		expect(body.chapters[0]?.keyChanges.every((k) => typeof k === "object")).toBe(true);
	});

	it("GET /api/runs/:runId/chapters returns prologue: null when no prologue was imported", async () => {
		const db = getDb({ dbPath: env.dbPath });
		const { runId } = insertChaptersFile(db, makeFixture(), makeRepoContext());

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, `/api/runs/${runId}/chapters`);

		expect(res.status).toBe(200);
		const body = res.body as { prologue: unknown };
		expect(body.prologue).toBeNull();
	});

	it("GET /api/runs/:runId/chapters includes the prologue when imported", async () => {
		const db = getDb({ dbPath: env.dbPath });
		const prologue = {
			motivation: "Slow page loads on large repos.",
			outcome: "Pages load fast now.",
			diagram: null,
			keyChanges: [
				{ summary: "Pagination added to repo list", description: "Limits to 50 repos per page" },
			],
			focusAreas: [
				{
					type: "performance" as const,
					severity: "info" as const,
					title: "Pagination boundary",
					description: "Verify off-by-one at page boundaries",
					locations: ["src/repos.ts"],
				},
			],
			complexity: { level: "low" as const, reasoning: "Simple pagination" },
		};
		const { runId } = insertChaptersFile(db, makeFixture({ prologue }), makeRepoContext());

		const { port } = await env.startWithRoutes();
		const res = await getJson(port, `/api/runs/${runId}/chapters`);

		expect(res.status).toBe(200);
		const body = res.body as { prologue: typeof prologue };
		expect(body.prologue).toEqual(prologue);
	});

	it("GET /api/runs/:runId/chapters returns 404 for unknown runs", async () => {
		const { port } = await env.startWithRoutes();
		const res = await getJson(port, "/api/runs/00000000-0000-0000-0000-000000000000/chapters");
		expect(res.status).toBe(404);
	});
});
