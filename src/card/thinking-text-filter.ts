export type ThinkingTextFilter = {
  carry: string;
  mode: 'visible' | 'thinking';
};

const RT = 'redacted_' + 'thinking';
const THINKING_CLOSE_TAGS = ['</thinking>', '</' + RT + '>'] as const;
const THINKING_TAG_PREFIXES = [
  '<thinking',
  '<' + RT,
  '</thinking>',
  '</' + RT + '>',
] as const;
const RT_GROUP = '(thinking|' + RT + ')';
const RT_CLOSE_GROUP = '(?:thinking|' + RT + ')';

export function emptyThinkingTextFilter(): ThinkingTextFilter {
  return { carry: '', mode: 'visible' };
}

function longestPartialTagSuffix(s: string): number {
  let max = 0;
  for (const tag of THINKING_TAG_PREFIXES) {
    const lowerTag = tag.toLowerCase();
    for (let i = 1; i <= Math.min(s.length, lowerTag.length - 1); i++) {
      if (lowerTag.startsWith(s.slice(-i).toLowerCase())) {
        max = Math.max(max, i);
      }
    }
  }
  return max;
}

function findThinkingOpen(input: string): { idx: number; len: number } {
  const re = new RegExp('<(' + RT_GROUP + ')\b[^>]*>', 'i');
  const match = input.match(re);
  if (!match || match.index === undefined) return { idx: -1, len: 0 };
  return { idx: match.index, len: match[0].length };
}

function findEarliestCloseTag(input: string): { idx: number; len: number } {
  const lower = input.toLowerCase();
  let best = { idx: -1, len: 0 };
  for (const tag of THINKING_CLOSE_TAGS) {
    const idx = lower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (best.idx === -1 || idx < best.idx)) {
      best = { idx, len: tag.length };
    }
  }
  return best;
}

export function filterThinkingTextDelta(
  filter: ThinkingTextFilter,
  delta: string,
): { output: string; clearPriorInBlock: boolean } {
  let input = filter.carry + delta;
  filter.carry = '';
  let output = '';
  let clearPriorInBlock = false;

  while (input.length > 0) {
    if (filter.mode === 'thinking') {
      const close = findEarliestCloseTag(input);
      if (close.idx !== -1) {
        input = input.slice(close.idx + close.len);
        filter.mode = 'visible';
        continue;
      }
      const keep = longestPartialTagSuffix(input);
      if (keep > 0) {
        filter.carry = input.slice(-keep);
        input = input.slice(0, -keep);
      }
      break;
    }

    const open = findThinkingOpen(input);
    const close = findEarliestCloseTag(input);
    if (open.idx !== -1 && (close.idx === -1 || open.idx <= close.idx)) {
      output += input.slice(0, open.idx);
      input = input.slice(open.idx + open.len);
      filter.mode = 'thinking';
      continue;
    }
    if (close.idx !== -1) {
      output = '';
      clearPriorInBlock = true;
      input = input.slice(close.idx + close.len);
      continue;
    }

    const keep = longestPartialTagSuffix(input);
    if (keep > 0) {
      output += input.slice(0, -keep);
      filter.carry = input.slice(-keep);
    } else {
      output += input;
    }
    break;
  }

  return { output, clearPriorInBlock };
}

export function sanitizeThinkingText(text: string): string {
  let s = text;
  const blockRe = new RegExp('<(' + RT_GROUP + ')\\b[^>]*>[\\s\\S]*?</\\1>', 'gi');
  const openTailRe = new RegExp('<(' + RT_GROUP + ')\\b[^>]*>[\\s\\S]*$', 'gi');
  const orphanCloseRe = new RegExp('^[\\s\\S]*?</' + RT_CLOSE_GROUP + '>', 'gi');
  const tickCloseRe = new RegExp('`?</' + RT + '>`?', 'gi');
  s = s.replace(blockRe, '');
  s = s.replace(openTailRe, '');
  s = s.replace(orphanCloseRe, '');
  s = s.replace(tickCloseRe, '');
  return s;
}
