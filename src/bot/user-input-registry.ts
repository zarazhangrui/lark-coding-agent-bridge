import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import type {
  AgentUserInputQuestion,
  AgentUserInputRequest,
  AgentUserInputResponse,
  NonEmptyReadonlyArray,
} from '../agent/types';
import type { CallbackAuth } from '../card/callback-auth';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { log } from '../core/logger';

export const CODEX_USER_INPUT_MARKER = '__codex_user_input';

interface UserInputRegistryOptions {
  channel: LarkChannel;
  callbackAuth?: CallbackAuth;
  createInteractionId?: () => string;
  submittedUpdateDelayMs?: number;
  callbackTtlMs?: number;
}

export interface RegisterUserInputRequest {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  policyFingerprint: string;
  request: AgentUserInputRequest;
  replyTo: string;
  replyInThread: boolean;
}

export interface UserInputCardAction {
  interactionId: string;
  token: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  activeRunId?: string;
  formValue?: Record<string, unknown>;
}

interface InteractionContext {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  policyFingerprint: string;
}

interface QuestionField {
  questionId: string;
  selectName: string;
  choices: ReadonlyMap<string, string>;
  other?: {
    choiceValue: string;
    inputName: string;
  };
}

type CardDelivery =
  | { kind: 'sending' }
  | { kind: 'sent'; messageId: string };

interface ActiveInteraction {
  context: InteractionContext;
  request: AgentUserInputRequest;
  fields: NonEmptyReadonlyArray<QuestionField>;
  card: CardDelivery;
  signal: AbortSignal;
  onAbort(): void;
  expiryTimer: ReturnType<typeof setTimeout>;
  resolve(response: AgentUserInputResponse): void;
  reject(error: Error): void;
}

const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

export class UserInputRegistry {
  private readonly channel: LarkChannel;
  private readonly callbackAuth: CallbackAuth | undefined;
  private readonly createInteractionId: () => string;
  private readonly submittedUpdateDelayMs: number;
  private readonly callbackTtlMs: number;
  private readonly active = new Map<string, ActiveInteraction>();

  constructor(options: UserInputRegistryOptions) {
    this.channel = options.channel;
    this.callbackAuth = options.callbackAuth;
    this.createInteractionId = options.createInteractionId ?? randomUUID;
    this.submittedUpdateDelayMs = options.submittedUpdateDelayMs ?? 1000;
    this.callbackTtlMs = positiveDuration(options.callbackTtlMs ?? CALLBACK_TTL_MS);
  }

  async request(input: RegisterUserInputRequest, signal: AbortSignal): Promise<AgentUserInputResponse> {
    if (!this.callbackAuth) {
      throw new Error('飞书回调鉴权未初始化，无法安全展示 Codex 用户输入表单');
    }
    if (signal.aborted) throw abortError(signal);

    const interactionId = nonEmptyId(this.createInteractionId(), 'interaction id');
    if (this.active.has(interactionId)) {
      throw new Error('用户输入 interaction id 冲突');
    }
    const context: InteractionContext = {
      runId: input.runId,
      scope: input.scope,
      chatId: input.chatId,
      operatorOpenId: input.operatorOpenId,
      policyFingerprint: input.policyFingerprint,
    };
    const fields = buildQuestionFields(input.request.questions);
    let resolveAnswer!: (response: AgentUserInputResponse) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<AgentUserInputResponse>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    // Cancellation can happen while sendManagedCard is still awaiting the
    // network. Attach a rejection observer immediately so that narrow race
    // cannot surface as an unhandled rejection before this method returns the
    // answer promise to the app-server handler.
    void answer.catch(() => {});
    const onAbort = (): void => this.cancel(interactionId, abortError(signal));
    const expiryTimer = this.createExpiryTimer(interactionId);
    const entry: ActiveInteraction = {
      context,
      request: input.request,
      fields,
      card: { kind: 'sending' },
      signal,
      onAbort,
      expiryTimer,
      resolve: resolveAnswer,
      reject: rejectAnswer,
    };
    this.active.set(interactionId, entry);
    signal.addEventListener('abort', onAbort, { once: true });

    const token = this.sign(entry, interactionId);
    let messageId: string;
    try {
      ({ messageId } = await sendManagedCard(
        this.channel,
        input.chatId,
        renderQuestionCard(interactionId, entry, token),
        {
          replyTo: input.replyTo,
          ...(input.replyInThread ? { replyInThread: true } : {}),
        },
      ));
    } catch (err) {
      this.cancel(interactionId, new Error(`发送 Codex 用户输入卡片失败：${errorMessage(err)}`));
      throw err;
    }

    const current = this.active.get(interactionId);
    if (current === entry) {
      current.card = { kind: 'sent', messageId };
    } else {
      updateTerminalCard(
        this.channel,
        messageId,
        'invalid',
        'late-invalid-card-update-failed',
      );
    }
    return answer;
  }

  async handleCardAction(action: UserInputCardAction): Promise<boolean> {
    const entry = this.active.get(action.interactionId);
    if (!entry || entry.card.kind !== 'sent') {
      log.warn('user-input', 'submit-denied', { reason: 'unknown-or-ended' });
      return true;
    }
    if (
      action.scope !== entry.context.scope ||
      action.chatId !== entry.context.chatId ||
      action.operatorOpenId !== entry.context.operatorOpenId ||
      action.activeRunId !== entry.context.runId
    ) {
      log.warn('user-input', 'submit-denied', { reason: 'context-mismatch' });
      return true;
    }
    const auth = this.callbackAuth;
    if (!auth) {
      log.warn('user-input', 'submit-denied', { reason: 'auth-unavailable' });
      return true;
    }
    const verified = auth.verify(action.token, {
      runId: entry.context.runId,
      scope: entry.context.scope,
      chatId: entry.context.chatId,
      operatorOpenId: entry.context.operatorOpenId,
      action: callbackAction(action.interactionId),
      policyFingerprint: entry.context.policyFingerprint,
    });
    if (!verified.ok) {
      log.warn('user-input', 'submit-denied', { reason: verified.reason });
      return true;
    }

    const parsed = parseAnswers(entry, action.formValue);
    if (!parsed.ok) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = this.createExpiryTimer(action.interactionId);
      const retryToken = this.sign(entry, action.interactionId);
      try {
        await updateManagedCard(
          this.channel,
          entry.card.messageId,
          renderQuestionCard(action.interactionId, entry, retryToken, parsed.message),
        );
      } catch (err) {
        this.cancel(
          action.interactionId,
          new Error(`更新 Codex 用户输入重试卡片失败：${errorMessage(err)}`),
        );
        throw err;
      }
      return true;
    }

    this.active.delete(action.interactionId);
    entry.signal.removeEventListener('abort', entry.onAbort);
    clearTimeout(entry.expiryTimer);
    entry.resolve(parsed.response);
    const messageId = entry.card.messageId;
    const timer = setTimeout(() => {
      updateTerminalCard(
        this.channel,
        messageId,
        'submitted',
        'submitted-card-update-failed',
      );
    }, this.submittedUpdateDelayMs);
    timer.unref?.();
    return true;
  }

  cancelAll(reason = 'Bridge channel 已关闭'): void {
    for (const interactionId of [...this.active.keys()]) {
      this.cancel(interactionId, new Error(reason));
    }
  }

  activeCount(): number {
    return this.active.size;
  }

  private sign(entry: ActiveInteraction, interactionId: string): string {
    if (!this.callbackAuth) throw new Error('飞书回调鉴权未初始化');
    return this.callbackAuth.sign({
      runId: entry.context.runId,
      scope: entry.context.scope,
      chatId: entry.context.chatId,
      operatorOpenId: entry.context.operatorOpenId,
      action: callbackAction(interactionId),
      policyFingerprint: entry.context.policyFingerprint,
      ttlMs: this.callbackTtlMs,
    });
  }

  private createExpiryTimer(interactionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.cancel(interactionId, new Error('Codex 用户输入请求已过期'));
    }, this.callbackTtlMs);
    timer.unref?.();
    return timer;
  }

  private cancel(interactionId: string, error: Error): void {
    const entry = this.active.get(interactionId);
    if (!entry) return;
    this.active.delete(interactionId);
    entry.signal.removeEventListener('abort', entry.onAbort);
    clearTimeout(entry.expiryTimer);
    entry.reject(error);
    if (entry.card.kind === 'sent') {
      updateTerminalCard(
        this.channel,
        entry.card.messageId,
        'invalid',
        'invalid-card-update-failed',
      );
    }
  }
}

function updateTerminalCard(
  channel: LarkChannel,
  messageId: string,
  state: 'submitted' | 'invalid',
  failureEvent: string,
): void {
  void updateManagedCard(channel, messageId, renderTerminalCard(state))
    .catch((err) => {
      log.warn('user-input', failureEvent, { err: errorMessage(err) });
    })
    .finally(() => forgetManagedCard(messageId));
}

function buildQuestionFields(
  questions: NonEmptyReadonlyArray<AgentUserInputQuestion>,
): NonEmptyReadonlyArray<QuestionField> {
  return questions.map((question, questionIndex) => {
    const choices = new Map<string, string>();
    question.options.forEach((option, optionIndex) => {
      choices.set(`choice_${questionIndex}_${optionIndex}`, option.label);
    });
    return {
      questionId: question.id,
      selectName: `bridge_question_${questionIndex}`,
      choices,
      ...(question.allowOther
        ? {
            other: {
              choiceValue: `other_${questionIndex}`,
              inputName: `bridge_other_${questionIndex}`,
            },
          }
        : {}),
    };
  }) as unknown as NonEmptyReadonlyArray<QuestionField>;
}

function parseAnswers(
  entry: ActiveInteraction,
  formValue: Record<string, unknown> | undefined,
): { ok: true; response: AgentUserInputResponse } | { ok: false; message: string } {
  if (!formValue) return { ok: false, message: '请回答所有问题后再提交。' };
  const answers: Array<{ questionId: string; value: string }> = [];
  for (const field of entry.fields) {
    const selected = formValue[field.selectName];
    if (typeof selected !== 'string') {
      return { ok: false, message: '请回答所有问题后再提交。' };
    }
    const label = field.choices.get(selected);
    if (label) {
      answers.push({ questionId: field.questionId, value: label });
      continue;
    }
    if (field.other && selected === field.other.choiceValue) {
      const other = formValue[field.other.inputName];
      if (typeof other !== 'string' || other.trim().length === 0) {
        return { ok: false, message: '选择“其他”时，请填写对应的自定义回答。' };
      }
      answers.push({ questionId: field.questionId, value: other.trim() });
      continue;
    }
    return { ok: false, message: '表单包含无法识别的选项，请重新选择。' };
  }
  return {
    ok: true,
    response: {
      answers: answers as unknown as NonEmptyReadonlyArray<{ questionId: string; value: string }>,
    },
  };
}

function renderQuestionCard(
  interactionId: string,
  entry: ActiveInteraction,
  token: string,
  error?: string,
): object {
  const elements: object[] = [];
  if (error) {
    elements.push({ tag: 'markdown', content: `⚠️ **${escapeMarkdown(error)}**` });
  }
  entry.request.questions.forEach((question, questionIndex) => {
    const field = entry.fields[questionIndex]!;
    elements.push({
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(question.header)}**`,
        escapeMarkdown(question.question),
        '',
        ...question.options.map(
          (option) => `- **${escapeMarkdown(option.label)}** — ${escapeMarkdown(option.description)}`,
        ),
      ].join('\n'),
    });
    elements.push({
      tag: 'select_static',
      name: field.selectName,
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: [
        ...[...field.choices.entries()].map(([value, label]) => ({
          text: { tag: 'plain_text', content: label },
          value,
        })),
        ...(field.other
          ? [{ text: { tag: 'plain_text', content: '其他' }, value: field.other.choiceValue }]
          : []),
      ],
    });
    if (field.other) {
      elements.push({
        tag: 'input',
        name: field.other.inputName,
        input_type: 'text',
        placeholder: { tag: 'plain_text', content: '若选择“其他”，请在这里填写' },
      });
    }
  });
  elements.push({
    tag: 'button',
    name: 'bridge_user_input_submit',
    text: { tag: 'plain_text', content: '提交回答' },
    type: 'primary',
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          [CODEX_USER_INPUT_MARKER]: true,
          interaction_id: interactionId,
          bridge_token: token,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: 'Codex 正在等待你的选择' } },
    header: { title: { tag: 'plain_text', content: 'Codex 需要你的确认' } },
    body: {
      elements: [{ tag: 'form', name: 'bridge_user_input_form', elements }],
    },
  };
}

function renderTerminalCard(state: 'submitted' | 'invalid'): object {
  const submitted = state === 'submitted';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: submitted ? '回答已提交' : '请求已失效' } },
    header: {
      template: submitted ? 'green' : 'grey',
      title: { tag: 'plain_text', content: submitted ? '回答已提交' : '请求已失效' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: submitted
            ? '✅ 已收到回答，Codex 正在继续执行。'
            : '此输入请求已经结束，无法再次提交。',
        },
      ],
    },
  };
}

function callbackAction(interactionId: string): string {
  return `codex_user_input:${interactionId}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Codex 用户输入请求已取消');
}

function nonEmptyId(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} 不能为空`);
  return value;
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('callback TTL 必须是正数');
  }
  return value;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_`\\])/g, '\\$1');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
