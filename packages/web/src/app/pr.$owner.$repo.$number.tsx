import { createFileRoute } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";

// Placeholder — Task 12 builds the real PR resolution page.
export const Route = createFileRoute("/pr/$owner/$repo/$number")({
	component: PrPlaceholder,
});

function PrPlaceholder() {
	return <Skeleton className="m-6 h-16 w-full" />;
}
