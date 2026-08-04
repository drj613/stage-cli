import { createFileRoute } from "@tanstack/react-router";

// Placeholder — Task 12 builds the real PR resolution page.
export const Route = createFileRoute("/pr/$owner/$repo/$number")({
	component: PrPlaceholder,
});

function PrPlaceholder() {
	return null;
}
