import { createFileRoute } from "@tanstack/react-router";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { useActiveJobs } from "@/lib/use-active-jobs";
import { useRepoPulls } from "@/lib/use-browse";

export const Route = createFileRoute("/browse/$owner/$repo")({
	component: BrowseRepoPulls,
});

function BrowseRepoPulls() {
	const { owner, repo } = Route.useParams();
	const query = useRepoPulls(owner, repo);
	const rows = query.data?.available === true ? query.data.pullRequests : [];
	const activeJobs = useActiveJobs();

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-6 lg:p-8">
				<SectionLabel>{`${owner}/${repo}`}</SectionLabel>
				<PullRequestList
					query={query}
					rows={rows}
					emptyText={`No open pull requests in ${owner}/${repo}.`}
					activeJobs={activeJobs}
				/>
			</main>
		</>
	);
}
