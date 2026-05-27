import type { AgentEvent } from '../types';

interface CodexItemBase {
  id?: string;
  type?: string;
  status?: string;
}

interface CodexAgentMessageItem extends CodexItemBase {
  type: 'agent_message';
  text?: string;
}

interface CodexCommandExecutionItem extends CodexItemBase {
  type: 'command_execution';
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
}

interface CodexFileChangeItem extends CodexItemBase {
  type: 'file_change';
  changes?: Array<{ path?: string; kind?: string }>;
}

type CodexItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexItemBase;

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
}

export function createCodexTranslator(): {
  translate(raw: unknown): Generator<AgentEvent>;
} {
  let threadId: string | undefined;
  return {
    *translate(raw: unknown): Generator<AgentEvent> {
      if (!raw || typeof raw !== 'object') return;
      const evt = raw as CodexRawEvent;

      switch (evt.type) {
        case 'thread.started':
          if (typeof evt.thread_id === 'string') {
            threadId = evt.thread_id;
            yield { type: 'system', sessionId: evt.thread_id };
          }
          return;

        case 'turn.started':
          return;

        case 'item.started':
          yield* translateStartedItem(evt.item);
          return;

        case 'item.completed':
          yield* translateCompletedItem(evt.item);
          return;

        case 'turn.completed':
          if (evt.usage) {
            yield {
              type: 'usage',
              inputTokens: evt.usage.input_tokens,
              outputTokens: evt.usage.output_tokens,
            };
          }
          yield { type: 'done', sessionId: threadId };
          return;

        case 'turn.failed':
          yield { type: 'error', message: evt.error?.message ?? 'codex turn failed' };
          return;
      }
    },
  };
}

function* translateStartedItem(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item || typeof item.id !== 'string') return;
  if (item.type === 'command_execution') {
    yield {
      type: 'tool_use',
      id: item.id,
      name: 'shell',
      input: { command: (item as CodexCommandExecutionItem).command ?? '' },
    };
  } else if (item.type === 'file_change') {
    yield {
      type: 'tool_use',
      id: item.id,
      name: 'edit',
      input: { changes: (item as CodexFileChangeItem).changes ?? [] },
    };
  }
}

function* translateCompletedItem(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item) return;
  if (item.type === 'agent_message') {
    const text = (item as CodexAgentMessageItem).text;
    if (text) yield { type: 'text', delta: text };
  } else if (item.type === 'command_execution' && typeof item.id === 'string') {
    const cmd = item as CodexCommandExecutionItem;
    yield {
      type: 'tool_result',
      id: item.id,
      output: cmd.aggregated_output ?? '',
      isError: typeof cmd.exit_code === 'number' && cmd.exit_code !== 0,
    };
  } else if (item.type === 'file_change' && typeof item.id === 'string') {
    yield {
      type: 'tool_result',
      id: item.id,
      output: summarizeFileChanges((item as CodexFileChangeItem).changes),
      isError: false,
    };
  }
}

function summarizeFileChanges(changes: Array<{ path?: string; kind?: string }> | undefined): string {
  if (!changes || changes.length === 0) return '(no changes)';
  return changes.map((c) => `${c.kind ?? '?'} ${c.path ?? '?'}`).join('\n');
}
