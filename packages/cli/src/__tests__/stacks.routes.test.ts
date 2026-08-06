import { afterEach, describe, expect, it } from "vitest";
import { type StackRouteDeps, stackRoutes } from "../routes/stacks.js";
import { type ServerHandle, startServer } from "../server.js";
import { getJson } from "./runs-route-harness.js";

const handles: ServerHandle[] = [];
afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
});

type ListPullRequests = StackRouteDeps["listPullRequests"];

async function start(listPullRequests: ListPullRequests): Promise<number> {
	const handle = await startServer({ routes: stackRoutes({ listPullRequests }) });
	handles.push(handle);
	return handle.port;
}

const row = (number: number, headRefName: string, baseRefName: string) => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/acme/app/pull/${number}`,
	isDraft: false,
	isCrossRepository: false,
	headRefName,
	baseRefName,
});

describe("GET /api/stacks/:owner/:repo", () => {
	it("returns the chain graph for the repo", async () => {
		const port = await start(async () => ({
			prs: [row(12, "a", "main"), row(13, "b", "a")],
			capped: false,
		}));
		const res = await getJson(port, "/api/stacks/acme/app");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			available: true,
			graph: {
				complete: true,
				chains: [
					{
						members: [
							{ number: 12, title: "PR 12", url: row(12, "a", "main").url, isDraft: false },
							{ number: 13, title: "PR 13", url: row(13, "b", "a").url, isDraft: false },
						],
					},
				],
			},
		});
	});

	it("passes the repo slug through to gh", async () => {
		const seen: string[] = [];
		const port = await start(async (nameWithOwner) => {
			seen.push(nameWithOwner);
			return { prs: [], capped: false };
		});
		await getJson(port, "/api/stacks/acme/app");
		expect(seen).toEqual(["acme/app"]);
	});

	it("reports unavailable when gh fails, rather than erroring the list", async () => {
		const port = await start(async () => {
			throw new Error("gh: not authenticated");
		});
		const res = await getJson(port, "/api/stacks/acme/app");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ available: false });
	});

	it("marks a capped result incomplete so the UI hides badges", async () => {
		const port = await start(async () => ({
			prs: [row(12, "a", "main"), row(13, "b", "a")],
			capped: true,
		}));
		const res = await getJson(port, "/api/stacks/acme/app");
		expect(res.body).toMatchObject({ available: true, graph: { complete: false } });
	});
});
