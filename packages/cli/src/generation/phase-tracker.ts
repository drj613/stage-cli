import {
	GENERATION_PHASE,
	GENERATION_PHASE_ORDER,
	type GenerationPhase,
} from "@stagereview/types/generation";
import { z } from "zod";
import { invokesSubcommand } from "./bash-commands.js";

const STAGEREVIEW = "stagereview";
/**
 * The heredoc *opener*, not a bare mention of the delimiter — `rg AGENT_EOF`
 * must not advance the rail to Write.
 */
const AGENT_OUTPUT_HEREDOC = /<<-?\s*(['"])AGENT_EOF\1/;
const AGENT_OUTPUT_PATH = /stage-agent-output/;

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
 */
export class PhaseTracker {
	private index = 0;
	private prepToolUseId: string | null = null;

	get phase(): GenerationPhase {
		return GENERATION_PHASE_ORDER[this.index] ?? GENERATION_PHASE.PREP;
	}

	observeToolUse(toolUseId: string, name: string, input: unknown): void {
		if (name === "Write" || name === "Edit") {
			const parsed = FilePathInput.safeParse(input);
			if (parsed.success && AGENT_OUTPUT_PATH.test(parsed.data.file_path)) {
				this.advanceTo(GENERATION_PHASE.WRITE);
			}
			return;
		}
		if (name !== "Bash") return;
		const parsed = CommandInput.safeParse(input);
		if (!parsed.success) return;
		const { command } = parsed.data;

		if (invokesSubcommand(command, STAGEREVIEW, "prep")) this.prepToolUseId = toolUseId;
		if (AGENT_OUTPUT_HEREDOC.test(command)) this.advanceTo(GENERATION_PHASE.WRITE);
		if (invokesSubcommand(command, STAGEREVIEW, "import")) {
			this.advanceTo(GENERATION_PHASE.IMPORT);
		}
	}

	observeToolResult(toolUseId: string, isError: boolean): void {
		if (toolUseId !== this.prepToolUseId || isError) return;
		this.advanceTo(GENERATION_PHASE.ANALYZE);
	}

	private advanceTo(phase: GenerationPhase): void {
		this.index = Math.max(this.index, GENERATION_PHASE_ORDER.indexOf(phase));
	}
}
