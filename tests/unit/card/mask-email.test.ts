import { describe, expect, it } from 'vitest';
import { deepMaskEmails, maskEmails } from '../../../src/card/mask-email.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { reduce, initialState, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('maskEmails', () => {
  it('rewrites the @ of a plain email', () => {
    expect(maskEmails('noreply@example.com')).toBe('noreply[at]example.com');
  });

  it('masks emails inside a commit trailer', () => {
    expect(maskEmails('Co-Authored-By: Some One <noreply@example.com>')).toBe(
      'Co-Authored-By: Some One <noreply[at]example.com>',
    );
  });

  it('masks every email in a string, incl. subdomains and +tags', () => {
    expect(maskEmails('a.b+c@sub.example.co.uk and x@example.org')).toBe(
      'a.b+c[at]sub.example.co.uk and x[at]example.org',
    );
  });

  it('masks an ssh remote (the audit flags it as an email too)', () => {
    expect(maskEmails('git@example.com:org/repo.git')).toBe('git[at]example.com:org/repo.git');
  });

  it('leaves non-email @ usages untouched', () => {
    expect(maskEmails('@scope/pkg')).toBe('@scope/pkg');
    expect(maskEmails('pkg@1.2.3')).toBe('pkg@1.2.3');
    expect(maskEmails('user@localhost')).toBe('user@localhost');
    expect(maskEmails('see @someone in the thread')).toBe('see @someone in the thread');
  });

  it('produces no raw email (no bare local@domain.tld remains)', () => {
    const masked = maskEmails('reach me at foo.bar@example.org please');
    expect(masked).not.toMatch(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/);
  });
});

describe('deepMaskEmails', () => {
  it('masks strings nested in objects and arrays, leaving other types alone', () => {
    const input = {
      tag: 'markdown',
      content: 'ping noreply@example.com',
      nested: [{ text: 'a@example.net' }, 42, true, null],
    };
    expect(deepMaskEmails(input)).toEqual({
      tag: 'markdown',
      content: 'ping noreply[at]example.com',
      nested: [{ text: 'a[at]example.net' }, 42, true, null],
    });
  });
});

describe('renderers strip emails end-to-end', () => {
  const withEmail: AgentEvent[] = [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m "x"' } },
    { type: 'tool_result', id: 't1', output: 'Co-Authored-By: Some One <noreply@example.com>', isError: false },
    { type: 'text', delta: 'Committed. Trailer: authored by team@example.org.' },
    { type: 'done', terminationReason: 'normal' },
  ];
  const state: RunState = withEmail.reduce(reduce, initialState);
  const rawEmail = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/;

  it('renderText emits no raw email', () => {
    expect(renderText(state)).not.toMatch(rawEmail);
  });

  it('renderCard emits no raw email anywhere in the payload', () => {
    expect(JSON.stringify(renderCard(state))).not.toMatch(rawEmail);
  });
});
