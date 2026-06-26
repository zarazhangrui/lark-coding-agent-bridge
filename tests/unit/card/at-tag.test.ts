import { describe, expect, it } from 'vitest';
import { normalizeAtTags } from '../../../src/card/at-tag';

describe('normalizeAtTags', () => {
  it('rewrites the card-style <at id="..."> to the post-style <at user_id="...">', () => {
    expect(normalizeAtTags('<at id="ou_xxx"></at>')).toBe('<at user_id="ou_xxx"></at>');
  });

  it('handles single-quoted ids', () => {
    expect(normalizeAtTags("<at id='ou_abc'></at>")).toBe('<at user_id="ou_abc"></at>');
  });

  it('preserves an already-correct <at user_id="...">', () => {
    const correct = '<at user_id="ou_xxx"></at>';
    expect(normalizeAtTags(correct)).toBe(correct);
  });

  it('normalizes an unquoted self-closing <at user_id=ou_xxx/>', () => {
    expect(normalizeAtTags('<at user_id=ou_xxx/>')).toBe('<at user_id="ou_xxx"></at>');
  });

  it('handles multiple tags and surrounding text', () => {
    expect(normalizeAtTags('hi <at id="ou_a"></at> and <at id="ou_b"></at>!')).toBe(
      'hi <at user_id="ou_a"></at> and <at user_id="ou_b"></at>!',
    );
  });

  it('is idempotent', () => {
    const once = normalizeAtTags('<at id="ou_xxx"></at>');
    expect(normalizeAtTags(once)).toBe(once);
  });

  it('leaves empty input untouched', () => {
    expect(normalizeAtTags('')).toBe('');
  });

  it('does not mangle unrelated tags or bare text', () => {
    const plain = 'see <at> no id here';
    expect(normalizeAtTags(plain)).toBe(plain);
  });
});
