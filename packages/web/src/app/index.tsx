import { createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/dashboard/inbox-list";
import { RunList } from "@/components/dashboard/run-list";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";

export const Route = createFileRoute("/")({
	component: Dashboard,
});

function Dashboard() {
	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-10 p-6 lg:p-8">
				<section className="space-y-3">
					<SectionLabel>Waiting on your review</SectionLabel>
					<InboxList />
				</section>
				<section className="space-y-3">
					<SectionLabel>Recent runs</SectionLabel>
					<RunList />
				</section>
			</main>
		</>
	);
}
