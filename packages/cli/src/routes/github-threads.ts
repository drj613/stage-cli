import {
	GitHubReplyBodySchema,
	GitHubResolveBodySchema,
	type GitHubThreadsResponse,
	SubmitReviewBodySchema,
} from "@stagereview/types/github-threads";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import {
	type CommentRow,
	type CommentThreadRow,
	comment,
	commentThread,
} from "../db/schema/index.js";
import { parseGitHubRepo } from "../github/index.js";
import {
	type ReviewCommentInput,
	replyToReviewComment,
	setReviewThreadResolved,
	submitReview,
} from "../github/mutations.js";
import { fetchReviewThreads } from "../github/review-comments.js";
import { listRunMembers } from "../runs/run-members.js";
import { DIFF_SIDE } from "../schema.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import {
	enforceSameOrigin,
	parseNumber,
	requireRepo,
	resolveRun,
	runGhMutation,
} from "./pull-request-shared.js";

const UNAVAILABLE: GitHubThreadsResponse = { available: false, threads: [] };

// `commentId` and `threadNodeId` flow straight into `gh` argv (see mutations.ts),
// so they're validated here at the route boundary rather than deep in the gh
// helpers. `commentId` is documented as a REST database id (numeric); a decoded
// `../` would rewrite which endpoint gets POSTed to. `threadNodeId` is a GraphQL
// node id — the charset deliberately excludes `@` (gh's `-F`/`-f` "read from file"
// marker), `/`, and `.` to rule out path-like values entirely.
const COMMENT_ID_PATTERN = /^\d+$/;
const THREAD_NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Routes for GitHub review threads: a live-fetch GET (GitHub stays the source
 * of truth for its own threads — they're never mirrored into the local DB) and
 * three mutations that submit/append to a review via `gh`.
 */
export function gitHubThreadRoutes(db: StageDb): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/runs/:runId/github-threads",
			handler: async (_req, res, params) => {
				const run = resolveRun(db, params, res);
				if (!run) return;
				const repo = parseGitHubRepo(run.originUrl);
				const members = listRunMembers(db, run.runId);
				if (!repo || members.length === 0) {
					writeJson(res, 200, UNAVAILABLE);
					return;
				}
				// One fetch per member; each thread carries the PR it came from (stamped
				// by fetchReviewThreads) so replies route back to it. A member that
				// fails to fetch makes the whole response unavailable rather than
				// silently showing a subset — a half-populated list reads as "no
				// feedback here", which is the wrong thing to tell a reviewer.
				const perMember = await Promise.all(
					members.map(async (member) => {
						const threads = await fetchReviewThreads(
							run.repoRoot,
							repo,
							member.prNumber,
							member.headSha,
						);
						return threads;
					}),
				);
				if (perMember.some((threads) => threads === null)) {
					writeJson(res, 200, UNAVAILABLE);
					return;
				}
				const threads = perMember.flatMap((memberThreads) => memberThreads ?? []);
				writeJson(res, 200, { available: true, threads } satisfies GitHubThreadsResponse);
			},
		},
		{
			method: "POST",
			pattern: "/api/runs/:runId/reviews/:prNumber",
			handler: async (req, res, params) => {
				if (!enforceSameOrigin(req, res)) return;
				const run = resolveRun(db, params, res);
				if (!run) return;
				const repo = requireRepo(run, res);
				if (!repo) return;
				// One PR at a time. N GitHub mutations are not atomic, so pretending a
				// stack submits as one review would hide a partial failure; the caller
				// issues one request per member and reports each result.
				const prNumber = parseNumber(params.prNumber ?? null);
				const member =
					prNumber === null
						? undefined
						: listRunMembers(db, run.runId).find((m) => m.prNumber === prNumber);
				if (prNumber === null || member === undefined) {
					writeJson(res, 400, { error: "Run does not review that pull request" });
					return;
				}
				const body = await parseJsonBody(req, res, SubmitReviewBodySchema);
				if (!body) return;

				const pending = listPendingThreads(db, run.scopeKey, prNumber);
				const comments = pending.map(toReviewCommentInput);
				const submitted = await runGhMutation(
					res,
					async () => {
						await submitReview(run.repoRoot, repo, prNumber, {
							// The member's own head. The run's headSha is the tip of the
							// stack, which is not a commit of a lower PR — GitHub rejects a
							// review anchored outside the PR it is filed against.
							commit_id: member.headSha,
							event: body.event,
							body: body.body,
							comments,
						});
					},
					502,
				);
				// Nothing was deleted on failure — pending comments survive a failed submit.
				if (!submitted) return;
				// GitHub accepted the review: it is now the source of truth, so drop
				// the local pending rows (the live github-threads fetch shows them).
				db.delete(commentThread)
					.where(
						inArray(
							commentThread.id,
							pending.map((t) => t.thread.id),
						),
					)
					.run();
				writeJson(res, 200, {});
			},
		},
		{
			method: "POST",
			pattern: "/api/runs/:runId/github-threads/:commentId/replies",
			handler: async (req, res, params) => {
				if (!enforceSameOrigin(req, res)) return;
				const run = resolveRun(db, params, res);
				if (!run) return;
				const repo = requireRepo(run, res);
				if (!repo) return;
				const commentId = params.commentId;
				if (!commentId) {
					writeJson(res, 400, { error: "Run has no associated pull request" });
					return;
				}
				if (!COMMENT_ID_PATTERN.test(commentId)) {
					writeJson(res, 400, { error: "Invalid commentId" });
					return;
				}
				const body = await parseJsonBody(req, res, GitHubReplyBodySchema);
				if (!body) return;
				// A thread on a lower member does not live on the run's tip, so the
				// reply is routed by the thread's own PR when the caller names one.
				const prNumber = body.prNumber ?? run.prNumbers[0];
				if (prNumber === undefined || !run.prNumbers.includes(prNumber)) {
					writeJson(res, 400, { error: "Run does not review that pull request" });
					return;
				}
				const replied = await runGhMutation(
					res,
					() => replyToReviewComment(run.repoRoot, repo, prNumber, commentId, body.body),
					502,
				);
				if (!replied) return;
				writeJson(res, 200, {});
			},
		},
		{
			method: "PATCH",
			pattern: "/api/runs/:runId/github-threads/:threadNodeId/resolve",
			handler: async (req, res, params) => {
				if (!enforceSameOrigin(req, res)) return;
				const run = resolveRun(db, params, res);
				if (!run) return;
				const threadNodeId = params.threadNodeId;
				if (!threadNodeId) {
					writeJson(res, 400, { error: "Missing threadNodeId" });
					return;
				}
				if (!THREAD_NODE_ID_PATTERN.test(threadNodeId)) {
					writeJson(res, 400, { error: "Invalid threadNodeId" });
					return;
				}
				const body = await parseJsonBody(req, res, GitHubResolveBodySchema);
				if (!body) return;
				const resolved = await runGhMutation(
					res,
					() => setReviewThreadResolved(run.repoRoot, threadNodeId, body.resolved),
					502,
				);
				if (!resolved) return;
				writeJson(res, 200, {});
			},
		},
	];
}

interface PendingThread {
	thread: CommentThreadRow;
	comments: CommentRow[];
}

/**
 * Pending, unresolved threads for this scope + PR, each with its ordered
 * comments. A thread the user resolved locally before submitting shouldn't be
 * published — resolving is how they mark it "no longer worth raising".
 * Mirrors `listThreads` in comments.ts: one query for the threads, one batched
 * query (via `inArray`) for all their comments, grouped back in memory —
 * instead of a per-thread query.
 */
function listPendingThreads(db: StageDb, scopeKey: string, prNumber: number): PendingThread[] {
	const threads = db
		.select()
		.from(commentThread)
		.where(
			and(
				eq(commentThread.scopeKey, scopeKey),
				eq(commentThread.prNumber, prNumber),
				isNull(commentThread.resolvedAt),
			),
		)
		.orderBy(asc(commentThread.createdAt))
		.all();
	if (threads.length === 0) return [];

	const comments = db
		.select()
		.from(comment)
		.where(
			inArray(
				comment.threadId,
				threads.map((t) => t.id),
			),
		)
		.orderBy(asc(comment.createdAt))
		.all();

	const byThread = new Map<string, CommentRow[]>();
	for (const c of comments) {
		const list = byThread.get(c.threadId);
		if (list) list.push(c);
		else byThread.set(c.threadId, [c]);
	}
	return threads.map((thread) => ({ thread, comments: byThread.get(thread.id) ?? [] }));
}

const GH_SIDE: Record<CommentThreadRow["side"], "LEFT" | "RIGHT"> = {
	[DIFF_SIDE.ADDITIONS]: "RIGHT",
	[DIFF_SIDE.DELETIONS]: "LEFT",
};

/**
 * A local thread (root + local replies) becomes one review comment — GitHub's
 * atomic review call has no reply concept, so every local comment body in the
 * thread is concatenated into the single comment GitHub receives.
 */
function toReviewCommentInput(p: PendingThread): ReviewCommentInput {
	const side = GH_SIDE[p.thread.side];
	const input: ReviewCommentInput = {
		path: p.thread.filePath,
		body: p.comments.map((c) => c.body).join("\n\n---\n\n"),
		line: p.thread.endLine,
		side,
	};
	if (p.thread.startLine !== p.thread.endLine) {
		input.start_line = p.thread.startLine;
		input.start_side = side;
	}
	return input;
}
