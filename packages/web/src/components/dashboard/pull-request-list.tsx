import type {
	DashboardPullRequest,
	PullRequestListResponse,
} from "@stagereview/types/pull-requests";
import { Link } from "@tanstack/react-router";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimeAgo } from "@/lib/format";

export interface PullRequestListProps {
	data: PullRequestListResponse | undefined;
	error: unknown;
	isLoading: boolean;
	/** Rows to render — already deduped against higher sections by the caller. */
	rows: DashboardPullRequest[];
	emptyText: string;
}

export function PullRequestList({ data, error, isLoading, rows, emptyText }: PullRequestListProps) {
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
			{rows.map((pr) => (
				<PullRequestRow key={pr.url} pullRequest={pr} />
			))}
		</div>
	);
}

function PullRequestRow({ pullRequest }: { pullRequest: DashboardPullRequest }) {
	const [owner = "", repo = ""] = pullRequest.repository.split("/");
	return (
		<Link
			to="/pr/$owner/$repo/$number"
			params={{ owner, repo, number: String(pullRequest.number) }}
			className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
		>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">{pullRequest.title}</span>
					{pullRequest.isDraft && <Badge variant="outline">Draft</Badge>}
					{!pullRequest.cloned && <Badge variant="outline">Not cloned</Badge>}
				</div>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{pullRequest.repository} #{pullRequest.number} · {pullRequest.author ?? "unknown"} ·{" "}
					{formatTimeAgo(pullRequest.updatedAt)}
				</p>
			</div>
		</Link>
	);
}
