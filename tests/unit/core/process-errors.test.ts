import { describe, expect, it, vi } from 'vitest';
import { createProcessErrorHandlers } from '../../../src/core/process-errors.js';

describe('process error handlers', () => {
  it('records an unhandled rejection without exiting', () => {
    const logFailure = vi.fn();
    const reportError = vi.fn();
    const exit = vi.fn();
    const handlers = createProcessErrorHandlers({ logFailure, reportError, exit });
    const reason = new Error('async failure');

    handlers.unhandledRejection(reason);

    expect(logFailure).toHaveBeenCalledWith(reason, 'unhandledRejection');
    expect(reportError).toHaveBeenCalledWith(reason, 'unhandledRejection');
    expect(exit).not.toHaveBeenCalled();
  });

  it('records an uncaught exception once and exits once even if reporting throws', () => {
    const logFailure = vi.fn(() => {
      throw Object.assign(new Error('write EIO'), { code: 'EIO' });
    });
    const reportError = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    const exit = vi.fn();
    const handlers = createProcessErrorHandlers({ logFailure, reportError, exit });
    const fatal = new Error('fatal');

    expect(() => handlers.uncaughtException(fatal)).not.toThrow();
    expect(() => handlers.uncaughtException(new Error('recursive'))).not.toThrow();

    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledWith(fatal, 'uncaughtException');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
