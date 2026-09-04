/**
 * Pure group-mention admission decision.
 *
 * `smartMention` is an independent third mode and takes precedence over
 * `requireMention` when enabled:
 *  - smart=true: no-mention chatter and @-mentions of this bot pass; a message
 *    that explicitly @-mentions someone else is skipped.
 *  - smart=false: fall back to `requireMention` (only @-mentions of this bot
 *    pass when required).
 */
export type GroupMentionSkipReason = 'no-mention' | 'other-mentioned' | null;

export function groupMentionSkipReason(opts: {
  smartMention: boolean;
  requireMention: boolean;
  mentionedBot: boolean;
  mentionCount: number;
}): GroupMentionSkipReason {
  if (opts.mentionedBot) return null;
  if (opts.smartMention) {
    return opts.mentionCount > 0 ? 'other-mentioned' : null;
  }
  if (!opts.requireMention) return null;
  return opts.mentionCount > 0 ? 'other-mentioned' : 'no-mention';
}
