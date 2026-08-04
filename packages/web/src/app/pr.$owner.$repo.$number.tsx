import { PR_RESOLUTION } from "@stagereview/types/pull-requests";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { ListNotice } from "@/components/dashboard/list-notice";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { assertUnreachable, deriveResolverView } from "@/lib/resolver-view";
import { useCloneRoots } from "@/lib/use-clone-roots";
import type { PrAddress, PrResolutionMachine } from "@/lib/use-pr-resolution";
import { prResolutionQueryKey, usePrResolution } from "@/lib/use-pr-resolution";

export const Route = createFileRoute("/pr/$owner/$repo/$number")({
	component: PullRequestResolver,
});

function PullRequestResolver() {
	const params = Route.useParams();
	// Key by the normalized PR address: an in-place param change (PR A → PR B)
	// must remount ResolverForPr so usePrResolution's per-PR state resets — see
	// the hook's doc comment.
	const key = `${params.owner}/${params.repo}/${params.number}`.toLowerCase();
	return <ResolverForPr key={key} params={params} />;
}

function ResolverForPr({ params }: { params: PrAddress }) {
	const navigate = useNavigate();
	const machine = usePrResolution(params);
	const prLabel = `${params.owner}/${params.repo}#${params.number}`;

	// ready resolution or succeeded job → the run, replacing this transient page
	// in history so Back doesn't bounce through it.
	const { runId, resolution } = machine;
	const isStale = resolution?.state === PR_RESOLUTION.STALE;
	useEffect(() => {
		if (runId !== null && !isStale) {
			void navigate({ to: "/runs/$runId", params: { runId }, replace: true });
		}
	}, [runId, isStale, navigate]);

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-6 lg:p-8">
				<ResolverBody machine={machine} prLabel={prLabel} params={params} />
			</main>
		</>
	);
}

function ResolverBody({
	machine,
	prLabel,
	params,
}: {
	machine: PrResolutionMachine;
	prLabel: string;
	params: PrAddress;
}): ReactElement {
	const { resolution, resolutionError, job, generate, generationError } = machine;
	const view = deriveResolverView({ resolution, resolutionError, job, generationError });

	switch (view.tag) {
		case "loading":
			return (
				<div className="space-y-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			);
		case "error":
			return <ListNotice title="Couldn't load this pull request." details={view.message} />;
		case "failed":
			return <FailedCard error={view.error} onRetry={generate} />;
		case "stale":
			return <StaleCard runId={view.runId} onRegenerate={generate} />;
		case "no-clone":
			return <NoCloneCard nameWithOwner={view.nameWithOwner} params={params} />;
		case "progress":
			return <ProgressCard prLabel={prLabel} queuePosition={view.queuePosition} />;
		default:
			return assertUnreachable(view);
	}
}

function StaleCard({ runId, onRegenerate }: { runId: string; onRegenerate: () => void }) {
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<p className="text-sm">This pull request has new commits since the review was written.</p>
			<div className="flex gap-2">
				<Button onClick={onRegenerate}>Regenerate</Button>
				<Button variant="secondary" asChild>
					<Link to="/runs/$runId" params={{ runId }}>
						Open the existing review
					</Link>
				</Button>
			</div>
		</div>
	);
}

function FailedCard({ error, onRetry }: { error: string; onRetry: () => void }) {
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<p className="text-destructive text-sm">{error}</p>
			<Button onClick={onRetry}>
				<RefreshCw className="size-3.5" />
				Retry
			</Button>
		</div>
	);
}

function ProgressCard({
	prLabel,
	queuePosition,
}: {
	prLabel: string;
	queuePosition: number | null;
}) {
	const body = queuePosition !== null ? `Queued — ${queuePosition} ahead` : "Chaptering…";
	return (
		<div className="flex items-center gap-3 rounded-lg border p-4">
			<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
			<div className="min-w-0 space-y-1">
				<p className="truncate font-medium text-sm">{prLabel}</p>
				<p className="text-muted-foreground text-xs">{body}</p>
			</div>
		</div>
	);
}

function NoCloneCard({ nameWithOwner, params }: { nameWithOwner: string; params: PrAddress }) {
	const queryClient = useQueryClient();
	const cloneRoots = useCloneRoots();
	const [copied, setCopied] = useState(false);
	const [rescanning, setRescanning] = useState(false);
	const cloneCommand = `git clone https://github.com/${nameWithOwner}.git`;

	async function handleCopy() {
		await navigator.clipboard.writeText(cloneCommand);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	async function handleRescan() {
		setRescanning(true);
		try {
			await fetch("/api/clone-roots/rescan", { method: "POST" });
			await queryClient.invalidateQueries({ queryKey: prResolutionQueryKey(params) });
		} finally {
			setRescanning(false);
		}
	}

	return (
		<div className="space-y-3 rounded-lg border p-4">
			<p className="text-sm">
				Stage needs a local clone of <code className="font-mono">{nameWithOwner}</code>.
			</p>
			<div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
				<code className="min-w-0 flex-1 truncate font-mono text-xs">{cloneCommand}</code>
				<Button variant="ghost" size="icon-sm" onClick={handleCopy} aria-label="Copy clone command">
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				</Button>
			</div>
			{cloneRoots.data && cloneRoots.data.roots.length > 0 && (
				<div className="space-y-1">
					<p className="text-muted-foreground text-xs">Searched:</p>
					<ul className="space-y-0.5">
						{cloneRoots.data.roots.map((root) => (
							<li key={root.path} className="truncate font-mono text-muted-foreground text-xs">
								{root.path}
							</li>
						))}
					</ul>
				</div>
			)}
			<Button variant="secondary" onClick={handleRescan} disabled={rescanning}>
				<RefreshCw className={rescanning ? "size-3.5 animate-spin" : "size-3.5"} />
				Rescan
			</Button>
		</div>
	);
}
