import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
  readonly waitForExitTimeouts: readonly number[];
}

export type FakeWaitForExitResult = boolean | Promise<boolean>;

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: FakeWaitForExitResult;
  readonly #holdOpen: boolean;
  readonly #stopEvent: AgentEvent | undefined;
  readonly #stopCompletion: Promise<void> | undefined;
  #stopped = false;
  readonly #waitForExitTimeouts: number[] = [];
  #releaseHold: (() => void) | undefined;

  constructor(
    opts: AgentRunOptions,
    events: readonly AgentEvent[],
    waitForExitResult: FakeWaitForExitResult,
    holdOpen: boolean,
    stopEvent: AgentEvent | undefined,
    stopCompletion: Promise<void> | undefined,
  ) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.#holdOpen = holdOpen;
    this.#stopEvent = stopEvent;
    this.#stopCompletion = stopCompletion;
    this.events = this.iterate(events);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitTimeouts.length;
  }

  get waitForExitTimeouts(): readonly number[] {
    return this.#waitForExitTimeouts;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    try {
      await this.#stopCompletion;
    } finally {
      this.#releaseHold?.();
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    this.#waitForExitTimeouts.push(timeoutMs);
    return await this.waitForExitResult;
  }

  private async *iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of events) {
      if (this.#stopped) return;
      yield event;
    }
    if (this.#holdOpen && !this.#stopped) {
      await new Promise<void>((resolve) => {
        this.#releaseHold = resolve;
      });
    }
    if (this.#stopped && this.#stopEvent) yield this.#stopEvent;
  }
}

export type FakeAgentEvents =
  | readonly AgentEvent[]
  | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #available: boolean;
  #eventRuns: AgentEvent[][];
  #waitForExitResults: FakeWaitForExitResult[];
  #holdOpen: boolean;
  #stopEvent: AgentEvent | undefined;
  #stopCompletion: Promise<void> | undefined;

  constructor(options: {
    id?: string;
    displayName?: string;
    available?: boolean;
    events?: FakeAgentEvents;
    waitForExit?: FakeWaitForExitResult | readonly FakeWaitForExitResult[];
    holdOpen?: boolean;
    stopEvent?: AgentEvent;
    stopCompletion?: Promise<void>;
  } = {}) {
    this.id = options.id ?? 'fake-agent';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.#available = options.available ?? true;
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
    this.#holdOpen = options.holdOpen ?? false;
    this.#stopEvent = options.stopEvent;
    this.#stopCompletion = options.stopCompletion;
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const run = new FakeRun(
      opts,
      events,
      waitForExitResult,
      this.#holdOpen,
      this.#stopEvent,
      this.#stopCompletion,
    );
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  setWaitForExit(result: FakeWaitForExitResult | readonly FakeWaitForExitResult[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(
  result: FakeWaitForExitResult | readonly FakeWaitForExitResult[] | undefined,
): FakeWaitForExitResult[] {
  if (result === undefined) return [];
  return Array.isArray(result)
    ? [...result]
    : [result as FakeWaitForExitResult];
}
