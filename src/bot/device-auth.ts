/**
 * Detect a Feishu/Lark device-flow OAuth verification URL inside a `lark-cli`
 * tool_result payload.
 *
 * Background: when the active profile has no usable user identity, `lark-cli`
 * skills fall back to device-flow authorization. The agent is *supposed* to
 * surface the `verification_url` to the user (see the OAuth section of the
 * bridge system prompt) and then block on `auth login --device-code` until the
 * user authorizes. In practice agents sometimes skip the "surface the URL"
 * step and jump straight to the blocking poll — leaving the user staring at a
 * silent run with no link to click, while the poll quietly retries until it
 * times out. The bridge forwards the URL itself as a safety net so the user
 * can always complete authorization.
 *
 * The detector is deliberately conservative to avoid forwarding unrelated URLs:
 *  - The structured path only matches a JSON envelope that carries BOTH a
 *    verification URL and a `device_code` (the device-flow signature).
 *  - The text fallback only matches the device-flow verify path.
 */

interface DeviceAuthEnvelope {
  verification_url?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  device_code?: unknown;
}

// e.g. https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=...
const DEVICE_VERIFY_URL =
  /https:\/\/[a-z0-9.-]*(?:feishu\.cn|larksuite\.com)\/oauth\/v1\/device\/verify[^\s"')]*/i;

/**
 * Return the verification URL if `toolOutput` looks like a device-flow
 * authorization response, otherwise `undefined`.
 */
export function extractDeviceAuthUrl(toolOutput: string): string | undefined {
  if (!toolOutput) return undefined;

  const envelope = parseDeviceAuthEnvelope(toolOutput);
  if (envelope) {
    const url =
      pickString(envelope.verification_uri_complete) ??
      pickString(envelope.verification_url) ??
      pickString(envelope.verification_uri);
    if (url) return url;
  }

  const match = toolOutput.match(DEVICE_VERIFY_URL);
  return match ? match[0] : undefined;
}

export interface DeviceAuthForward {
  markdown: string;
  /** Whether this message exposes the verification URL (only safe in p2p). */
  includesUrl: boolean;
}

/**
 * Build the chat message that surfaces a device-flow authorization to the user.
 *
 * In a p2p chat we include the link directly. In a group we must NOT leak it:
 * device flow binds the token to whoever clicks first, so a link in a group
 * would authorize the wrong identity. There we steer the user to DM instead.
 */
export function deviceAuthForwardMessage(chatType: string, url: string): DeviceAuthForward {
  if (chatType === 'p2p') {
    return {
      includesUrl: true,
      markdown: `🔐 需要先完成一次飞书授权才能继续。请打开下面的链接完成授权，完成后我会自动继续，无需回复：\n\`\`\`\n${url}\n\`\`\``,
    };
  }
  return {
    includesUrl: false,
    markdown:
      '🔐 需要先完成一次飞书授权才能继续，但授权必须在私聊里做（在群里授权会绑定到错误的身份）。请单独私信我，我会把授权链接发给你。',
  };
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Find the first JSON object in `text` that parses and carries the device-flow
 * signature (a `device_code` plus some verification URI). tool_result output is
 * usually the raw command stdout, but may be wrapped in surrounding log lines,
 * so we also try the substring spanning the outermost braces.
 */
function parseDeviceAuthEnvelope(text: string): DeviceAuthEnvelope | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const envelope = parsed as DeviceAuthEnvelope;
    const hasVerification =
      pickString(envelope.verification_uri_complete) ??
      pickString(envelope.verification_url) ??
      pickString(envelope.verification_uri);
    if (pickString(envelope.device_code) && hasVerification) return envelope;
  }
  return undefined;
}
