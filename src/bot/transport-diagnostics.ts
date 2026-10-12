/** Explicitly allowlisted metadata from SDK debug logs. Never return raw payloads. */
export function transportDiagnostic(args: unknown[]): Record<string, string | number> | undefined {
  const values = args.flat(2).filter((value): value is string => typeof value === 'string');
  for (const value of values) {
    const drop = /^safety: drop (duplicate|in-flight) (message|action) /.exec(value);
    if (drop) return { kind: 'safety-drop', reason: `${drop[1]}-${drop[2]}` };
    if (!value.startsWith('receive message, message_type:')) continue;
    // SDK 1.74 has already decoded the envelope when it logs this line, but
    // interpolates envelope.data (usually undefined), not the envelope itself.
    // The frame ID is still useful for correlating platform delivery records.
    const frame = /^receive message, message_type: event; message_id: ([\w.-]{1,128}); trace_id: ([\w.-]{1,128}); data: /.exec(value);
    const routing: Record<string, string> = frame ? { frameId: frame[1]!, traceId: frame[2]! } : {};
    try {
      const offset = value.indexOf('; data: ');
      if (offset < 0) return { kind: 'unparsed-frame' };
      const raw = JSON.parse(value.slice(offset + 8));
      const result: Record<string, string | number> = { kind: 'received', ...routing };
      // Identifiers are restricted as well: a malformed payload must not smuggle text into logs.
      for (const [name, field] of Object.entries({ eventId: raw.header?.event_id,
        eventType: raw.header?.event_type, messageId: raw.event?.message?.message_id ?? raw.event?.context?.open_message_id })) {
        if (typeof field === 'string' && /^[\w.-]{1,128}$/.test(field)) result[name] = field;
      }
      const timestamp = raw.event?.message?.create_time;
      if (typeof timestamp === 'string' && /^\d{1,16}$/.test(timestamp)) result.createTime = Number(timestamp);
      return result;
    } catch {
      return frame ? { kind: 'received', ...routing } : { kind: 'unparsed-frame' };
    }
  }
  return undefined;
}
