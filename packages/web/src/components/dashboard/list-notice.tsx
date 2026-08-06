import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export interface ListNoticeProps {
	title: string;
	details: ReactNode;
}

/** The dashboard's failure block: what went wrong, plus what to do about it. */
export function ListNotice({ title, details }: ListNoticeProps) {
	return (
		<div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-4 text-sm">
			<TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 space-y-1">
				<p className="text-foreground">{title}</p>
				<div className="text-muted-foreground text-xs">{details}</div>
			</div>
		</div>
	);
}

/** Nothing went wrong — there's just nothing here. */
export function ListEmpty({ children }: { children: string }) {
	return (
		<p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
