const MAX_THREAD_NAME_CHARS = 96;

/** Build a compact, user-visible Codex App thread name from the original user text. */
export function buildBridgeThreadName(prefix: string, input: string): string {
  const normalizedPrefix = prefix.replace(/\s+/gu, ' ').trim() || '飞书';
  const normalizedInput = input.replace(/\s+/gu, ' ').trim() || '新会话';
  const leading = `${normalizedPrefix} · `;
  const available = Math.max(1, MAX_THREAD_NAME_CHARS - Array.from(leading).length);
  const inputChars = Array.from(normalizedInput);
  const body =
    inputChars.length <= available
      ? normalizedInput
      : `${inputChars.slice(0, Math.max(1, available - 1)).join('')}…`;
  return `${leading}${body}`;
}
