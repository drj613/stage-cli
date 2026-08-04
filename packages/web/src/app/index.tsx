import { PR_FILTER } from "@stagereview/types/pull-requests";
import { createFileRoute } from "@tanstack/react-router";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { RunList } from "@/components/dashboard/run-list";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { dedupeAgainst } from "@/lib/dedupe-pull-requests";
import { usePullRequests } from "@/lib/use-pull-requests";

export const Route = createFileRoute("/")({
	component: Dashboard,
});

function Dashboard() {
	const review = usePullRequests(PR_FILTER.REVIEW_REQUESTED);
	const assigned = usePullRequests(PR_FILTER.ASSIGNEE);
	const authored = usePullRequests(PR_FILTER.AUTHOR);

	const reviewRows = review.data?.available === true ? review.data.pullRequests : null;
	const assignedRows = assigned.data?.available === true ? assigned.data.pullRequests : null;
	const authoredRows = authored.data?.available === true ? authored.data.pullRequests : null;

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-10 p-6 lg:p-8">
				<section className="space-y-3">
					<SectionLabel>Waiting on your review</SectionLabel>
					<PullRequestList
						data={review.data}
						error={review.error}
						isLoading={review.isLoading}
						rows={reviewRows ?? []}
						emptyText="Nothing is waiting on your review."
					/>
				</section>
				<section className="space-y-3">
					<SectionLabel>Assigned to you</SectionLabel>
					<PullRequestList
						data={assigned.data}
						error={assigned.error}
						isLoading={assigned.isLoading}
						rows={dedupeAgainst(assignedRows ?? [], [reviewRows])}
						emptyText="Nothing is assigned to you."
					/>
				</section>
				<section className="space-y-3">
					<SectionLabel>Your open PRs</SectionLabel>
					<PullRequestList
						data={authored.data}
						error={authored.error}
						isLoading={authored.isLoading}
						rows={dedupeAgainst(authoredRows ?? [], [reviewRows, assignedRows])}
						emptyText="You have no open pull requests."
					/>
				</section>
				<section className="space-y-3">
					<SectionLabel>Recent runs</SectionLabel>
					<RunList />
				</section>
			</main>
		</>
	);
}
