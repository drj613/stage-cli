import {
	ACTIVITY_LIMIT,
	ACTIVITY_STATE,
	type ActivityEntry,
	type JobProgress,
} from "@stagereview/types/generation";
import { describeToolUse } from "./describe-tool-use.js";
import { PhaseTracker } from "./phase-tracker.js";
import {
	isToolResultBlock,
	isToolUseBlock,
	parseStreamEvent,
	type ResultEvent,
} from "./stream-events.js";

/**
 * Folds raw stdout lines into a progress snapshot.
 *
 * It owns JSON parsing and validation, not just the fold: a reducer handed
 * pre-parsed events could not count the parse failures it never saw, and
 * AgentSession's "process I/O only" boundary would be fiction.
 */
export class StreamReducer {
	private readonly phases = new PhaseTracker();
	private readonly activity: ActivityEntry[] = [];
	private readonly entryByToolUseId = new Map<string, ActivityEntry>();
	private resolvedModel: string | null = null;
	private turns = 0;
	private dropped = 0;
	private terminalResult: ResultEvent | null = null;

	/**
	 * `startedAt` must be a real epoch-ms timestamp: it is copied into every
	 * snapshot, and `JobProgressSchema` requires a positive integer, so a zero or
	 * relative value produces a snapshot the SPA refuses to parse.
	 */
	constructor(
		private readonly repoRoot: string,
		private readonly startedAt: number,
	) {}

	get droppedLines(): number {
		return this.dropped;
	}

	/**
	 * The last result event seen, or null if none has. Nothing here enforces that it
	 * is terminal — `consumeLine` keeps folding after it, and a second result event
	 * replaces this one. AgentSession settles on it.
	 */
	get result(): ResultEvent | null {
		return this.terminalResult;
	}

	consumeLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed);
		} catch {
			this.dropped += 1;
			return;
		}
		const parsed = parseStreamEvent(raw);
		if (parsed.outcome === "invalid") {
			this.dropped += 1;
			return;
		}
		if (parsed.outcome === "unknown") return;

		const { event } = parsed;
		switch (event.type) {
			case "system":
				this.resolvedModel = event.model;
				return;
			case "assistant": {
				// Subagent traffic is not a top-level turn and not the main agent's work.
				if (event.parent_tool_use_id != null) return;
				this.turns += 1;
				for (const block of event.message.content) {
					if (!isToolUseBlock(block)) continue;
					this.phases.observeToolUse(block.id, block.name, block.input);
					const entry = this.push({
						...describeToolUse(block.name, block.input, this.repoRoot),
						state: ACTIVITY_STATE.RUNNING,
					});
					this.entryByToolUseId.set(block.id, entry);
				}
				return;
			}
			case "user": {
				if (event.parent_tool_use_id != null) return;
				for (const block of event.message.content) {
					if (!isToolResultBlock(block)) continue;
					const isError = block.is_error === true;
					this.phases.observeToolResult(block.tool_use_id, isError);
					const entry = this.entryByToolUseId.get(block.tool_use_id);
					if (entry === undefined) continue;
					entry.state = isError ? ACTIVITY_STATE.FAILED : ACTIVITY_STATE.DONE;
				}
				return;
			}
			case "result":
				this.terminalResult = event;
				if (event.num_turns !== undefined) this.turns = event.num_turns;
				return;
		}
	}

	/**
	 * Copies each entry, which is enough only because {@link ActivityEntry} is flat.
	 * The stored entries are mutated in place as their results arrive, so a caller
	 * holding a snapshot must not see them change. Give an entry a nested field and
	 * this one level of spread stops being isolation.
	 */
	snapshot(): JobProgress {
		return {
			startedAt: this.startedAt,
			// Stamped by JobManager when the session settles: the reducer folds lines,
			// and the last line is not where a run ends.
			endedAt: null,
			resolvedModel: this.resolvedModel,
			turns: this.turns,
			phase: this.phases.phase,
			activity: this.activity.map((entry) => ({ ...entry })),
		};
	}

	/**
	 * Appends to the activity window, first dropping the oldest entry and its
	 * correlation key if the window is already full. The scan compares object
	 * identity rather than looking the id up, which is what makes a duplicated
	 * tool_use id safe: only the key pointing at the entry being dropped goes.
	 */
	private push(entry: ActivityEntry): ActivityEntry {
		if (this.activity.length === ACTIVITY_LIMIT) {
			const evicted = this.activity.shift();
			if (evicted !== undefined) {
				for (const [id, candidate] of this.entryByToolUseId) {
					if (candidate === evicted) this.entryByToolUseId.delete(id);
				}
			}
		}
		this.activity.push(entry);
		return entry;
	}
}
