import fs from "node:fs";
import path from "node:path";
import type { StageDb } from "../db/client.js";
import { RunIndex } from "../runs/run-index.js";
import { CloneIndex, type CloneOwner } from "./clone-index.js";
import { listCloneRoots } from "./clone-root-store.js";

export interface RescanSummary {
	repoCount: number;
	ownerCount: number;
}

/**
 * Owns the configured search roots and the current scan result. One instance
 * per server process, built at startup and injected into routes. The single
 * path-resolution entry point for both PR resolution and POST /api/generate.
 *
 * Both `CloneIndex` and `RunIndex` are built once and cached, refreshed
 * together only by `rescan()`. `RunIndex` walks every `chapter_run` row ever
 * written across every repo in the (global) database — rebuilding it on
 * every `resolveRepoRoot` call, as the naive version of this class did,
 * means a PR list of N rows does a full table scan N times. The trade-off:
 * a clone Stage learns about between rescans — e.g. the user runs
 * `stagereview show` or `import` in a repo outside every configured clone
 * root while `start` is running — won't resolve until the next rescan,
 * where it used to resolve on the very next request. That's acceptable
 * because a rescan is always one click (or one `POST /api/clone-roots/rescan`)
 * away, and the generate route's 422 already tells the user to add a root or
 * rescan when resolution fails.
 */
export class CloneRegistry {
	private index = CloneIndex.empty();
	private runIndex = RunIndex.empty();

	private constructor(private readonly db: StageDb) {}

	static create(db: StageDb): CloneRegistry {
		const registry = new CloneRegistry(db);
		registry.rescan();
		return registry;
	}

	rescan(): RescanSummary {
		const roots = listCloneRoots(this.db).map((row) => row.path);
		this.index = CloneIndex.scan(roots);
		this.runIndex = RunIndex.load(this.db);
		return { repoCount: this.index.size, ownerCount: this.index.owners().length };
	}

	owners(): CloneOwner[] {
		return this.index.owners();
	}

	isCloned(nameWithOwner: string): boolean {
		return this.resolveRepoRoot(nameWithOwner) !== null;
	}

	/**
	 * A usable local clone for the repo, or null. Tries the clone index, falls
	 * back to RunIndex — each candidate is validated independently (still holds
	 * a `.git` entry) before being returned, and a stale candidate from one
	 * source falls through to the next rather than suppressing it. Trusting an
	 * unvalidated path is how a moved clone becomes a raw ENOENT inside a
	 * spawned agent.
	 */
	resolveRepoRoot(nameWithOwner: string): string | null {
		const candidates = [
			this.index.pathFor(nameWithOwner),
			this.runIndex.repoRootFor(nameWithOwner),
		];
		for (const candidate of candidates) {
			if (candidate !== null && fs.existsSync(path.join(candidate, ".git"))) return candidate;
		}
		return null;
	}
}
