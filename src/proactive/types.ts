export type ProactiveAction =
  | 'ignore'
  | 'create'
  | 'complete'
  | 'cancel'
  | 'postpone'
  | 'clarify'
  | 'possible-complex-task';

export type FollowUpStatus = 'pending' | 'completed' | 'cancelled';

export interface ObserverMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  senderName?: string;
  text: string;
  createTime: number;
}

export interface FollowUp {
  id: string;
  chatId: string;
  /** Feishu topic/thread that owns this follow-up, when present. */
  threadId?: string;
  sourceMessageId: string;
  summary: string;
  ownerId: string;
  dueAt: number;
  status: FollowUpStatus;
  createdAt: number;
  updatedAt: number;
  /** Persisted before sending the immediate "recorded" receipt card. */
  receiptAttemptedAt?: number;
  receiptSentAt?: number;
  receiptMessageId?: string;
  /**
   * Persisted before the outbound call. Feishu message creation has no
   * idempotency key, so an attempted reminder is never retried automatically
   * after an ambiguous transport failure.
   */
  reminderAttemptedAt?: number;
  reminderSentAt?: number;
  reminderMessageId?: string;
  resolutionMessageId?: string;
}

export interface ProactiveDecision {
  messageId: string;
  chatId: string;
  action: ProactiveAction;
  confidence: number;
  outcome: 'ignored' | 'shadow' | 'applied' | 'failed';
  decidedAt: number;
  targetFollowUpId?: string;
  reason?: string;
}

export interface ProactiveState {
  version: 1;
  messages: ObserverMessage[];
  decisions: ProactiveDecision[];
  followUps: FollowUp[];
  processedMessageIds: string[];
}

export interface DecisionInput {
  message: ObserverMessage;
  recentMessages: ObserverMessage[];
  pendingFollowUps: FollowUp[];
  now: number;
}

export interface DecisionResult {
  action: ProactiveAction;
  confidence: number;
  model?: string;
}

export interface DecisionProvider {
  decide(input: DecisionInput): Promise<DecisionResult>;
}

