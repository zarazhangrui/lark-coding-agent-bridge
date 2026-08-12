import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/agent/types.ts'), 'utf8');

describe('agent type contract', () => {
  it('supports claude session ids, codex thread ids, and optional usage cost', () => {
    expect(source).toMatch(/type:\s*'system'[^|]*sessionId\?:\s*string[^|]*threadId\?:\s*string/s);
    expect(source).toMatch(/type:\s*'done'[^|]*sessionId\?:\s*string[^|]*threadId\?:\s*string/s);
    expect(source).toMatch(/type:\s*'usage'[^|]*costUsd\?:\s*number/s);
  });

  it('requires termination reasons on terminal events', () => {
    expect(source).toMatch(/type:\s*'done'[^|]*terminationReason:\s*'normal'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
    expect(source).toMatch(/type:\s*'error'[^|]*terminationReason:\s*'failed'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
  });

  it('requires runId on run options and run handles', () => {
    expect(source).toMatch(/interface AgentRunOptions[^}]*runId:\s*string/s);
    expect(source).toMatch(/interface AgentRun[^}]*readonly runId:\s*string/s);
    expect(source).toMatch(/interface AgentRunOptions[^}]*threadId\?:\s*string/s);
  });

  it('requires callers to choose an interactive or unavailable user-input mode', () => {
    expect(source).toMatch(/type AgentUserInputMode[\s\S]*kind:\s*'interactive'[\s\S]*kind:\s*'unavailable'/);
    expect(source).toMatch(/interface AgentRunOptions[^}]*userInput:\s*AgentUserInputMode/s);
    expect(source).toMatch(/type NonEmptyReadonlyArray<T>\s*=\s*readonly \[T, \.\.\.T\[\]\]/);
    expect(source).toMatch(/interface AgentUserInputAnswer[^}]*value:\s*string/s);
    expect(source).not.toMatch(/interface AgentUserInputAnswer[^}]*values:/s);
  });
});
