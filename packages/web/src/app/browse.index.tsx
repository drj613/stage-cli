import type { OwnersResponse } from "@stagereview/types/browse";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListNotice } from "@/components/dashboard/list-notice";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useOwners } from "@/lib/use-browse";

export const Route = createFileRoute("/browse/")({
	component: BrowseOwners,
});

function BrowseOwners() {
	const { data, error, isLoading } = useOwners();

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-6 lg:p-8">
				<SectionLabel>Browse</SectionLabel>
				<OwnersBody data={data} error={error} isLoading={isLoading} />
			</main>
		</>
	);
}

function OwnersBody({
	data,
	error,
	isLoading,
}: {
	data: OwnersResponse | undefined;
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
				title="Couldn't load owners."
				details={error instanceof Error ? error.message : "The Stage server didn't respond."}
			/>
		);
	}

	if (data.owners.length === 0) {
		return <OnboardingCard />;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{data.owners.map((owner) => (
				<Link
					key={owner.owner}
					to="/browse/$owner"
					params={{ owner: owner.owner }}
					className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
				>
					<div className="min-w-0 flex-1">
						<span className="truncate font-medium text-sm">{owner.owner}</span>
						<p className="mt-1 truncate text-muted-foreground text-xs">
							{owner.cloneCount} {owner.cloneCount === 1 ? "clone" : "clones"}
						</p>
					</div>
				</Link>
			))}
		</div>
	);
}
