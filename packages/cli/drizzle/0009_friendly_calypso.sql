CREATE TABLE `chapter_run_pull_request` (
	`runId` text NOT NULL,
	`prNumber` integer NOT NULL,
	`headSha` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`runId`, `prNumber`),
	FOREIGN KEY (`runId`) REFERENCES `chapter_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chapter_run_pr_number_idx` ON `chapter_run_pull_request` (`prNumber`);--> statement-breakpoint
CREATE UNIQUE INDEX `chapter_run_pr_position` ON `chapter_run_pull_request` (`runId`,`position`);--> statement-breakpoint
INSERT INTO `chapter_run_pull_request` (`runId`, `prNumber`, `headSha`, `position`)
SELECT `id`, `prNumber`, `headSha`, 0 FROM `chapter_run` WHERE `prNumber` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `chapter_run` DROP COLUMN `prNumber`;