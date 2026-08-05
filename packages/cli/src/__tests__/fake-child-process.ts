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

	// Signature must match ChildProcess.kill, or FakeChild isn't assignable to
	// SpawnedChild.
	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal ?? "SIGTERM");
		return true;
	}

	/** Writes one NDJSON line to stdout. */
	emitLine(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	/** Ends the streams and fires `close`, the only event that settles a run. */
	close(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, signal);
	}
}
