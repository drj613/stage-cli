import type { BrowseRepo, OwnerReposResponse } from "@stagereview/types/browse";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimeAgo } from "@/lib/format";
import { splitNameWithOwner } from "@/lib/split-name-with-owner";
import { useOwnerRepos } from "@/lib/use-browse";

export const Route = createFileRoute("/browse/$owner/")({
	component: BrowseOwnerRepos,
});

function BrowseOwnerRepos() {
	const { owner } = Route.useParams();
	const { data, error, isLoading } = useOwnerRepos(owner);

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-6 lg:p-8">
				<SectionLabel>{owner}</SectionLabel>
				<ReposBody owner={owner} data={data} error={error} isLoading={isLoading} />
			</main>
		</>
	);
}

function ReposBody({
	owner,
	data,
	error,
	isLoading,
}: {
	owner: string;
	data: OwnerReposResponse | undefined;
	error: unknown;
	isLoading: boolean;
}) {
	if (isLoading) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-14 w-full" />
				<Skeleton className="h-14 w-full" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<ListNotice
				title="Couldn't load repositories."
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

	const repos = data.repos;
	if (repos.length === 0) {
		return <ListEmpty>{`No repositories found for ${owner}.`}</ListEmpty>;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{repos.map((repo) => (
				<RepoRow key={repo.nameWithOwner} owner={owner} repo={repo} />
			))}
		</div>
	);
}

function RepoRow({ owner, repo }: { owner: string; repo: BrowseRepo }) {
	const { repo: repoName } = splitNameWithOwner(repo.nameWithOwner);
	return (
		<Link
			to="/browse/$owner/$repo"
			params={{ owner, repo: repoName }}
			className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
		>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">{repoName}</span>
					{!repo.cloned && <Badge variant="outline">Not cloned</Badge>}
				</div>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{repo.description ? `${repo.description} · ` : ""}
					{formatTimeAgo(repo.updatedAt)}
				</p>
			</div>
		</Link>
	);
}
