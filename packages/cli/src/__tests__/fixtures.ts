import fs from "node:fs/promises";
import path from "node:path";
import type { RepoContext } from "../git.js";
import type { ChaptersFile } from "../schema.js";

const SHA = {
	base: "1111111111111111111111111111111111111111",
	head: "2222222222222222222222222222222222222222",
	mergeBase: "3333333333333333333333333333333333333333",
} as const;

export function makeRepoContext(over: Partial<RepoContext> = {}): RepoContext {
	return { root: "/repo", originUrl: null, ...over };
}

/**
 * Writes a fake `.git/config` under `dir` naming `originUrl` as the `origin`
 * remote — enough for `CloneIndex.scan` (and anything else that reads
 * `.git/config` directly) to recognize `dir` as a clone of that repo.
 */
export async function writeCloneConfig(dir: string, originUrl: string): Promise<void> {
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(
		path.join(dir, ".git", "config"),
		`[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
	);
}

export function makeFixture(over: Partial<ChaptersFile> = {}): ChaptersFile {
	return {
		scope: {
			kind: "committed",
			baseSha: SHA.base,
			headSha: SHA.head,
			mergeBaseSha: SHA.mergeBase,
		},
		chapters: [
			{
				id: "chapter-0",
				order: 1,
				title: "Wire org ID through the API layer",
				summary: "Threads orgId through request handlers so tenant queries scope correctly.",
				hunkRefs: [{ filePath: "src/foo.ts", oldStart: 1 }],
				keyChanges: [
					{
						content: "Should orgId fall back to the user's primary org?",
						lineRefs: [{ filePath: "src/foo.ts", side: "additions", startLine: 5, endLine: 10 }],
					},
				],
			},
		],
		generatedAt: "2026-04-26T12:00:00.000Z",
		...over,
	};
}
