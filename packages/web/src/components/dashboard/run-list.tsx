import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimeAgo } from "@/lib/format";
import { useRuns } from "@/lib/use-runs";

export function RunList() {
	const { data, isLoading, error } = useRuns();

	if (isLoading) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-14 w-full" />
				<Skeleton className="h-14 w-full" />
				<Skeleton className="h-14 w-full" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<ListNotice
				title="Couldn't load your runs."
				details={error instanceof Error ? error.message : "The Stage server didn't respond."}
			/>
		);
	}

	if (data.runs.length === 0) {
		return <ListEmpty>No runs yet. Generate chapters for a pull request to get started.</ListEmpty>;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{data.runs.map((run) => (
				<Link
					key={run.id}
					to="/runs/$runId"
					params={{ runId: run.id }}
					className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
				>
					<BookOpen className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate font-medium text-sm">{run.repoName}</span>
					{run.prNumber !== null && <Badge variant="outline">#{run.prNumber}</Badge>}
					<span className="shrink-0 text-muted-foreground text-xs">
						{run.chapterCount} {run.chapterCount === 1 ? "chapter" : "chapters"}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{formatTimeAgo(run.generatedAt)}
					</span>
				</Link>
			))}
		</div>
	);
}
