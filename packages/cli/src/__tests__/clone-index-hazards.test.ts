import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloneIndex } from "../clones/clone-index.js";
import { writeCloneConfig } from "./fixtures.js";

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
	await writeCloneConfig(dir, originUrl);
	return dir;
}

describe("CloneIndex.scan hazards", () => {
	it("resolves a linked worktree via the gitdir → commondir hop", async () => {
		// The main clone lives OUTSIDE the scanned root — the only way o/wt can
		// resolve is through the linked worktree's .git file. (A main clone inside
		// the root would make this test pass even with the hop completely broken.)
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stage-wt-main-"));
		try {
			const main = path.join(outside, "main");
			await fs.mkdir(path.join(main, ".git"), { recursive: true });
			await fs.writeFile(
				path.join(main, ".git", "config"),
				`[remote "origin"]\n\turl = https://github.com/o/wt\n`,
			);
			const wtGitDir = path.join(main, ".git", "worktrees", "feature");
			await fs.mkdir(wtGitDir, { recursive: true });
			await fs.writeFile(path.join(wtGitDir, "commondir"), "../..\n");
			const linked = path.join(root, "linked");
			await fs.mkdir(linked);
			await fs.writeFile(path.join(linked, ".git"), `gitdir: ${wtGitDir}\n`);
			const index = CloneIndex.scan([root]);
			expect(index.pathFor("o/wt")).toBe(linked);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("does not descend into a repo whose origin is unreadable", async () => {
		// A repo with an include.path-only config is still a repo — the scanner
		// must not descend into it and index vendored clones inside.
		const dir = path.join(root, "opaque");
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await fs.writeFile(path.join(dir, ".git", "config"), `[include]\n\tpath = ../extra\n`);
		await makeRepo("opaque/vendor/inner", "https://github.com/o/inner");
		expect(CloneIndex.scan([root]).pathFor("o/inner")).toBeNull();
	});

	it("terminates on symlink loops", async () => {
		const a = path.join(root, "a");
		await fs.mkdir(a);
		await fs.symlink(root, path.join(a, "loop"), "dir");
		expect(() => CloneIndex.scan([root])).not.toThrow();
	});

	it("skips unreadable directories instead of aborting", async () => {
		const locked = path.join(root, "locked");
		await fs.mkdir(locked);
		const ok = await makeRepo("ok", "https://github.com/o/ok");
		await fs.chmod(locked, 0o000);
		try {
			expect(CloneIndex.scan([root]).pathFor("o/ok")).toBe(ok);
		} finally {
			await fs.chmod(locked, 0o755);
		}
	});

	it("warns and returns an empty index when a configured root does not exist", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const missing = path.join(root, "does-not-exist");
			const index = CloneIndex.scan([missing]);
			expect(index.owners()).toEqual([]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(missing));
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn about permission errors on directories nested below a root", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const locked = path.join(root, "locked");
			await fs.mkdir(locked);
			await fs.chmod(locked, 0o000);
			try {
				CloneIndex.scan([root]);
			} finally {
				await fs.chmod(locked, 0o755);
			}
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
