export interface ProcessErrorHandlerDeps {
  logFailure: (err: unknown, kind: 'unhandledRejection' | 'uncaughtException') => void;
  reportError: (err: unknown, kind: 'unhandledRejection' | 'uncaughtException') => void;
  exit: (code: number) => void;
}

/**
 * Build the process-level safety handlers without binding them to the real
 * process object, so the fatal path can be regression-tested safely.
 *
 * An unhandled rejection is recorded and the bridge stays alive, preserving
 * the existing behavior for missed asynchronous call-site catches. An
 * uncaught exception is different: Node cannot guarantee runtime consistency,
 * and attempting to log through a failed stdout/stderr used to recursively
 * emit another uncaught exception. Record it at most once and terminate so an
 * external supervisor can restart a clean process.
 */
export function createProcessErrorHandlers(deps: ProcessErrorHandlerDeps): {
  unhandledRejection: (reason: unknown) => void;
  uncaughtException: (err: unknown) => void;
} {
  let fatalHandled = false;

  const record = (
    err: unknown,
    kind: 'unhandledRejection' | 'uncaughtException',
  ): void => {
    try {
      deps.logFailure(err, kind);
    } catch {
      // The error reporter must never become a second fatal exception.
    }
    try {
      deps.reportError(err, kind);
    } catch {
      // Optional telemetry is best-effort on a fatal path.
    }
  };

  return {
    unhandledRejection(reason): void {
      record(reason, 'unhandledRejection');
    },
    uncaughtException(err): void {
      if (fatalHandled) return;
      fatalHandled = true;
      record(err, 'uncaughtException');
      deps.exit(1);
    },
  };
}
