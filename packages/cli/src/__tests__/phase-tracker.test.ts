import { GENERATION_PHASE } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { PhaseTracker } from "../generation/phase-tracker.js";

const PREP_COMMAND = "PREP_FILE=$(stagereview prep)";
const WRITE_COMMAND = [
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
	'AGENT_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/stage-agent-output.XXXXXX")',
	`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
	'{ "chapters": [] }',
	"AGENT_EOF",
].join("\n");
const IMPORT_COMMAND = 'stagereview import "$AGENT_OUTPUT" --pr 42';

describe("PhaseTracker", () => {
	it("starts in prep", () => {
		expect(new PhaseTracker().phase).toBe(GENERATION_PHASE.PREP);
	});

	it("stays in prep while prep is still running", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to analyze when prep succeeds", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.ANALYZE);
	});

	it("stays in prep when prep fails", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", true);
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("does not advance when a failed prep's result is delivered twice", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", true);
		tracker.observeToolResult("t1", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("ignores a result for a different tool call", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t2", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to write on the heredoc opener", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: WRITE_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("advances to write on a Write to the agent-output path", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Write", { file_path: "/tmp/stage-agent-output.AbC123" });
		expect(tracker.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("does not advance to write when a search merely mentions the delimiter", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: "rg AGENT_EOF src" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to import", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: IMPORT_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.IMPORT);
	});

	it("does not advance on a command that only mentions the import subcommand", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: "echo run stagereview import next" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("never rewinds", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: IMPORT_COMMAND });
		tracker.observeToolUse("t2", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t2", false);
		tracker.observeToolUse("t3", "Read", { file_path: "/repo/src/a.ts" });
		expect(tracker.phase).toBe(GENERATION_PHASE.IMPORT);
	});

	it("leaves the phase alone for unrelated tools", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Read", { file_path: "/repo/src/a.ts" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("does not advance to write when a search quotes the whole heredoc opener", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: `rg "<< 'AGENT_EOF'" src` });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to write on an unquoted heredoc opener", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: 'cat > "$AGENT_OUTPUT" <<AGENT_EOF' });
		expect(tracker.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("does not advance to write for a file that merely mentions the output name", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Write", { file_path: "/repo/docs/notes-stage-agent-output.md" });
		tracker.observeToolUse("t2", "Edit", { file_path: "/repo/src/stage-agent-outputs/a.ts" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances when the earlier of two concurrent preps is the one that succeeds", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolUse("t2", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.ANALYZE);
	});
});
