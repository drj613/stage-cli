import { PR_RESOLUTION } from "@stagereview/types/pull-requests";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { ListNotice } from "@/components/dashboard/list-notice";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PrAddress } from "@/lib/use-pr-resolution";
import { useStackResolution } from "@/lib/use-stack-resolution";

export const Route = createFileRoute("/stack/$owner/$repo/$number")({
	component: StackResolver,
});

function StackResolver() {
	const params = Route.useParams();
	// Same remount discipline as the PR resolver: the machine holds per-target
	// state, so an in-place param change must reset it rather than carry over.
	const key = `${params.owner}/${params.repo}/${params.number}`.toLowerCase();
	return <ResolverForStack key={key} params={params} />;
}

function ResolverForStack({ params }: { params: PrAddress }) {
	const navigate = useNavigate();
	const machine = useStackResolution(params);
	const { runId, resolution, chain, resolutionError, generate, generationError } = machine;

	const isStale = resolution?.state === PR_RESOLUTION.STALE;
	useEffect(() => {
		if (runId !== null && !isStale) {
			void navigate({ to: "/runs/$runId", params: { runId }, replace: true });
		}
	}, [runId, isStale, navigate]);

	const label =
		chain === null
			? `${params.owner}/${params.repo} stack`
			: `${params.owner}/${params.repo} #${chain.members[0]?.number}→#${params.number}`;

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-6 lg:p-8">
				{resolutionError ? (
					<ListNotice
						title="Couldn't load this stack."
						details={
							resolutionError instanceof Error
								? resolutionError.message
								: "The Stage server didn't respond."
						}
					/>
				) : resolution === undefined || chain === null ? (
					<div className="space-y-3">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				) : (
					<StackBody
						label={label}
						resolution={resolution}
						generationError={generationError}
						onGenerate={generate}
					/>
				)}
			</main>
		</>
	);
}

function StackBody({
	label,
	resolution,
	generationError,
	onGenerate,
}: {
	label: string;
	resolution: NonNullable<ReturnType<typeof useStackResolution>["resolution"]>;
	generationError: string | null;
	onGenerate: () => void;
}) {
	switch (resolution.state) {
		case PR_RESOLUTION.STALE:
			return (
				<div className="space-y-3 rounded-lg border p-4">
					<p className="text-sm">
						{resolution.movedPrNumbers.map((n) => `#${n}`).join(", ")}{" "}
						{resolution.movedPrNumbers.length === 1 ? "has" : "have"} new commits since this review
						was written.
					</p>
					<div className="flex gap-2">
						<Button onClick={onGenerate}>Regenerate</Button>
						<Button variant="secondary" asChild>
							<Link to="/runs/$runId" params={{ runId: resolution.runId }}>
								Open the existing review
							</Link>
						</Button>
					</div>
				</div>
			);
		case PR_RESOLUTION.FAILED:
			return (
				<div className="space-y-3 rounded-lg border p-4">
					<p className="font-medium text-destructive text-sm">Chapter generation didn't finish.</p>
					{generationError !== null && (
						<p className="break-words text-muted-foreground text-xs">{generationError}</p>
					)}
					<Button onClick={onGenerate}>Retry</Button>
				</div>
			);
		case PR_RESOLUTION.NO_CLONE:
			return (
				<ListNotice
					title="Stage needs a local clone."
					details={`Clone ${resolution.nameWithOwner} and rescan from Settings, then try again.`}
				/>
			);
		default:
			return (
				<div className="flex items-center gap-3 rounded-lg border p-4">
					<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
					<div className="min-w-0 space-y-1">
						<p className="truncate font-medium text-sm">{label}</p>
						<p className="text-muted-foreground text-xs">Chaptering the whole stack…</p>
					</div>
				</div>
			);
	}
}
