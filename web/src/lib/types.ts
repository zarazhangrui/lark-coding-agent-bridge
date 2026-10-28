export type AgentKind = "claude" | "codex" | "omp";
export type ProfileMode = "personal" | "team";
export type LarkCliIdentity = "bot-only" | "user-default";
export type MessageReply = "card" | "markdown" | "text";
export type CotMessages = "off" | "brief" | "detailed";

export interface Status {
  hosted: boolean;
  version: string;
  activeProfile?: string;
  online: number;
}

export interface BotInfo {
  id: string;
  pid: number;
  appId?: string;
  profileName: string;
  agentKind: AgentKind;
  version: string;
  botName?: string;
  startedAt?: string;
  uptimeMs: number;
}

export interface ProfileInfo {
  name: string;
  agentKind: AgentKind;
  active: boolean;
  running: boolean;
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ConfigView {
  profile: string;
  agentKind: AgentKind;
  mode: ProfileMode;
  model: string;
  models: ModelOption[];
  messageReply: MessageReply;
  showToolCalls: boolean;
  cotMessages: CotMessages;
  maxConcurrentRuns: number;
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentity;
  meeting: MeetingConfig;
  access: {
    allowedUsers: string[];
    allowedChats: string[];
    admins: string[];
    /** chat_id → per-chat @-mention override (overrides requireMentionInGroup). */
    chatRequireMention: Record<string, boolean>;
  };
  /** True when this profile's process hosts the UI (edits apply live). */
  live?: boolean;
}

/** A chat the bot is a member of, for the group picker. */
export interface KnownChat {
  id: string;
  name: string;
}

/** Owner user-identity auth status (for the "我的群" picker). */
export interface UserAuthStatus {
  loggedIn: boolean;
  userName?: string;
  openId?: string;
  scopes: string[];
}

/** OAuth device-flow start response. */
export interface DeviceLogin {
  verificationUrl: string;
  userCode?: string;
  deviceCode: string;
  expiresIn?: number;
}

/** A group the owner is in (for the "我的群" picker). */
export interface UserChat {
  id: string;
  name: string;
  botInIt: boolean;
}

// ── in-meeting agent ──────────────────────────────────────────────────────────

export type MeetingRespondIn = "meeting" | "im" | "both";
export type MeetingSummaryTarget = "origin" | "owner";

export interface MeetingConfig {
  enabled: boolean;
  autoJoinOnInvite: boolean;
  transcript: { keep: number; stabilizeMs: number };
  respondIn: MeetingRespondIn;
  trigger: string;
  pollIntervalMs: number;
  summaryOnEnd: boolean;
  summaryTarget: MeetingSummaryTarget;
}

export interface MeetingSessionInfo {
  meetingId: string;
  meetingNo: string;
  topic?: string;
  startedAt: string;
  source: "push" | "poll";
  transcriptLines: number;
  participants: number;
  ingested: number;
  /** Raw activity items per event type; `?`-prefixed keys were unparseable. */
  eventCounts: Record<string, number>;
  ended: boolean;
}

export interface MeetingsView {
  available: boolean;
  reason?: string;
  sessions: MeetingSessionInfo[];
  push: { hooked: boolean; reason?: string; received: number; lastAt?: string };
}

export interface MeetingPreflight {
  status: "ok" | "scope-missing" | "not-in-beta" | "unknown";
  message: string;
  missingScopes: string[];
  /** Feishu scope-apply URL — opaque, render as link/QR only. */
  consoleUrl?: string;
  requiredEvents: string[];
  /** Every app scope the feature needs, with what each unlocks. */
  requiredScopes: { scope: string; purpose: string }[];
  betaChatUrl?: string;
}

export interface OnboardState {
  hasConfig: boolean;
  activeProfile?: string;
  profiles: string[];
  detectedAgents: AgentKind[];
}
