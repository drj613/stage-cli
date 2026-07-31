import { createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/dashboard/inbox-list";
import { RunList } from "@/components/dashboard/run-list";
import { Topbar } from "@/components/layout/topbar";

export const Route = createFileRoute("/")({
	component: Dashboard,
});

function Dashboard() {
	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-10 p-6 lg:p-8">
				<section className="space-y-3">
					<h2 className="font-semibold text-sm">Waiting on your review</h2>
					<InboxList />
				</section>
				<section className="space-y-3">
					<h2 className="font-semibold text-sm">Recent runs</h2>
					<RunList />
				</section>
			</main>
		</>
	);
}
