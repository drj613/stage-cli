import { Link } from "@tanstack/react-router";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import stageMarkUrl from "../../../../../assets/stage-mark.svg";

export function Topbar() {
	return (
		<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-border border-b bg-background px-6 lg:px-8">
			<Link to="/" className="flex min-w-0 items-center gap-2 text-sm">
				<img src={stageMarkUrl} alt="" className="size-[29px] shrink-0" />
				<span className="font-medium text-foreground">Stage</span>
			</Link>
			<div className="flex shrink-0 items-center gap-4">
				<nav className="flex items-center gap-4 text-muted-foreground text-sm">
					<Link to="/" className="transition-colors hover:text-foreground">
						Dashboard
					</Link>
					<Link to="/browse" className="transition-colors hover:text-foreground">
						Browse
					</Link>
					<Link to="/settings" className="transition-colors hover:text-foreground">
						Settings
					</Link>
				</nav>
				<ThemeToggle />
			</div>
		</header>
	);
}
