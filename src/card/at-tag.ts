/**
 * Normalize `@`/`<at>` tags to the form Feishu renders in plain-text / post
 * (markdown) messages: `<at user_id="ou_xxx"></at>`.
 *
 * Why this exists: Feishu accepts two `<at>` spellings and they are NOT
 * interchangeable across message types.
 *   - `<at user_id="ou_xxx"></at>`  → post / markdown message body  ✅ rendered
 *   - `<at id="ou_xxx"></at>`        → CardKit markdown element       ✅ rendered
 *   - `<at id="ou_xxx"></at>`        → post / markdown message body  ❌ NOT rendered (shown as raw text)
 *
 * The config card builder (`config-card.ts`) uses the `id=` spelling because it
 * is inside a card. But the agent's free-form replies go out as markdown/post
 * messages via `renderText`, where only `user_id=` works. An agent (or a
 * hand-written template) copying the `id=` form would silently fail to @.
 *
 * This helper is idempotent and leaves unknown / empty tags untouched.
 */
export function normalizeAtTags(markdown: string): string {
  if (!markdown) return markdown;
  // Already-correct `user_id=` form, or self-closing / empty — leave alone.
  let out = markdown.replace(
    /<at\s+id=["']([A-Za-z0-9_-]+)["']\s*>\s*<\/at>/g,
    '<at user_id="$1"></at>',
  );
  // Some authors write a bare value attribute: <at>ou_xxx</at> is too ambiguous
  // to touch, but `<at user_id=ou_xxx/>` (no quotes, self-closing) is safe:
  out = out.replace(
    /<at\s+user_id=([A-Za-z0-9_-]+)\s*\/>/g,
    '<at user_id="$1"></at>',
  );
  return out;
}
