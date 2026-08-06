import { z } from "zod";

const runIdSchema = z.string().uuid();

/**
 * The runId the agent was told to print as its last line. Throws when the agent
 * ended on anything else — a missing or malformed runId means the run didn't
 * land in the database, so failing loudly beats surfacing a bogus link.
 *
 * The offending line is deliberately NOT quoted back: under stream-json it is
 * the tail of the agent's final prose, which can contain source or file
 * contents.
 */
export function parseRunnerOutput(stdout: string): string {
	const lines = stdout.trim().split("\n");
	const lastLine = lines[lines.length - 1]?.trim() ?? "";
	const parsed = runIdSchema.safeParse(lastLine);
	if (!parsed.success) throw new Error("Agent did not return a valid runId.");
	return parsed.data;
}
