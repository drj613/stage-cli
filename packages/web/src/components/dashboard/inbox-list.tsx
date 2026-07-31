import type { InboxPullRequest } from "@stagereview/types/inbox";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimeAgo } from "@/lib/format";
import { type ChapterGeneration, useChapterGeneration, useInbox } from "@/lib/use-inbox";

export function InboxList() {
	const { data, isLoading, error } = useInbox();

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
				title="Couldn't load your inbox."
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

	if (data.pullRequests.length === 0) {
		return <ListEmpty>Nothing is waiting on your review.</ListEmpty>;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{data.pullRequests.map((pr) => (
				<InboxRow key={pr.url} pullRequest={pr} />
			))}
		</div>
	);
}

function InboxRow({ pullRequest }: { pullRequest: InboxPullRequest }) {
	const generation = useChapterGeneration();
	const runId = pullRequest.runId ?? generation.runId;

	return (
		<div className="flex items-center gap-3 px-4 py-3.5">
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">{pullRequest.title}</span>
					{pullRequest.isDraft && <Badge variant="outline">Draft</Badge>}
				</div>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{pullRequest.repository} #{pullRequest.number} · {pullRequest.author ?? "unknown"} ·{" "}
					{formatTimeAgo(pullRequest.updatedAt)}
				</p>
				{generation.error !== null && (
					<p className="mt-1 text-destructive text-xs">{generation.error}</p>
				)}
			</div>
			{runId ? (
				<Button asChild size="sm" variant="secondary">
					<Link to="/runs/$runId" params={{ runId }}>
						Open review
						<ArrowRight className="size-3.5" />
					</Link>
				</Button>
			) : (
				<GenerateButton generation={generation} prUrl={pullRequest.url} />
			)}
		</div>
	);
}

function GenerateButton({ generation, prUrl }: { generation: ChapterGeneration; prUrl: string }) {
	if (generation.isRunning) {
		return (
			<Button size="sm" variant="secondary" disabled>
				<Loader2 className="size-3.5 animate-spin" />
				Generating
			</Button>
		);
	}

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button size="sm" variant="secondary">
					Generate chapters
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Generate chapters for this pull request?</AlertDialogTitle>
					<AlertDialogDescription>
						This runs 1 Claude agent session against your usage limits.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={() => generation.start(prUrl)}>Generate</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
