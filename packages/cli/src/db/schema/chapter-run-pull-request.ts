import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { chapterRun } from "./chapter-run.js";

/**
 * Which pull requests a run reviews, in stack order. A local run has no rows, a
 * single-PR run one, a stack run one per member. `headSha` is that member's head
 * at generation time — comparing it to the live head is how stack staleness is
 * found, since a push to a lower member never moves the tip.
 */
export const chapterRunPullRequest = sqliteTable(
	"chapter_run_pull_request",
	{
		runId: text()
			.notNull()
			.references(() => chapterRun.id, { onDelete: "cascade" }),
		prNumber: integer().notNull(),
		headSha: text().notNull(),
		/** 0 is the bottom of the stack — the member based on the trunk. */
		position: integer().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.runId, table.prNumber] }),
		unique("chapter_run_pr_position").on(table.runId, table.position),
		index("chapter_run_pr_number_idx").on(table.prNumber),
	],
);

export type ChapterRunPullRequestRow = typeof chapterRunPullRequest.$inferSelect;
