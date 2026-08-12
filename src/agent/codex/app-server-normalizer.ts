import type {
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequest,
  AgentUserInputResponse,
  NonEmptyReadonlyArray,
} from '../types';

const MINIMUM_CODEX_VERSION = [0, 107, 0] as const;
const OFFICIAL_USER_AGENT = new RegExp(
  '^(?:lark-channel-bridge|codex-cli)/(\\d+)\\.(\\d+)\\.(\\d+)'
    + '(-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?'
    + '(\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\s|\\(|$)',
  'i',
);

export class AppServerCompatibilityError extends Error {
  override readonly name = 'AppServerCompatibilityError';
}

export function normalizeInitializeResult(input: unknown): { userAgent: string } {
  const result = recordValue(input);
  const userAgent = nonEmptyString(result?.userAgent);
  if (!userAgent) {
    throw new AppServerCompatibilityError('initialize 响应缺少 userAgent');
  }
  assertMinimumCodexVersion(userAgent);
  return { userAgent };
}

export function normalizeThreadResult(input: unknown): { threadId: string } {
  const thread = recordValue(recordValue(input)?.thread);
  const threadId = nonEmptyString(thread?.id);
  if (!threadId) throw new Error('thread 响应缺少合法 id');
  return { threadId };
}

export function normalizeTurnResult(input: unknown): { turnId: string } {
  const turn = recordValue(recordValue(input)?.turn);
  const turnId = nonEmptyString(turn?.id);
  if (!turnId) throw new Error('turn/start 响应缺少合法 turn id');
  return { turnId };
}

export function normalizeUserInputRequest(input: unknown): AgentUserInputRequest {
  const params = recordValue(input);
  const itemId = nonEmptyString(params?.itemId);
  if (!itemId) throw new Error('缺少 itemId');
  if (!Array.isArray(params?.questions) || params.questions.length < 1 || params.questions.length > 3) {
    throw new Error('questions 必须包含 1 到 3 个问题');
  }

  const ids = new Set<string>();
  const questions = params.questions.map((raw, questionIndex): AgentUserInputQuestion => {
    const question = recordValue(raw);
    const id = nonEmptyString(question?.id);
    const header = nonEmptyString(question?.header);
    const prompt = nonEmptyString(question?.question);
    if (!id || !header || !prompt) throw new Error(`第 ${questionIndex + 1} 个问题字段不完整`);
    if (!question) throw new Error(`第 ${questionIndex + 1} 个问题不是对象`);
    if (ids.has(id)) throw new Error(`问题 id 重复：${id}`);
    ids.add(id);

    const isSecret = optionalBoolean(question, 'isSecret', false);
    if (isSecret) throw new Error(`不支持 secret 问题：${id}`);
    const allowOther = optionalBoolean(question, 'isOther', false);
    if (!Array.isArray(question.options) || question.options.length < 1) {
      throw new Error(`问题 ${id} 缺少选项`);
    }

    const labels = new Set<string>();
    const options = question.options.map((rawOption, optionIndex): AgentUserInputOption => {
      const option = recordValue(rawOption);
      const label = nonEmptyString(option?.label);
      const description = nonEmptyString(option?.description);
      if (!label || !description) throw new Error(`问题 ${id} 的第 ${optionIndex + 1} 个选项不完整`);
      if (labels.has(label)) throw new Error(`问题 ${id} 的选项标签重复：${label}`);
      labels.add(label);
      return { label, description };
    });
    return { id, header, question: prompt, allowOther, options: asNonEmpty(options) };
  });
  return { id: itemId, questions: asNonEmpty(questions) };
}

export function serializeUserInputResponse(
  request: AgentUserInputRequest,
  response: AgentUserInputResponse,
): Record<string, { answers: [string] }> {
  if (!Array.isArray(response.answers) || response.answers.length < 1) {
    throw new Error('回答集合为空');
  }

  const expected = new Map(request.questions.map((question) => [question.id, question]));
  const result = new Map<string, { answers: [string] }>();
  for (const rawAnswer of response.answers as readonly unknown[]) {
    const answer = recordValue(rawAnswer);
    const questionId = nonEmptyString(answer?.questionId);
    if (!questionId) throw new Error('回答缺少合法 questionId');
    const question = expected.get(questionId);
    if (!question) throw new Error(`回答包含未知问题：${questionId}`);
    if (result.has(questionId)) throw new Error(`问题被重复回答：${questionId}`);

    const value = nonEmptyString(answer?.value);
    if (!value) throw new Error(`问题 ${questionId} 包含空回答`);
    const knownOption = question.options.some((option) => option.label === value);
    if (!knownOption && !question.allowOther) {
      throw new Error(`问题 ${questionId} 的回答不在合法选项中`);
    }
    result.set(questionId, { answers: [value] });
  }
  for (const question of request.questions) {
    if (!result.has(question.id)) throw new Error(`问题未回答：${question.id}`);
  }
  return Object.fromEntries(result);
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function assertMinimumCodexVersion(userAgent: string): void {
  const match = OFFICIAL_USER_AGENT.exec(userAgent);
  if (!match) return;
  const version = match.slice(1, 4).map(Number);
  if (version.some((part) => !Number.isSafeInteger(part))) return;
  const [major, minor, patch] = version as [number, number, number];
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_CODEX_VERSION;
  const numericEqualToMinimum = major === minimumMajor
    && minor === minimumMinor
    && patch === minimumPatch;
  const belowMinimum = major < minimumMajor
    || (major === minimumMajor && minor < minimumMinor)
    || (major === minimumMajor && minor === minimumMinor && patch < minimumPatch)
    || (numericEqualToMinimum && match[4] !== undefined);
  if (belowMinimum) {
    throw new AppServerCompatibilityError(
      `Codex CLI ${major}.${minor}.${patch}${match[4] ?? ''} 低于最低支持版本 0.107.0`,
    );
  }
}

function optionalBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = record?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} 必须是 boolean`);
  return value;
}

function asNonEmpty<T>(values: T[]): NonEmptyReadonlyArray<T> {
  const first = values[0];
  if (first === undefined) throw new Error('集合不能为空');
  return [first, ...values.slice(1)];
}
