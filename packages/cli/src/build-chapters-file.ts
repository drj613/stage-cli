import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildOtherChangesChapter } from "./build-other-changes.js";
import { type ResolvedFilteredDiff, resolveFilteredDiff } from "./resolve-diff.js";
import type { RunMember } from "./runs/run-members.js";
import {
	type AgentOutput,
	AgentOutputSchema,
	type Chapter,
	type ChaptersFile,
	ChaptersFileSchema,
	DIFF_SIDE,
} from "./schema.js";
import { type DiffScopeOptions, membersFromRefs } from "./scope.js";

export interface BuiltChaptersFile {
	chaptersFile: ChaptersFile;
	/** The reviewed PRs in stack order, bottom first. Empty for a local-ref scope. */
	members: RunMember[];
}

export async function buildChaptersFile(
	jsonPath: string,
	options: DiffScopeOptions,
): Promise<BuiltChaptersFile> {
	const absolute = path.resolve(jsonPath);
	const raw = readFileSync(absolute, "utf8");
	const parsed = JSON.parse(raw) as unknown;

	// A fully-formed chapters file carries its own scope, so the diff isn't
	// recomputed from the working tree or PR. `--pr` still records which PRs the
	// run targets (so the UI resolves the right one) — no diff is needed here,
	// since the scope already comes from the file, but a stack's member order is
	// still established by ancestry rather than trusted from the command line.
	const fullResult = ChaptersFileSchema.safeParse(parsed);
	if (fullResult.success) {
		return {
			chaptersFile: fullResult.data,
			members: await membersFromRefs(options.cwd, options.prRefs ?? []),
		};
	}

	const agentResult = AgentOutputSchema.safeParse(parsed);
	if (agentResult.success) {
		const diff = await resolveFilteredDiff(options);
		return { chaptersFile: assembleChaptersFile(agentResult.data, diff), members: diff.members };
	}

	// Only a full chapters file carries `scope`, so its presence tells us which
	// schema the author was aiming at. The agent is asked for the agent shape, and
	// telling it about `scope` and `generatedAt` — fields it never emits — sends it
	// chasing the wrong bug.
	throw carriesScope(parsed) ? fullResult.error : agentResult.error;
}

function carriesScope(parsed: unknown): boolean {
	const object = z.record(z.string(), z.unknown()).safeParse(parsed);
	return object.success && "scope" in object.data;
}

function assembleChaptersFile(agentOutput: AgentOutput, diff: ResolvedFilteredDiff): ChaptersFile {
	const { scope, allFiles, files: filteredFiles, excludedByPath } = diff;

	validateHunkCoverage(filteredFiles, agentOutput.chapters);
	const sanitized = sanitizeLineRefs(agentOutput.chapters, filteredFiles);

	const chapters = [...sanitized];
	const otherChanges = buildOtherChangesChapter(allFiles, excludedByPath);
	if (otherChanges) {
		chapters.push({ ...otherChanges, order: chapters.length + 1 });
	}

	return {
		scope,
		chapters,
		prologue: agentOutput.prologue,
		generatedAt: new Date().toISOString(),
	};
}

function validateHunkCoverage(
	filteredFiles: { path: string; hunks: { oldStart: number }[] }[],
	chapters: Chapter[],
): void {
	const expected = new Map<string, Set<number>>();
	for (const file of filteredFiles) {
		const starts = new Set<number>();
		for (const hunk of file.hunks) {
			starts.add(hunk.oldStart);
		}
		if (starts.size > 0) {
			expected.set(file.path, starts);
		}
	}

	const actual = new Map<string, Map<number, number>>();
	const duplicates: string[] = [];
	for (const chapter of chapters) {
		for (const ref of chapter.hunkRefs) {
			let starts = actual.get(ref.filePath);
			if (!starts) {
				starts = new Map();
				actual.set(ref.filePath, starts);
			}
			const count = starts.get(ref.oldStart) ?? 0;
			if (count > 0) {
				duplicates.push(`  filePath: "${ref.filePath}", oldStart: ${ref.oldStart}`);
			}
			starts.set(ref.oldStart, count + 1);
		}
	}

	const missing: string[] = [];
	for (const [filePath, starts] of expected) {
		const actualStarts = actual.get(filePath);
		for (const oldStart of starts) {
			if (!actualStarts?.has(oldStart)) {
				missing.push(`  filePath: "${filePath}", oldStart: ${oldStart}`);
			}
		}
	}

	const extra: string[] = [];
	for (const [filePath, starts] of actual) {
		const expectedStarts = expected.get(filePath);
		for (const oldStart of starts.keys()) {
			if (!expectedStarts?.has(oldStart)) {
				extra.push(`  filePath: "${filePath}", oldStart: ${oldStart}`);
			}
		}
	}

	if (missing.length === 0 && extra.length === 0 && duplicates.length === 0) return;

	const lines = ["Hunk coverage validation failed."];
	if (missing.length > 0) {
		lines.push(`Missing hunks (${missing.length}) — not assigned to any chapter:`);
		lines.push(...missing);
	}
	if (extra.length > 0) {
		lines.push(`Extra hunks (${extra.length}) — not found in the diff:`);
		lines.push(...extra);
	}
	if (duplicates.length > 0) {
		lines.push(`Duplicate hunks (${duplicates.length}) — assigned to multiple chapters:`);
		lines.push(...duplicates);
	}
	throw new Error(lines.join("\n"));
}

interface HunkSpan {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

function sanitizeLineRefs(
	chapters: Chapter[],
	filteredFiles: {
		path: string;
		hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[];
	}[],
): Chapter[] {
	const hunkSpanIndex = new Map<string, Map<number, HunkSpan>>();
	for (const file of filteredFiles) {
		const spans = new Map<number, HunkSpan>();
		for (const hunk of file.hunks) {
			spans.set(hunk.oldStart, {
				oldStart: hunk.oldStart,
				oldEnd: hunk.oldStart + hunk.oldLines - 1,
				newStart: hunk.newStart,
				newEnd: hunk.newStart + hunk.newLines - 1,
			});
		}
		if (spans.size > 0) {
			hunkSpanIndex.set(file.path, spans);
		}
	}

	return chapters.map((chapter) => {
		const chapterSpans = new Map<string, HunkSpan[]>();
		for (const ref of chapter.hunkRefs) {
			const fileSpans = hunkSpanIndex.get(ref.filePath);
			if (!fileSpans) continue;
			const span = fileSpans.get(ref.oldStart);
			if (!span) continue;
			let spans = chapterSpans.get(ref.filePath);
			if (!spans) {
				spans = [];
				chapterSpans.set(ref.filePath, spans);
			}
			spans.push(span);
		}

		const keyChanges = chapter.keyChanges.flatMap((kc) => {
			const validRefs = kc.lineRefs.filter((ref) => {
				if (ref.startLine < 1 || ref.endLine < 1) return false;
				if (ref.startLine > ref.endLine) return false;

				const spans = chapterSpans.get(ref.filePath);
				if (!spans) return false;

				return spans.some((span) => {
					const [rangeStart, rangeEnd] =
						ref.side === DIFF_SIDE.ADDITIONS
							? [span.newStart, span.newEnd]
							: [span.oldStart, span.oldEnd];
					if (rangeStart > rangeEnd) return false;
					return ref.startLine >= rangeStart && ref.endLine <= rangeEnd;
				});
			});

			const uniqueRefs: typeof validRefs = [];
			for (const ref of validRefs) {
				const isDuplicate = uniqueRefs.some(
					(existing) =>
						existing.filePath === ref.filePath &&
						existing.side === ref.side &&
						existing.startLine === ref.startLine &&
						existing.endLine === ref.endLine,
				);
				if (!isDuplicate) uniqueRefs.push(ref);
			}

			if (uniqueRefs.length === 0) return [];
			return [{ content: kc.content, lineRefs: uniqueRefs }];
		});

		return { ...chapter, keyChanges };
	});
}
