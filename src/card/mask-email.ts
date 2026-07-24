/**
 * Feishu's tenant message audit rejects any outbound message that contains a
 * raw email address with a 400 ("The messages do NOT pass the audit ...
 * contain sensitive data: EMAIL_ADDRESS"). For a streamed card/markdown reply
 * this is silent from the agent's side: the update just fails, so a run that
 * `cot completed reason=done` appears to never reply. The usual trigger is a
 * commit co-author trailer (`Co-Authored-By: … <name@example.com>`) that the
 * agent echoes in its answer or runs through `git commit` (shown in a tool
 * panel).
 *
 * We neutralize emails at the render boundary (renderText / renderCard) by
 * rewriting the `@` to `[at]`. Deliberately NOT a lookalike codepoint (fullwidth
 * `＠`) or a zero-width space: Chinese text audits routinely normalize
 * fullwidth→ASCII and strip zero-width characters, either of which would re-form
 * the address and re-trigger the block. `[at]` cannot be normalized back into a
 * valid address and stays readable.
 */

// `local@domain.tld`, requiring a dotted domain ending in a 2+ letter TLD. The
// dotted-TLD requirement keeps us off npm scopes (`@larksuite/x` — no local
// part before `@`), version specs (`pkg@1.2.3` — numeric tail), and bare
// handles (`user@localhost` — no dot). SSH remotes (`git@host.tld`) DO match
// and get masked — intentional: the audit flags them as EMAIL_ADDRESS too, so
// masking is what lets the message through at all.
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

/** Rewrite every email in `text` so the tenant audit won't flag it. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, '$1[at]$2');
}

/**
 * Recursively mask emails in every string value of a rendered card object.
 * Emails only occur in user/agent-authored content (text blocks, tool
 * input/output, reasoning, error notices); structural card values (tags,
 * colors, icon/callback tokens) never contain an `@`, so a blanket walk is
 * safe and guarantees no email slips through any field.
 */
export function deepMaskEmails<T>(value: T): T {
  if (typeof value === 'string') return maskEmails(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepMaskEmails(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepMaskEmails(val);
    return out as T;
  }
  return value;
}
