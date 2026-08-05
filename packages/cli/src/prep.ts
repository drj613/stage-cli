import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hunk, PullRequestFile } from "@stagereview/types/parsed-diff";
import { formatHunkDiffWithLineNumbers } from "./format-diff.js";
import { getCommitMessages } from "./git.js";
import { resolveFilteredDiff } from "./resolve-diff.js";
import type { DiffScopeOptions } from "./scope.js";

function formatHunkForPrompt(file: PullRequestFile, hunk: Hunk): string {
	return `=== File: ${file.path} (${file.status}) | filePath: "${file.path}", oldStart: ${hunk.oldStart} ===
=== Hunk @${hunk.oldStart}: ${hunk.header} ===
${formatHunkDiffWithLineNumbers(hunk)}`;
}

export async function runPrep(options: DiffScopeOptions): Promise<string> {
	const { scope, mergeBaseSha, files } = await resolveFilteredDiff(options);

	const formattedHunks = files
		.flatMap((file) => file.hunks.map((hunk) => formatHunkForPrompt(file, hunk)))
		.join("\n\n");

	const commitMessages = getCommitMessages(options.cwd, mergeBaseSha, scope.headSha);

	const sections = ["=== COMMIT MESSAGES ===", commitMessages, "", "=== HUNKS ===", formattedHunks];

	const filePath = path.join(tmpdir(), `stage-prep-${Date.now()}.txt`);
	writeFileSync(filePath, sections.join("\n"), "utf8");

	return filePath;
}
