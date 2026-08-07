import { Link } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { ReviewToolbar } from "@/components/comments/review-toolbar";
import { SectionLabel } from "@/components/shared/section-label";
import { splitNameWithOwner } from "@/lib/split-name-with-owner";

export interface StackHeaderProps {
	/** `owner/repo` — the chain's members all live in one repository. */
	nameWithOwner: string;
	/** The chain's PRs, bottom of the stack first. */
	pullRequests: readonly { number: number }[];
}

/**
 * The header for a run that reviews a whole chain.
 *
 * Merge state, reviewers, and status controls are deliberately absent: each is
 * a property of one pull request, and a chain has no single answer for any of
 * them. They stay on the individual PR pages, which each member links to. The
 * review toolbar does belong here — it submits one review per member.
 */
export function StackHeader({ nameWithOwner, pullRequests }: StackHeaderProps) {
	const { owner, repo } = splitNameWithOwner(nameWithOwner);
	const first = pullRequests[0];
	const last = pullRequests[pullRequests.length - 1];
	if (!first || !last) return null;

	return (
		<header className="space-y-2">
			<div className="flex items-center gap-2">
				<SectionLabel>Stack</SectionLabel>
				<Layers aria-hidden className="size-3.5 text-muted-foreground" />
				<h1 className="font-semibold text-base tabular-nums">
					#{first.number}→#{last.number}
				</h1>
				<ReviewToolbar />
			</div>
			<ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{pullRequests.map((pr) => (
					<li key={pr.number}>
						<Link
							to="/pr/$owner/$repo/$number"
							params={{ owner, repo, number: String(pr.number) }}
							className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
						>
							#{pr.number}
						</Link>
					</li>
				))}
			</ul>
		</header>
	);
}
