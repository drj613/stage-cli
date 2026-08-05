import path from "node:path";
import {
	GENERATION_PHASE,
	GENERATION_PHASE_ORDER,
	type GenerationPhase,
} from "@stagereview/types/generation";
import { z } from "zod";
import { heredocDelimiters, invokesSubcommand } from "./bash-commands.js";

const STAGEREVIEW = "stagereview";
/** The delimiter of the heredoc the chapter JSON is written through. */
const AGENT_OUTPUT_DELIMITER = "AGENT_EOF";
/**
 * Matched against the basename, not the whole path, so an unrelated file that
 * merely mentions the output name — `docs/notes-stage-agent-output.md` — does not
 * count as writing chapters.
 */
const AGENT_OUTPUT_BASENAME = /^stage-agent-output/;

const CommandInput = z.object({ command: z.string() });
const FilePathInput = z.object({ file_path: z.string() });

/**
 * Monotonic phase state derived from the agent's tool stream.
 *
 * Two rules keep it truthful. Phases advance on *successful completion*, not on
 * invocation — a failed `stagereview prep` stays in Prep, because showing
 * "Analyze" for a run that never got a diff is a lie. And the phase is the
 * running maximum, so an agent re-reading a file after writing chapters cannot
 * rewind the rail.
 *
 * Every other advance keys off invocation, which is the same rule seen from the
 * other side: each transition means "phase N has started". Prep is the exception
 * only because the job begins already in Prep, so the signal worth reporting is
 * prep finishing rather than starting. The running maximum is also why a phase may
 * be skipped: a `stagereview import` proves the earlier phases happened, and
 * refusing to skip would leave the rail stuck at Prep while the run finishes.
 *
 * Tool names are expected in the canonical casing the API emits (`Bash`, not
 * `bash`); anything else is ignored rather than guessed at.
 */
export class PhaseTracker {
	private current: GenerationPhase = GENERATION_PHASE.PREP;
	/** Every prep still awaiting a result — success on any of them means Analyze. */
	private readonly pendingPreps = new Set<string>();

	get phase(): GenerationPhase {
		return this.current;
	}

	observeToolUse(toolUseId: string, name: string, input: unknown): void {
		if (name === "Write" || name === "Edit") {
			const parsed = FilePathInput.safeParse(input);
			if (parsed.success && AGENT_OUTPUT_BASENAME.test(path.basename(parsed.data.file_path))) {
				this.advanceTo(GENERATION_PHASE.WRITE);
			}
			return;
		}
		if (name !== "Bash") return;
		const parsed = CommandInput.safeParse(input);
		if (!parsed.success) return;
		const { command } = parsed.data;

		if (invokesSubcommand(command, STAGEREVIEW, "prep")) this.pendingPreps.add(toolUseId);
		if (heredocDelimiters(command).includes(AGENT_OUTPUT_DELIMITER)) {
			this.advanceTo(GENERATION_PHASE.WRITE);
		}
		if (invokesSubcommand(command, STAGEREVIEW, "import")) {
			this.advanceTo(GENERATION_PHASE.IMPORT);
		}
	}

	observeToolResult(toolUseId: string, isError: boolean): void {
		if (!this.pendingPreps.delete(toolUseId) || isError) return;
		this.advanceTo(GENERATION_PHASE.ANALYZE);
	}

	private advanceTo(phase: GenerationPhase): void {
		const reached = GENERATION_PHASE_ORDER.indexOf(phase);
		if (reached > GENERATION_PHASE_ORDER.indexOf(this.current)) this.current = phase;
	}
}
