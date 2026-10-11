import type { AgentPreflightDiagnostic, AgentPreflightErrorCode } from '../agent/preflight';

export type RunRejectedCode =
  | 'pool-full'
  | 'unsupported-execution-mode'
  | 'policy-expired'
  | 'reconnect-in-progress'
  | 'run-already-active';
export type SpawnFailedCode =
  | 'agent-spawn-failed'
  | 'agent-prepare-failed'
  | AgentPreflightErrorCode;

export class RunRejected extends Error {
  readonly code: RunRejectedCode;

  constructor(code: RunRejectedCode, message: string) {
    super(message);
    this.name = 'RunRejected';
    this.code = code;
  }
}

export class SpawnFailed extends Error {
  override readonly cause: unknown;
  readonly code: SpawnFailedCode;
  readonly diagnostic: AgentPreflightDiagnostic | undefined;

  constructor(
    message: string,
    cause: unknown,
    code: SpawnFailedCode = 'agent-spawn-failed',
    diagnostic?: AgentPreflightDiagnostic,
  ) {
    super(message);
    this.name = 'SpawnFailed';
    this.cause = cause;
    this.code = code;
    this.diagnostic = diagnostic;
  }
}
