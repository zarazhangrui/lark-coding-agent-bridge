import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  /** Receipt-backed outcome for a current-scope `/stop` command reply. */
  interruptionAcknowledgement?: Promise<boolean>;
  /** Executor-owned stop path that also settles process tracking. */
  requestStop?: () => Promise<void>;
}

export interface InterruptOptions {
  /** Pending delivery outcome when the caller may own the acknowledgement. */
  interruptionAcknowledgement?: Promise<boolean>;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was newly issued. An already-interrupted handle keeps its first
   * acknowledgement owner and returns false. Fires stop() fire-and-forget —
   * the old run's generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string, options: InterruptOptions = {}): boolean {
    const h = this.handles.get(chatId);
    if (!h || h.interrupted) return false;
    this.reservations.delete(chatId);
    h.interrupted = true;
    if (options.interruptionAcknowledgement) {
      h.interruptionAcknowledgement ??= options.interruptionAcknowledgement;
    }
    const stopping = h.requestStop?.() ?? h.run.stop();
    void stopping
      .catch(() => {
        /* stop errors are non-fatal */
      })
      .finally(() => this.unregister(chatId, h.run));
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.requestStop?.() ?? h.run.stop()));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
