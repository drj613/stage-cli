import { GENERATION_PHASE_ORDER, type GenerationPhase } from "@stagereview/types/generation";
import { PHASE_LABELS } from "@/lib/generation-labels";
import { cn } from "@/lib/utils";

/**
 * The four-step rail. The current step is marked with aria-current and a text
 * label, never colour alone. On narrow layouts the labels wrap rather than
 * forcing the card wider.
 */
export function PhaseRail({ phase }: { phase: GenerationPhase }) {
	const currentIndex = GENERATION_PHASE_ORDER.indexOf(phase);
	return (
		<ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{GENERATION_PHASE_ORDER.map((step, index) => {
				const isCurrent = index === currentIndex;
				const isDone = index < currentIndex;
				return (
					<li
						key={step}
						aria-current={isCurrent ? "step" : undefined}
						className="flex items-center gap-2"
					>
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								isDone && "bg-muted-foreground",
								isCurrent && "bg-foreground",
								!isDone && !isCurrent && "bg-border",
							)}
						/>
						<span
							className={cn(
								"text-xs",
								isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
							)}
						>
							{PHASE_LABELS[step]}
						</span>
						{index < GENERATION_PHASE_ORDER.length - 1 && (
							<span aria-hidden className="hidden h-px w-4 bg-border sm:block" />
						)}
					</li>
				);
			})}
		</ol>
	);
}
