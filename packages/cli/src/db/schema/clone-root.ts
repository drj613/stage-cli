import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A directory Stage scans for local git clones. One row per configured search root. */
export const cloneRoot = sqliteTable("clone_root", {
	path: text().primaryKey(),
	addedAt: integer({ mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.notNull(),
});

export type CloneRootRow = typeof cloneRoot.$inferSelect;
