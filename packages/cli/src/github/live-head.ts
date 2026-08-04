import { z } from "zod";
import { gh } from "./exec.js";

const HeadSchema = z.object({ headRefOid: z.string() });

/** Current head commit of a PR, via one `gh pr view --repo` call. Throws on gh failure. */
export async function liveHeadSha(nameWithOwner: string, prNumber: number): Promise<string> {
	const stdout = await gh(
		["pr", "view", String(prNumber), "--repo", nameWithOwner, "--json", "headRefOid"],
		process.cwd(),
	);
	return HeadSchema.parse(JSON.parse(stdout)).headRefOid;
}
