import { Link } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ChainPosition, tipOf } from "@/lib/chain-position";
import { splitNameWithOwner } from "@/lib/split-name-with-owner";

export interface StackBadgeProps {
	nameWithOwner: string;
	prNumber: number;
	/** Every chain this PR belongs to. More than one means it sits below a fork. */
	chains: ChainPosition[];
}

/**
 * Where a PR sits in its stack, with a link to review the whole chain.
 *
 * A chain is named by its tip, so a PR below a fork gets one link per leaf
 * rather than a single "the stack" that would have to pick a branch silently.
 */
export function StackBadge({ nameWithOwner, prNumber, chains }: StackBadgeProps) {
	const first = chains[0];
	if (!first) return null;
	const { owner, repo } = splitNameWithOwner(nameWithOwner);

	return (
		<Popover>
			<PopoverTrigger asChild>
				{/* A real button: Badge renders a span, which handlers alone do not
				    make focusable, and the chain would be keyboard-unreachable. */}
				<button
					type="button"
					aria-label={`Stack position ${first.position} of ${first.length}`}
					className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					<Badge variant="outline" className="gap-1">
						<Layers aria-hidden className="size-3" />
						{first.position}/{first.length}
					</Badge>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 space-y-3">
				{chains.map((entry) => {
					const tip = tipOf(entry.chain);
					return (
						<div key={tip.number} className="space-y-1.5">
							<ul className="space-y-0.5">
								{entry.chain.members.map((member) => (
									<li
										key={member.number}
										className={
											member.number === prNumber
												? "truncate font-medium text-sm"
												: "truncate text-muted-foreground text-sm"
										}
									>
										<span className="tabular-nums">#{member.number}</span> {member.title}
									</li>
								))}
							</ul>
							<Link
								to="/stack/$owner/$repo/$number"
								params={{ owner, repo, number: String(tip.number) }}
								className="inline-block text-primary text-xs underline underline-offset-2"
							>
								Review whole stack →
							</Link>
						</div>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}
