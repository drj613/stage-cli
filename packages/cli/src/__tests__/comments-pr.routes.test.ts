import type { CommentThread } from "@stagereview/types/comments";
import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { chapterRunPullRequest, commentThread } from "../db/schema/index.js";
import { send, setupCommentRoutesTest } from "./comment-routes-harness.js";

const env = setupCommentRoutesTest("stage-cli-comments-pr-");

/** Seed a run and record which PRs it reviews (fixtures have no PR path). */
function seedPrRun(...prNumbers: number[]): string {
	const runId = env.seedRun();
	const db = getDb({ dbPath: env.dbPath });
	prNumbers.forEach((prNumber, position) => {
		db.insert(chapterRunPullRequest)
			.values({ runId, prNumber, headSha: "2".repeat(40), position })
			.run();
	});
	return runId;
}

describe("pending review comments (PR runs)", () => {
	it("stamps the run's prNumber on threads created in a PR run and reports pending", async () => {
		const runId = seedPrRun(7);
		const { port } = await env.startWithRoutes();
		const thread = await env.createThread(port, runId);
		expect(thread.pending).toBe(true);
		const db = getDb({ dbPath: env.dbPath });
		const [row] = db.select().from(commentThread).all();
		expect(row?.prNumber).toBe(7);
	});

	it("creates plain local notes (pending false, prNumber null) on non-PR runs", async () => {
		const runId = env.seedRun();
		const { port } = await env.startWithRoutes();
		const thread = await env.createThread(port, runId);
		expect(thread.pending).toBe(false);
		const db = getDb({ dbPath: env.dbPath });
		expect(db.select().from(commentThread).all()[0]?.prNumber).toBeNull();
	});

	it("hides pending threads from a non-PR run of the same diff, and notes stay visible to both", async () => {
		// Same fixture → same scopeKey for both runs.
		const prRunId = seedPrRun(7);
		const plainRunId = env.seedRun();
		const { port } = await env.startWithRoutes();
		await env.createThread(port, prRunId, { body: "pending comment" });
		await env.createThread(port, plainRunId, { body: "local note" });

		const plainList = await send(port, "GET", `/api/runs/${plainRunId}/comment-threads`);
		const plainBodies = (plainList.body as CommentThread[]).flatMap((t) =>
			t.comments.map((c) => c.body),
		);
		expect(plainBodies).toEqual(["local note"]);

		const prList = await send(port, "GET", `/api/runs/${prRunId}/comment-threads`);
		const prBodies = (prList.body as CommentThread[]).flatMap((t) => t.comments.map((c) => c.body));
		expect(prBodies).toEqual(expect.arrayContaining(["pending comment", "local note"]));
	});

	it("hides pending threads for PR 7 from a run targeting PR 8", async () => {
		const run7 = seedPrRun(7);
		const run8 = seedPrRun(8);
		const { port } = await env.startWithRoutes();
		await env.createThread(port, run7, { body: "for pr 7" });
		const list = await send(port, "GET", `/api/runs/${run8}/comment-threads`);
		expect((list.body as CommentThread[]).length).toBe(0);
	});

	it("rejects a comment aimed at a pull request the run does not review", async () => {
		const runId = seedPrRun(7);
		const { port } = await env.startWithRoutes();
		const res = await send(port, "POST", `/api/runs/${runId}/comment-threads`, {
			filePath: "src/foo.ts",
			side: "additions",
			startLine: 1,
			endLine: 1,
			body: "why?",
			prNumber: 99,
		});
		expect(res.status).toBe(400);
	});

	it("refuses an untargeted comment on a stack run rather than guessing", async () => {
		const runId = seedPrRun(12, 13);
		const { port } = await env.startWithRoutes();
		const res = await send(port, "POST", `/api/runs/${runId}/comment-threads`, {
			filePath: "src/foo.ts",
			side: "additions",
			startLine: 1,
			endLine: 1,
			body: "why?",
		});
		expect(res.status).toBe(400);
	});

	it("stores the chosen member on a stack run's thread", async () => {
		const runId = seedPrRun(12, 13);
		const { port } = await env.startWithRoutes();
		const res = await send(port, "POST", `/api/runs/${runId}/comment-threads`, {
			filePath: "src/foo.ts",
			side: "additions",
			startLine: 1,
			endLine: 1,
			body: "why?",
			prNumber: 13,
		});
		expect(res.status).toBe(201);
		const db = getDb({ dbPath: env.dbPath });
		const [row] = db.select().from(commentThread).all();
		expect(row?.prNumber).toBe(13);
	});
});
