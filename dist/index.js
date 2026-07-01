// src/card/tool-render.ts
var HEADER_SUMMARY_MAX = 80;
var BODY_FIELD_MAX = 600;
var OUTPUT_MAX = 1200;
var BODY_TOTAL_MAX = 2500;
function toolHeaderText(tool) {
  const icon = tool.status === "done" ? "\u2705" : tool.status === "error" ? "\u274C" : "\u23F3";
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** \u2014 ${summary}` : `${icon} **${tool.name}**`;
}
function toolBodyMd(tool) {
  const parts = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);
  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === "error") {
      parts.push(`**Error**
\`\`\`
${truncated}
\`\`\``);
    } else if (tool.name === "Bash") {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**
\`\`\`
${truncated}
\`\`\``);
    }
  } else if (tool.status === "running") {
    parts.push("_\u8FD0\u884C\u4E2D\u2026_");
  }
  const body = parts.join("\n\n");
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}\u2026

_\uFF08body \u5DF2\u622A\u65AD,\u5B8C\u6574\u5185\u5BB9\u67E5 \`/doctor\` \u6216\u65E5\u5FD7\uFF09_`;
}
function summarizeInput(name, input) {
  if (!input || typeof input !== "object") return "";
  const rec = input;
  const pick = (key, max = HEADER_SUMMARY_MAX) => {
    const v = rec[key];
    if (typeof v !== "string") return "";
    const oneLine = v.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}\u2026` : oneLine;
  };
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return shortenPath(pick("file_path"));
    case "Grep": {
      const pat = pick("pattern", 40);
      const path = pick("path", 30);
      return path ? `${pat} in ${shortenPath(path)}` : pat;
    }
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query", 60);
    case "Agent":
    case "Task":
      return pick("description") || pick("subagent_type");
    default:
      return pick("command") || pick("file_path") || pick("path") || pick("query");
  }
}
function renderInput(tool) {
  const input = tool.input;
  if (!input || typeof input !== "object") return "";
  const rec = input;
  const str = (k) => typeof rec[k] === "string" ? rec[k] : "";
  switch (tool.name) {
    case "Bash": {
      const cmd = str("command");
      return cmd ? `**Command**
\`\`\`bash
${truncate(cmd, BODY_FIELD_MAX)}
\`\`\`` : "";
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = str("file_path");
      return fp ? `**File** \`${fp}\`` : "";
    }
    case "Grep": {
      const lines = [];
      if (str("pattern")) lines.push(`**Pattern** \`${str("pattern")}\``);
      if (str("path")) lines.push(`**Path** \`${str("path")}\``);
      return lines.join("\n");
    }
    case "WebFetch":
      return str("url") ? `**URL** ${str("url")}` : "";
    case "WebSearch":
      return str("query") ? `**Query** \`${truncate(str("query"), BODY_FIELD_MAX)}\`` : "";
    default:
      return "";
  }
}
function renderBashOutput(out) {
  return `**Output**
\`\`\`
${out}
\`\`\``;
}
function shortenPath(p) {
  return p;
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

// src/card/run-renderer.ts
var REASONING_MAX = 1500;
var COLLAPSE_TOOL_THRESHOLD = 3;
function renderCard(state, options = {}) {
  const presentationMode = options.presentationMode ?? "debug";
  const elements = [];
  if (presentationMode === "debug" && state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === "text") {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else if (presentationMode === "debug") {
      elements.push(...renderToolGroup(group.tools, state.terminal !== "running"));
    }
  }
  if (state.terminal === "interrupted") {
    elements.push(noteMd("_\u23F9 \u5DF2\u88AB\u4E2D\u65AD_"));
  } else if (state.terminal === "idle_timeout") {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_\u23F1 ${mins} \u5206\u949F\u65E0\u54CD\u5E94,\u5DF2\u81EA\u52A8\u7EC8\u6B62_`));
  } else if (state.terminal === "error" && state.errorMsg) {
    elements.push(noteMd(`\u26A0\uFE0F agent \u5931\u8D25\uFF1A${state.errorMsg}`));
  } else if (state.terminal === "done" && elements.length === 0) {
    elements.push(noteMd("_\uFF08\u672A\u8FD4\u56DE\u5185\u5BB9\uFF09_"));
  }
  if (state.terminal === "running") {
    const status = presentationMode === "debug" ? state.footer ? footerStatus(state.footer) : void 0 : presentationStatus(state.footer, presentationMode);
    if (status) elements.push(status);
    elements.push(stopButton(options));
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: state.terminal === "running",
      summary: { content: summaryText(state, presentationMode) }
    },
    body: { elements }
  };
}
function* groupBlocks(blocks) {
  let toolBuf = [];
  for (const b of blocks) {
    if (b.kind === "tool") {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: "tools", tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: "text", content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: "tools", tools: toolBuf };
}
function renderToolGroup(tools, finalized) {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}
function reasoningPanel(content, active2) {
  const title = active2 ? "\u{1F9E0} **\u601D\u8003\u4E2D**" : "\u{1F9E0} **\u601D\u8003\u5B8C\u6210\uFF0C\u70B9\u51FB\u67E5\u770B**";
  return collapsiblePanel({
    title,
    expanded: active2,
    border: "grey",
    body: truncate2(content, REASONING_MAX)
  });
}
function toolPanel(tool, expanded) {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === "error" ? "red" : "grey",
    body: toolBodyMd(tool) || "_\u65E0\u8F93\u51FA_"
  });
}
function collapsedToolSummary(tools, finalized) {
  const suffix = finalized ? "\uFF08\u5DF2\u7ED3\u675F\uFF09" : "";
  const title = `\u2615 **${tools.length} \u4E2A\u5DE5\u5177\u8C03\u7528${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join("\n");
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: panelHeader(title),
    border: { color: "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: headerList, text_size: "notation" }]
  };
}
function collapsiblePanel(opts) {
  return {
    tag: "collapsible_panel",
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: opts.body, text_size: "notation" }]
  };
}
function panelHeader(titleMd) {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180
  };
}
function markdown(content) {
  return { tag: "markdown", content };
}
function noteMd(content) {
  return { tag: "markdown", content, text_size: "notation" };
}
function stopButton(options) {
  const value = { cmd: "stop" };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback("stop");
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: "\u23F9 \u7EC8\u6B62" },
    type: "danger",
    behaviors: [{ type: "callback", value }]
  };
}
function footerStatus(status) {
  const text = status === "thinking" ? "\u{1F9E0} \u6B63\u5728\u601D\u8003" : status === "tool_running" ? "\u{1F9F0} \u6B63\u5728\u8C03\u7528\u5DE5\u5177" : "\u270D\uFE0F \u6B63\u5728\u8F93\u51FA";
  return noteMd(text);
}
function presentationStatus(status, mode) {
  if (mode === "clean") return noteMd("_\u5904\u7406\u4E2D\u2026_");
  const text = status === "thinking" ? "_\u5904\u7406\u4E2D\uFF1A\u89C4\u5212\u4E2D\u2026_" : status === "tool_running" ? "_\u5904\u7406\u4E2D\uFF1A\u6267\u884C\u5185\u90E8\u6B65\u9AA4\u2026_" : status === "streaming" ? "_\u5904\u7406\u4E2D\uFF1A\u6574\u7406\u56DE\u590D\u2026_" : "_\u5904\u7406\u4E2D\u2026_";
  return noteMd(text);
}
function summaryText(state, mode) {
  if (state.terminal === "interrupted") return "\u5DF2\u4E2D\u65AD";
  if (state.terminal === "idle_timeout") return "\u5DF2\u8D85\u65F6";
  if (state.terminal === "error") return "\u51FA\u9519";
  if (state.terminal === "done") return "\u5DF2\u5B8C\u6210";
  if (mode === "clean") return "\u5904\u7406\u4E2D";
  if (state.footer === "tool_running") return "\u6B63\u5728\u8C03\u7528\u5DE5\u5177";
  if (state.footer === "streaming") return "\u6B63\u5728\u8F93\u51FA";
  return "\u601D\u8003\u4E2D";
}
function truncate2(s, max) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

// src/card/text-renderer.ts
function renderText(state, options = {}) {
  const presentationMode = options.presentationMode ?? "debug";
  const parts = [];
  for (const block of state.blocks) {
    const piece = renderBlock(block, presentationMode);
    if (piece) parts.push(piece);
  }
  if (state.terminal === "interrupted") {
    parts.push("_\u23F9 \u5DF2\u88AB\u4E2D\u65AD_");
  } else if (state.terminal === "idle_timeout") {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_\u23F1 ${mins} \u5206\u949F\u65E0\u54CD\u5E94,\u5DF2\u81EA\u52A8\u7EC8\u6B62_`);
  } else if (state.terminal === "error" && state.errorMsg) {
    parts.push(`\u26A0\uFE0F agent \u5931\u8D25:${state.errorMsg}`);
  } else if (state.terminal === "running" && state.footer) {
    parts.push(footerLine(state.footer, presentationMode));
  }
  return parts.join("\n\n");
}
function renderBlock(block, presentationMode) {
  if (block.kind === "text") {
    return block.content.trim();
  }
  if (presentationMode !== "debug") return "";
  return toolLine(block.tool);
}
function toolLine(tool) {
  return `> ${toolHeaderText(tool)}`;
}
function footerLine(status, presentationMode) {
  if (presentationMode === "clean") return "_\u5904\u7406\u4E2D\u2026_";
  if (presentationMode === "progress") {
    if (status === "thinking") return "_\u5904\u7406\u4E2D\uFF1A\u89C4\u5212\u4E2D\u2026_";
    if (status === "tool_running") return "_\u5904\u7406\u4E2D\uFF1A\u6267\u884C\u5185\u90E8\u6B65\u9AA4\u2026_";
    return "_\u5904\u7406\u4E2D\uFF1A\u6574\u7406\u56DE\u590D\u2026_";
  }
  if (status === "thinking") return "_\u{1F9E0} \u6B63\u5728\u601D\u8003\u2026_";
  if (status === "tool_running") return "_\u{1F9F0} \u6B63\u5728\u8C03\u7528\u5DE5\u5177\u2026_";
  return "_\u270D\uFE0F \u6B63\u5728\u8F93\u51FA\u2026_";
}

// src/card/run-state.ts
var initialState = {
  blocks: [],
  reasoning: { content: "", active: false },
  footer: "thinking",
  terminal: "running"
};
function closeStreamingText(blocks) {
  return blocks.map(
    (b) => b.kind === "text" && b.streaming ? { ...b, streaming: false } : b
  );
}
function reduce(state, evt) {
  switch (evt.type) {
    case "text": {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === "text" && last.streaming) {
        const next = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: "streaming"
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: "text", content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: "streaming"
      };
    }
    case "thinking": {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: "thinking"
      };
    }
    case "tool_use": {
      const tool = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: "running"
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: "tool", tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: "tool_running"
      };
    }
    case "tool_result": {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== "tool" || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? "error" : "done",
            output: evt.output
          }
        };
      });
      return { ...state, blocks };
    }
    case "error": {
      const terminal = evt.terminationReason === "interrupted" ? "interrupted" : evt.terminationReason === "timeout" ? "idle_timeout" : "error";
      return {
        ...state,
        terminal,
        errorMsg: terminal === "error" ? evt.message : state.errorMsg,
        footer: null
      };
    }
    case "done": {
      const terminal = evt.terminationReason === "interrupted" ? "interrupted" : evt.terminationReason === "timeout" ? "idle_timeout" : "done";
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null
      };
    }
    default:
      return state;
  }
}
function markInterrupted(state) {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "interrupted",
    footer: null
  };
}
function finalizeIfRunning(state) {
  if (state.terminal !== "running") return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "done",
    footer: null
  };
}

// src/core/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import { createWriteStream, mkdirSync } from "fs";
import { open, readdir, rm, stat } from "fs/promises";
import { join } from "path";

// src/core/telemetry.ts
var noop = {
  emit() {
  },
  recordError() {
  },
  recordMetric() {
  },
  flush() {
  },
  close() {
  }
};
var active = noop;
function telemetry() {
  return active;
}

// src/core/logger.ts
var DEFAULT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 30) || 30
);
var als = new AsyncLocalStorage();
var RAW_PAYLOAD_KEYS = /* @__PURE__ */ new Set([
  "prompt",
  "stdout",
  "stderr",
  "env",
  "environment",
  "proxy"
]);
var RESOURCE_ID_KEYS = /* @__PURE__ */ new Set(["fileKey", "sourceFileKey"]);
var ID_KEYS = /* @__PURE__ */ new Set([
  "chatId",
  "senderId",
  "sender",
  "openId",
  "operatorId",
  "userId",
  "msgId",
  "messageId",
  "sourceMessageId",
  "sessionId",
  "threadId",
  "docToken",
  "fileToken",
  "fileKey",
  "sourceFileKey",
  "commentId",
  "rootCommentId",
  "replyId",
  "reactionId",
  "scope",
  "appId"
]);
var MAX_LOG_STRING_CHARS = 4096;
var CREDENTIAL_JSON_FIELD_RE = /("(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)"\s*:\s*")[^"]*(")/gi;
var ESCAPED_CREDENTIAL_JSON_FIELD_RE = /(\\\"(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;
var RESOURCE_JSON_FIELD_RE = /("(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)"\s*:\s*")[^"]*(")/gi;
var ESCAPED_RESOURCE_JSON_FIELD_RE = /(\\\"(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;
var EXTERNAL_SANITIZE = { redactIds: true };
function sanitizeLogValue(key, value, options = EXTERNAL_SANITIZE) {
  const normalizedKey = key.startsWith("_") ? key.slice(1) : key;
  if (value === void 0) return void 0;
  if (RAW_PAYLOAD_KEYS.has(normalizedKey)) return "[REDACTED]";
  if (/token|secret|authorization/i.test(normalizedKey)) return "[REDACTED]";
  if (/attachment.*path|media.*path|^(cwd|cwdRealpath|path|absPath)$/i.test(normalizedKey)) {
    return "[REDACTED_PATH]";
  }
  if (RESOURCE_ID_KEYS.has(normalizedKey)) return "[REDACTED_RESOURCE]";
  if (options.redactIds && ID_KEYS.has(normalizedKey)) return redactId(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item, options));
  }
  if (value && typeof value === "object") {
    const nested = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = sanitizeLogValue(nestedKey, nestedValue, options);
    }
    return nested;
  }
  if (typeof value === "string") {
    const redacted = redactDiagnosticText(value);
    if (redacted.length > MAX_LOG_STRING_CHARS) {
      return `${redacted.slice(0, MAX_LOG_STRING_CHARS)}...[truncated]`;
    }
    return redacted;
  }
  return value;
}
function redactId(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 6) return value;
  return `...${value.slice(-6)}`;
}
function redactDiagnosticText(text) {
  let out = redactJsonCredentialText(text);
  out = redactResourceText(out);
  out = out.replace(
    /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    "$1[REDACTED]"
  );
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+/g, "$1[REDACTED]");
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token|app_secret|appSecret|secret|token|doc_token|file_token|authorization)=([^&\s"',}]+)/gi,
    "$1=[REDACTED]"
  );
  out = out.replace(
    /(^|[\s"'=])((?:\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/[^\s"',)]+))/g,
    "$1[REDACTED_PATH]"
  );
  out = out.replace(/(^|[\s"'=])(~\/[^\s"',)]+)/g, "$1[REDACTED_PATH]");
  out = out.replace(/[A-Za-z]:\\[^\s"',)]+/g, "[REDACTED_PATH]");
  return out;
}
function redactJsonCredentialText(text) {
  return text.replace(CREDENTIAL_JSON_FIELD_RE, "$1[REDACTED]$2").replace(ESCAPED_CREDENTIAL_JSON_FIELD_RE, "$1[REDACTED]$2");
}
function redactResourceText(text) {
  return text.replace(RESOURCE_JSON_FIELD_RE, "$1[REDACTED_RESOURCE]$2").replace(ESCAPED_RESOURCE_JSON_FIELD_RE, "$1[REDACTED_RESOURCE]$2").replace(
    /<\s*(?:file|image|img|audio|video|media|folder)\b[^>]*\bkey\s*=\s*["'][^"']+["'][^>]*>/gi,
    "[REDACTED_RESOURCE]"
  ).replace(/!?\[[^\]]*]\((?:file|img|image|media)_[^)]+\)/gi, "[REDACTED_RESOURCE]").replace(
    /\b(?:file|img|image|media)_(?:v\d+_)?[A-Za-z0-9][A-Za-z0-9._-]{8,}\b/g,
    "[REDACTED_RESOURCE]"
  );
}
function reportMetric(name, value, tags) {
  try {
    telemetry().recordMetric(name, value, sanitizeMetricTags(tags));
  } catch {
  }
}
function reportError(err, ctx) {
  try {
    telemetry().recordError(sanitizeTelemetryError(err), sanitizeTelemetryContext(ctx));
  } catch {
  }
}
function sanitizeMetricTags(tags) {
  if (!tags) return void 0;
  const out = {};
  for (const [key, value] of Object.entries(tags)) {
    const sanitized = sanitizeLogValue(key, value);
    out[key] = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  }
  return out;
}
function sanitizeTelemetryContext(ctx) {
  if (!ctx) return void 0;
  const out = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = sanitizeLogValue(key, value);
  }
  return out;
}
function sanitizeTelemetryError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: sanitizeLogValue("err", err.message),
      ...err.stack ? { stack: sanitizeLogValue("stack", err.stack) } : {}
    };
  }
  return sanitizeLogValue("err", err);
}
export {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  renderCard,
  renderText,
  reportError,
  reportMetric
};
