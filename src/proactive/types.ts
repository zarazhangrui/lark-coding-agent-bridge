export type ProactiveAction =
  | 'ignore'
  | 'create'
  | 'complete'
  | 'cancel'
  | 'postpone'
  | 'clarify'
  | 'list'
  | 'settings'
  | 'possible-complex-task';

export type FollowUpStatus = 'proposed' | 'pending' | 'completed' | 'cancelled';

export interface ObserverMention {
  id: string;
  name?: string;
}

export interface ObserverMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  senderName?: string;
  mentions?: ObserverMention[];
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
  /** User who authored the commitment or assignment. */
  createdById?: string;
  /** User responsible for confirming and completing the item. */
  ownerId: string;
  /** Missing while a proposal is waiting for the owner to choose a deadline. */
  dueAt?: number;
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
  /** Successful reminder deliveries, used for limits and auditability. */
  reminderHistory?: number[];
  /** Number of overdue chases sent after the first due reminder. */
  overdueReminderCount?: number;
  /** Next eligible reminder instant. Defaults to dueAt for migrated V1 items. */
  nextReminderAt?: number;
  confirmedAt?: number;
  resolutionMessageId?: string;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface ProactiveUserPreferences {
  userId: string;
  enabled: boolean;
  overdueReminders: boolean;
  dailyReminderLimit: number;
  quietHours?: QuietHours;
  updatedAt: number;
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
  version: 3;
  messages: ObserverMessage[];
  decisions: ProactiveDecision[];
  followUps: FollowUp[];
  preferences: ProactiveUserPreferences[];
  tasks: ProactiveTask[];
  taskDashboards?: TaskDashboard[];
  processedMessageIds: string[];
}

export interface DecisionInput {
  message: ObserverMessage;
  recentMessages: ObserverMessage[];
  pendingFollowUps: FollowUp[];
  now: number;
  executionEnabled?: boolean;
}

export interface DecisionResult {
  action: ProactiveAction;
  confidence: number;
  model?: string;
  taskKind?: ProactiveTaskKind;
}

export type ProactiveTaskKind = 'summary' | 'research' | 'draft';
export type ProactiveTaskStatus =
  | 'proposed' | 'needs_input' | 'running' | 'publishing'
  | 'delivered' | 'accepted' | 'failed' | 'cancelled';

export interface TaskDraft {
  title: string;
  content: string;
  sources: Array<{ title: string; url: string }>;
}

/** Each revision has its own confirmation; stale cards never approve new scope. */
export interface ProactiveTask {
  id: string;
  chatId: string;
  threadId?: string;
  sourceMessageId: string;
  ownerId: string;
  kind: ProactiveTaskKind;
  request: string;
  context: ObserverMessage[];
  fingerprint: string;
  revision: number;
  status: ProactiveTaskStatus;
  createdAt: number;
  updatedAt: number;
  approvalRequestedAt?: number;
  confirmedAt?: number;
  confirmedBy?: string;
  cardMessageId?: string;
  cardAttemptedAt?: number;
  progress?: string;
  question?: string;
  error?: string;
  draft?: TaskDraft;
  documentId?: string;
  documentUrl?: string;
  publicationAttemptedAt?: number;
  artifacts: Array<{ revision: number; url: string; title: string }>;
  reviewFollowUpId?: string;
  reviewReminderAt?: number;
  cardSyncError?: string;
}

export interface TaskDashboard {
  chatId: string;
  threadId?: string;
  ownerId: string;
  sourceMessageId: string;
  messageId?: string;
  attemptedAt: number;
  page: number;
}

export interface DecisionProvider {
  decide(input: DecisionInput): Promise<DecisionResult>;
}

