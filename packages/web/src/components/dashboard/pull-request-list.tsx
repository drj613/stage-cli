import type { GenerationJob } from "@stagereview/types/generation";
import type {
	DashboardPullRequest,
	PullRequestListResponse,
} from "@stagereview/types/pull-requests";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import { StackBadge } from "@/components/shared/stack-badge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { type ChainPosition, chainsContaining } from "@/lib/chain-position";
import { formatTimeAgo } from "@/lib/format";
import { formatJobBadge } from "@/lib/generation-labels";
import { splitNameWithOwner } from "@/lib/split-name-with-owner";
import { findJobForPr } from "@/lib/use-active-jobs";
import { useStacks } from "@/lib/use-stacks";

export interface PullRequestListProps {
	query: Pick<UseQueryResult<PullRequestListResponse>, "data" | "error" | "isLoading">;
	/** Rows to render — already deduped against higher sections by the caller. */
	rows: DashboardPullRequest[];
	emptyText: string;
	/** Jobs in flight, for badging rows that are mid-generation. */
	activeJobs: readonly GenerationJob[];
}

export function PullRequestList({ query, rows, emptyText, activeJobs }: PullRequestListProps) {
	const { data, error, isLoading } = query;
	// Fetched per distinct repo once the rows exist, so a slow `gh` call never
	// holds up the list — stack badges just appear a beat later.
	const stacks = useStacks(rows.map((row) => row.repository));

	if (isLoading) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<ListNotice
				title="Couldn't load pull requests."
				details={error instanceof Error ? error.message : "The Stage server didn't respond."}
			/>
		);
	}

	if (!data.available) {
		return (
			<ListNotice
				title="Couldn't reach GitHub."
				details={
					<>
						<p>{data.reason}</p>
						<p>
							You may need to run <code>gh auth login</code>.
						</p>
					</>
				}
			/>
		);
	}

	if (rows.length === 0) {
		return <ListEmpty>{emptyText}</ListEmpty>;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{rows.map((pr) => {
				const graph = stacks.get(pr.repository);
				return (
					<PullRequestRow
						key={pr.url}
						pullRequest={pr}
						job={findJobForPr(activeJobs, pr.url)}
						chains={graph ? chainsContaining(graph, pr.number) : []}
					/>
				);
			})}
		</div>
	);
}

function PullRequestRow({
	pullRequest,
	job,
	chains,
}: {
	pullRequest: DashboardPullRequest;
	/** The row's job from the active set, so it is never in a terminal status. */
	job: GenerationJob | null;
	/** Every stack chain this PR sits in. Empty when it is not stacked. */
	chains: ChainPosition[];
}) {
	const { owner, repo } = splitNameWithOwner(pullRequest.repository);
	return (
		// The row is a container with a stretched link rather than one big anchor:
		// the stack badge opens a popover, and a button nested inside an anchor is
		// invalid markup and unreachable by keyboard.
		<div className="relative flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50">
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<Link
						to="/pr/$owner/$repo/$number"
						params={{ owner, repo, number: String(pullRequest.number) }}
						className="truncate font-medium text-sm after:absolute after:inset-0 after:content-['']"
					>
						{pullRequest.title}
					</Link>
					{pullRequest.isDraft && <Badge variant="outline">Draft</Badge>}
					{!pullRequest.cloned && <Badge variant="outline">Not cloned</Badge>}
					{chains.length > 0 && (
						<span className="relative z-10">
							<StackBadge
								nameWithOwner={pullRequest.repository}
								prNumber={pullRequest.number}
								chains={chains}
							/>
						</span>
					)}
					{job !== null ? (
						<Badge variant="outline">
							<Loader2 aria-hidden className="animate-spin" />
							{formatJobBadge(job)}
						</Badge>
					) : (
						pullRequest.runId !== null && <Badge variant="outline">Chaptered</Badge>
					)}
				</div>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{pullRequest.repository} #{pullRequest.number} · {pullRequest.author ?? "unknown"} ·{" "}
					{formatTimeAgo(pullRequest.updatedAt)}
				</p>
			</div>
		</div>
	);
}
