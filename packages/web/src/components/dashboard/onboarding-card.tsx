import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAddCloneRoot } from "@/lib/use-clone-roots";

/**
 * Zero-roots empty state: shown on the dashboard (when at least one listed PR
 * is uncloned) and in place of the owner list on `/browse`.
 */
export function OnboardingCard() {
	const addRoot = useAddCloneRoot();
	const [path, setPath] = useState("");

	function handleAdd() {
		const trimmed = path.trim();
		if (!trimmed) return;
		addRoot.mutate(trimmed, { onSuccess: () => setPath("") });
	}

	return (
		<div className="space-y-3 rounded-lg border p-4">
			<div className="space-y-1">
				<p className="font-medium text-sm">Stage doesn't know where your clones live</p>
				<p className="text-muted-foreground text-sm">
					Add a folder that contains your git clones so Stage can chapter PRs from it.
				</p>
			</div>
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
			<Link
				to="/settings"
				className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
			>
				Manage clone roots
			</Link>
		</div>
	);
}
