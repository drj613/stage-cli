import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * The narrow slice of ChildProcess that AgentSession uses, so a test can drive
 * a run without launching anything.
 */
export class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: Array<NodeJS.Signals | number> = [];
	private reaped = false;

	// Signature must match ChildProcess.kill, or FakeChild isn't assignable to
	// SpawnedChild. Returns false once reaped, as Node's does — a signal cannot
	// land on a process that has already been waited on.
	kill(signal?: NodeJS.Signals | number): boolean {
		if (this.reaped) return false;
		this.signals.push(signal ?? "SIGTERM");
		return true;
	}

	/** Writes one NDJSON line to stdout. */
	emitLine(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	/**
	 * Fires `exit` and leaves stdout open: what a real child looks like when a
	 * grandchild inherited the pipe, and the one case where `close` never comes.
	 */
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.reaped = true;
		this.emit("exit", code, signal);
	}

	/**
	 * A full shutdown in Node's order: `exit`, then `close` once both stdio
	 * streams have closed. That order is load-bearing — readline flushes a
	 * newline-less final line on `end`, so a `close` emitted any earlier would
	 * drop the agent's last line.
	 */
	close(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exit(code, signal);
		let pending = 2;
		const closed = () => {
			pending -= 1;
			if (pending === 0) this.emit("close", code, signal);
		};
		this.stdout.once("close", closed);
		this.stderr.once("close", closed);
		this.stdout.end();
		this.stderr.end();
	}
}
