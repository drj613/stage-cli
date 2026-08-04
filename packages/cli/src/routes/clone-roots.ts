import type { ServerResponse } from "node:http";
import type { CloneRootsResponse, RescanResponse } from "@stagereview/types/clone-roots";
import { z } from "zod";
import type { CloneRegistry } from "../clones/clone-registry.js";
import { addCloneRoot, listCloneRoots, removeCloneRoot } from "../clones/clone-root-store.js";
import type { StageDb } from "../db/client.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

const RootInput = z.object({ path: z.string().min(1) });

/** CRUD for the configured clone-search roots, plus an explicit rescan trigger. */
export function cloneRootRoutes(db: StageDb, registry: CloneRegistry): Route[] {
	function respondWithRoots(res: ServerResponse): void {
		writeJson(res, 200, {
			roots: listCloneRoots(db).map((r) => ({ path: r.path, addedAt: r.addedAt.toISOString() })),
		} satisfies CloneRootsResponse);
	}

	return [
		{
			method: "GET",
			pattern: "/api/clone-roots",
			handler: (_req, res) => respondWithRoots(res),
		},
		{
			method: "POST",
			pattern: "/api/clone-roots",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, RootInput);
				if (!body) return;
				try {
					addCloneRoot(db, body.path);
				} catch (err) {
					writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
					return;
				}
				registry.rescan(); // a just-added root should be usable without a second click
				respondWithRoots(res);
			},
		},
		{
			method: "DELETE",
			pattern: "/api/clone-roots",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, RootInput);
				if (!body) return;
				removeCloneRoot(db, body.path);
				registry.rescan();
				respondWithRoots(res);
			},
		},
		{
			method: "POST",
			pattern: "/api/clone-roots/rescan",
			handler: (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				writeJson(res, 200, registry.rescan() satisfies RescanResponse);
			},
		},
	];
}
