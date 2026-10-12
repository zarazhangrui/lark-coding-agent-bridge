import { describe, expect, it } from 'vitest';
import { transportDiagnostic } from '../../../src/bot/transport-diagnostics';

describe('transport diagnostics', () => {
  it('retains routing metadata but never message content, credentials or callback values', () => {
    const body = { header: { event_id: 'event-1', event_type: 'im.message.receive_v1' },
      event: { message: { message_id: 'om_test', chat_id: 'oc_test', create_time: '1234',
        content: 'PRIVATE' }, token: 'SECRET' } };
    expect(transportDiagnostic([['[ws]', `receive message, message_type: event; message_id: frame; trace_id: trace; data: ${JSON.stringify(body)}`]]))
      .toEqual({ kind: 'received', frameId: 'frame', traceId: 'trace', eventId: 'event-1', eventType: 'im.message.receive_v1', messageId: 'om_test', createTime: 1234 });
  });

  it('retains frame routing when the SDK logs an already-decoded envelope.data as undefined', () => {
    expect(transportDiagnostic([['[ws]', 'receive message, message_type: event; message_id: frame-1; trace_id: trace-1; data: undefined']]))
      .toEqual({ kind: 'received', frameId: 'frame-1', traceId: 'trace-1' });
  });

  it('reports malformed frames without echoing raw data and ignores other debug messages', () => {
    expect(transportDiagnostic(['[ws]', 'receive message, message_type: event; data: SECRET'])).toEqual({ kind: 'unparsed-frame' });
    expect(transportDiagnostic(['request headers', { secret: 'SECRET' }])).toBeUndefined();
  });

  it('exposes safety drops without echoing card action values', () => {
    expect(transportDiagnostic(['safety: drop duplicate action card:om_test:user:PRIVATE']))
      .toEqual({ kind: 'safety-drop', reason: 'duplicate-action' });
  });
});
