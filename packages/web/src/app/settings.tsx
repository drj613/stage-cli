import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ListEmpty } from "@/components/dashboard/list-notice";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useAddCloneRoot,
	useCloneRoots,
	useRemoveCloneRoot,
	useRescan,
} from "@/lib/use-clone-roots";

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
});

function SettingsPage() {
	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-2xl flex-1 space-y-6 p-6 lg:p-8">
				<section className="space-y-3">
					<SectionLabel>Clone roots</SectionLabel>
					<RootsList />
					<AddRootForm />
					<RescanControl />
				</section>
			</main>
		</>
	);
}

function RootsList() {
	const { data, isLoading } = useCloneRoots();
	const removeRoot = useRemoveCloneRoot();

	if (isLoading) {
		return <Skeleton className="h-14 w-full" />;
	}

	if (!data || data.roots.length === 0) {
		return <ListEmpty>No clone roots configured.</ListEmpty>;
	}

	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{data.roots.map((root) => (
				<div key={root.path} className="flex items-center justify-between gap-3 px-4 py-3">
					<span className="min-w-0 truncate font-mono text-sm">{root.path}</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => removeRoot.mutate(root.path)}
						disabled={removeRoot.isPending}
					>
						Remove
					</Button>
				</div>
			))}
		</div>
	);
}

function AddRootForm() {
	const addRoot = useAddCloneRoot();
	const [path, setPath] = useState("");

	function handleAdd() {
		const trimmed = path.trim();
		if (!trimmed) return;
		addRoot.mutate(trimmed, { onSuccess: () => setPath("") });
	}

	return (
		<div className="space-y-1.5">
			<div className="flex gap-2">
				<Input
					placeholder="/Users/you/code"
					value={path}
					onChange={(e) => setPath(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleAdd();
					}}
				/>
				<Button onClick={handleAdd} disabled={addRoot.isPending}>
					Add
				</Button>
			</div>
			{addRoot.error && <p className="text-destructive text-xs">{addRoot.error.message}</p>}
		</div>
	);
}

function RescanControl() {
	const rescan = useRescan();

	return (
		<div className="flex items-center gap-3">
			<Button variant="secondary" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
				<RefreshCw className={rescan.isPending ? "size-3.5 animate-spin" : "size-3.5"} />
				Rescan
			</Button>
			{rescan.data && (
				<span className="text-muted-foreground text-sm">
					{rescan.data.repoCount} repos across {rescan.data.ownerCount} owners
				</span>
			)}
		</div>
	);
}
