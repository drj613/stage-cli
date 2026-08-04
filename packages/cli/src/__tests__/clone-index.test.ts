import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneIndex } from "../clones/clone-index.js";

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-index-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A fake clone: a directory holding .git/config with the given origin url. */
async function makeRepo(rel: string, originUrl: string): Promise<string> {
	const dir = path.join(root, rel);
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(
		path.join(dir, ".git", "config"),
		`[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
	);
	return dir;
}

describe("CloneIndex.scan", () => {
	it("maps origin urls to lowercased owner/repo keys", async () => {
		const dir = await makeRepo("Acme/API", "git@github.com:Acme/API.git");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("acme/api")).toBe(dir);
		expect(index.pathFor("Acme/API")).toBe(dir);
	});

	it("merges mixed-case remote urls into one key and one owner", async () => {
		await makeRepo("a", "https://github.com/Acme/one.git");
		await makeRepo("b", "https://github.com/acme/two");
		const index = CloneIndex.scan([root]);
		expect(index.owners()).toEqual([{ owner: "acme", cloneCount: 2 }]);
	});

	it("does not descend into a repo looking for nested repos", async () => {
		const outer = await makeRepo("outer", "https://github.com/o/outer");
		await makeRepo("outer/vendor/inner", "https://github.com/o/inner");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("o/outer")).toBe(outer);
		expect(index.pathFor("o/inner")).toBeNull();
	});

	it("skips node_modules and dot-directories", async () => {
		await makeRepo("node_modules/dep", "https://github.com/o/dep");
		await makeRepo(".cache/repo", "https://github.com/o/cached");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("o/dep")).toBeNull();
		expect(index.pathFor("o/cached")).toBeNull();
	});

	it("skips repos deeper than the depth bound", async () => {
		await makeRepo("a/b/c/d/deep", "https://github.com/o/deep");
		expect(CloneIndex.scan([root]).pathFor("o/deep")).toBeNull();
	});

	it("skips non-GitHub remotes", async () => {
		await makeRepo("gl", "git@gitlab.com:o/r.git");
		expect(CloneIndex.scan([root]).owners()).toEqual([]);
	});

	it("skips bare clones (no .git working-tree entry)", async () => {
		const bare = path.join(root, "bare.git");
		await fs.mkdir(bare, { recursive: true });
		await fs.writeFile(
			path.join(bare, "config"),
			`[core]\n\tbare = true\n[remote "origin"]\n\turl = https://github.com/o/bare\n`,
		);
		expect(CloneIndex.scan([root]).pathFor("o/bare")).toBeNull();
	});

	it("skips configs whose origin url is only reachable via include.path", async () => {
		const dir = path.join(root, "included");
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await fs.writeFile(path.join(dir, ".git", "config"), `[include]\n\tpath = ../extra\n`);
		expect(CloneIndex.scan([root]).owners()).toEqual([]);
	});
});
