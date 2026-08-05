import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { heredocDelimiters } from "../generation/bash-commands.js";
import { AGENT_OUTPUT_BASENAME, AGENT_OUTPUT_DELIMITER } from "../generation/phase-tracker.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKILL = path.join(REPO_ROOT, "skills/stage-chapters/SKILL.md");
const BASH_BLOCK = /```bash\n([\s\S]*?)```/g;

/** Step 5's block is the one that mints the output path with `mktemp`. */
function agentOutputBlock(): string {
	const blocks = [...readFileSync(SKILL, "utf8").matchAll(BASH_BLOCK)]
		.map(([, body]) => body ?? "")
		.filter((body) => body.includes("mktemp"));
	expect(blocks).toHaveLength(1);
	return blocks[0] ?? "";
}

describe("stage-chapters skill contract", () => {
	it("writes the chapter JSON through the delimiter the tracker watches for", () => {
		expect(heredocDelimiters(agentOutputBlock())).toContain(AGENT_OUTPUT_DELIMITER);
	});

	it("mints an output path whose basename the tracker recognizes", () => {
		const template = /mktemp\s+"[^"]*\/([^"/]+)"/.exec(agentOutputBlock());
		expect(template?.[1]).toMatch(AGENT_OUTPUT_BASENAME);
	});
});
