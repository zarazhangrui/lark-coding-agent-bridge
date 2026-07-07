import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../../../src/agent/claude/permission-policy.js';

describe('classifyTool', () => {
  it('auto-allows known read-only tools', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'NotebookRead']) {
      expect(classifyTool(t)).toBe('auto-allow');
    }
  });

  it('prompts for write / external / unknown tools', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'mcp__x__y', 'SomethingNew']) {
      expect(classifyTool(t)).toBe('prompt');
    }
  });
});
