// src/cli/index.ts
import { Command } from "commander";

// package.json
var package_default = {
  name: "lark-channel-bridge",
  version: "0.4.0",
  description: "Bridge Feishu/Lark messenger with local CLI coding agents",
  type: "module",
  packageManager: "pnpm@10.33.0",
  repository: {
    type: "git",
    url: "git+https://github.com/zarazhangrui/feishu-claude-code-bridge.git"
  },
  bugs: {
    url: "https://github.com/zarazhangrui/feishu-claude-code-bridge/issues"
  },
  homepage: "https://github.com/zarazhangrui/feishu-claude-code-bridge#readme",
  bin: {
    "lark-channel-bridge": "./bin/lark-channel-bridge.mjs"
  },
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    }
  },
  files: [
    "dist",
    "bin",
    "README.md",
    "README.zh.md",
    "LICENSE"
  ],
  scripts: {
    dev: "tsup --watch",
    build: "tsup",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "test:unit": "vitest run tests/unit --passWithNoTests",
    "test:integration": "vitest run tests/integration --passWithNoTests",
    "test:process": "vitest run tests/process --passWithNoTests",
    "ci:local": "git diff --check && pnpm test && pnpm typecheck && pnpm build",
    "ci:platform": "pnpm test && pnpm typecheck && pnpm build",
    prepare: "node bin/prepare-git-install.mjs",
    prepublishOnly: "pnpm typecheck && pnpm build"
  },
  dependencies: {
    "@clack/prompts": "^1.4.0",
    "@larksuite/channel": "^0.2.0",
    commander: "^12.1.0",
    "cross-spawn": "^7.0.6",
    "graceful-fs": "^4.2.11",
    "proper-lockfile": "^4.1.2",
    "qrcode-terminal": "^0.12.0"
  },
  devDependencies: {
    "@types/cross-spawn": "^6.0.6",
    "@types/graceful-fs": "^4.1.9",
    "@types/node": "^22.10.0",
    "@types/proper-lockfile": "^4.1.4",
    "@types/qrcode-terminal": "^0.12.2",
    tsup: "^8.3.5",
    typescript: "^5.6.3",
    vitest: "^2.1.8"
  },
  engines: {
    node: ">=20.12.0"
  },
  pnpm: {
    onlyBuiltDependencies: [
      "esbuild",
      "protobufjs"
    ]
  },
  keywords: [
    "feishu",
    "lark",
    "claude",
    "claude-code",
    "codex",
    "cli",
    "channel",
    "bridge"
  ],
  license: "MIT"
};

// src/platform/spawn.ts
import crossSpawn from "cross-spawn";
function spawnProcess(command, args = [], options = {}) {
  return crossSpawn(command, [...args], options);
}
function spawnProcessSync(command, args = [], options = {}) {
  return crossSpawn.sync(command, [...args], options);
}
function mergeProcessEnv(base = process.env, overrides = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== void 0) out[key] = value;
  }
  return out;
}

// src/agent/preflight.ts
var AgentPreflightError = class extends Error {
  diagnostic;
  constructor(diagnostic, message) {
    super(message ?? summaryForDiagnostic(diagnostic));
    this.name = "AgentPreflightError";
    this.diagnostic = diagnostic;
  }
};
async function checkAgentAvailability(input) {
  try {
    return { ok: true, version: await checkAgentVersion(input) };
  } catch (err) {
    if (err instanceof AgentPreflightError) {
      return { ok: false, error: err, diagnostic: err.diagnostic };
    }
    throw err;
  }
}
async function checkAgentVersion(input) {
  const args = input.args ?? ["--version"];
  const timeoutMs = input.timeoutMs ?? 5e3;
  const executable = input.realpath ?? input.binaryPath;
  return new Promise((resolve2, reject4) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const base = () => ({
      agentId: input.agentId,
      agentName: input.agentName,
      command: input.command,
      binaryPath: input.binaryPath,
      ...input.realpath ? { realpath: input.realpath } : {},
      args,
      stdoutExcerpt: excerpt(stdout),
      stderrExcerpt: excerpt(stderr)
    });
    const child = (() => {
      try {
        return spawnProcess(executable, [...args], {
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (err) {
        finish(
          () => reject4(
            new AgentPreflightError({
              ...base(),
              code: codeForSpawnError(err),
              errno: err.code
            })
          )
        );
        return void 0;
      }
    })();
    if (!child) return;
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        () => reject4(
          new AgentPreflightError({
            ...base(),
            code: "agent-version-check-timeout",
            timeoutMs
          })
        )
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      finish(
        () => reject4(
          new AgentPreflightError({
            ...base(),
            code: codeForSpawnError(err),
            errno: err.code
          })
        )
      );
    });
    child.once("exit", (exitCode, signal) => {
      finish(() => {
        if (signal) {
          reject4(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-signaled",
              exitCode,
              signal
            })
          );
          return;
        }
        if (exitCode !== 0) {
          reject4(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-nonzero-exit",
              exitCode,
              signal
            })
          );
          return;
        }
        const version = (stdout.trim() || stderr.trim()).split("\n")[0]?.trim();
        if (!version) {
          reject4(
            new AgentPreflightError({
              ...base(),
              code: "agent-version-check-empty-output",
              exitCode,
              signal
            })
          );
          return;
        }
        resolve2(version);
      });
    });
  });
}
function formatAgentPreflightDiagnostic(diagnostic) {
  const command = commandForDisplay(diagnostic);
  switch (diagnostic.code) {
    case "agent-binary-not-found":
      return [
        `\u2717 \u672A\u627E\u5230\u672C\u5730 ${diagnostic.agentName}\u3002`,
        "",
        `\u8BF7\u5148\u5B89\u88C5 ${diagnostic.agentName}\uFF0C\u6216\u914D\u7F6E\u6B63\u786E\u7684\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u3002`,
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-binary-not-executable":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u6267\u884C\u3002`,
        "",
        `\u8BF7\u68C0\u67E5\u53EF\u6267\u884C\u6743\u9650\uFF0C\u6216\u91CD\u65B0\u5B89\u88C5 ${diagnostic.agentName}\u3002`,
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-binary-resolve-failed":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u8DEF\u5F84\u89E3\u6790\u5931\u8D25\u3002`,
        "",
        "\u8BF7\u786E\u8BA4\u5F53\u524D\u914D\u7F6E\u7684\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u6709\u6548\u540E\uFF0C\u518D\u91CD\u65B0\u8FD0\u884C bridge\u3002",
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-binary-not-readable":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E8C\u8FDB\u5236\u4E0D\u53EF\u8BFB\u53D6\u3002`,
        "",
        `\u8BF7\u68C0\u67E5\u6587\u4EF6\u6743\u9650\uFF0C\u6216\u91CD\u65B0\u5B89\u88C5 ${diagnostic.agentName}\u3002`,
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-version-check-spawn-failed":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u7528\uFF1A\u65E0\u6CD5\u6267\u884C \`${command}\`\u3002`,
        "",
        "\u8BF7\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C\u540C\u4E00\u547D\u4EE4\u5E76\u4FEE\u590D\u62A5\u9519\u3002",
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-version-check-timeout":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u7528\uFF1A\`${command}\` \u8D85\u65F6\u672A\u8FD4\u56DE\u3002`,
        "",
        "\u8BF7\u5148\u786E\u8BA4\u8BE5\u547D\u4EE4\u80FD\u6B63\u5E38\u7ED3\u675F\u3002",
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-version-check-signaled":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u7528\uFF1A\u6267\u884C \`${command}\` \u65F6\u88AB\u7CFB\u7EDF\u7EC8\u6B62\uFF08${diagnostic.signal ?? "unknown"}\uFF09\u3002`,
        "",
        "\u8BF7\u5148\u5728\u7EC8\u7AEF\u786E\u8BA4\uFF1A",
        `  ${command}`,
        "",
        `\u4FEE\u590D\u672C\u5730 ${diagnostic.agentName} \u540E\uFF0C\u518D\u91CD\u65B0\u8FD0\u884C bridge\u3002`,
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-version-check-nonzero-exit":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u7528\uFF1A\`${command}\` \u9000\u51FA\u7801\u4E3A ${diagnostic.exitCode ?? "unknown"}\u3002`,
        "",
        "\u8BF7\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C\u540C\u4E00\u547D\u4EE4\u5E76\u4FEE\u590D\u62A5\u9519\u3002",
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
    case "agent-version-check-empty-output":
      return [
        `\u2717 \u672C\u5730 ${diagnostic.agentName} \u4E0D\u53EF\u7528\uFF1A\`${command}\` \u6CA1\u6709\u8FD4\u56DE\u7248\u672C\u4FE1\u606F\u3002`,
        "",
        `\u8BF7\u786E\u8BA4\u5B89\u88C5\u7684\u662F\u53D7\u652F\u6301\u7684 ${diagnostic.agentName}\u3002`,
        `\u9519\u8BEF\u7801\uFF1A${diagnostic.code}`
      ].join("\n");
  }
}
function getAgentPreflightDiagnostic(err) {
  if (err instanceof AgentPreflightError) return err.diagnostic;
  if (!err || typeof err !== "object") return void 0;
  const diagnostic = err.diagnostic;
  if (isAgentPreflightDiagnostic(diagnostic)) return diagnostic;
  return getAgentPreflightDiagnostic(err.cause);
}
function isAgentPreflightDiagnostic(input) {
  if (!input || typeof input !== "object") return false;
  const raw = input;
  return typeof raw.code === "string" && raw.code.startsWith("agent-") && (raw.agentId === "claude" || raw.agentId === "codex") && typeof raw.agentName === "string" && typeof raw.command === "string";
}
function codeForSpawnError(err) {
  if (err.code === "ENOENT") return "agent-binary-not-found";
  if (err.code === "EACCES" || err.code === "EPERM") return "agent-binary-not-executable";
  return "agent-version-check-spawn-failed";
}
function commandForDisplay(diagnostic) {
  return [diagnostic.command, ...diagnostic.args ?? []].join(" ");
}
function summaryForDiagnostic(diagnostic) {
  return `${diagnostic.agentName} preflight failed: ${diagnostic.code}`;
}
function excerpt(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : void 0;
}

// src/cli/commands/migrate.ts
import { mkdir as mkdir7, readFile as readFile5, readdir, rename as rename3, rm as rm4, stat as stat4 } from "fs/promises";
import { dirname as dirname8, join as join9 } from "path";

// src/cli/profile-bootstrap.ts
import { mkdir, realpath as realpath2 } from "fs/promises";
import { join as join2 } from "path";

// src/config/schema.ts
function isComplete(cfg) {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}
function hasSecret(s) {
  if (!s) return false;
  if (typeof s === "string") return s.length > 0;
  return Boolean(s.source && s.id);
}
function isSecretRef(s) {
  return typeof s === "object" && s !== null;
}
function secretKeyForApp(appId) {
  return `app-${appId}`;
}
function getMessageReplyMode(cfg) {
  const raw = cfg.preferences?.messageReply;
  if (raw === "text" && cfg.preferences?.messageReplyMigrated !== true) {
    return "markdown";
  }
  if (raw === "card" || raw === "markdown" || raw === "text") return raw;
  return "markdown";
}
function isPresentationMode(value) {
  return value === "clean" || value === "progress" || value === "debug";
}
function getPresentationMode(cfg) {
  const raw = cfg.preferences?.presentation?.mode;
  if (isPresentationMode(raw)) return raw;
  if (cfg.preferences?.showToolCalls === true) return "debug";
  return "clean";
}
function getCotMessages(cfg) {
  const raw = cfg.preferences?.cotMessages;
  if (raw === "brief" || raw === "simple") return "brief";
  if (raw === "detailed" || raw === "on") return "detailed";
  return "off";
}
function getMaxConcurrentRuns(cfg) {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}
function getRequireMentionInGroup(cfg) {
  if (cfg.preferences?.requireMentionInGroup !== void 0) {
    return cfg.preferences.requireMentionInGroup !== false;
  }
  const profileAccess = cfg.access;
  if (profileAccess?.requireMentionInGroup !== void 0) {
    return profileAccess.requireMentionInGroup;
  }
  return true;
}
function getAgentStopGraceMs(cfg) {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5e3;
  return Math.min(3e4, Math.max(100, Math.floor(raw)));
}
function getRunIdleTimeoutMs(cfg) {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return void 0;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 6e4;
}
var DEFAULT_AUTO_NEW_INPUT_TOKEN_THRESHOLD = 1e5;
var DEFAULT_AUTO_NEW_MIN_TURNS_BEFORE_INPUT_TOKEN_RESET = 3;
var DEFAULT_AUTO_NEW_MAX_TURNS = 8;
function getAutoNewSessionConfig(cfg) {
  const raw = cfg.preferences?.autoNewSession;
  const enabled = raw?.enabled !== false;
  const threshold = typeof raw?.inputTokenThreshold === "number" && Number.isFinite(raw.inputTokenThreshold) && raw.inputTokenThreshold > 0 ? Math.floor(raw.inputTokenThreshold) : DEFAULT_AUTO_NEW_INPUT_TOKEN_THRESHOLD;
  const maxTurns = typeof raw?.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns >= 0 ? Math.min(1e3, Math.floor(raw.maxTurns)) : DEFAULT_AUTO_NEW_MAX_TURNS;
  const minTurnsBeforeInputTokenReset = typeof raw?.minTurnsBeforeInputTokenReset === "number" && Number.isFinite(raw.minTurnsBeforeInputTokenReset) && raw.minTurnsBeforeInputTokenReset > 0 ? Math.min(1e3, Math.floor(raw.minTurnsBeforeInputTokenReset)) : DEFAULT_AUTO_NEW_MIN_TURNS_BEFORE_INPUT_TOKEN_RESET;
  return {
    enabled,
    inputTokenThreshold: threshold,
    minTurnsBeforeInputTokenReset,
    maxTurns
  };
}

// src/config/permissions.ts
var ACCESS_ORDER = {
  "read-only": 0,
  workspace: 1,
  full: 2
};
var CLAUDE_PERMISSION_ACCESS = {
  plan: "read-only",
  default: "workspace",
  acceptEdits: "workspace",
  bypassPermissions: "full"
};
function normalizePermissions(input) {
  const hasSandbox = hasLegacySandbox(input.sandbox);
  const base = hasSandbox ? normalizeLegacySandboxPermissions(input.sandbox) : defaultPermissions();
  if (input.permissions !== void 0) {
    return {
      permissions: normalizeCanonicalPermissions(input.permissions, base),
      source: "permissions"
    };
  }
  return {
    permissions: base,
    source: hasSandbox ? "sandbox" : "default"
  };
}
function assertAccessPair(defaultAccess, maxAccess, source = "permissions") {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    const suffix = source === "sandbox" ? " from sandbox" : "";
    throw new Error(`permission defaultAccess cannot exceed maxAccess${suffix}`);
  }
}
function clampAccess(defaultAccess, profileMax, capabilityMax) {
  const maxAllowed = ACCESS_ORDER[profileMax] < ACCESS_ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ACCESS_ORDER[defaultAccess] <= ACCESS_ORDER[maxAllowed] ? defaultAccess : maxAllowed;
}
function codexSandboxToAccess(mode) {
  switch (mode) {
    case "read-only":
      return "read-only";
    case "workspace-write":
      return "workspace";
    case "danger-full-access":
      return "full";
    default:
      throw new Error("invalid sandbox mode");
  }
}
function accessToCodexSandbox(access3) {
  switch (access3) {
    case "read-only":
      return "read-only";
    case "workspace":
      return "workspace-write";
    case "full":
      return "danger-full-access";
  }
}
function accessToClaudePermissionMode(access3, permissions) {
  const override = permissions?.claude?.permissionMode;
  if (override && ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[override]] <= ACCESS_ORDER[access3]) {
    return override;
  }
  return accessToDefaultClaudePermissionMode(access3);
}
function accessToDefaultClaudePermissionMode(access3) {
  switch (access3) {
    case "read-only":
      return "plan";
    case "workspace":
      return "acceptEdits";
    case "full":
      return "bypassPermissions";
  }
}
function permissionsToLegacySandbox(permissions) {
  const defaultMode = accessToCodexSandbox(permissions.defaultAccess);
  const maxMode = accessToCodexSandbox(permissions.maxAccess);
  return {
    default: defaultMode,
    max: maxMode,
    defaultMode,
    maxMode
  };
}
function normalizeCanonicalPermissions(input, base) {
  if (!isConfigObject(input)) {
    throw new Error("invalid permission config");
  }
  const explicitMaxAccess = readAccess(input.maxAccess, "maxAccess");
  const explicitDefaultAccess = readAccess(input.defaultAccess, "defaultAccess");
  const maxAccess = explicitMaxAccess ?? base.maxAccess;
  const defaultAccess = explicitDefaultAccess ?? (ACCESS_ORDER[base.defaultAccess] <= ACCESS_ORDER[maxAccess] ? base.defaultAccess : maxAccess);
  assertAccessPair(defaultAccess, maxAccess);
  const claude = normalizeClaudePermissions(input.claude);
  if (claude?.permissionMode) {
    assertClaudePermissionWithinAccess(claude.permissionMode, maxAccess);
  }
  return {
    defaultAccess,
    maxAccess,
    ...claude ? { claude } : {}
  };
}
function defaultPermissions() {
  return {
    defaultAccess: "full",
    maxAccess: "full"
  };
}
function assertClaudePermissionWithinAccess(permissionMode, maxAccess) {
  if (ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[permissionMode]] > ACCESS_ORDER[maxAccess]) {
    throw new Error("permission claude.permissionMode cannot exceed maxAccess");
  }
}
function normalizeLegacySandboxPermissions(input) {
  if (!isConfigObject(input)) {
    throw new Error("invalid sandbox mode");
  }
  const maxMode = readSandboxMode(input.max ?? input.maxMode, "maxMode") ?? "danger-full-access";
  const defaultMode = readSandboxMode(input.default ?? input.defaultMode, "defaultMode") ?? maxMode;
  const defaultAccess = codexSandboxToAccess(defaultMode);
  const maxAccess = codexSandboxToAccess(maxMode);
  assertAccessPair(defaultAccess, maxAccess, "sandbox");
  return {
    defaultAccess,
    maxAccess
  };
}
function normalizeClaudePermissions(input) {
  if (input === void 0) {
    return void 0;
  }
  if (!isConfigObject(input)) {
    throw new Error("invalid permission claude config");
  }
  if (input.permissionMode === void 0) {
    return void 0;
  }
  if (!isClaudePermissionMode(input.permissionMode)) {
    throw new Error("invalid permission claude.permissionMode");
  }
  return {
    permissionMode: input.permissionMode
  };
}
function hasLegacySandbox(input) {
  if (input === void 0) {
    return false;
  }
  if (!isConfigObject(input)) {
    throw new Error("invalid sandbox mode");
  }
  return input.default !== void 0 || input.max !== void 0 || input.defaultMode !== void 0 || input.maxMode !== void 0;
}
function readAccess(value, field) {
  if (value === void 0) {
    return void 0;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}
function readSandboxMode(value, field) {
  if (value === void 0) {
    return void 0;
  }
  if (!isCodexSandboxMode(value)) {
    throw new Error(`invalid sandbox ${field}`);
  }
  return value;
}
function isAccessMode(value) {
  return value === "read-only" || value === "workspace" || value === "full";
}
function isConfigObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCodexSandboxMode(value) {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}
function isClaudePermissionMode(value) {
  return value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan";
}

// src/config/profile-schema.ts
function createDefaultProfileConfig(input) {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input
  });
}
function normalizeProfileConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("profile config must be an object");
  }
  const raw = input;
  if (raw.schemaVersion !== 2) {
    throw new Error("profile schemaVersion must be 2");
  }
  if (raw.agentKind !== "claude" && raw.agentKind !== "codex") {
    throw new Error("agentKind must be claude or codex");
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === "codex" && !raw.codex) {
    throw new Error("codex profile requires codex configuration");
  }
  const preferences = normalizePreferences(raw.preferences);
  const access3 = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const larkCli = normalizeLarkCli(raw.larkCli);
  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    accounts,
    ...raw.secrets ? { secrets: raw.secrets } : {},
    preferences,
    access: access3,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...raw.codex ? { codex: normalizeCodex(raw.codex) } : {},
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1e3),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024)
    },
    comments,
    larkCli
  };
}
function normalizeAccounts(input) {
  if (!input || typeof input !== "object") {
    throw new Error("accounts.app is required");
  }
  const accounts = input;
  const app = accounts.app;
  if (!app?.id || !app.secret || app.tenant !== "feishu" && app.tenant !== "lark") {
    throw new Error("accounts.app is incomplete");
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant
    }
  };
}
function normalizePreferences(preferences) {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    showToolCalls,
    presentation,
    ...rest
  } = preferences ?? {};
  const normalized = { ...rest };
  if (messageReply !== void 0 && isMessageReply(messageReply)) {
    normalized.messageReply = messageReply;
  }
  if (typeof showToolCalls === "boolean") {
    normalized.showToolCalls = showToolCalls;
  }
  if (presentation && typeof presentation === "object" && isPresentationMode(presentation.mode)) {
    normalized.presentation = { mode: presentation.mode };
  }
  return normalized;
}
function isMessageReply(value) {
  return value === "card" || value === "markdown" || value === "text";
}
function normalizeAccess(access3, legacyRequireMentionInGroup) {
  return {
    allowedUsers: stringArray(access3?.allowedUsers),
    allowedChats: stringArray(access3?.allowedChats),
    admins: stringArray(access3?.admins),
    requireMentionInGroup: access3?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true
  };
}
function normalizeWorkspaces(input) {
  const defaultWorkspace = typeof input?.default === "string" && input.default.trim() ? input.default.trim() : void 0;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}
function normalizeCodex(input) {
  const codex = {
    binaryPath: input.binaryPath,
    ...typeof input.realpath === "string" ? { realpath: input.realpath } : {},
    ...typeof input.version === "string" ? { version: input.version } : {},
    ...typeof input.sha256 === "string" ? { sha256: input.sha256 } : {},
    ...typeof input.owner === "number" ? { owner: input.owner } : {},
    ...typeof input.mode === "number" ? { mode: input.mode } : {},
    ...typeof input.codexHome === "string" ? { codexHome: input.codexHome } : {},
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false
  };
  return codex;
}
function normalizeComments(_input) {
  return {};
}
function normalizeLarkCli(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { identityPreset: "bot-only" };
  }
  const raw = input;
  const identityPreset = raw.identityPreset === "user-default" ? "user-default" : "bot-only";
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...localUserImport ? { localUserImport } : {}
  };
}
function normalizeLarkCliUserImport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const raw = input;
  if (!isLarkCliUserImportStatus(raw.status)) return void 0;
  return {
    status: raw.status,
    ...typeof raw.attemptedAt === "string" ? { attemptedAt: raw.attemptedAt } : {},
    ...typeof raw.importedAt === "string" ? { importedAt: raw.importedAt } : {},
    ...typeof raw.reason === "string" ? { reason: raw.reason } : {}
  };
}
function isLarkCliUserImportStatus(value) {
  return value === "not-needed" || value === "imported" || value === "skipped-existing-private-user" || value === "skipped-no-local-user" || value === "failed";
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// src/policy/workspace.ts
import { realpath, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, dirname, resolve } from "path";
async function resolveWorkingDirectory(requestedCwd) {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject("empty-requested-cwd", requestedCwd, "\u672A\u6307\u5B9A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  let resolved;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject("path-inaccessible", requestedCwd, `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BBF\u95EE\uFF1A${requestedCwd}`);
  }
  const info = await stat(resolved).catch(() => void 0);
  if (!info?.isDirectory()) {
    return reject("not-directory", requestedCwd, `\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55\uFF1A${resolved}`);
  }
  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const homeRealpath = await realpath(homedir()).catch(() => resolve(homedir()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath, homeRealpath);
  if (broad) return broad;
  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved
  };
}
function reject(reason, requestedCwd, userVisible) {
  return { ok: false, reason, requestedCwd, userVisible };
}
function classifyHighRiskWorkingDirectory(real, requestedCwd, tempRealpath, homeRealpath) {
  if (real === dirname(real)) {
    return reject("filesystem-root", requestedCwd, "\u4E0D\u80FD\u628A\u6587\u4EF6\u7CFB\u7EDF\u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  const home = homeRealpath;
  if (real === home) {
    return reject("home-root", requestedCwd, "\u4E0D\u80FD\u628A Home \u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  if (real === dirname(home)) {
    return reject("user-root", requestedCwd, "\u4E0D\u80FD\u628A\u7528\u6237\u76EE\u5F55\u6839\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  if (dirname(real) === home && (/* @__PURE__ */ new Set(["Desktop", "Downloads"])).has(basename(real))) {
    return reject("broad-user-folder", requestedCwd, "\u8FD9\u4E2A\u76EE\u5F55\u8303\u56F4\u8FC7\u5927\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === "/tmp" || real === "/private/tmp") {
    return reject("temp-root", requestedCwd, "\u4E0D\u80FD\u628A\u4E34\u65F6\u76EE\u5F55\u6839\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  const systemRoots = /* @__PURE__ */ new Set([
    "/Applications",
    "/bin",
    "/etc",
    "/Library",
    "/private",
    "/sbin",
    "/System",
    "/usr",
    "/var"
  ]);
  if (systemRoots.has(real)) {
    return reject("system-root", requestedCwd, "\u4E0D\u80FD\u628A\u7CFB\u7EDF\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  if (real === "/Volumes" || dirname(real) === "/Volumes") {
    return reject("volume-root", requestedCwd, "\u4E0D\u80FD\u628A\u78C1\u76D8\u5377\u6839\u76EE\u5F55\u8BBE\u4E3A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u9009\u62E9\u66F4\u5177\u4F53\u7684\u5B50\u76EE\u5F55\u3002");
  }
  return void 0;
}

// src/cli/agent-detection.ts
import { constants } from "fs";
import { access } from "fs/promises";
import { delimiter, extname, isAbsolute, join } from "path";
async function resolveExecutablePath(command) {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}
function executableCandidates(dir, command) {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join(dir, `${command}${ext}`));
  }
  return candidates;
}
function pathExts() {
  return (process.env.PATHEXT ?? "").split(";").map((ext) => ext.trim()).filter(Boolean);
}
async function detectInstalledAgents() {
  const candidates = [
    { kind: "claude", command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? "claude" },
    { kind: "codex", command: process.env.LARK_CHANNEL_CODEX_BIN ?? "codex" }
  ];
  const detected = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command)
      });
    } catch {
    }
  }
  return detected;
}

// src/cli/profile-bootstrap.ts
async function createBootstrapProfileConfig(input) {
  const workspace = input.workspace ? await resolveBootstrapWorkspace(input.workspace) : input.defaultWorkspace ? await ensureManagedDefaultWorkspace(input.defaultWorkspace) : void 0;
  const codex = input.agentKind === "codex" ? await createBootstrapCodexConfig(input.codexBinaryPath) : void 0;
  const profile2 = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...codex ? { codex } : {}
  });
  if (workspace) {
    profile2.workspaces = {
      ...profile2.workspaces,
      default: workspace
    };
  }
  if (input.profileDir && profile2.codex?.inheritCodexHome === false) {
    await mkdir(join2(input.profileDir, "codex-home"), { recursive: true });
  }
  return profile2;
}
async function resolveBootstrapWorkspace(workspace) {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}
async function ensureManagedDefaultWorkspace(path) {
  await mkdir(path, { recursive: true, mode: 448 });
  return realpath2(path);
}
async function createBootstrapCodexConfig(binaryPath) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? "codex";
  let resolvedBinary;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = err.code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: "codex",
      agentName: "Codex CLI",
      command,
      binaryPath: command,
      errno
    });
  }
  return { binaryPath: resolvedBinary };
}
function codexBootstrapBinaryErrorCode(errno) {
  if (errno === "EACCES" || errno === "EPERM") return "agent-binary-not-executable";
  if (errno === "ELOOP" || errno === "ENOTDIR" || errno === "EINVAL") {
    return "agent-binary-resolve-failed";
  }
  return "agent-binary-not-found";
}

// src/cli/prompt.ts
import { createInterface } from "readline";
import { Writable } from "stream";
async function promptLine(prompt) {
  return new Promise((resolve2) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY)
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve2(answer.trim());
    });
  });
}
async function promptPassword(prompt) {
  const isTTY = Boolean(process.stdin.isTTY);
  return new Promise((resolve2) => {
    const muted = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      }
    });
    process.stdout.write(prompt);
    const rl = createInterface({
      input: process.stdin,
      output: isTTY ? muted : process.stdout,
      terminal: isTTY
    });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve2(answer.trim());
    });
  });
}

// src/runtime/registry.ts
import { randomBytes as randomBytes2 } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { mkdir as mkdir4, writeFile as writeFile2 } from "fs/promises";
import { basename as basename3, dirname as dirname4, join as join6 } from "path";
import * as lockfile2 from "proper-lockfile";

// src/config/app-paths.ts
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
var DEFAULT_PROFILE = "claude";
function resolveAppPaths(opts = {}) {
  const rootDir = opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? join3(homedir2(), ".lark-channel");
  const profile2 = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profileDir = join3(rootDir, "profiles", profile2);
  const registryDir = join3(rootDir, "registry");
  const userLockDir = join3(registryDir, "locks");
  return {
    rootDir,
    profile: profile2,
    profileDir,
    defaultWorkspaceDir: join3(`${rootDir}-workspaces`, profile2, "default"),
    configFile: join3(rootDir, "config.json"),
    activeProfileFile: join3(rootDir, "active-profile"),
    sessionsFile: join3(profileDir, "sessions.json"),
    workspacesFile: join3(profileDir, "workspaces.json"),
    secretsFile: join3(profileDir, "secrets.enc"),
    keystoreSaltFile: join3(profileDir, ".keystore.salt"),
    secretsGetterScript: join3(rootDir, "secrets-getter"),
    larkCliConfigDir: join3(profileDir, "lark-cli"),
    larkCliSourceDir: join3(profileDir, "lark-cli-source"),
    larkCliSourceConfigFile: join3(profileDir, "lark-cli-source", "config.json"),
    larkCliTargetConfigFile: join3(profileDir, "lark-cli", "lark-channel", "config.json"),
    mediaDir: join3(profileDir, "media"),
    logsDir: join3(profileDir, "logs"),
    registryDir,
    userRegistryFile: join3(registryDir, "processes.json"),
    userLockDir,
    profileLockFile: join3(userLockDir, "profile", `${profile2}.lock`),
    appLockFile: (appId) => join3(userLockDir, "app", `${lockSafeName(appId)}.lock`)
  };
}
function normalizeProfileName(profile2) {
  const trimmed = profile2.trim();
  if (!trimmed) throw new Error("profile name is required");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`invalid profile name: ${profile2}`);
  }
  return trimmed;
}
function lockSafeName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

// src/config/paths.ts
import { homedir as homedir3 } from "os";
import { join as join4 } from "path";
var appPaths = resolveAppPaths();
var paths = {
  ...appPaths,
  appDir: appPaths.rootDir,
  cacheDir: appPaths.rootDir,
  processesFile: appPaths.userRegistryFile
  /**
   * Thin shell wrapper that lark-cli and other exec-provider consumers invoke
   * to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
};
var legacyPaths = {
  appDir: join4(
    process.env.XDG_CONFIG_HOME ?? join4(homedir3(), ".config"),
    "lark-channel-bridge"
  ),
  cacheDir: join4(
    process.env.XDG_CACHE_HOME ?? join4(homedir3(), ".cache"),
    "lark-channel-bridge"
  )
};

// src/platform/atomic-write.ts
import { randomBytes } from "crypto";
import { chmod, mkdir as mkdir2, open, rm } from "fs/promises";
import { basename as basename2, dirname as dirname2, join as join5 } from "path";
import { promisify } from "util";
import gracefulFs from "graceful-fs";
var gracefulRename = promisify(gracefulFs.rename);
var DEFAULT_RENAME_ATTEMPTS = 5;
var DEFAULT_RETRY_DELAY_MS = 25;
async function writeFileAtomic(path, data, opts = {}) {
  await mkdir2(dirname2(path), { recursive: true });
  const tmp = join5(
    dirname2(path),
    `.${basename2(path)}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`
  );
  try {
    const handle = await open(tmp, "w", opts.mode ?? 384);
    try {
      await handle.writeFile(data);
      try {
        await handle.sync();
      } catch (err) {
        if (!isIgnorableWindowsFsyncError(err)) throw err;
      }
    } finally {
      await handle.close();
    }
    await chmod(tmp, opts.mode ?? 384);
    await renameWithRetry(tmp, path, opts);
    await fsyncDir(dirname2(path));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
    });
    throw err;
  }
}
async function renameWithRetry(from, to, opts) {
  const maxAttempts = opts.maxRenameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const rename6 = opts.rename ?? ((src, dest, fallback) => fallback(src, dest));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename6(from, to, gracefulRename);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}
function isTransientRenameError(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EBUSY";
}
function isIgnorableWindowsFsyncError(err) {
  return process.platform === "win32" && err?.code === "EPERM";
}
async function fsyncDir(path) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/runtime/locks.ts
import { chmod as chmod2, mkdir as mkdir3, readFile, unlink, writeFile } from "fs/promises";
import { dirname as dirname3 } from "path";
import * as lockfile from "proper-lockfile";
var RuntimeLockConflictError = class extends Error {
  constructor(kind, target, meta, cause) {
    super(`runtime ${kind} lock is already held: ${target}`);
    this.kind = kind;
    this.target = target;
    this.meta = meta;
    this.name = "RuntimeLockConflictError";
    this.cause = cause;
  }
  kind;
  target;
  meta;
};
async function withProfileAndAppLocks(paths2, appId, agentKind, fn) {
  const acquired = [];
  try {
    acquired.push(
      await acquireRuntimeLock({
        kind: "profile",
        target: paths2.profileLockFile,
        profile: paths2.profile,
        agentKind
      })
    );
    acquired.push(
      await acquireRuntimeLock({
        kind: "app",
        target: paths2.appLockFile(appId),
        profile: paths2.profile,
        agentKind,
        appId
      })
    );
    return await fn([...acquired]);
  } finally {
    for (const lock4 of acquired.reverse()) {
      await lock4.release().catch(() => {
      });
    }
  }
}
async function acquireAppRuntimeLock(paths2, appId, agentKind) {
  return acquireRuntimeLock({
    kind: "app",
    target: paths2.appLockFile(appId),
    profile: paths2.profile,
    agentKind,
    appId
  });
}
async function acquireProfileRuntimeLock(paths2, agentKind) {
  return acquireRuntimeLock({
    kind: "profile",
    target: paths2.profileLockFile,
    profile: paths2.profile,
    agentKind
  });
}
function runtimeLockMetaFile(target) {
  return `${target}.meta.json`;
}
async function readRuntimeLockMeta(target) {
  try {
    const parsed = JSON.parse(await readFile(runtimeLockMetaFile(target), "utf8"));
    return isRuntimeLockMeta(parsed) ? parsed : void 0;
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    return void 0;
  }
}
async function checkRuntimeLock(target) {
  try {
    const locked = await lockfile.check(target, { realpath: false });
    if (!locked) return { locked: false };
    const meta = await readRuntimeLockMeta(target);
    if (!meta) {
      return { locked: true, uncertain: true, error: "missing-or-invalid-runtime-lock-meta" };
    }
    return { locked: true, meta };
  } catch (err) {
    if (err.code === "ENOENT") return { locked: false };
    return {
      locked: true,
      uncertain: true,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function acquireRuntimeLock(meta) {
  await mkdir3(dirname3(meta.target), { recursive: true });
  await writeFile(meta.target, "", { flag: "a", mode: 384 });
  await chmod2(meta.target, 384);
  let release;
  try {
    release = await lockfile.lock(meta.target, {
      realpath: false,
      stale: 3e4,
      update: 1e4
    });
  } catch (err) {
    throw new RuntimeLockConflictError(meta.kind, meta.target, await readRuntimeLockMeta(meta.target), err);
  }
  const fullMeta = {
    ...meta,
    pid: process.pid,
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const metaFile = runtimeLockMetaFile(meta.target);
  await writeFile(metaFile, `${JSON.stringify(fullMeta, null, 2)}
`, {
    mode: 384
  });
  await chmod2(metaFile, 384);
  return {
    kind: meta.kind,
    target: meta.target,
    async release() {
      await unlink(metaFile).catch(() => {
      });
      await release();
    }
  };
}
function isRuntimeLockMeta(value) {
  if (!value || typeof value !== "object") return false;
  const meta = value;
  return (meta.kind === "profile" || meta.kind === "app") && typeof meta.target === "string" && typeof meta.profile === "string" && (meta.agentKind === "claude" || meta.agentKind === "codex") && typeof meta.pid === "number" && typeof meta.startedAt === "string" && (meta.appId === void 0 || typeof meta.appId === "string");
}

// src/runtime/registry.ts
var EMPTY = { entries: [] };
function isValidEntry(e) {
  if (!e || typeof e !== "object") return false;
  const x = e;
  return typeof x.id === "string" && typeof x.pid === "number" && typeof x.appId === "string" && (x.tenant === "feishu" || x.tenant === "lark") && typeof x.profileName === "string" && (x.agentKind === "claude" || x.agentKind === "codex") && typeof x.configPath === "string" && typeof x.startedAt === "string" && typeof x.version === "string";
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function readAndPrune(path = paths.processesFile) {
  return readRaw(path).entries;
}
async function writeAtomic(entries, path) {
  const body = `${JSON.stringify({ entries }, null, 2)}
`;
  await writeFileAtomic(path, body, { mode: 384 });
}
function writeAtomicSync(entries, path) {
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ entries }, null, 2)}
`;
  mkdirSync(dirname4(path), { recursive: true });
  const fd = openSync(tmp, "w", 384);
  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirSync(dirname4(path));
}
function generateShortId() {
  return randomBytes2(2).toString("hex");
}
async function register(args) {
  const registryFile = args.registryFile ?? paths.processesFile;
  const entry = {
    id: generateShortId(),
    pid: process.pid,
    appId: args.appId,
    tenant: args.tenant,
    profileName: args.profileName ?? "claude",
    agentKind: args.agentKind ?? "claude",
    configPath: args.configPath,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    version: args.version
  };
  await withRegistryFileLock(registryFile, async () => {
    const { entries: live } = await readForWriteState(registryFile);
    await writeAtomic([...live, entry], registryFile);
  });
  return entry;
}
async function updateEntry(id, patch, registryFile = paths.processesFile) {
  await withRegistryFileLock(registryFile, async () => {
    const { entries: live, pruned } = await readForWriteState(registryFile);
    let changed = false;
    const next = live.map((e) => {
      if (e.id !== id) return e;
      changed = true;
      return { ...e, ...patch };
    });
    if (!changed && !pruned) return;
    await writeAtomic(next, registryFile);
  });
}
function unregisterSync(id, registryFile = paths.processesFile) {
  try {
    withRegistryFileLockSync(registryFile, () => {
      const live = readRaw(registryFile).entries;
      const next = live.filter((e) => e.id !== id);
      if (next.length === live.length) return;
      writeAtomicSync(next, registryFile);
    });
  } catch {
  }
}
function cleanupTmpFiles(registryFile = paths.processesFile) {
  try {
    unlinkSync(`${registryFile}.tmp-${process.pid}`);
  } catch {
  }
}
function sameAppOthers(appId, excludePid = process.pid, registryFile = paths.processesFile) {
  return readAndPrune(registryFile).filter((e) => e.appId === appId && e.pid !== excludePid);
}
async function sameAppLiveOthers(appId, excludePid = process.pid, registryFile = paths.processesFile) {
  const candidates = sameAppOthers(appId, excludePid, registryFile);
  const checks = await Promise.all(
    candidates.map(async (entry) => ({
      entry,
      stale: await isEntryStale(entry, registryFile)
    }))
  );
  return checks.filter(({ stale }) => !stale).map(({ entry }) => entry);
}
function resolveTarget(target) {
  const live = readAndPrune();
  const byId = live.find((e) => e.id === target);
  if (byId) return byId;
  const n = Number.parseInt(target, 10);
  if (Number.isFinite(n) && n >= 1 && n <= live.length) {
    return live[n - 1];
  }
  return void 0;
}
async function withRegistryFileLock(registryFile, fn) {
  await ensureRegistryFile(registryFile);
  const release = await lockfile2.lock(registryFile, {
    realpath: false,
    stale: 3e4,
    update: 1e4
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
function withRegistryFileLockSync(registryFile, fn) {
  ensureRegistryFileSync(registryFile);
  const release = lockfile2.lockSync(registryFile, {
    realpath: false,
    stale: 3e4,
    update: 1e4
  });
  try {
    return fn();
  } finally {
    release();
  }
}
async function ensureRegistryFile(registryFile) {
  await mkdir4(dirname4(registryFile), { recursive: true });
  const legacy = legacyRegistryFile(registryFile);
  const initial = legacy ? readRegistryFile(legacy) ?? EMPTY : EMPTY;
  try {
    await writeFile2(registryFile, `${JSON.stringify(initial, null, 2)}
`, {
      flag: "wx",
      mode: 384
    });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}
function ensureRegistryFileSync(registryFile) {
  mkdirSync(dirname4(registryFile), { recursive: true });
  const legacy = legacyRegistryFile(registryFile);
  const initial = legacy ? readRegistryFile(legacy) ?? EMPTY : EMPTY;
  try {
    writeFileSync(registryFile, `${JSON.stringify(initial, null, 2)}
`, {
      flag: "wx",
      mode: 384
    });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}
async function readForWriteState(registryFile) {
  const raw = readRaw(registryFile);
  const checks = await Promise.all(
    raw.entries.map(async (entry) => ({
      entry,
      stale: await isEntryStale(entry, registryFile)
    }))
  );
  const entries = checks.filter(({ stale }) => !stale).map(({ entry }) => entry);
  return { entries, pruned: entries.length !== raw.entries.length };
}
async function isEntryStale(entry, registryFile) {
  const rootDir = rootDirFromRegistryFile(registryFile);
  const appPaths2 = resolveAppPaths({ rootDir, profile: entry.profileName });
  const [profileLock, appLock] = await Promise.all([
    checkRuntimeLock(appPaths2.profileLockFile),
    checkRuntimeLock(appPaths2.appLockFile(entry.appId))
  ]);
  return !lockMatchesEntry(profileLock, entry, "profile") || !lockMatchesEntry(appLock, entry, "app");
}
function lockMatchesEntry(lock4, entry, kind) {
  if (lock4.uncertain) {
    throw new Error(
      `runtime lock state unknown for ${kind} ${entry.profileName}/${entry.appId}: ${lock4.error ?? "unknown"}`
    );
  }
  if (!lock4.locked || !lock4.meta) return false;
  if (lock4.meta.kind !== kind) return false;
  if (lock4.meta.profile !== entry.profileName) return false;
  if (lock4.meta.agentKind !== entry.agentKind) return false;
  if (lock4.meta.pid !== entry.pid) return false;
  if (kind === "app" && lock4.meta.appId !== entry.appId) return false;
  return true;
}
function rootDirFromRegistryFile(registryFile) {
  const parent = dirname4(registryFile);
  return basename3(parent) === "registry" ? dirname4(parent) : parent;
}
function readRaw(path) {
  const preferred = readRegistryFile(path);
  if (preferred) return preferred;
  const legacy = legacyRegistryFile(path);
  if (legacy && legacy !== path) {
    return readRegistryFile(legacy) ?? { entries: [] };
  }
  return { entries: [] };
}
function readRegistryFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isValidEntry) };
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    return { entries: [] };
  }
}
function legacyRegistryFile(path) {
  if (basename3(path) !== "processes.json") return void 0;
  const parent = dirname4(path);
  if (basename3(parent) !== "registry") return void 0;
  const legacy = join6(dirname4(parent), "processes.json");
  return existsSync(path) ? void 0 : legacy;
}
function fsyncDirSync(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}

// src/cli/commands/ps.ts
function runPs() {
  const live = readAndPrune();
  if (live.length === 0) {
    console.log("\u5F53\u524D\u6CA1\u6709 bot \u5728\u8FD0\u884C\u3002");
    return;
  }
  console.log(`# \u5F53\u524D\u5171 ${live.length} \u4E2A bot \u5728\u8FD0\u884C
`);
  const rows = live.map((e, idx) => {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const app = e.botName ? `${e.botName} (${e.appId})` : e.appId;
    return {
      idx: String(idx + 1),
      id: e.id,
      pid: String(e.pid),
      app,
      started: ago,
      version: e.version
    };
  });
  const headers = { idx: "#", id: "ID", pid: "PID", app: "Bot", started: "\u542F\u52A8", version: "\u7248\u672C" };
  printTable([headers, ...rows]);
}
async function runKillCli(target) {
  if (!target) {
    console.error("\u7528\u6CD5: lark-channel-bridge kill <bot id \u6216\u5E8F\u53F7>");
    process.exit(1);
  }
  const entry = resolveTarget(target);
  if (!entry) {
    console.error(`\u2717 \u6CA1\u627E\u5230\u5339\u914D\u7684 bot:${target}`);
    console.error("  \u7528 `lark-channel-bridge ps` \u770B\u53EF\u9009\u76EE\u6807\u3002");
    process.exit(1);
  }
  console.log(`\u6B63\u5728\u5173\u95ED bot ${entry.id}\u2026`);
  let result;
  try {
    result = await stopProcessEntry(entry);
  } catch (err) {
    console.error(`\u2717 \u5173\u95ED\u5931\u8D25:${err.message}`);
    process.exit(1);
  }
  if (result === "killed") {
    console.log(`\u2713 \u5DF2\u5F3A\u5236\u5173\u95ED bot ${entry.id}\u3002`);
    return;
  }
  console.log(`\u2713 \u5DF2\u5173\u95ED bot ${entry.id}\u3002`);
}
async function stopProcessEntry(entry, timeoutMs = 2e3) {
  process.kill(entry.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      return "terminated";
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(entry.pid, "SIGKILL");
  const forceDeadline = Date.now() + timeoutMs;
  while (Date.now() < forceDeadline) {
    if (!isAlive(entry.pid)) {
      return "killed";
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process ${entry.pid} did not exit after SIGKILL`);
}
function formatAgo(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)}s \u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)}m \u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)}h \u524D`;
  return `${Math.floor(ms / 864e5)}d \u524D`;
}
function printTable(rows) {
  if (rows.length === 0) return;
  const headerRow = rows[0];
  if (!headerRow) return;
  const cols = Object.keys(headerRow);
  const widths = {};
  for (const col of cols) {
    widths[col] = Math.max(...rows.map((r) => displayWidth(r[col] ?? "")));
  }
  for (const r of rows) {
    const line = cols.map((c) => padEndDisplay(r[c] ?? "", widths[c] ?? 0)).join("  ");
    console.log(line);
  }
}
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 11904 ? 2 : 1;
  }
  return w;
}
function padEndDisplay(s, target) {
  const pad = target - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// src/config/migrate-v2.ts
import {
  copyFile,
  mkdir as mkdir6,
  readFile as readFile3,
  rename as rename2,
  rm as rm3,
  stat as stat3,
  writeFile as writeFile4
} from "fs/promises";
import { dirname as dirname6, join as join8 } from "path";

// src/config/profile-store.ts
import { chmod as chmod3, mkdir as mkdir5, readFile as readFile2, rename, rm as rm2, rmdir, stat as stat2, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname5, join as join7 } from "path";
import * as lockfile3 from "proper-lockfile";
async function loadRootConfig(path) {
  try {
    const parsed = JSON.parse(await readFile2(path, "utf8"));
    return isRootConfig(parsed) ? normalizeRootConfig(parsed) : void 0;
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
}
function normalizeRootConfig(root) {
  const profiles = {};
  for (const [name, profile2] of Object.entries(root.profiles)) {
    profiles[name] = normalizeProfileConfig(profile2);
  }
  const migrations = normalizeRootMigrations(root.migrations);
  return {
    schemaVersion: 2,
    activeProfile: root.activeProfile,
    preferences: {},
    ...root.secrets ? { secrets: root.secrets } : {},
    ...migrations ? { migrations } : {},
    profiles
  };
}
async function saveRootConfig(root, path) {
  await writeFileAtomic(path, formatRootConfig(root), { mode: 384 });
}
function formatRootConfig(root) {
  return `${JSON.stringify(serializeRootConfig(root), null, 2)}
`;
}
function serializeRootConfig(root) {
  const profiles = {};
  for (const [name, profile2] of Object.entries(root.profiles)) {
    profiles[name] = serializeProfileConfig(profile2);
  }
  const migrations = normalizeRootMigrations(root.migrations);
  return {
    schemaVersion: 2,
    activeProfile: root.activeProfile,
    preferences: {},
    ...root.secrets ? { secrets: root.secrets } : {},
    ...migrations ? { migrations } : {},
    profiles
  };
}
function serializeProfileConfig(profile2) {
  return {
    schemaVersion: profile2.schemaVersion,
    agentKind: profile2.agentKind,
    accounts: profile2.accounts,
    ...profile2.secrets ? { secrets: profile2.secrets } : {},
    preferences: profile2.preferences,
    access: profile2.access,
    workspaces: profile2.workspaces,
    permissions: profile2.permissions,
    ...profile2.codex ? { codex: profile2.codex } : {},
    attachments: profile2.attachments,
    comments: {},
    larkCli: profile2.larkCli
  };
}
async function withConfigFileLock(configPath, fn) {
  const lockTarget = `${configPath}.lock`;
  await mkdir5(dirname5(lockTarget), { recursive: true });
  await writeFile3(lockTarget, "", { flag: "a", mode: 384 });
  await chmod3(lockTarget, 384).catch(() => {
  });
  const release = await lockfile3.lock(lockTarget, {
    realpath: false,
    stale: 3e4,
    update: 1e4,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100
    }
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
async function readActiveProfile(rootDir) {
  const activeProfileFile = join7(
    rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir,
    "active-profile"
  );
  try {
    const text = await readFile2(activeProfileFile, "utf8");
    const profile2 = text.trim();
    return profile2 || void 0;
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
}
async function writeActiveProfile(rootDir, profile2) {
  const activeProfileFile = join7(rootDir, "active-profile");
  await writeFileAtomic(activeProfileFile, `${profile2}
`, { mode: 384 });
}
function runtimeProfileConfig(root, profile2) {
  const cfg = root.profiles[profile2];
  if (!cfg) {
    throw new Error(`profile not found: ${profile2}`);
  }
  return {
    ...cfg,
    ...cfg.secrets ?? root.secrets ? { secrets: cfg.secrets ?? root.secrets } : {}
  };
}
function createRootConfig(profile2, cfg, secrets2 = cfg.secrets) {
  return {
    schemaVersion: 2,
    activeProfile: profile2,
    preferences: {},
    ...secrets2 ? { secrets: secrets2 } : {},
    migrations: { permissionDefaultsV1: [profile2] },
    profiles: {
      [profile2]: {
        ...cfg,
        secrets: void 0
      }
    }
  };
}
function isRootConfig(value) {
  if (!value || typeof value !== "object") return false;
  const root = value;
  return root.schemaVersion === 2 && Boolean(root.profiles && typeof root.profiles === "object");
}
function hasPermissionDefaultsMigration(root, profile2) {
  return root.migrations?.permissionDefaultsV1?.includes(profile2) ?? false;
}
function markPermissionDefaultsMigration(root, profile2) {
  const permissionDefaultsV1 = uniqueSortedStrings([
    ...root.migrations?.permissionDefaultsV1 ?? [],
    profile2
  ]);
  return {
    ...root,
    migrations: {
      ...root.migrations,
      permissionDefaultsV1
    }
  };
}
function normalizeRootMigrations(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const permissionDefaultsV1 = uniqueSortedStrings(input.permissionDefaultsV1);
  return permissionDefaultsV1.length > 0 ? { permissionDefaultsV1 } : void 0;
}
function uniqueSortedStrings(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((value) => typeof value === "string").map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
async function removeProfile(root, profile2, rootDir, opts = {}) {
  if (!root.profiles[profile2]) throw new Error(`profile not found: ${profile2}`);
  const next = {
    ...root,
    profiles: { ...root.profiles }
  };
  delete next.profiles[profile2];
  if (root.activeProfile === profile2) {
    next.activeProfile = Object.keys(next.profiles).sort((a, b) => a.localeCompare(b))[0] ?? "";
  }
  const profileDir = resolveAppPaths({ rootDir, profile: profile2 }).profileDir;
  if (opts.purge) {
    if (!await pathExists(profileDir)) return { root: next, purged: true };
    const trashDir2 = join7(rootDir, ".trash");
    await mkdir5(trashDir2, { recursive: true });
    const stagedTo = await nextArchivePath(trashDir2, profile2, opts.now?.() ?? /* @__PURE__ */ new Date());
    await rename(profileDir, stagedTo);
    return {
      root: next,
      archivedTo: stagedTo,
      purged: true,
      restore: async () => {
        await rename(stagedTo, profileDir);
      },
      cleanup: async () => {
        await rm2(stagedTo, { recursive: true, force: true });
        await rmdir(trashDir2).catch(() => {
        });
      }
    };
  }
  const trashDir = join7(rootDir, ".trash");
  await mkdir5(trashDir, { recursive: true });
  const archivedTo = await nextArchivePath(trashDir, profile2, opts.now?.() ?? /* @__PURE__ */ new Date());
  await rename(profileDir, archivedTo);
  return {
    root: next,
    archivedTo,
    restore: async () => {
      await rename(archivedTo, profileDir);
    }
  };
}
async function nextArchivePath(trashDir, profile2, now) {
  const base = join7(trashDir, `${profile2}-${archiveTimestamp(now)}`);
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (!await pathExists(candidate)) return candidate;
  }
}
function archiveTimestamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
async function pathExists(path) {
  try {
    await stat2(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
function agentKindFromString(value) {
  if (value === "claude" || value === "codex") return value;
  if (value === void 0) return void 0;
  throw new Error(`unsupported agent: ${value}`);
}

// src/config/migrate-v2.ts
var ActiveBridgeMigrationConflictError = class extends Error {
  constructor(processes) {
    super(`active bridge process blocks v2 migration: ${formatActiveProcesses(processes)}`);
    this.processes = processes;
    this.name = "ActiveBridgeMigrationConflictError";
  }
  processes;
};
var STATE_ENTRIES = [
  "sessions.json",
  "workspaces.json",
  "secrets.enc",
  ".keystore.salt",
  "media",
  "logs"
];
async function migrateV1ToV2(opts = {}) {
  const paths2 = resolveAppPaths(opts);
  const profile2 = paths2.profile;
  const configFile = opts.configFile ?? paths2.configFile;
  let rawConfig;
  try {
    rawConfig = await readFile3(configFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { migrated: false, profile: profile2 };
    }
    throw err;
  }
  const parsed = JSON.parse(rawConfig);
  if (parsed.schemaVersion === 2) {
    return { migrated: false, profile: parsed.activeProfile ?? profile2 };
  }
  await assertNoActiveOldProcesses([
    paths2.userRegistryFile,
    join8(paths2.rootDir, "processes.json")
  ]);
  const legacy = parsed;
  const app = legacy.accounts?.app ?? legacy.app;
  if (!app?.id || !app.secret || app.tenant !== "feishu" && app.tenant !== "lark") {
    throw new Error("legacy config is missing accounts.app");
  }
  const legacyDefaultWorkspace = opts.workspace ? await resolveBootstrapWorkspace2(opts.workspace) : await collectLegacyDefaultWorkspace(paths2.rootDir);
  const agentKind = opts.agentKind ?? "claude";
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: { app },
    preferences: legacy.preferences,
    access: {
      ...legacy.preferences?.access,
      requireMentionInGroup: legacy.preferences?.requireMentionInGroup
    },
    ...agentKind === "codex" && opts.codex ? { codex: opts.codex } : {}
  });
  if (legacyDefaultWorkspace) {
    profileConfig.workspaces = {
      ...profileConfig.workspaces,
      default: legacyDefaultWorkspace
    };
  }
  const next = markPermissionDefaultsMigration({
    schemaVersion: 2,
    activeProfile: profile2,
    preferences: {},
    ...legacy.secrets ? { secrets: legacy.secrets } : {},
    profiles: {
      [profile2]: profileConfig
    }
  }, profile2);
  const moved = [];
  try {
    await mkdir6(paths2.profileDir, { recursive: true });
    await copyFile(configFile, `${configFile}.bak`);
    await moveStateEntries(paths2.rootDir, paths2.profileDir, moved);
    await saveRootConfig(next, configFile);
    await writeFileAtomic(paths2.activeProfileFile, `${profile2}
`, { mode: 384 });
    return { migrated: true, profile: profile2 };
  } catch (err) {
    await rollbackMoves(moved);
    await writeFile4(configFile, rawConfig, "utf8").catch(() => {
    });
    await rm3(paths2.activeProfileFile, { force: true }).catch(() => {
    });
    throw err;
  }
}
async function assertNoActiveOldProcesses(registryFiles) {
  const active2 = [];
  for (const path of registryFiles) {
    active2.push(...await activeOldProcessesInFile(path));
  }
  const unique = uniqueActiveProcesses(active2);
  if (unique.length > 0) {
    throw new ActiveBridgeMigrationConflictError(unique);
  }
}
async function activeOldProcessesInFile(path) {
  let registry;
  try {
    registry = JSON.parse(await readFile3(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const active2 = [];
  for (const entry of registry.entries ?? []) {
    if (typeof entry.pid !== "number") continue;
    if (entry.pid === process.pid) continue;
    if (isAlive2(entry.pid)) {
      active2.push(activeProcessFromRegistryEntry(entry));
    }
  }
  return active2;
}
function activeProcessFromRegistryEntry(entry) {
  const active2 = { pid: entry.pid };
  if (typeof entry.id === "string") active2.id = entry.id;
  if (typeof entry.appId === "string") active2.appId = entry.appId;
  if (typeof entry.tenant === "string") active2.tenant = entry.tenant;
  if (typeof entry.profileName === "string") active2.profileName = entry.profileName;
  if (entry.agentKind === "claude" || entry.agentKind === "codex") active2.agentKind = entry.agentKind;
  if (typeof entry.configPath === "string") active2.configPath = entry.configPath;
  if (typeof entry.startedAt === "string") active2.startedAt = entry.startedAt;
  if (typeof entry.version === "string") active2.version = entry.version;
  if (typeof entry.botName === "string") active2.botName = entry.botName;
  return active2;
}
function uniqueActiveProcesses(processes) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const active2 of processes) {
    const key = `${active2.pid}:${active2.id ?? ""}:${active2.configPath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(active2);
  }
  return unique;
}
function formatActiveProcesses(processes) {
  return processes.map((active2) => {
    const id = active2.id ? ` id ${active2.id}` : "";
    const app = active2.appId ? ` app ${active2.appId}` : "";
    return `pid ${active2.pid}${id}${app}`;
  }).join(", ");
}
function isAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
async function moveStateEntries(rootDir, profileDir, moved) {
  for (const name of STATE_ENTRIES) {
    const from = join8(rootDir, name);
    const to = join8(profileDir, name);
    if (!await exists(from)) continue;
    if (await exists(to)) {
      throw new Error(`profile state already exists: ${to}`);
    }
    await mkdir6(dirname6(to), { recursive: true });
    await rename2(from, to);
    moved.push({ from, to });
  }
}
async function rollbackMoves(moved) {
  for (const item of moved.reverse()) {
    if (!await exists(item.to)) continue;
    await mkdir6(dirname6(item.from), { recursive: true }).catch(() => {
    });
    await rename2(item.to, item.from).catch(() => {
    });
  }
}
async function resolveBootstrapWorkspace2(workspace) {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}
async function collectLegacyDefaultWorkspace(rootDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile3(join8(rootDir, "workspaces.json"), "utf8"));
  } catch {
    return void 0;
  }
  const candidates = legacyWorkspaceCandidates(parsed);
  const imported = [];
  for (const candidate of candidates) {
    const workspace = await resolveWorkingDirectory(candidate);
    if (workspace.ok) imported.push(workspace.cwdRealpath);
  }
  return uniqueStrings(imported)[0];
}
function legacyWorkspaceCandidates(value) {
  if (!value || typeof value !== "object") return [];
  const data = value;
  const candidates = [];
  for (const chat of Object.values(data.chats ?? {})) {
    if (typeof chat?.cwd === "string") candidates.push(chat.cwd);
  }
  for (const cwd of Object.values(data.named ?? {})) {
    if (typeof cwd === "string") candidates.push(cwd);
  }
  return uniqueStrings(candidates);
}
function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))].sort();
}
async function exists(path) {
  try {
    await stat3(path);
    return true;
  } catch {
    return false;
  }
}

// src/config/store.ts
import { readFile as readFile4 } from "fs/promises";
import { dirname as dirname7 } from "path";
async function loadConfig(path = paths.configFile) {
  try {
    const text = await readFile4(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}
async function buildEncryptedAccountConfig(appId, tenant, preferences, appPaths2 = paths) {
  const wrapperPath = await ensureSecretsGetterWrapper(appPaths2);
  return {
    accounts: {
      app: {
        id: appId,
        secret: {
          source: "exec",
          provider: "bridge",
          id: secretKeyForApp(appId)
        },
        tenant
      }
    },
    secrets: {
      providers: {
        bridge: {
          source: "exec",
          command: wrapperPath,
          // The wrapper has args baked in; pass none here.
          args: []
        }
      }
    },
    ...preferences ? { preferences } : {}
  };
}
async function ensureSecretsGetterWrapper(appPaths2 = paths, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const wrapperPath = platform === "win32" ? `${appPaths2.secretsGetterScript}.cmd` : appPaths2.secretsGetterScript;
  const node = opts.nodePath ?? process.execPath;
  const bridgeEntry = opts.bridgeEntry ?? process.argv[1] ?? "";
  const rootDir = appPaths2.rootDir ?? dirname7(appPaths2.secretsGetterScript);
  if (platform === "win32") {
    const dq = (s) => `"${s.replace(/"/g, '""')}"`;
    const content2 = `@echo off\r
rem Auto-generated by lark-channel-bridge. Do not edit.\r
set "LARK_CHANNEL_HOME=${rootDir.replace(/"/g, '""')}"\r
${dq(node)} ${dq(bridgeEntry)} secrets get %*\r
`;
    await writeFileAtomic(wrapperPath, content2, { mode: 384 });
    return wrapperPath;
  }
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const content = `#!/bin/sh
# Auto-generated by lark-channel-bridge. Do not edit.
# Forwards exec-provider requests to: node bridge secrets get
LARK_CHANNEL_HOME=${sq(rootDir)} exec ${sq(node)} ${sq(bridgeEntry)} secrets get "$@"
`;
  await writeFileAtomic(wrapperPath, content, { mode: 448 });
  return wrapperPath;
}
async function saveConfig(cfg, path = paths.configFile) {
  await writeFileAtomic(path, `${JSON.stringify(cfg, null, 2)}
`, { mode: 384 });
}

// src/cli/commands/migrate.ts
async function runMigrate(opts) {
  const configPath = opts.config ?? paths.configFile;
  await migrateLegacyPaths();
  await migrateConfigShape(configPath);
  const agentKind = agentKindFromString(opts.agent) ?? (opts.profile === "codex" ? "codex" : void 0);
  const needsV2Migration = await hasLegacyProfileConfig(configPath);
  const result = await migrateProfileV2WithActiveBridgePrompt({
    rootDir: dirname8(configPath),
    configFile: configPath,
    profile: opts.profile,
    ...agentKind ? { agentKind } : {},
    ...needsV2Migration && agentKind === "codex" ? { codex: await createBootstrapCodexConfig(void 0) } : {}
  }, opts);
  if (!result) return;
  if (result.migrated) {
    console.log(`\u2713 \u5DF2\u5347\u7EA7 profile \u76EE\u5F55\u7ED3\u6784\uFF1A${result.profile}`);
  } else {
    console.log(`\u2713 profile \u76EE\u5F55\u7ED3\u6784\u5DF2\u662F\u6700\u65B0\uFF1A${result.profile}`);
  }
}
async function migrateProfileV2WithActiveBridgePrompt(migrateOptions, commandOptions) {
  for (; ; ) {
    try {
      return await migrateV1ToV2(migrateOptions);
    } catch (err) {
      if (!(err instanceof ActiveBridgeMigrationConflictError)) throw err;
      if (commandOptions.confirmStopActiveBridgeProcesses) {
        const confirmed = await commandOptions.confirmStopActiveBridgeProcesses(err.processes);
        if (!confirmed) {
          console.log("\u5DF2\u53D6\u6D88\u8FC1\u79FB\u3002");
          return void 0;
        }
        if (commandOptions.stopActiveBridgeProcesses) {
          await commandOptions.stopActiveBridgeProcesses(err.processes);
        } else {
          await stopActiveBridgeProcesses(err.processes);
        }
        continue;
      }
      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: "\u5DF2\u53D6\u6D88\u8FC1\u79FB\u3002"
      });
      if (!handled) return void 0;
    }
  }
}
async function promptAndStopActiveBridgeMigrationConflict(err, options = {}) {
  const confirmed = await confirmStopActiveBridgeProcesses(err.processes);
  if (!confirmed) {
    if (options.cancelMessage) console.log(options.cancelMessage);
    return false;
  }
  await stopActiveBridgeProcesses(err.processes);
  return true;
}
async function confirmStopActiveBridgeProcesses(processes) {
  console.log("\u68C0\u6D4B\u5230 bridge \u6B63\u5728\u8FD0\u884C\uFF0C\u8FC1\u79FB\u9700\u8981\u5148\u505C\u6B62\u8FD9\u4E9B\u8FDB\u7A0B:");
  for (const active2 of processes) {
    console.log(`  - ${formatActiveBridgeProcess(active2)}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("\u68C0\u6D4B\u5230 bridge \u6B63\u5728\u8FD0\u884C\uFF1B\u975E\u4EA4\u4E92\u6A21\u5F0F\u65E0\u6CD5\u786E\u8BA4\u505C\u6B62\uFF0C\u8BF7\u5148\u505C\u6B62\u540E\u91CD\u8BD5\u8FC1\u79FB");
  }
  const answer = (await promptLine("\u662F\u5426\u505C\u6B62\u8FD9\u4E9B\u8FDB\u7A0B\u5E76\u7EE7\u7EED\u8FC1\u79FB? [y/N]: ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
async function stopActiveBridgeProcesses(processes) {
  for (const active2 of processes) {
    console.log(`\u6B63\u5728\u505C\u6B62 ${formatActiveBridgeProcess(active2)}...`);
    const result = await stopProcessEntry(active2);
    if (result === "killed") {
      console.log(`\u2713 \u5DF2\u5F3A\u5236\u505C\u6B62 pid ${active2.pid}`);
    } else {
      console.log(`\u2713 \u5DF2\u505C\u6B62 pid ${active2.pid}`);
    }
  }
}
function formatActiveBridgeProcess(active2) {
  const label = active2.botName ? `bot ${active2.botName}` : active2.appId ? `app ${active2.appId}` : "bridge";
  const id = active2.id ? ` id=${active2.id}` : "";
  const profile2 = active2.profileName ? ` profile=${active2.profileName}` : "";
  return `${label}${id}${profile2} pid=${active2.pid}`;
}
async function hasLegacyProfileConfig(path) {
  let raw;
  try {
    raw = await readFile5(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  return !isRootConfigV2(JSON.parse(raw));
}
async function migrateLegacyPaths() {
  const legacyConfig = await pathExists2(legacyPaths.appDir);
  const legacyCache = await pathExists2(legacyPaths.cacheDir);
  if (!legacyConfig && !legacyCache) return;
  await mkdir7(paths.appDir, { recursive: true });
  if (legacyConfig) {
    await moveDirContents(legacyPaths.appDir, paths.appDir);
    await rmIfEmpty(legacyPaths.appDir);
    console.log(`\u2713 \u5DF2\u642C\u8FC1\u914D\u7F6E\uFF1A${legacyPaths.appDir} \u2192 ${paths.appDir}`);
  }
  if (legacyCache) {
    const legacyMedia = join9(legacyPaths.cacheDir, "media");
    if (await pathExists2(legacyMedia)) {
      await moveDirContents(legacyMedia, paths.mediaDir);
      await rmIfEmpty(legacyMedia);
    }
    await moveDirContents(legacyPaths.cacheDir, paths.appDir);
    await rmIfEmpty(legacyPaths.cacheDir);
    console.log(`\u2713 \u5DF2\u642C\u8FC1\u7F13\u5B58\uFF1A${legacyPaths.cacheDir} \u2192 ${paths.appDir}`);
  }
}
async function migrateConfigShape(path) {
  let raw;
  try {
    raw = await readFile5(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("  config.json \u4E0D\u5B58\u5728\uFF0C\u8DF3\u8FC7\u7ED3\u6784\u8FC1\u79FB");
      return;
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`\u2717 config \u4E0D\u662F\u5408\u6CD5 JSON (${path}):`, err);
    process.exit(1);
  }
  if (isRootConfigV2(parsed)) {
    console.log(`\u2713 config \u7ED3\u6784\u5DF2\u662F profile v2 \u683C\u5F0F\uFF1A${path}`);
    return;
  }
  const obj = parsed;
  if (isComplete(obj)) {
    console.log(`\u2713 config \u7ED3\u6784\u5DF2\u662F\u65B0\u683C\u5F0F\uFF1A${path}`);
    return;
  }
  if (obj.app?.id && obj.app.secret && obj.app.tenant) {
    const next = { accounts: { app: obj.app } };
    await saveConfig(next, path);
    console.log(`\u2713 \u5DF2\u5347\u7EA7 config \u7ED3\u6784\uFF1A${path}`);
    console.log("  { app: ... } \u2192 { accounts: { app: ... } }");
    return;
  }
  console.error(`\u2717 \u65E0\u6CD5\u8BC6\u522B\u7684 config \u683C\u5F0F\uFF1A${path}`);
  console.error("  \u671F\u671B { app: { id, secret, tenant } } \u6216 { accounts: { app: ... } }");
  process.exit(1);
}
function isRootConfigV2(value) {
  return Boolean(
    value && typeof value === "object" && value.schemaVersion === 2 && value.profiles && typeof value.profiles === "object"
  );
}
async function pathExists2(p3) {
  try {
    await stat4(p3);
    return true;
  } catch {
    return false;
  }
}
async function moveDirContents(from, to) {
  let entries;
  try {
    entries = await readdir(from);
  } catch {
    return;
  }
  await mkdir7(to, { recursive: true });
  for (const name of entries) {
    const src = join9(from, name);
    const dst = join9(to, name);
    if (await pathExists2(dst)) {
      console.log(`  \xB7 \u8DF3\u8FC7 ${name}\uFF08\u76EE\u6807\u5DF2\u5B58\u5728\uFF09`);
      continue;
    }
    await rename3(src, dst);
  }
}
async function rmIfEmpty(p3) {
  try {
    const remaining = await readdir(p3);
    if (remaining.length === 0) await rm4(p3, { recursive: false });
  } catch {
  }
}

// src/config/keystore.ts
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes as randomBytes3 } from "crypto";
import { readFile as readFile6 } from "fs/promises";
import { hostname, userInfo } from "os";
var KEY_LEN = 32;
var IV_LEN = 12;
var TAG_LEN = 16;
var PBKDF2_ITER = 1e5;
var FILE_VERSION = 1;
var derivedKeyCache = /* @__PURE__ */ new Map();
async function readStore(storePaths = paths) {
  try {
    const text = await readFile6(storePaths.secretsFile, "utf8");
    const parsed = JSON.parse(text);
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return emptyStore();
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if (err.code === "ENOENT") return emptyStore();
    throw err;
  }
}
function emptyStore() {
  return { version: FILE_VERSION, entries: {} };
}
async function writeStore(store, storePaths = paths) {
  await writeFileAtomic(storePaths.secretsFile, `${JSON.stringify(store, null, 2)}
`, {
    mode: 384
  });
}
async function loadOrCreateSalt(storePaths = paths) {
  try {
    const buf = await readFile6(storePaths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const salt = randomBytes3(KEY_LEN);
  await writeFileAtomic(storePaths.keystoreSaltFile, salt, { mode: 384 });
  return salt;
}
async function deriveKey(storePaths = paths) {
  const cacheKey = `${storePaths.keystoreSaltFile}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = await loadOrCreateSalt(storePaths);
  const seed = `${hostname()}|${userInfo().username}`;
  const key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, "sha256");
  derivedKeyCache.set(cacheKey, key);
  return key;
}
function encrypt(key, plaintext) {
  const iv = randomBytes3(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: enc.toString("base64"),
    tag: tag.toString("base64")
  };
}
function decrypt(key, env) {
  const iv = Buffer.from(env.iv, "base64");
  const data = Buffer.from(env.data, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_LEN) throw new Error("invalid IV length");
  if (tag.length !== TAG_LEN) throw new Error("invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}
async function getSecret(id, storePaths = paths) {
  const store = await readStore(storePaths);
  const env = store.entries[id];
  if (!env) return void 0;
  const key = await deriveKey(storePaths);
  return decrypt(key, env);
}
async function setSecret(id, plaintext, storePaths = paths) {
  const key = await deriveKey(storePaths);
  const env = encrypt(key, plaintext);
  const store = await readStore(storePaths);
  store.entries[id] = env;
  await writeStore(store, storePaths);
}
async function removeSecret(id, storePaths = paths) {
  const store = await readStore(storePaths);
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  await writeStore(store, storePaths);
  return true;
}
async function listSecretIds(storePaths = paths) {
  const store = await readStore(storePaths);
  return Object.keys(store.entries);
}

// src/runtime/profile-discovery.ts
import { readdir as readdir2 } from "fs/promises";
import { join as join10 } from "path";
async function listAllProfiles(rootDir) {
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  if (!root) throw new Error(`root config not found: ${rootPaths.configFile}`);
  const activeProfile = await readActiveProfile(rootPaths.rootDir) ?? root.activeProfile;
  if (!root.profiles[activeProfile]) {
    throw new Error(`active profile not found: ${activeProfile}`);
  }
  const configured = Object.keys(root.profiles);
  const stateDirs = await readProfileStateDirs(rootPaths.rootDir);
  const configuredSet = new Set(configured);
  const stateSet = new Set(stateDirs);
  const missingState = configured.filter((name) => !stateSet.has(name));
  if (missingState.length > 0) {
    throw new Error(`profile state directory missing: ${missingState.join(", ")}`);
  }
  const orphanState = [];
  for (const name of stateDirs) {
    if (configuredSet.has(name)) continue;
    if (await isLogOnlyProfileState(rootPaths.rootDir, name)) continue;
    orphanState.push(name);
  }
  if (orphanState.length > 0) {
    throw new Error(`profile state directory without config: ${orphanState.join(", ")}`);
  }
  return configured.sort((a, b) => profileSort(a, b, activeProfile)).map((name) => {
    const profile2 = root.profiles[name];
    if (!profile2) throw new Error(`profile not found: ${name}`);
    return {
      name,
      active: name === activeProfile,
      agentKind: profile2.agentKind,
      profileDir: resolveAppPaths({ rootDir: rootPaths.rootDir, profile: name }).profileDir
    };
  });
}
async function readProfileStateDirs(rootDir) {
  const profilesDir = join10(rootDir, "profiles");
  try {
    const entries = await readdir2(profilesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
async function isLogOnlyProfileState(rootDir, profile2) {
  try {
    const entries = await readdir2(join10(rootDir, "profiles", profile2), { withFileTypes: true });
    return entries.length === 1 && entries[0]?.isDirectory() === true && entries[0].name === "logs";
  } catch {
    return false;
  }
}
function profileSort(a, b, active2) {
  if (a === active2) return -1;
  if (b === active2) return 1;
  return a.localeCompare(b);
}

// src/cli/commands/secrets.ts
var PROTOCOL_VERSION = 1;
async function runSecretsGet() {
  const input = await readAllStdin();
  let req;
  try {
    req = JSON.parse(input || "{}");
  } catch (err) {
    console.error(`secrets get: invalid stdin JSON: ${err.message}`);
    process.exit(2);
  }
  const ids = req.ids ?? [];
  const resp = {
    protocolVersion: PROTOCOL_VERSION,
    values: {}
  };
  for (const id of ids) {
    try {
      const v = await resolveSecretAcrossProfiles(id);
      if (v !== void 0) {
        resp.values[id] = v;
      } else {
        (resp.errors ??= {})[id] = { message: "not found" };
      }
    } catch (err) {
      (resp.errors ??= {})[id] = { message: err.message };
    }
  }
  process.stdout.write(`${JSON.stringify(resp)}
`);
}
async function runSecretsSet(appId, opts = {}) {
  if (!appId) {
    console.error("\u7528\u6CD5: lark-channel-bridge secrets set --app-id <id>");
    process.exit(1);
  }
  const plaintext = await promptPassword(`\u8F93\u5165 ${appId} \u7684 App Secret: `);
  if (!plaintext) {
    console.error("\u2717 \u53D6\u6D88(secret \u4E3A\u7A7A)");
    process.exit(1);
  }
  await setAppSecret(appId, plaintext, opts);
  console.log(`\u2713 \u5DF2\u52A0\u5BC6\u5B58\u5230 ~/.lark-channel/secrets.enc`);
}
async function runSecretsList(opts = {}) {
  const appPaths2 = await resolveSecretProfilePaths(opts);
  const ids = await listSecretIds(appPaths2);
  if (ids.length === 0) {
    console.log("\u5F53\u524D\u6CA1\u6709\u52A0\u5BC6\u5B58\u50A8\u7684 secret\u3002");
    return;
  }
  console.log(`# \u5F53\u524D\u5171 ${ids.length} \u4E2A secret \u5728\u52A0\u5BC6\u5B58\u50A8\u91CC
`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}
async function runSecretsRemove(appId, opts = {}) {
  if (!appId) {
    console.error("\u7528\u6CD5: lark-channel-bridge secrets remove --app-id <id>");
    process.exit(1);
  }
  const id = secretKeyForApp(appId);
  const removed = await removeAppSecret(appId, opts);
  if (!removed) {
    console.error(`\u2717 \u6CA1\u627E\u5230 secret: ${id}`);
    process.exit(1);
  }
  console.log(`\u2713 \u5DF2\u5220\u9664 ${id}`);
}
async function resolveSecretAcrossProfiles(id, rootDir = paths.rootDir, warn = (message) => console.error(message), profile2 = process.env.LARK_CHANNEL_PROFILE) {
  if (profile2) {
    const appPaths2 = resolveAppPaths({ rootDir, profile: profile2 });
    const ids = await listSecretIds(appPaths2);
    if (!ids.includes(id)) return void 0;
    return getSecret(id, appPaths2);
  }
  const profiles = await listSecretProfiles(rootDir);
  const matches = [];
  for (const profile3 of profiles) {
    const appPaths2 = resolveAppPaths({ rootDir, profile: profile3.name });
    const ids = await listSecretIds(appPaths2);
    if (ids.includes(id)) matches.push(appPaths2);
  }
  if (matches.length === 0) return void 0;
  if (matches.length > 1) {
    warn(
      `secrets get: secret ${id} exists in multiple profiles; using ${matches[0]?.profile ?? "unknown"}`
    );
  }
  const first = matches[0];
  if (!first) return void 0;
  return getSecret(id, first);
}
async function setAppSecret(appId, plaintext, opts = {}) {
  const appPaths2 = await resolveSecretProfilePaths(opts);
  await setSecret(secretKeyForApp(appId), plaintext, appPaths2);
}
async function removeAppSecret(appId, opts = {}) {
  const appPaths2 = await resolveSecretProfilePaths(opts);
  return removeSecret(secretKeyForApp(appId), appPaths2);
}
async function resolveSecretProfilePaths(opts) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  const profile2 = opts.profile ?? await readActiveProfile(rootDir) ?? root?.activeProfile ?? "claude";
  if (root && !root.profiles[profile2]) throw new Error(`profile not found: ${profile2}`);
  return resolveAppPaths({ rootDir, profile: profile2 });
}
async function listSecretProfiles(rootDir) {
  try {
    return await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("root config not found:")) throw err;
    return [{ name: resolveAppPaths({ rootDir }).profile }];
  }
}
async function readAllStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve2, reject4) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", reject4);
  });
}

// src/cli/commands/profile.ts
import { existsSync as existsSync2 } from "fs";
import { rm as rm7 } from "fs/promises";

// src/config/secret-resolver.ts
import { readFile as readFile7 } from "fs/promises";
import { join as join11 } from "path";
var ENV_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
var DEFAULT_PROVIDER = "default";
var DEFAULT_EXEC_TIMEOUT_MS = 5e3;
var DEFAULT_EXEC_MAX_OUTPUT = 64 * 1024;
async function resolveAppSecret(cfg, secretPaths = paths) {
  const appId = cfg.accounts.app.id;
  const secret = cfg.accounts.app.secret;
  return resolveSecretInput(secret, cfg.secrets, appId, secretPaths);
}
async function resolveSecretInput(input, secretsCfg, appId, secretPaths) {
  if (!input) {
    throw new Error("app secret is missing");
  }
  if (typeof input === "string") {
    return resolvePlainOrTemplate(input);
  }
  if (!isSecretRef(input)) {
    throw new Error(`unsupported secret form: ${JSON.stringify(input)}`);
  }
  switch (input.source) {
    case "env":
      return resolveEnvRef(input, lookupProvider(secretsCfg, input));
    case "file":
      return resolveFileRef(input, lookupProvider(secretsCfg, input));
    case "exec":
      return resolveExecRef(input, lookupProvider(secretsCfg, input), appId, secretPaths);
    default:
      throw new Error(`unknown secret source: ${input.source}`);
  }
}
function resolvePlainOrTemplate(value) {
  if (!value) throw new Error("app secret is empty");
  const m = ENV_TEMPLATE_RE.exec(value);
  if (m) {
    const name = m[1];
    const v = process.env[name];
    if (!v) throw new Error(`env var ${name} referenced by secret is not set`);
    return v;
  }
  return value;
}
function lookupProvider(secretsCfg, ref) {
  if (!secretsCfg?.providers) return void 0;
  const name = ref.provider ?? secretsCfg.defaults?.[ref.source] ?? DEFAULT_PROVIDER;
  return secretsCfg.providers[name];
}
function resolveEnvRef(ref, pc) {
  if (pc?.allowlist && pc.allowlist.length > 0 && !pc.allowlist.includes(ref.id)) {
    throw new Error(`env var ${ref.id} is not allowlisted in provider`);
  }
  const v = process.env[ref.id];
  if (!v) throw new Error(`env var ${ref.id} is not set`);
  return v;
}
async function resolveFileRef(ref, pc) {
  const path = pc?.path ? join11(pc.path, ref.id) : ref.id;
  const text = await readFile7(path, "utf8");
  return text.trim();
}
async function resolveExecRef(ref, pc, appId, secretPaths) {
  if (!pc?.command) {
    throw new Error("exec provider missing `command`");
  }
  if (isSelfBridgeCommand(pc.command, pc.args)) {
    const candidate = await getSecret(ref.id, secretPaths);
    if (candidate !== void 0) return candidate;
    const conventional = secretKeyForApp(appId);
    const fallback = await getSecret(conventional, secretPaths);
    if (fallback !== void 0) return fallback;
    throw new Error(`keystore has no entry for "${ref.id}" or "${conventional}"`);
  }
  return spawnExecProvider(pc, ref);
}
function isSelfBridgeCommand(command, args) {
  if (command === paths.secretsGetterScript) return true;
  if (command === `${paths.secretsGetterScript}.cmd`) return true;
  if (args && args.length >= 2) {
    const a = args[args.length - 2];
    const b = args[args.length - 1];
    if (a === "secrets" && b === "get") return true;
  }
  return false;
}
async function spawnExecProvider(pc, ref) {
  const timeoutMs = pc.noOutputTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutput = pc.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT;
  const providerName = ref.provider ?? DEFAULT_PROVIDER;
  return new Promise((resolve2, reject4) => {
    const env = {};
    if (pc.passEnv) {
      for (const k of pc.passEnv) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    }
    if (pc.env) Object.assign(env, pc.env);
    const child = spawnProcess(pc.command, pc.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject4(new Error(`exec provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      if (stdout.length + chunk.length > maxOutput) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject4(new Error(`exec provider failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        reject4(new Error(`exec provider stdout exceeded ${maxOutput} bytes`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : "";
        reject4(new Error(`exec provider exited with code ${code}${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const value = parsed.values?.[ref.id];
        if (typeof value === "string") {
          resolve2(value);
          return;
        }
        const err = parsed.errors?.[ref.id]?.message;
        reject4(new Error(`exec provider did not return secret for ${ref.id}${err ? `: ${err}` : ""}`));
      } catch (err) {
        reject4(new Error(`exec provider returned invalid JSON: ${err.message}`));
      }
    });
    const request = JSON.stringify({
      protocolVersion: 1,
      provider: providerName,
      ids: [ref.id]
    });
    child.stdin.end(request);
  });
}

// src/runtime/profile-runtime.ts
import { mkdir as mkdir8, readFile as readFile9, realpath as realpath3 } from "fs/promises";
import { dirname as dirname10 } from "path";
import * as p from "@clack/prompts";

// src/bot/wizard.ts
import { registerApp } from "@larksuite/channel";
import qrcode from "qrcode-terminal";
async function requestScopeGrantLink(opts) {
  return new Promise((resolve2, reject4) => {
    let urlDelivered = false;
    const completion = registerApp({
      source: "lark-channel-bridge",
      appId: opts.appId,
      addons: { scopes: { tenant: opts.tenantScopes } },
      ...opts.signal ? { signal: opts.signal } : {},
      onQRCodeReady: (info) => {
        urlDelivered = true;
        resolve2({ url: info.url, expireIn: info.expireIn, completion });
      }
    }).then(() => void 0);
    completion.catch((err) => {
      if (!urlDelivered) reject4(err);
    });
  });
}
async function runRegistrationWizard() {
  console.log("\n\u672A\u68C0\u6D4B\u5230\u98DE\u4E66\u5E94\u7528\u914D\u7F6E\uFF0C\u8FDB\u5165\u626B\u7801\u521B\u5EFA\u5411\u5BFC\u3002\n");
  const result = await registerApp({
    source: "lark-channel-bridge",
    onQRCodeReady: (info) => {
      console.log("\u8BF7\u7528\u98DE\u4E66 App \u626B\u63CF\u4EE5\u4E0B\u4E8C\u7EF4\u7801\u5B8C\u6210\u5E94\u7528\u521B\u5EFA\uFF1A\n");
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`
\u4E8C\u7EF4\u7801\u6709\u6548\u671F\uFF1A\u7EA6 ${mins} \u5206\u949F`);
      console.log(`\u4E5F\u53EF\u4EE5\u76F4\u63A5\u5728\u6D4F\u89C8\u5668\u6253\u5F00\uFF1A${info.url}
`);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        console.log("\u8BC6\u522B\u5230\u56FD\u9645\u7248\u79DF\u6237\uFF0C\u5DF2\u5207\u6362\u5230 larksuite.com \u57DF\u540D\u3002");
      } else if (info.status === "slow_down") {
        console.log("\u8F6E\u8BE2\u901F\u5EA6\u8FC7\u5FEB\uFF0C\u5DF2\u81EA\u52A8\u964D\u901F\u3002");
      }
    }
  });
  const tenant = result.user_info?.tenant_brand ?? "feishu";
  const operatorOpenId = result.user_info?.open_id;
  console.log("\n\u2713 \u5E94\u7528\u521B\u5EFA\u6210\u529F");
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);
  if (operatorOpenId) {
    console.log(`  Creator: ${operatorOpenId} (Lark \u5E94\u7528 owner\uFF0C\u81EA\u52A8\u8C41\u514D\u8BBF\u95EE\u63A7\u5236)`);
  } else {
    console.log("  \u26A0\uFE0F \u672A\u62FF\u5230\u626B\u7801\u7528\u6237\u7684 open_id\uFF1B\u542F\u52A8\u540E\u4F1A\u901A\u8FC7\u5E94\u7528 owner API \u89E3\u6790\u521B\u5EFA\u8005\u3002");
  }
  if (operatorOpenId) {
    console.log(`  Creator: ${operatorOpenId} (Lark \u5E94\u7528 owner\uFF0C\u81EA\u52A8\u8C41\u514D\u6240\u6709\u8BBF\u95EE\u63A7\u5236)`);
  } else {
    console.log(
      "  \u26A0\uFE0F \u672A\u62FF\u5230\u626B\u7801\u7528\u6237\u7684 open_id\uFF1B\u9996\u6B21\u542F\u52A8\u65F6 bridge \u4F1A\u81EA\u884C\u8C03 application/v6 API \u89E3\u6790\u5F53\u524D owner\u3002"
    );
  }
  const cfg = {
    accounts: {
      app: {
        id: result.client_id,
        secret: result.client_secret,
        tenant
      }
    }
  };
  console.log("");
  return cfg;
}

// src/core/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import { createWriteStream, mkdirSync as mkdirSync2 } from "fs";
import { open as open2, readdir as readdir3, rm as rm5, stat as stat5 } from "fs/promises";
import { join as join12 } from "path";

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
var methodWarned = false;
function diag(event, fields) {
  console.warn(`\u26A0 [telemetry.${event}] ${JSON.stringify(fields)}`);
}
function warnOnce(event, fields) {
  if (methodWarned) return;
  methodWarned = true;
  diag(event, fields);
}
function bound(fn, ctx) {
  return typeof fn === "function" ? fn.bind(ctx) : void 0;
}
function wrapSafe(adapter) {
  const safe = (fn) => {
    if (!fn) return void 0;
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        warnOnce("method_threw", {
          err: err instanceof Error ? err.message : String(err)
        });
        return void 0;
      }
    };
  };
  return {
    emit: safe(bound(adapter.emit, adapter)) ?? noop.emit,
    recordError: safe(bound(adapter.recordError, adapter)) ?? noop.recordError,
    recordMetric: safe(bound(adapter.recordMetric, adapter)) ?? noop.recordMetric,
    flush: safe(bound(adapter.flush, adapter)),
    close: safe(bound(adapter.close, adapter))
  };
}
async function loadTelemetryAdapter(meta) {
  const mod = process.env.LARK_CHANNEL_TELEMETRY_MODULE;
  if (!mod) return;
  try {
    const imported = await import(normalizeModuleSpecifier(mod));
    const factory = imported.default ?? imported.createAdapter;
    if (typeof factory !== "function") {
      diag("bad_module", { module: mod });
      return;
    }
    const adapter = factory(meta);
    if (!adapter || typeof adapter.emit !== "function") {
      diag("bad_adapter", { module: mod });
      return;
    }
    active = wrapSafe(adapter);
  } catch (err) {
    diag("load_fail", {
      module: mod,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}
function normalizeModuleSpecifier(specifier) {
  return specifier.startsWith("file:") ? specifier.replace(/%7E/gi, "~") : specifier;
}
function telemetry() {
  return active;
}

// src/core/logger.ts
var DEFAULT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 30) || 30
);
var loggerOptions = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  now: () => /* @__PURE__ */ new Date()
};
var STDOUT_INFO_ALLOWLIST = /* @__PURE__ */ new Set([
  "ws.connected",
  "ws.reconnecting",
  "ws.reconnected",
  "intake.enter",
  "intake.command",
  "run.started",
  "run.completed",
  "run.failed",
  "cot.created",
  "cot.completed",
  "outbound.sent",
  "outbound.markdown-stream-fallback",
  "card.final"
]);
var als = new AsyncLocalStorage();
var stream = null;
var currentDate = "";
function todayKey() {
  return formatLocalDateKey(loggerOptions.now());
}
function logsDir() {
  return loggerOptions.logsDir;
}
function logFileName(dateKey) {
  return `bridge-${dateKey}.jsonl`;
}
function getStream() {
  const dir = logsDir();
  if (!dir) return null;
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
    }
  }
  try {
    mkdirSync2(dir, { recursive: true });
    stream = createWriteStream(join12(dir, logFileName(today)), { flags: "a" });
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}
var RESERVED_KEYS = /* @__PURE__ */ new Set([
  "ts",
  "level",
  "phase",
  "event",
  "traceId",
  "chatId",
  "msgId"
]);
var TELEMETRY_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "ts",
  "level",
  "phase",
  "event",
  "traceId",
  "chatId",
  "msgId"
]);
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
var LOCAL_LOG_SANITIZE = { redactIds: false };
var EXTERNAL_SANITIZE = { redactIds: true };
function sanitizeLogEntry(entry, options = EXTERNAL_SANITIZE) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = sanitizeLogValue(key, value, options);
  }
  return out;
}
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
function emit(level, phase, event, fields = {}) {
  const ctx = als.getStore() ?? {};
  const entry = sanitizeLogEntry({
    ts: formatLocalTimestamp(loggerOptions.now()),
    level,
    phase,
    event,
    ...ctx
  }, LOCAL_LOG_SANITIZE);
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = sanitizeLogValue(`_${k}`, v, LOCAL_LOG_SANITIZE);
    } else {
      entry[k] = sanitizeLogValue(k, v, LOCAL_LOG_SANITIZE);
    }
  }
  const externalEntry = sanitizeLogEntry(entry, EXTERNAL_SANITIZE);
  const telemetrySafe = telemetryPayloadFromEntry(externalEntry);
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}
`);
    } catch {
    }
  }
  try {
    telemetry().emit({
      level,
      phase,
      event,
      fields: telemetrySafe.fields,
      ctx: telemetrySafe.ctx,
      ts: String(entry.ts)
    });
  } catch {
  }
  if (level === "error") {
    try {
      telemetry().recordError(telemetrySafe.fields.err ?? `${phase}.${event}`, {
        phase,
        event,
        ...telemetrySafe.ctx,
        ...telemetrySafe.fields
      });
    } catch {
    }
  }
  const showOnStdout = level !== "info" || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(formatStdout(level, phase, event, telemetrySafe.ctx, telemetrySafe.fields));
}
function telemetryPayloadFromEntry(entry) {
  const ctx = {};
  if (typeof entry.traceId === "string") ctx.traceId = entry.traceId;
  if (typeof entry.chatId === "string") ctx.chatId = entry.chatId;
  if (typeof entry.msgId === "string") ctx.msgId = entry.msgId;
  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (TELEMETRY_ENVELOPE_KEYS.has(key) || value === void 0) continue;
    fields[key] = value;
  }
  return { ctx, fields };
}
function formatStdout(level, phase, event, ctx, fields) {
  if (phase === "ws") {
    if (event === "connected") {
      const bot = fields.bot ?? "-";
      const appId = fields.appId ? ` (${fields.appId})` : "";
      const agent = fields.agent ?? "-";
      const proc = fields.procId ? `  \u8FDB\u7A0B: ${fields.procId}` : "";
      return `\u2713 \u5DF2\u8FDE\u63A5  bot: ${bot}${appId}  agent: ${agent}${proc}`;
    }
    if (event === "reconnecting") return "\u21BB \u6B63\u5728\u91CD\u8FDE\u2026";
    if (event === "reconnected") return "\u2713 \u5DF2\u91CD\u8FDE";
    if (event === "fail") return `\u2717 WS \u9519\u8BEF: ${fields.err ?? ""}`;
  }
  if (phase === "intake" && event === "enter") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const mode = fields.chatMode ?? fields.chatType ?? "?";
    const scope = shortId(fields.scope);
    const sender = fields.sender ?? "-";
    const msg = shortId(ctx.msgId ?? fields.msgId ?? fields._msgId);
    const preview2 = fields.preview ?? "";
    return `\u25B8 ${mode}/${c} scope=${scope} sender=${sender} msg=${msg}: ${preview2}`;
  }
  if (phase === "intake" && event === "command") {
    const scope = shortId(fields.scope);
    return `  \u21B3 command scope=${scope} dropped=${fields.droppedPending ?? 0}`;
  }
  if (phase === "run" && event === "started") {
    const scope = shortId(fields.scope);
    return `  \u25B6 run start scope=${scope} run=${shortId(fields.runId)} queue=${fields.queueWaitMs ?? 0}ms`;
  }
  if (phase === "run" && (event === "completed" || event === "failed")) {
    const result = event === "failed" ? "failed" : fields.result ?? "done";
    const mark = event === "failed" ? "\u2717" : result === "interrupted" ? "\u23F9" : "\u2713";
    const scope = shortId(fields.scope);
    const duration = formatDurationMs(fields.durationMs);
    return `  ${mark} run ${result} scope=${scope} run=${shortId(fields.runId)}${duration ? ` duration=${duration}` : ""}`;
  }
  if (phase === "cot" && event === "created") {
    return `  \u25C7 cot created message=${shortId(fields.messageId)} cot=${shortId(fields.cotId)}`;
  }
  if (phase === "cot" && event === "completed") {
    return `  \u25C7 cot completed cot=${shortId(fields.cotId)} reason=${fields.reason ?? "-"}`;
  }
  if (phase === "outbound" && event === "markdown-stream-fallback") {
    return `  \u26A0 markdown stream fallback: ${fields.err ?? ""}`;
  }
  if (phase === "outbound" && event === "sent") {
    const scope = shortId(fields.scope);
    const reply2 = fields.replyInThread === true ? "thread" : "reply";
    return `  \u2197 sent ${fields.type ?? "message"} scope=${scope} ${reply2}=${shortId(fields.replyTo)} msg=${shortId(fields.messageId)}`;
  }
  if (phase === "card" && event === "final") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const t = fields.terminal;
    const mark = t === "done" ? "\u2713" : t === "interrupted" ? "\u23F9" : "\u2717";
    const scope = fields.scope ? shortId(fields.scope) : c;
    return `  ${mark} ${scope} ${t}`;
  }
  const ctxBits = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(" ")}` : "";
  const summary = formatFields(fields);
  const tag = level === "error" ? "\u2717" : level === "warn" ? "\u26A0" : "\xB7";
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ""}`;
}
function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function formatLocalTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign2 = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${sign2}${oh}:${om}`;
}
function shortId(value) {
  if (value === void 0 || value === null) return "-";
  const s = String(value);
  const last = s.includes(":") ? s.split(":").at(-1) ?? s : s;
  const bare = last.startsWith("...") ? last.slice(3) : last;
  return bare.length > 6 ? bare.slice(-6) : bare;
}
function formatDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  if (value < 1e3) return `${value}ms`;
  const seconds = value / 1e3;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}
function formatFields(fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";
  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === void 0 || v === null) continue;
    if (k === "stack") continue;
    if (typeof v === "string") {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}\u2026` : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}\u2026` : s}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(" ");
}
var log = {
  info(phase, event, fields) {
    emit("info", phase, event, fields);
  },
  warn(phase, event, fields) {
    emit("warn", phase, event, fields);
  },
  fail(phase, err, fields) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : void 0;
    const apiData = err?.response?.data;
    const apiStatus = err?.response?.status;
    emit("error", phase, "fail", {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack
    });
  }
};
function configureLogger(opts) {
  if (stream) {
    try {
      stream.end();
    } catch {
    }
  }
  stream = null;
  currentDate = "";
  loggerOptions = {
    ...opts.logsDir !== void 0 ? { logsDir: opts.logsDir } : { logsDir: loggerOptions.logsDir },
    retentionDays: Math.max(1, opts.retentionDays ?? loggerOptions.retentionDays),
    now: opts.now ?? loggerOptions.now
  };
}
function withTrace(ctx, fn) {
  const traceId = ctx.traceId ?? newTraceId();
  return als.run({ ...ctx, traceId }, fn);
}
function newTraceId() {
  return Math.random().toString(36).slice(2, 10);
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
async function gcOldLogs() {
  const dir = logsDir();
  if (!dir) return 0;
  let entries;
  try {
    entries = await readdir3(dir);
  } catch {
    return 0;
  }
  const cutoff = loggerOptions.now().getTime() - loggerOptions.retentionDays * 864e5;
  let removed = 0;
  for (const name of entries) {
    const m = name.match(/^bridge-(\d{4})(\d{2})(\d{2})\.jsonl$/);
    if (!m) continue;
    const fileMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isNaN(fileMs) || fileMs >= cutoff) continue;
    try {
      await rm5(join12(dir, name));
      removed++;
    } catch {
    }
  }
  if (removed > 0) {
    log.info("logger", "gc", { removed, retentionDays: loggerOptions.retentionDays });
  }
  return removed;
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

// src/lark-cli/legacy-source-overlay.ts
import { access as access2, readFile as readFile8, rm as rm6 } from "fs/promises";
import { dirname as dirname9, join as join13 } from "path";
function legacyLarkCliSourceOverlayPaths(configFile) {
  const dir = dirname9(configFile);
  return {
    backupFile: join13(dir, ".config.json.lark-cli-bind-backup"),
    markerFile: join13(dir, ".config.json.lark-cli-bind-marker")
  };
}
async function recoverLegacyLarkCliSourceOverlay(configFile) {
  await withConfigFileLock(configFile, async () => {
    await recoverLegacyLarkCliSourceOverlayUnlocked(configFile);
  });
}
async function hasLegacyLarkCliSourceOverlay(configFile) {
  const { markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
  try {
    await access2(markerFile);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
async function withLegacyLarkCliSourceOverlay(configFile, sourceConfigFile, fn) {
  return withConfigFileLock(configFile, async () => {
    await recoverLegacyLarkCliSourceOverlayUnlocked(configFile);
    const { backupFile, markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
    const original = await readOptional(configFile);
    if (original !== void 0) {
      await writeFileAtomic(backupFile, original, { mode: 384 });
    } else {
      await rm6(backupFile, { force: true }).catch(() => {
      });
    }
    const marker = { hadConfig: original !== void 0 };
    await writeFileAtomic(markerFile, `${JSON.stringify(marker, null, 2)}
`, { mode: 384 });
    const source = await readFile8(sourceConfigFile);
    await writeFileAtomic(configFile, source, { mode: 384 });
    try {
      return await fn();
    } finally {
      await restoreLegacyLarkCliSourceOverlayUnlocked(configFile);
    }
  });
}
async function recoverLegacyLarkCliSourceOverlayUnlocked(configFile) {
  const marker = await readMarker(configFile);
  if (!marker) return;
  await restoreLegacyLarkCliSourceOverlayUnlocked(configFile, marker);
}
async function restoreLegacyLarkCliSourceOverlayUnlocked(configFile, markerArg) {
  const marker = markerArg ?? await readMarker(configFile);
  if (!marker) return;
  const { backupFile, markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
  if (marker.hadConfig) {
    const backup = await readFile8(backupFile);
    await writeFileAtomic(configFile, backup, { mode: 384 });
  } else {
    await rm6(configFile, { force: true }).catch(() => {
    });
  }
  await rm6(backupFile, { force: true }).catch(() => {
  });
  await rm6(markerFile, { force: true }).catch(() => {
  });
}
async function readMarker(configFile) {
  const { markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
  try {
    const parsed = JSON.parse(await readFile8(markerFile, "utf8"));
    return { hadConfig: parsed.hadConfig === true, ...parsed.profile ? { profile: parsed.profile } : {} };
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
}
async function readOptional(path) {
  try {
    return await readFile8(path);
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
}

// src/utils/feishu-auth.ts
var ENDPOINTS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
async function validateAppCredentials(appId, appSecret, tenant) {
  const base = ENDPOINTS[tenant];
  let resp;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
  } catch (err) {
    return { ok: false, reason: `\u7F51\u7EDC\u9519\u8BEF\uFF1A${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, reason: "\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON" };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? "?"} msg=${data.msg ?? "<no msg>"}` };
  }
  const info = await fetchBotInfo(base, data.tenant_access_token).catch(() => void 0);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id };
}
async function fetchBotInfo(base, token) {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return void 0;
  return await resp.json();
}

// src/runtime/profile-runtime.ts
var ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;
function createRuntimeProfileConfig(input) {
  return createDefaultProfileConfig({
    ...input,
    ...input.agentKind === "codex" ? { codex: input.codex ?? { binaryPath: process.env.LARK_CHANNEL_CODEX_BIN ?? "codex" } } : {}
  });
}
async function resolveProfileRuntime(opts) {
  const rootDir = opts.config ? dirname10(opts.config) : void 0;
  const recoveryConfigFile = opts.config ?? resolveAppPaths({ rootDir }).configFile;
  if (await hasLegacyLarkCliSourceOverlay(recoveryConfigFile)) {
    await recoverLegacyLarkCliSourceOverlay(recoveryConfigFile);
  }
  const requestedAgent = agentKindFromString(opts.agent);
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? await readActiveProfile(rootDir);
  let profile2 = activeProfile ?? requestedAgent;
  if (!profile2 && opts.allowBootstrap) {
    const detected = await detectInstalledAgents();
    if (detected.length === 0) {
      throw new Error("no supported local agent found; install claude or codex first");
    }
    if (detected.length > 1) {
      const selected = await selectDetectedAgent(detected, opts.selectAgent);
      if (!selected) {
        throw new Error(formatAmbiguousAgentSelectionError(detected));
      }
      profile2 = selected;
    } else {
      profile2 = detected[0]?.kind;
    }
  }
  if (!profile2 && !opts.allowBootstrap) {
    throw new Error("active profile is required");
  }
  profile2 ??= "claude";
  let appPaths2 = resolveAppPaths({ rootDir, profile: profile2 });
  const configPath = opts.config ?? appPaths2.configFile;
  const migrationAgent = resolveBootstrapAgent(requestedAgent, profile2);
  const needsMigration = await hasLegacyConfig(configPath);
  await migrateV1ToV2WithActiveBridgeHandling({
    rootDir: appPaths2.rootDir,
    profile: appPaths2.profile,
    configFile: configPath,
    workspace: opts.workspace,
    ...migrationAgent ? { agentKind: migrationAgent } : {},
    ...needsMigration && migrationAgent === "codex" ? { codex: await createBootstrapCodexConfig(void 0) } : {}
  }, opts.handleActiveBridgeMigrationConflict);
  let rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile2 = rootConfig.activeProfile;
      appPaths2 = resolveAppPaths({ rootDir, profile: profile2 });
    }
    let profileConfig2 = rootConfig.profiles[profile2];
    if (!profileConfig2) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile: profile2,
          requestedAgent,
          opts,
          appPaths: appPaths2,
          configPath
        });
      }
      throw new Error(`profile not found: ${profile2}`);
    }
    assertRequestedAgentMatchesExistingProfile(profile2, profileConfig2, requestedAgent);
    const runtimeUpgrade = upgradeLegacyRuntimeDefaults(rootConfig, profile2);
    if (runtimeUpgrade.changed) {
      rootConfig = runtimeUpgrade.rootConfig;
    }
    const defaultWorkspaceUpgrade = await ensureProfileDefaultWorkspace(rootConfig, profile2, appPaths2);
    if (defaultWorkspaceUpgrade.changed) {
      rootConfig = defaultWorkspaceUpgrade.rootConfig;
    }
    if (runtimeUpgrade.changed || defaultWorkspaceUpgrade.changed) {
      await saveRootConfig(rootConfig, configPath);
      profileConfig2 = rootConfig.profiles[profile2];
      log.info("profile", "legacy-runtime-defaults-upgraded", {
        profile: profile2,
        permissions: runtimeUpgrade.permissions,
        codex: runtimeUpgrade.codex,
        workspace: defaultWorkspaceUpgrade.changed
      });
    }
    assertBootstrapAppMatchesExistingProfile(opts, profile2, profileConfig2);
    const cfg = await maybeMigrateRootPlaintextSecret(rootConfig, profile2, appPaths2, configPath);
    return { cfg, profileConfig: profileConfig2, configPath, appPaths: appPaths2, profile: profile2 };
  }
  const existing = await loadConfig(configPath);
  if (isComplete(existing)) {
    assertBootstrapAppMatchesExistingConfig(opts, profile2, existing);
    const cfg = await maybeMigratePlaintextSecret(existing, configPath, appPaths2);
    const profileConfig2 = createRuntimeProfileConfig({
      agentKind: requestedAgent ?? "claude",
      accounts: cfg.accounts,
      preferences: cfg.preferences,
      secrets: cfg.secrets
    });
    profileConfig2.workspaces.default = await resolveConvertedLegacyDefaultWorkspace(opts, appPaths2);
    const root2 = createRootConfig(profile2, profileConfig2, cfg.secrets);
    await saveRootConfig(root2, configPath);
    await writeActiveProfile(appPaths2.rootDir, profile2);
    return { cfg: runtimeProfileConfig(root2, profile2), profileConfig: profileConfig2, configPath, appPaths: appPaths2, profile: profile2 };
  }
  if (!opts.allowBootstrap) {
    throw new Error("config not initialized");
  }
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile2) ?? "claude";
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths2);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths2.defaultWorkspaceDir,
    profileDir: appPaths2.profileDir
  });
  const root = createRootConfig(profile2, profileConfig, encrypted.secrets);
  await saveRootConfig(root, configPath);
  await writeActiveProfile(appPaths2.rootDir, profile2);
  console.log(`\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230 ${configPath}
`);
  return { cfg: runtimeProfileConfig(root, profile2), profileConfig, configPath, appPaths: appPaths2, profile: profile2 };
}
async function bootstrapProfileIntoExistingRoot(args) {
  const { rootConfig, profile: profile2, requestedAgent, opts, appPaths: appPaths2, configPath } = args;
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile2) ?? "claude";
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths2);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths2.defaultWorkspaceDir,
    profileDir: appPaths2.profileDir
  });
  const nextRoot = {
    ...rootConfig,
    ...rootConfig.secrets ?? encrypted.secrets ? { secrets: rootConfig.secrets ?? encrypted.secrets } : {},
    profiles: {
      ...rootConfig.profiles,
      [profile2]: {
        ...profileConfig,
        secrets: void 0
      }
    }
  };
  await saveRootConfig(markPermissionDefaultsMigration(nextRoot, profile2), configPath);
  console.log(`\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230 ${configPath}
`);
  return {
    cfg: runtimeProfileConfig(nextRoot, profile2),
    profileConfig,
    configPath,
    appPaths: appPaths2,
    profile: profile2
  };
}
function upgradeLegacyRuntimeDefaults(rootConfig, profile2) {
  const profileConfig = rootConfig.profiles[profile2];
  if (!profileConfig) {
    return { rootConfig, changed: false, permissions: false, codex: false };
  }
  const permissionDefaultsMigrated = hasPermissionDefaultsMigration(rootConfig, profile2);
  const shouldUpgradeClaudeDefaultPermissions = !permissionDefaultsMigrated && profileConfig.agentKind === "claude" && !profileConfig.permissions.claude?.permissionMode && profileConfig.permissions.defaultAccess === "workspace" && profileConfig.permissions.maxAccess === "workspace";
  const legacySandboxPolicy = profileConfig.permissionSource === "sandbox";
  const nextPermissions = shouldUpgradeClaudeDefaultPermissions ? { defaultAccess: "full", maxAccess: "full" } : profileConfig.permissions;
  const legacyCodexDefaults = profileConfig.permissionSource !== "permissions";
  const legacyIsolatedCodexHome = legacyCodexDefaults && profileConfig.agentKind === "codex" && Boolean(profileConfig.codex) && !profileConfig.codex?.codexHome && profileConfig.codex?.inheritCodexHome === false;
  const legacyIgnoredUserConfig = legacyCodexDefaults && profileConfig.agentKind === "codex" && Boolean(profileConfig.codex) && !profileConfig.codex?.codexHome && profileConfig.codex?.ignoreUserConfig === true;
  const permissionsChanged = legacySandboxPolicy || shouldUpgradeClaudeDefaultPermissions;
  const permissionDefaultsMarkerChanged = !permissionDefaultsMigrated;
  const codexChanged = legacyIsolatedCodexHome || legacyIgnoredUserConfig;
  if (!permissionsChanged && !codexChanged && !permissionDefaultsMarkerChanged) {
    return { rootConfig, changed: false, permissions: false, codex: false };
  }
  const nextProfile = {
    ...profileConfig,
    ...permissionsChanged ? {
      permissions: nextPermissions,
      permissionSource: "permissions",
      sandbox: permissionsToLegacySandbox(nextPermissions)
    } : {},
    ...profileConfig.codex ? {
      codex: {
        ...profileConfig.codex,
        ...legacyIsolatedCodexHome ? { inheritCodexHome: true } : {},
        ...legacyIgnoredUserConfig ? { ignoreUserConfig: false } : {}
      }
    } : {}
  };
  const nextRoot = {
    ...rootConfig,
    profiles: {
      ...rootConfig.profiles,
      [profile2]: nextProfile
    }
  };
  return {
    changed: true,
    permissions: permissionsChanged,
    codex: codexChanged,
    rootConfig: permissionDefaultsMarkerChanged ? markPermissionDefaultsMigration(nextRoot, profile2) : nextRoot
  };
}
async function ensureProfileDefaultWorkspace(rootConfig, profile2, appPaths2) {
  const profileConfig = rootConfig.profiles[profile2];
  if (!profileConfig || profileConfig.workspaces.default) {
    return { rootConfig, changed: false };
  }
  await mkdir8(appPaths2.defaultWorkspaceDir, { recursive: true, mode: 448 });
  const defaultWorkspace = await realpath3(appPaths2.defaultWorkspaceDir);
  const nextProfile = {
    ...profileConfig,
    workspaces: {
      ...profileConfig.workspaces,
      default: defaultWorkspace
    }
  };
  return {
    changed: true,
    rootConfig: {
      ...rootConfig,
      profiles: {
        ...rootConfig.profiles,
        [profile2]: nextProfile
      }
    }
  };
}
async function resolveConvertedLegacyDefaultWorkspace(opts, appPaths2) {
  if (opts.workspace) return resolveBootstrapWorkspace(opts.workspace);
  const legacyDefault = await collectLegacyDefaultWorkspace(appPaths2.rootDir);
  if (legacyDefault) return legacyDefault;
  await mkdir8(appPaths2.defaultWorkspaceDir, { recursive: true, mode: 448 });
  return realpath3(appPaths2.defaultWorkspaceDir);
}
function resolveBootstrapAgent(requestedAgent, profile2) {
  return requestedAgent ?? (profile2 === "codex" ? "codex" : void 0);
}
async function hasLegacyConfig(configPath) {
  let raw;
  try {
    raw = await readFile9(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  const parsed = JSON.parse(raw);
  return parsed.schemaVersion !== 2;
}
async function migrateV1ToV2WithActiveBridgeHandling(options, handler) {
  for (; ; ) {
    try {
      await migrateV1ToV2(options);
      return;
    } catch (err) {
      if (!(err instanceof ActiveBridgeMigrationConflictError) || !handler) throw err;
      const shouldRetry = await handler(err);
      if (!shouldRetry) throw err;
    }
  }
}
async function resolveBootstrapAppConfig(opts) {
  if (!opts.appId) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        "\u5F53\u524D\u6CA1\u6709\u914D\u7F6E\uFF0C\u975E\u4EA4\u4E92\u6A21\u5F0F\u65E0\u6CD5\u5B8C\u6210\u626B\u7801\u521B\u5EFA\u5E94\u7528\u3002\u8BF7\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C `lark-channel-bridge run` \u5B8C\u6210\u9996\u6B21\u521D\u59CB\u5316\uFF0C\u6216\u4F20\u5165 --app-id \u548C --app-secret\u3002"
      );
    }
    return runRegistrationWizard();
  }
  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        `\u975E\u4EA4\u4E92\u6A21\u5F0F\u7F3A\u5C11 App Secret: ${opts.appId}\u3002\u8BF7\u4F20\u5165 --app-secret <secret>\uFF0C\u6216\u5728\u7EC8\u7AEF\u4E2D\u91CD\u65B0\u8FD0\u884C\u547D\u4EE4\u540E\u6309\u63D0\u793A\u8F93\u5165\u3002`
      );
    }
    appSecret = await promptPassword(`\u8F93\u5165 ${opts.appId} \u7684 App Secret: `);
  }
  if (!appSecret) throw new Error("app secret is required");
  const tenant = tenantBrandFromString(opts.tenant);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant);
  if (!result.ok) {
    throw new Error(`app credentials validation failed: ${result.reason ?? "unknown"}`);
  }
  if (result.botName) {
    console.log(`\u2713 \u5E94\u7528\u51ED\u8BC1\u6821\u9A8C\u901A\u8FC7: ${result.botName}`);
  } else {
    console.log("\u2713 \u5E94\u7528\u51ED\u8BC1\u6821\u9A8C\u901A\u8FC7");
  }
  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant
      }
    }
  };
}
function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
function tenantBrandFromString(value) {
  if (value === void 0) return "feishu";
  if (value === "feishu" || value === "lark") return value;
  throw new Error(`unsupported tenant: ${value}`);
}
function assertBootstrapAppMatchesExistingProfile(opts, profile2, profileConfig) {
  if (!opts.appId || opts.appId === profileConfig.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile2}; it uses app ${profileConfig.accounts.app.id}. omit --app-id or create another profile`
  );
}
function assertRequestedAgentMatchesExistingProfile(profile2, profileConfig, requestedAgent) {
  if (!requestedAgent || profileConfig.agentKind === requestedAgent) return;
  throw new Error(
    `profile ${profile2} already exists with agentKind ${profileConfig.agentKind}, but this command requested --agent ${requestedAgent}. Profile names are labels; to use the existing ${profileConfig.agentKind} profile, omit --agent. To recreate it as ${requestedAgent}, remove profile ${profile2} first.`
  );
}
function assertBootstrapAppMatchesExistingConfig(opts, profile2, cfg) {
  if (!opts.appId || opts.appId === cfg.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile2}; it uses app ${cfg.accounts.app.id}. omit --app-id or create another profile`
  );
}
async function materializeEnvSecretForService(opts = {}) {
  const rootDir = opts.config ? dirname10(opts.config) : void 0;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? await readActiveProfile(rootDir);
  let profile2 = activeProfile ?? "claude";
  let appPaths2 = resolveAppPaths({ rootDir, profile: profile2 });
  const configPath = opts.config ?? appPaths2.configFile;
  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile2 = rootConfig.activeProfile;
      appPaths2 = resolveAppPaths({ rootDir, profile: profile2 });
    }
    const profileConfig = rootConfig.profiles[profile2];
    if (!profileConfig) throw new Error(`profile not found: ${profile2}`);
    const cfg = runtimeProfileConfig(rootConfig, profile2);
    if (!isEnvBackedSecret(cfg.accounts.app.secret)) return false;
    const encrypted2 = await encryptedConfigForResolvedSecret(
      cfg,
      await resolveAppSecret(cfg, appPaths2),
      appPaths2
    );
    rootConfig.profiles[profile2] = {
      ...profileConfig,
      accounts: encrypted2.accounts
    };
    if (encrypted2.secrets) rootConfig.secrets = encrypted2.secrets;
    await saveRootConfig(rootConfig, configPath);
    return true;
  }
  const existing = await loadConfig(configPath);
  if (!isComplete(existing) || !isEnvBackedSecret(existing.accounts.app.secret)) return false;
  const encrypted = await encryptedConfigForResolvedSecret(
    existing,
    await resolveAppSecret(existing, appPaths2),
    appPaths2
  );
  await saveConfig(encrypted, configPath);
  return true;
}
function formatAmbiguousAgentSelectionError(detected) {
  const lines = detected.map((agent) => `  - ${agent.kind}: ${agent.binaryPath}`);
  return [
    "\u68C0\u6D4B\u5230\u591A\u4E2A\u672C\u5730 agent\uFF0C\u8BF7\u4F7F\u7528 --agent <claude|codex> \u6307\u5B9A\u8981\u521D\u59CB\u5316\u54EA\u4E00\u4E2A\u3002",
    "\u5DF2\u68C0\u6D4B\u5230\uFF1A",
    ...lines
  ].join("\n");
}
async function selectDetectedAgent(detected, selector) {
  const selected = selector ? await selector(detected) : await promptForDetectedAgentSelection(detected);
  if (!selected) return void 0;
  return detected.some((agent) => agent.kind === selected) ? selected : void 0;
}
async function promptForDetectedAgentSelection(detected) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return void 0;
  p.intro("\u9009\u62E9\u672C\u5730 agent");
  const selected = await p.select({
    message: "\u68C0\u6D4B\u5230\u591A\u4E2A\u672C\u5730 agent\uFF0C\u672C\u6B21\u8981\u521D\u59CB\u5316\u54EA\u4E00\u4E2A\uFF1F",
    options: detected.map((agent) => ({
      value: agent.kind,
      label: displayAgentKind(agent.kind),
      hint: agent.binaryPath
    })),
    initialValue: detected[0]?.kind
  });
  if (p.isCancel(selected)) {
    p.cancel("\u5DF2\u53D6\u6D88 agent \u9009\u62E9\u3002");
    throw new UserCancelledError("\u5DF2\u53D6\u6D88\u542F\u52A8\u3002");
  }
  p.outro(`\u5DF2\u9009\u62E9 ${displayAgentKind(selected)}`);
  return selected;
}
var UserCancelledError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UserCancelledError";
  }
};
function displayAgentKind(kind) {
  return kind === "claude" ? "Claude Code" : "Codex CLI";
}
async function maybeMigrateRootPlaintextSecret(rootConfig, profile2, appPaths2, configPath) {
  const cfg = runtimeProfileConfig(rootConfig, profile2);
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== "string" || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(secret)) {
    return cfg;
  }
  const encrypted = await encryptedConfigForProfile(cfg, appPaths2);
  const profileConfig = rootConfig.profiles[profile2];
  if (!profileConfig) throw new Error(`profile not found: ${profile2}`);
  rootConfig.profiles[profile2] = {
    ...profileConfig,
    accounts: encrypted.accounts
  };
  if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
  await saveRootConfig(rootConfig, configPath);
  return runtimeProfileConfig(rootConfig, profile2);
}
async function encryptedConfigForProfile(cfg, appPaths2) {
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== "string") return cfg;
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths2
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), secret, appPaths2);
  return next;
}
async function encryptedConfigForResolvedSecret(cfg, plaintext, appPaths2) {
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths2
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), plaintext, appPaths2);
  return next;
}
function isEnvBackedSecret(secret) {
  if (typeof secret === "string") return ENV_SECRET_TEMPLATE_RE.test(secret);
  return isSecretRef(secret) && secret.source === "env";
}
async function maybeMigratePlaintextSecret(cfg, configPath, appPaths2) {
  const s = cfg.accounts.app.secret;
  if (typeof s === "string" && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths2
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s, appPaths2);
      await saveConfig(next, configPath);
      console.log("\u{1F512} \u5DF2\u628A App Secret \u52A0\u5BC6\u8FC1\u79FB\u5230 ~/.lark-channel/secrets.enc");
      return next;
    } catch (err) {
      log.warn("config", "migrate-encrypted-failed", {
        err: err instanceof Error ? err.message : String(err)
      });
      return cfg;
    }
  }
  if (typeof s === "string") return cfg;
  try {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths2);
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths2
      );
      await saveConfig(next, configPath);
      console.log("\u{1F512} \u5DF2\u628A secrets provider \u5207\u5230 wrapper \u5F62\u6001");
      return next;
    }
  } catch (err) {
    log.warn("config", "wrapper-refresh-failed", {
      err: err instanceof Error ? err.message : String(err)
    });
  }
  return cfg;
}
function needsProviderRewrite(cfg, wrapperPath) {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}

// src/cli/commands/profile.ts
async function runProfileList(opts = {}) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  let profiles;
  try {
    profiles = await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("root config not found:")) throw err;
    console.log("\u6682\u65E0 profile\u3002");
    return;
  }
  const registryFile = resolveAppPaths({ rootDir }).userRegistryFile;
  const running = readAndPrune(registryFile);
  const rows = profiles.map((profile2) => {
    const holders = running.filter((entry) => entry.profileName === profile2.name).map((entry) => `pid=${entry.pid} agent=${entry.agentKind}`);
    return {
      active: profile2.active ? "*" : "",
      profile: profile2.name,
      agent: profile2.agentKind,
      status: holders.length > 0 ? holders.join(", ") : "-"
    };
  });
  const widths = {
    active: Math.max("ACTIVE".length, ...rows.map((row) => row.active.length)),
    profile: Math.max("PROFILE".length, ...rows.map((row) => row.profile.length)),
    agent: Math.max("AGENT".length, ...rows.map((row) => row.agent.length))
  };
  console.log(formatProfileListRow({
    active: "ACTIVE",
    profile: "PROFILE",
    agent: "AGENT",
    status: "STATUS"
  }, widths));
  for (const row of rows) {
    console.log(formatProfileListRow(row, widths));
  }
}
function formatProfileListRow(row, widths) {
  return [
    row.active.padEnd(widths.active),
    row.profile.padEnd(widths.profile),
    row.agent.padEnd(widths.agent),
    row.status
  ].join("  ");
}
async function runProfileCreate(name, opts = {}) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    const existing = root?.profiles[name];
    if (existing) {
      const requested = agentKindFromString(opts.agent);
      if (requested && existing.agentKind !== requested) {
        throw new Error(
          `profile ${name} already exists with agentKind ${existing.agentKind}, but profile create requested --agent ${requested}. Profile names are labels; use the existing ${existing.agentKind} profile, choose another name, or remove profile ${name} before creating a ${requested} profile.`
        );
      }
      throw new Error(`profile already exists: ${name}`);
    }
    await resolveProfileRuntime({
      config: configFile,
      profile: name,
      agent: opts.agent,
      workspace: opts.workspace,
      appId: opts.appId,
      appSecret: opts.appSecret,
      tenant: opts.tenant,
      allowBootstrap: true
    });
  });
  console.log(`\u5DF2\u521B\u5EFA profile: ${name}`);
}
async function runProfileUse(name, opts = {}) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    if (!root?.profiles[name]) throw new Error(`profile not found: ${name}`);
    root.activeProfile = name;
    await saveRootConfig(root, configFile);
    await writeActiveProfile(rootDir, name);
  });
  console.log(`\u5DF2\u5207\u6362\u5230 profile: ${name}`);
}
async function runProfileRemove(name, opts = {}) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  if (opts.purge && !opts.yes) {
    throw new Error("profile remove --purge requires --yes");
  }
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    if (!root) throw new Error("config not initialized");
    const profile2 = root.profiles[name];
    if (!profile2) throw new Error(`profile not found: ${name}`);
    const activeProfile = await readActiveProfile(rootDir);
    if (activeProfile) {
      if (!root.profiles[activeProfile]) {
        throw new Error(`active profile not found: ${activeProfile}; run profile use <name> to repair`);
      }
      root.activeProfile = activeProfile;
    }
    const profilePaths = resolveAppPaths({ rootDir, profile: name });
    const profileLock = await checkRuntimeLock(profilePaths.profileLockFile);
    if (profileLock.locked) {
      const holder = profileLock.meta ? ` pid=${profileLock.meta.pid}` : "";
      throw new Error(`profile is locked/running: ${name}${holder}`);
    }
    const lock4 = await acquireProfileRuntimeLock(profilePaths, profile2.agentKind);
    try {
      const result = await removeProfile(root, name, rootDir, {
        purge: opts.purge,
        now: opts.now
      });
      try {
        if (Object.keys(result.root.profiles).length === 0) {
          await rm7(configFile, { force: true });
          await rm7(resolveAppPaths({ rootDir }).activeProfileFile, { force: true });
        } else {
          await saveRootConfig(result.root, configFile);
          await writeActiveProfile(rootDir, result.root.activeProfile);
        }
      } catch (err) {
        if (result.restore) {
          try {
            await result.restore();
            await saveRootConfig(root, configFile);
            await writeActiveProfile(rootDir, root.activeProfile);
          } catch (restoreErr) {
            throw new Error(
              `profile remove failed after moving ${name}; state is at ${result.archivedTo}. restore failed: ${String(restoreErr.message ?? restoreErr)}. root config error: ${String(err.message ?? err)}`
            );
          }
        }
        throw err;
      }
      if (result.purged) {
        await result.cleanup?.();
        console.log(`\u5DF2\u6C38\u4E45\u5220\u9664 profile: ${name}`);
        return;
      }
      console.log(`\u5DF2\u5F52\u6863 profile: ${name} -> ${result.archivedTo}`);
    } finally {
      await lock4.release().catch(() => {
      });
    }
  });
}
async function runProfileExport(name, opts = {}) {
  if (opts.includeSecrets && !opts.yes) {
    throw new Error("profile export --include-secrets requires --yes");
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  if (!root) throw new Error("config not initialized");
  const selected = root.profiles[name];
  if (!selected) throw new Error(`profile not found: ${name}`);
  const profile2 = cloneJson(selected);
  if (opts.includeSecrets) {
    profile2.accounts.app.secret = await resolveAppSecret(
      runtimeProfileConfig(root, name),
      resolveAppPaths({ rootDir, profile: name })
    );
  }
  const exportedBase = {
    schemaVersion: 2,
    activeProfile: name,
    preferences: {},
    ...opts.includeSecrets && root.secrets ? { secrets: cloneJson(root.secrets) } : {},
    profiles: {
      [name]: profile2
    }
  };
  const exported = hasPermissionDefaultsMigration(root, name) ? markPermissionDefaultsMigration(exportedBase, name) : exportedBase;
  if (!opts.includeSecrets) {
    delete profile2.secrets;
    profile2.accounts.app.secret = "[REDACTED]";
  }
  const body = formatRootConfig(exported);
  if (!opts.output) {
    console.log(body.trimEnd());
    return;
  }
  if (existsSync2(opts.output) && !opts.force) {
    throw new Error("output already exists; use --force");
  }
  await writeFileAtomic(opts.output, body, { mode: 384 });
  console.log(`\u5DF2\u5BFC\u51FA profile: ${name} -> ${opts.output}`);
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// src/cli/commands/service.ts
import { createInterface as createInterface2 } from "readline";

// src/daemon/paths.ts
import { homedir as homedir4 } from "os";
import { join as join14 } from "path";
var SERVICE_NAME = "lark-channel-bridge.bot";
function serviceProfileId(profile2) {
  const trimmed = profile2.trim();
  if (!trimmed) throw new Error("profile name is required for service id");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`invalid profile name: ${profile2}`);
  }
  return trimmed;
}
function serviceNameForProfile(profile2 = paths.profile) {
  return `${SERVICE_NAME}.${serviceProfileId(profile2)}`;
}
var LAUNCH_AGENT_LABEL = launchAgentLabel();
function launchAgentLabel(profile2 = paths.profile) {
  return `ai.${serviceNameForProfile(profile2)}`;
}
function launchAgentPlistPath(profile2 = paths.profile) {
  return join14(homedir4(), "Library", "LaunchAgents", `${launchAgentLabel(profile2)}.plist`);
}
var SYSTEMD_UNIT_NAME = systemdUnitName();
function systemdUnitName(profile2 = paths.profile) {
  return `${serviceNameForProfile(profile2)}.service`;
}
function systemdUnitPath(profile2 = paths.profile) {
  const base = process.env.XDG_CONFIG_HOME ?? join14(homedir4(), ".config");
  return join14(base, "systemd", "user", systemdUnitName(profile2));
}
var WINDOWS_TASK_NAME = windowsTaskName();
function windowsTaskName(profile2 = paths.profile) {
  return `LarkChannelBridge.Bot.${serviceProfileId(profile2)}`;
}
function windowsLauncherCmdPath(profile2 = paths.profile) {
  return join14(paths.appDir, "daemon", serviceProfileId(profile2), "launcher.cmd");
}
function daemonLogDir(profile2 = paths.profile) {
  return join14(resolveAppPaths({ rootDir: paths.rootDir, profile: profile2 }).logsDir, "daemon");
}
function daemonStdoutPath(profile2 = paths.profile) {
  return join14(daemonLogDir(profile2), "daemon-stdout.log");
}
function daemonStderrPath(profile2 = paths.profile) {
  return join14(daemonLogDir(profile2), "daemon-stderr.log");
}

// src/daemon/launchd.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync3 } from "fs";
import { mkdir as mkdir9, rm as rm8, writeFile as writeFile5 } from "fs/promises";
import { userInfo as userInfo2 } from "os";
import { dirname as dirname11 } from "path";
function buildPlist(inputs) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${launchAgentLabel(inputs.profile)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escape(inputs.nodePath)}</string>
        <string>${escape(inputs.bridgeEntryPath)}</string>
        <string>run</string>
        <string>--profile</string>
        <string>${escape(inputs.profile)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escape(daemonStdoutPath(inputs.profile))}</string>
    <key>StandardErrorPath</key>
    <string>${escape(daemonStderrPath(inputs.profile))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(inputs.envPath)}</string>
        <key>LARK_CHANNEL_HOME</key>
        <string>${escape(inputs.channelHome)}</string>
    </dict>
</dict>
</plist>
`;
}
async function writePlist(profile2) {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildPlist({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? "",
    profile: profile2,
    channelHome: paths.rootDir
  });
  const plistPath = launchAgentPlistPath(profile2);
  await mkdir9(dirname11(plistPath), { recursive: true });
  await mkdir9(daemonLogDir(profile2), { recursive: true });
  await writeFile5(plistPath, content, "utf8");
}
function plistExists(profile2) {
  return existsSync3(launchAgentPlistPath(profile2));
}
function userTarget() {
  return `gui/${userInfo2().uid}`;
}
function serviceTarget(profile2) {
  return `${userTarget()}/${launchAgentLabel(profile2)}`;
}
function runLaunchctl(args) {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
function bootstrap(profile2) {
  return runLaunchctl(["bootstrap", userTarget(), launchAgentPlistPath(profile2)]);
}
function bootout(profile2) {
  return runLaunchctl(["bootout", serviceTarget(profile2)]);
}
function kickstart(profile2) {
  return runLaunchctl(["kickstart", "-k", serviceTarget(profile2)]);
}
function isLoaded(profile2) {
  const r = spawnSync("launchctl", ["print", serviceTarget(profile2)], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
async function waitUntilUnloaded(profile2, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded(profile2)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function describeService(profile2) {
  const r = runLaunchctl(["print", serviceTarget(profile2)]);
  return r.stdout || r.stderr || "";
}
async function deletePlist(profile2) {
  await rm8(launchAgentPlistPath(profile2), { force: true });
}

// src/daemon/schtasks.ts
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync4 } from "fs";
import { mkdir as mkdir10, rm as rm9, writeFile as writeFile6 } from "fs/promises";
import { dirname as dirname12 } from "path";
function buildLauncherCmd(inputs) {
  return [
    "@echo off",
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" run --profile "${inputs.profile}" >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    ""
  ].join("\r\n");
}
async function writeLauncherCmd(profile2) {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? "",
    profile: profile2,
    channelHome: paths.rootDir
  });
  const cmdPath = windowsLauncherCmdPath(profile2);
  await mkdir10(dirname12(cmdPath), { recursive: true });
  await mkdir10(daemonLogDir(profile2), { recursive: true });
  await writeFile6(cmdPath, content, "utf8");
}
function runSchtasks(args) {
  const r = spawnSync2("schtasks", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
async function installTask(profile2) {
  await writeLauncherCmd(profile2);
  return runSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    windowsTaskName(profile2),
    "/TR",
    `"${windowsLauncherCmdPath(profile2)}"`
  ]);
}
function runTask(profile2) {
  return runSchtasks(["/Run", "/TN", windowsTaskName(profile2)]);
}
function endTask(profile2) {
  return runSchtasks(["/End", "/TN", windowsTaskName(profile2)]);
}
function disableTask(profile2) {
  return runSchtasks(["/Change", "/TN", windowsTaskName(profile2), "/Disable"]);
}
function endAndDisable(profile2) {
  const ended = endTask(profile2);
  const disabled = disableTask(profile2);
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}
async function restartTask(profile2) {
  endTask(profile2);
  await waitUntilStopped(profile2);
  return runTask(profile2);
}
function isTaskRegistered(profile2) {
  const r = spawnSync2("schtasks", ["/Query", "/TN", windowsTaskName(profile2)], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
function isTaskRunning(profile2) {
  const r = runSchtasks(["/Query", "/V", "/FO", "LIST", "/TN", windowsTaskName(profile2)]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}
function describeTask(profile2) {
  const r = runSchtasks(["/Query", "/V", "/FO", "LIST", "/TN", windowsTaskName(profile2)]);
  return r.stdout || r.stderr || "";
}
async function waitUntilStopped(profile2, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile2)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function deleteTask(profile2) {
  const r = runSchtasks(["/Delete", "/F", "/TN", windowsTaskName(profile2)]);
  if (existsSync4(windowsLauncherCmdPath(profile2))) {
    await rm9(windowsLauncherCmdPath(profile2), { force: true });
  }
  return r;
}

// src/daemon/systemd.ts
import { spawnSync as spawnSync3 } from "child_process";
import { existsSync as existsSync5 } from "fs";
import { mkdir as mkdir11, rm as rm10, writeFile as writeFile7 } from "fs/promises";
import { dirname as dirname13 } from "path";
function buildUnit(inputs) {
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[Unit]
Description=Lark Channel Bridge bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escape(inputs.nodePath)}" "${escape(inputs.bridgeEntryPath)}" run --profile "${escape(inputs.profile)}"
Restart=always
RestartSec=5
StandardOutput=append:${daemonStdoutPath(inputs.profile)}
StandardError=append:${daemonStderrPath(inputs.profile)}
Environment="PATH=${escape(inputs.envPath)}"
Environment="LARK_CHANNEL_HOME=${escape(inputs.channelHome)}"

[Install]
WantedBy=default.target
`;
}
async function writeUnit(profile2) {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildUnit({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? "",
    profile: profile2,
    channelHome: paths.rootDir
  });
  const unitPath = systemdUnitPath(profile2);
  await mkdir11(dirname13(unitPath), { recursive: true });
  await mkdir11(daemonLogDir(profile2), { recursive: true });
  await writeFile7(unitPath, content, "utf8");
}
function unitExists(profile2) {
  return existsSync5(systemdUnitPath(profile2));
}
function runSystemctl(args) {
  const r = spawnSync3("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
function daemonReload() {
  return runSystemctl(["daemon-reload"]);
}
function enableAndStart(profile2) {
  return runSystemctl(["enable", "--now", systemdUnitName(profile2)]);
}
function stop(profile2) {
  return runSystemctl(["stop", systemdUnitName(profile2)]);
}
function disableAndStop(profile2) {
  return runSystemctl(["disable", "--now", systemdUnitName(profile2)]);
}
function restart(profile2) {
  return runSystemctl(["restart", systemdUnitName(profile2)]);
}
function isActive(profile2) {
  const r = spawnSync3("systemctl", ["--user", "is-active", systemdUnitName(profile2)], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
function describeService2(profile2) {
  const r = runSystemctl(["status", systemdUnitName(profile2), "--no-pager"]);
  return r.stdout || r.stderr || "";
}
async function waitUntilInactive(profile2, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive(profile2)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function deleteUnit(profile2) {
  await rm10(systemdUnitPath(profile2), { force: true });
}

// src/daemon/service-adapter.ts
function makeLaunchdAdapter(profile2) {
  return {
    platformName: "launchd (macOS)",
    fileExists: () => plistExists(profile2),
    isRunning: () => isLoaded(profile2),
    servicePath: () => launchAgentPlistPath(profile2),
    install: () => writePlist(profile2),
    start: () => bootstrap(profile2),
    stop: () => bootout(profile2),
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: () => bootout(profile2),
    restart: () => kickstart(profile2),
    waitUntilStopped: (timeoutMs) => waitUntilUnloaded(profile2, timeoutMs),
    deleteFile: () => deletePlist(profile2),
    describeStatus: () => describeService(profile2),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1]
    })
  };
}
function makeSystemdAdapter(profile2) {
  return {
    platformName: "systemd (Linux user)",
    fileExists: () => unitExists(profile2),
    isRunning: () => isActive(profile2),
    servicePath: () => systemdUnitPath(profile2),
    install: async () => {
      await writeUnit(profile2);
      daemonReload();
    },
    start: () => enableAndStart(profile2),
    stop: () => stop(profile2),
    stopAndDisableAutostart: () => disableAndStop(profile2),
    restart: () => restart(profile2),
    waitUntilStopped: (timeoutMs) => waitUntilInactive(profile2, timeoutMs),
    deleteFile: async () => {
      await deleteUnit(profile2);
      daemonReload();
    },
    describeStatus: () => describeService2(profile2),
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1]
    })
  };
}
function makeSchtasksAdapter(profile2) {
  return {
    platformName: "Task Scheduler (Windows)",
    fileExists: () => isTaskRegistered(profile2),
    isRunning: () => isTaskRunning(profile2),
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => windowsTaskName(profile2),
    install: async () => {
      const r = await installTask(profile2);
      if (!r.ok) throw new Error(r.stderr || "schtasks /Create failed");
    },
    start: () => runTask(profile2),
    stop: () => endTask(profile2),
    stopAndDisableAutostart: () => endAndDisable(profile2),
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    restart: () => restartTask(profile2),
    waitUntilStopped: (timeoutMs) => waitUntilStopped(profile2, timeoutMs),
    deleteFile: async () => {
      await deleteTask(profile2);
    },
    describeStatus: () => describeTask(profile2),
    parseStatus: (text) => ({
      // `Process ID: <n>` shows up in verbose listing only when task is running.
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      // `Last Result: <0|nonzero>` — `0` means last run succeeded.
      // Filter the `1056` ("task already running") and `267011` ("task hasn't
      // run") sentinels that aren't real exit codes.
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1]
    })
  };
}
function getServiceAdapter(profile2 = "claude") {
  if (process.platform === "darwin") return makeLaunchdAdapter(profile2);
  if (process.platform === "linux") return makeSystemdAdapter(profile2);
  if (process.platform === "win32") return makeSchtasksAdapter(profile2);
  return null;
}

// src/cli/preflight.ts
import * as p2 from "@clack/prompts";
import { readFile as readFile10 } from "fs/promises";

// src/agent/lark-channel-env.ts
import { join as join15 } from "path";
function buildLarkChannelEnv(context) {
  const env = {
    LARK_CHANNEL: "1"
  };
  const profile2 = nonEmpty(context?.profile);
  if (profile2) env.LARK_CHANNEL_PROFILE = profile2;
  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;
  const configPath = nonEmpty(context?.larkCliSourceConfigFile) ?? nonEmpty(context?.configPath) ?? (rootDir ? join15(rootDir, "config.json") : void 0);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;
  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;
  return env;
}
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed ? value : void 0;
}

// src/lark-cli/identity-policy.ts
var POLICY_TIMEOUT_MS = 3e4;
var USER_OPEN_ID_KEYS = ["userOpenId", "openId", "user_open_id", "open_id"];
function hasLarkCliUserAuth(users) {
  if (hasStructuredLarkCliUserAuth(users)) return true;
  if (typeof users !== "string") return false;
  return isLarkCliUserDisplayValue(users);
}
function hasStructuredLarkCliUserAuth(users) {
  if (Array.isArray(users)) return users.some(hasStructuredLarkCliUserAuth);
  if (!users || typeof users !== "object") return false;
  if (hasLarkCliUserRecord(users)) return true;
  return Object.values(users).some(hasStructuredLarkCliUserAuth);
}
function hasLarkCliUserRecord(value) {
  const record = value;
  return USER_OPEN_ID_KEYS.some((key) => {
    const id = record[key];
    return typeof id === "string" && id.trim().length > 0;
  });
}
function isLarkCliUserDisplayValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(null|\(none\)|none|无|\(无\))$/i.test(trimmed)) return false;
  if (/^\(?no\s+logged[-\s]?in\s+users\)?$/i.test(trimmed)) return false;
  return true;
}
async function applyLarkCliIdentityPolicy(context, identityPreset) {
  const env = buildLarkChannelEnv(context);
  const strictMode = identityPreset === "user-default" ? "off" : "bot";
  const defaultAs = identityPreset === "user-default" ? "auto" : "bot";
  const strictResult = await runQuiet("lark-cli", ["config", "strict-mode", strictMode], env);
  if (!strictResult) return false;
  return runQuiet("lark-cli", ["config", "default-as", defaultAs], env);
}
async function runQuiet(cmd, args, env) {
  let timedOut = false;
  const exitCode = await new Promise((resolve2) => {
    const child = spawnProcess(cmd, args, {
      env: mergeProcessEnv(process.env, env),
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, POLICY_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve2(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve2(code);
    });
  });
  return !timedOut && exitCode === 0;
}

// src/lark-cli/profile-projection.ts
import { chmod as chmod4, mkdir as mkdir12 } from "fs/promises";
async function writeLarkCliSourceProjection(cfg, appPaths2) {
  await mkdir12(appPaths2.larkCliSourceDir, { recursive: true, mode: 448 });
  await chmod4(appPaths2.larkCliSourceDir, 448).catch(() => {
  });
  const secrets2 = await buildProjectionSecrets(cfg, appPaths2);
  const projection = {
    accounts: {
      app: {
        id: cfg.accounts.app.id,
        secret: cfg.accounts.app.secret,
        tenant: cfg.accounts.app.tenant
      }
    },
    ...secrets2 ? { secrets: secrets2 } : {}
  };
  await writeFileAtomic(appPaths2.larkCliSourceConfigFile, `${JSON.stringify(projection, null, 2)}
`, {
    mode: 384
  });
  return appPaths2.larkCliSourceConfigFile;
}
async function buildProjectionSecrets(cfg, appPaths2) {
  const providers = {
    ...cfg.secrets?.providers ?? {}
  };
  const providerName = bridgeProviderName(cfg.accounts.app.secret);
  if (providerName) {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths2);
    const existing = providers[providerName];
    providers[providerName] = {
      ...existing ?? {},
      source: "exec",
      command: wrapperPath,
      args: [],
      env: {
        ...existing?.env ?? {},
        LARK_CHANNEL_HOME: appPaths2.rootDir,
        LARK_CHANNEL_PROFILE: appPaths2.profile
      }
    };
  }
  if (Object.keys(providers).length === 0 && !cfg.secrets?.defaults) return void 0;
  return {
    ...cfg.secrets?.defaults ? { defaults: cfg.secrets.defaults } : {},
    ...Object.keys(providers).length > 0 ? { providers } : {}
  };
}
function bridgeProviderName(secret) {
  if (!isSecretRef(secret)) return void 0;
  if (secret.source !== "exec") return void 0;
  const ref = secret;
  return ref.provider ?? "default";
}

// src/cli/preflight.ts
var INSTALL_TIMEOUT_MS = 5 * 60 * 1e3;
var BIND_TIMEOUT_MS = 30 * 1e3;
var BOLD = "\x1B[1m";
var RESET = "\x1B[0m";
var MANUAL_INSTALL_HINT = [
  "Manual install command:",
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  "",
  "Restart the current profile after installation; bridge will initialize lark-cli automatically.",
  "",
  "Docs: https://github.com/larksuite/cli"
].join("\n");
async function preFlightChecks(opts) {
  await checkLarkCli(opts);
}
async function checkLarkCli(opts) {
  if (opts.skipCheckLarkCli) return;
  const bridgeConfig = opts.bridgeConfig;
  const appPaths2 = opts.appPaths;
  const privateBinding = bridgeConfig !== void 0 && appPaths2 !== void 0 && opts.larkChannel !== void 0;
  if (privateBinding) {
    await writeLarkCliSourceProjection(bridgeConfig, appPaths2);
  }
  const larkChannelEnv = opts.larkChannel ? buildLarkChannelEnv(opts.larkChannel) : void 0;
  const legacyLarkChannelEnv = opts.larkChannel ? buildLarkChannelEnv({ ...opts.larkChannel, larkCliConfigDir: void 0 }) : void 0;
  const profileArgs = privateBinding || !opts.larkChannel?.profile ? [] : ["--profile", opts.larkChannel.profile];
  if (!isLarkCliInstalled()) {
    console.log(
      [
        "",
        "lark-cli is not installed",
        "",
        "lark-cli is the Feishu/Lark command-line tool. After installation, the agent can:",
        "  - send interactive cards and forms",
        "  - query calendars, docs, tasks, OKRs, and attendance",
        "  - use 200+ Feishu/Lark API commands",
        ""
      ].join("\n")
    );
    if (!process.stdin.isTTY) {
      console.log(`(non-interactive mode; skipping auto-install)

${MANUAL_INSTALL_HINT}
`);
      return;
    }
    p2.intro("Setting up lark-cli");
    const sInstall = p2.spinner();
    sInstall.start("Installing lark-cli");
    const installResult = await runCapture(
      "npm",
      ["install", "-g", "@larksuite/cli"],
      INSTALL_TIMEOUT_MS
    );
    if (!installResult.success || !isLarkCliInstalled()) {
      sInstall.error("Install failed");
      if (installResult.output.trim()) {
        console.error(installResult.output);
      }
      p2.outro("lark-cli installation did not complete");
      printInstallFailedWarning();
      return;
    }
    sInstall.stop("Installed");
  }
  if (privateBinding) {
    const target = await readPrivateTarget(appPaths2, bridgeConfig);
    if (target.sameApp) {
      if (shouldSkipLocalUserImport(opts.profileConfig?.larkCli)) {
        if (target.identityPreset !== "bot-only") {
          await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "bot-only");
        }
        await persistLarkCliConfig(opts, {
          identityPreset: "bot-only",
          importStatus: "not-needed",
          reason: "manual-bot-only"
        });
      } else if (target.hasUserAuth) {
        if (target.identityPreset !== "user-default") {
          const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "user-default");
          if (switchResult.success) {
            await persistLarkCliConfig(opts, {
              identityPreset: "user-default",
              importStatus: "skipped-existing-private-user",
              reason: "existing-private-user"
            });
          } else {
            await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "bot-only");
            await persistLarkCliConfig(opts, {
              identityPreset: "bot-only",
              importStatus: "failed",
              reason: "private-user-policy-switch-failed"
            });
          }
        } else {
          await persistLarkCliConfig(opts, {
            identityPreset: "user-default",
            importStatus: "skipped-existing-private-user",
            reason: "existing-private-user"
          });
        }
      } else if (shouldAttemptLocalUserImport(opts)) {
        const localUser2 = await detectLocalSameAppUser(bridgeConfig, legacyLarkChannelEnv);
        if (localUser2.status === "imported") {
          await copyLocalUsersToPrivateTarget(appPaths2, bridgeConfig, localUser2.users);
          const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "user-default");
          if (switchResult.success && await privateSameAppUserReady(profileArgs, larkChannelEnv, bridgeConfig)) {
            await persistLarkCliConfig(opts, {
              identityPreset: "user-default",
              importStatus: "imported",
              reason: "same-app-local-user"
            });
            return;
          }
          await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "bot-only");
          await persistLarkCliConfig(opts, {
            identityPreset: target.identityPreset ?? "bot-only",
            importStatus: "failed",
            reason: switchResult.success ? "private-user-missing-after-switch" : "local-user-policy-switch-failed"
          });
          return;
        } else {
          await persistLarkCliConfig(opts, {
            identityPreset: target.identityPreset ?? "bot-only",
            importStatus: localUser2.status,
            reason: localUser2.reason
          });
        }
      }
      const showResult = await runCapture(
        "lark-cli",
        [...profileArgs, "config", "show"],
        BIND_TIMEOUT_MS,
        larkChannelEnv
      );
      if (showResult.success) return;
    }
  }
  if (!privateBinding) {
    const showResult = await runCapture(
      "lark-cli",
      [...profileArgs, "config", "show"],
      BIND_TIMEOUT_MS,
      larkChannelEnv
    );
    if (showResult.success) return;
  }
  const localUser = privateBinding && shouldSkipLocalUserImport(opts.profileConfig?.larkCli) ? { status: "not-needed", reason: "manual-bot-only" } : privateBinding && shouldAttemptLocalUserImport(opts) ? await detectLocalSameAppUser(bridgeConfig, legacyLarkChannelEnv) : { status: "not-needed", reason: "not-private-binding" };
  const sBind = p2.spinner();
  sBind.start("Initializing lark-cli configuration");
  const bindResult = await bindLarkCliWithCompatibility(
    profileArgs,
    larkChannelEnv,
    appPaths2,
    privateBinding,
    "bot-only"
  );
  if (!bindResult.success) {
    sBind.error("lark-cli configuration failed");
    if (privateBinding) {
      await persistLarkCliConfig(opts, {
        identityPreset: "bot-only",
        importStatus: localUser.status === "imported" ? "failed" : localUser.status,
        reason: "bind-failed"
      });
    }
    printBindFailedWarning(bindResult, appPaths2);
    return;
  }
  if (privateBinding) {
    if (localUser.status === "imported") {
      await copyLocalUsersToPrivateTarget(appPaths2, bridgeConfig, localUser.users);
      const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "user-default");
      if (switchResult.success && await privateSameAppUserReady(profileArgs, larkChannelEnv, bridgeConfig)) {
        await persistLarkCliConfig(opts, {
          identityPreset: "user-default",
          importStatus: "imported",
          reason: "same-app-local-user"
        });
      } else {
        await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, "bot-only");
        await persistLarkCliConfig(opts, {
          identityPreset: "bot-only",
          importStatus: "failed",
          reason: switchResult.success ? "private-user-missing-after-switch" : "user-policy-switch-failed"
        });
      }
    } else {
      await persistLarkCliConfig(opts, {
        identityPreset: "bot-only",
        importStatus: localUser.status,
        reason: localUser.reason
      });
    }
  }
  sBind.stop("lark-cli configuration ready");
  p2.outro("Done");
}
async function bindLarkCliWithCompatibility(profileArgs, larkChannelEnv, appPaths2, privateBinding, identityPreset) {
  const directResult = await runCapture(
    "lark-cli",
    [...profileArgs, "config", "bind", "--source", "lark-channel", "--identity", identityPreset],
    BIND_TIMEOUT_MS,
    larkChannelEnv
  );
  if (directResult.success) return directResult;
  if (privateBinding && appPaths2 && shouldUseLegacyLarkChannelSourceOverlay(directResult.output, appPaths2)) {
    return withLegacyLarkCliSourceOverlay(
      appPaths2.configFile,
      appPaths2.larkCliSourceConfigFile,
      () => runCapture(
        "lark-cli",
        [...profileArgs, "config", "bind", "--source", "lark-channel", "--identity", identityPreset],
        BIND_TIMEOUT_MS,
        larkChannelEnv
      )
    );
  }
  return directResult;
}
async function readPrivateTarget(appPaths2, cfg) {
  try {
    const raw = JSON.parse(await readFile10(appPaths2.larkCliTargetConfigFile, "utf8"));
    const app = raw.apps?.find(
      (candidate) => candidate.appId === cfg.accounts.app.id && candidate.brand === cfg.accounts.app.tenant
    );
    if (!app) {
      return { sameApp: false, hasUserAuth: false };
    }
    if (typeof app.users === "string") {
      app.users = null;
      try {
        await writeFileAtomic(appPaths2.larkCliTargetConfigFile, `${JSON.stringify(raw, null, 2)}
`, {
          mode: 384
        });
      } catch (err) {
        log.warn("lark-cli", "private-target-repair-failed", {
          profile: appPaths2.profile,
          err: errorMessage(err)
        });
      }
    }
    return {
      sameApp: true,
      identityPreset: larkCliIdentityPresetForTarget(app),
      hasUserAuth: hasStructuredLarkCliUserAuth(app.users)
    };
  } catch (err) {
    if (err.code === "ENOENT") return { sameApp: false, hasUserAuth: false };
    log.warn("lark-cli", "private-target-read-failed", {
      profile: appPaths2.profile,
      err: errorMessage(err)
    });
    return { sameApp: false, hasUserAuth: false };
  }
}
function larkCliIdentityPresetForTarget(app) {
  if (app.defaultAs === "bot" && app.strictMode === "bot") return "bot-only";
  if (app.defaultAs === "auto" && app.strictMode === "off") return "user-default";
  return void 0;
}
function shouldSkipLocalUserImport(config) {
  return config?.identityPreset === "bot-only" && config.localUserImport?.reason === "manual-bot-only";
}
function shouldAttemptLocalUserImport(opts) {
  return opts.profileConfig !== void 0 && !shouldSkipLocalUserImport(opts.profileConfig.larkCli);
}
async function privateSameAppUserReady(profileArgs, larkChannelEnv, cfg) {
  const result = await runCapture(
    "lark-cli",
    [...profileArgs, "config", "show"],
    BIND_TIMEOUT_MS,
    larkChannelEnv
  );
  if (!result.success) return false;
  const parsed = parseJsonObject(result.output);
  if (!parsed || typeof parsed !== "object") return false;
  const app = parsed;
  return app.appId === cfg.accounts.app.id && app.brand === cfg.accounts.app.tenant && hasLarkCliUserAuth(app.users);
}
async function detectLocalSameAppUser(cfg, env) {
  const result = await runCapture("lark-cli", ["config", "show"], BIND_TIMEOUT_MS, env);
  if (!result.success) return { status: "failed", reason: "local-config-show-failed" };
  const parsed = parseJsonObject(result.output);
  if (!parsed || typeof parsed !== "object") {
    return { status: "failed", reason: "local-config-show-invalid-json" };
  }
  const local = parsed;
  if (local.appId !== cfg.accounts.app.id || local.brand !== cfg.accounts.app.tenant) {
    return { status: "skipped-no-local-user", reason: "local-app-mismatch" };
  }
  if (!hasLarkCliUserAuth(local.users)) {
    return { status: "skipped-no-local-user", reason: "local-user-missing" };
  }
  const users = await readLocalSameAppUsers(result.output, cfg) ?? (hasStructuredLarkCliUserAuth(local.users) ? local.users : void 0);
  if (!users) {
    return { status: "skipped-no-local-user", reason: "local-user-unstructured" };
  }
  return {
    status: "imported",
    reason: "same-app-local-user",
    users
  };
}
async function readLocalSameAppUsers(output, cfg) {
  const configPath = parseLarkCliConfigPath(output);
  if (!configPath) return void 0;
  try {
    const raw = JSON.parse(await readFile10(configPath, "utf8"));
    const app = raw.apps?.find(
      (candidate) => candidate.appId === cfg.accounts.app.id && candidate.brand === cfg.accounts.app.tenant
    );
    return hasStructuredLarkCliUserAuth(app?.users) ? app?.users : void 0;
  } catch {
    return void 0;
  }
}
function parseLarkCliConfigPath(output) {
  const line = output.split(/\r?\n/).find((candidate) => /^Config file path:\s*/i.test(candidate.trim()));
  const value = line?.replace(/^Config file path:\s*/i, "").trim();
  return value || void 0;
}
async function copyLocalUsersToPrivateTarget(appPaths2, cfg, users) {
  if (!hasStructuredLarkCliUserAuth(users)) return false;
  try {
    const raw = JSON.parse(await readFile10(appPaths2.larkCliTargetConfigFile, "utf8"));
    const app = raw.apps?.find(
      (candidate) => candidate.appId === cfg.accounts.app.id && candidate.brand === cfg.accounts.app.tenant
    );
    if (!app || hasStructuredLarkCliUserAuth(app.users)) return false;
    app.users = users;
    await writeFileAtomic(appPaths2.larkCliTargetConfigFile, `${JSON.stringify(raw, null, 2)}
`, {
      mode: 384
    });
    return true;
  } catch {
    return false;
  }
}
async function switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, identityPreset) {
  const strictMode = identityPreset === "user-default" ? "off" : "bot";
  const defaultAs = identityPreset === "user-default" ? "auto" : "bot";
  const strictResult = await runCapture(
    "lark-cli",
    [...profileArgs, "config", "strict-mode", strictMode],
    BIND_TIMEOUT_MS,
    larkChannelEnv
  );
  if (!strictResult.success) return strictResult;
  return runCapture(
    "lark-cli",
    [...profileArgs, "config", "default-as", defaultAs],
    BIND_TIMEOUT_MS,
    larkChannelEnv
  );
}
async function persistLarkCliConfig(opts, update) {
  const appPaths2 = opts.appPaths;
  if (!appPaths2) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const localUserImport = {
    status: update.importStatus,
    attemptedAt: now,
    ...update.importStatus === "imported" ? { importedAt: now } : {},
    reason: update.reason
  };
  const nextLarkCli = {
    identityPreset: update.identityPreset,
    localUserImport
  };
  let persistAttempted = false;
  let saveSucceeded = false;
  try {
    await withConfigFileLock(appPaths2.configFile, async () => {
      const root = await loadRootConfig(appPaths2.configFile);
      if (!root) return;
      const profile2 = root.profiles[appPaths2.profile];
      if (!profile2) return;
      root.profiles[appPaths2.profile] = {
        ...profile2,
        larkCli: nextLarkCli
      };
      persistAttempted = true;
      await saveRootConfig(root, appPaths2.configFile);
      saveSucceeded = true;
    });
  } catch (err) {
    log.warn("lark-cli", "profile-config-persist-failed", {
      profile: appPaths2.profile,
      err: errorMessage(err)
    });
    if (saveSucceeded && opts.profileConfig) {
      opts.profileConfig.larkCli = nextLarkCli;
    }
    return;
  }
  if (!persistAttempted) return;
  if (opts.profileConfig) {
    opts.profileConfig.larkCli = nextLarkCli;
  }
}
function printInstallFailedWarning() {
  console.error(
    [
      "",
      `${BOLD}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${RESET}`,
      `${BOLD}\u2551  lark-cli auto-install failed                                 \u2551${RESET}`,
      `${BOLD}\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}`,
      "",
      "Possible causes: network unavailable, npm global install permission denied, or registry failure.",
      "",
      "Bridge will keep running, but the agent may be unable to use Feishu/Lark tools.",
      "Run manually:",
      "",
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      "",
      "Docs: https://github.com/larksuite/cli",
      "After installation, restart bridge or rerun the current start command.",
      ""
    ].join("\n")
  );
}
function printBindFailedWarning(result, appPaths2) {
  const profile2 = appPaths2?.profile;
  const tooOld = isUnsupportedLarkChannelSource(result.output);
  const lines = tooOld ? [
    "The installed lark-cli does not support the lark-channel source required by bridge auto-configuration.",
    "Bridge will keep listening for messages, but the agent cannot use lark-cli to call Feishu/Lark APIs.",
    "",
    "Recovery:",
    "  1. Install a lark-cli build that supports the lark-channel source.",
    `  2. ${restartInstruction(profile2)}`
  ] : [
    "Bridge will keep listening for messages, but this profile did not finish lark-cli configuration.",
    "Impact: the agent may be unable to send messages, send cards, or call Feishu/Lark APIs through lark-cli.",
    "",
    "Recovery:",
    `  1. ${restartInstruction(profile2)}`,
    "  2. If it still fails, check that this profile has a valid App Secret and that the lark-cli config directory is writable."
  ];
  console.log(["", ...lines, "", "Diagnostic details:", formatDiagnosticOutput(result.output), ""].join("\n"));
}
function restartInstruction(profile2) {
  const suffix = profile2 ? ` --profile ${profile2}` : "";
  return `Restart the current profile: lark-channel-bridge restart${suffix}; for foreground runs, press Ctrl+C and rerun lark-channel-bridge run${suffix}.`;
}
function shouldUseLegacyLarkChannelSourceOverlay(output, appPaths2) {
  if (isUnsupportedLarkChannelSource(output)) return false;
  if (!outputMentionsPath(output, appPaths2.configFile)) return false;
  return /accounts\.app\.id missing in /i.test(output) || /cannot read .*config\.json/i.test(output) || /no such file or directory/i.test(output);
}
function outputMentionsPath(output, path) {
  if (output.includes(path)) return true;
  return output.includes(JSON.stringify(path).slice(1, -1));
}
function isUnsupportedLarkChannelSource(output) {
  return /unknown flag:\s*--source/i.test(output) || /unknown command ["']?bind["']?/i.test(output) || /invalid --source[^-\n]*lark-channel/i.test(output) || /unsupported source:\s*lark-channel/i.test(output) || /invalid --source[^-\n]*lark-channel/i.test(output) && /valid values:\s*\S+/i.test(output);
}
function formatDiagnosticOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return "(lark-cli did not print error details)";
  if (/unknown flag:\s*--source/i.test(trimmed) || /unknown command ["']?bind["']?/i.test(trimmed)) {
    return "lark-cli does not support `config bind --source lark-channel`.";
  }
  const parsed = parseJson(trimmed);
  if (parsed !== void 0) {
    return JSON.stringify(stripLarkCliNotices(parsed), null, 2);
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => !isLarkCliUpdateNoticeLine(line));
  return lines.join("\n").trim() || "(lark-cli did not print error details)";
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function parseJsonObject(text) {
  const trimmed = text.trim();
  const parsed = parseJson(trimmed);
  if (parsed !== void 0) return parsed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return void 0;
  return parseJson(trimmed.slice(start, end + 1));
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function stripLarkCliNotices(value) {
  if (Array.isArray(value)) return value.map(stripLarkCliNotices);
  if (!value || typeof value !== "object") return value;
  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "_notice") continue;
    cleaned[key] = stripLarkCliNotices(child);
  }
  return cleaned;
}
function isLarkCliUpdateNoticeLine(line) {
  return /_notice/i.test(line) || /lark-cli/i.test(line) && /(update|upgrade|latest|newer|npm\s+install)/i.test(line) || /\b(current|latest)\s+version\b/i.test(line);
}
function isLarkCliInstalled() {
  try {
    const result = spawnProcessSync("lark-cli", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
async function runCapture(cmd, args, timeoutMs, env) {
  let captured = "";
  let timedOut = false;
  const exitCode = await new Promise((resolve2) => {
    const child = spawnProcess(cmd, args, {
      env: env ? mergeProcessEnv(process.env, env) : void 0,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (b) => {
      captured += b.toString("utf8");
    });
    child.stderr?.on("data", (b) => {
      captured += b.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve2(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve2(code);
    });
  });
  return { success: !timedOut && exitCode === 0, output: captured };
}

// src/cli/commands/service.ts
function requireAdapter(cmdName, profile2) {
  const adapter = getServiceAdapter(profile2);
  if (!adapter) {
    console.error(
      `${cmdName}: \u5F53\u524D\u7CFB\u7EDF\u4E0D\u652F\u6301\u540E\u53F0\u8FD0\u884C\u3002`
    );
    console.error("  \u76EE\u524D\u652F\u6301: macOS (launchd) / Linux (systemd) / Windows (Task Scheduler)");
    process.exit(1);
  }
  return adapter;
}
function formatServiceStderr(stderr) {
  return stderr.split("\n").filter((line) => !/re-running the command as root/i.test(line)).join("\n").trim();
}
function printServiceFailure(verb, stderr) {
  const cleaned = formatServiceStderr(stderr);
  const action = verb === "started" ? "\u542F\u52A8" : "\u91CD\u542F";
  if (/bootstrap failed.*input\/output error/i.test(cleaned)) {
    console.error(`\u2717 bot ${action}\u5931\u8D25\u3002`);
    console.error("");
    console.error("\u6700\u5E38\u89C1\u539F\u56E0:\u65E7\u7684 bot \u5B9E\u4F8B\u8FD8\u5728\u6536\u5C3E\u3002\u8BF7\u8BD5\u4EE5\u4E0B\u4EFB\u4E00\u79CD:");
    console.error("  1. \u7A0D\u7B49\u51E0\u79D2,\u91CD\u65B0\u8FD0\u884C `start`");
    console.error("  2. \u6216\u5F7B\u5E95\u6E05\u9664\u6CE8\u518C\u518D\u542F\u52A8:");
    console.error("       unregister");
    console.error("       start");
    console.error("");
    console.error("\u539F\u59CB\u9519\u8BEF:");
    console.error(`  ${cleaned}`);
    return;
  }
  console.error(`\u2717 bot ${action}\u5931\u8D25:`);
  console.error(cleaned);
}
async function ensureBridgeConfigured(opts) {
  const { cfg, profile: profile2, profileConfig, appPaths: appPaths2, configPath } = await resolveProfileRuntime({
    profile: opts.profile,
    agent: opts.agent,
    workspace: opts.workspace,
    appId: opts.appId,
    appSecret: opts.appSecret,
    tenant: opts.tenant,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: async (err) => {
      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: "\u5DF2\u53D6\u6D88\u542F\u52A8\u3002"
      });
      if (!handled) process.exit(0);
      return true;
    }
  });
  if (!isComplete(cfg)) {
    console.error("bot \u8FD8\u6CA1\u914D\u7F6E app \u51ED\u636E\u3002");
    console.error("\u8BF7\u91CD\u65B0\u8FD0\u884C `start` \u5B8C\u6210\u9996\u6B21\u626B\u7801\u5411\u5BFC\u6216\u4F20\u5165\u5DF2\u6709\u5E94\u7528\u4FE1\u606F\u3002");
    process.exit(1);
  }
  return { profile: profile2, cfg, profileConfig, appPaths: appPaths2, configPath };
}
async function assertLockNotHeldByAnotherRuntime(kind, target, adapter, opts = {}) {
  for (; ; ) {
    const lock4 = await checkRuntimeLock(target);
    if (!lock4.locked) return;
    const servicePid = adapter.isRunning() ? adapter.parseStatus(adapter.describeStatus()).pid : void 0;
    if (servicePid && lock4.meta?.pid === Number(servicePid)) return;
    console.error(`\u2717 \u5F53\u524D ${kind === "profile" ? "profile" : "app"} \u5DF2\u6709 bridge \u8FDB\u7A0B\u5360\u7528\u3002`);
    if (!lock4.meta) {
      console.error(`  lock: ${target}`);
      console.error("  \u8BF7\u5148\u505C\u6B62\u6B63\u5728\u8FD0\u884C\u7684\u5360\u7528\u8FDB\u7A0B\uFF0C\u518D\u6267\u884C start\u3002");
      process.exit(1);
    }
    const app = lock4.meta.appId ? ` app=${lock4.meta.appId}` : "";
    console.error(
      `  holder: profile=${lock4.meta.profile}${app} agent=${lock4.meta.agentKind} pid=${lock4.meta.pid} startedAt=${lock4.meta.startedAt}`
    );
    if (!opts.confirmStopRuntimeLockProcess && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      console.error(
        `  \u975E\u4EA4\u4E92\u6A21\u5F0F\u65E0\u6CD5\u786E\u8BA4\u505C\u6B62 ${kind === "profile" ? "profile" : "app"} \u5360\u7528\u8FDB\u7A0B\u3002\u8BF7\u5148\u7528 \`lark-channel-bridge ps\` \u67E5\u770B\u5E76\u7528 \`lark-channel-bridge kill <bot id>\` \u505C\u6B62\u540E\u91CD\u8BD5\u3002`
      );
      process.exit(1);
    }
    const confirmed = opts.confirmStopRuntimeLockProcess ? await opts.confirmStopRuntimeLockProcess(lock4.meta) : await confirmStopRuntimeLockProcess();
    if (!confirmed) {
      console.log("\u5DF2\u53D6\u6D88\u542F\u52A8\u3002");
      process.exit(0);
    }
    const result = opts.stopRuntimeLockProcess ? await opts.stopRuntimeLockProcess(lock4.meta) : await stopProcessEntry({ pid: lock4.meta.pid });
    if (result === "killed") {
      console.log(`\u2713 \u5DF2\u5F3A\u5236\u505C\u6B62 pid ${lock4.meta.pid}`);
    } else {
      console.log(`\u2713 \u5DF2\u505C\u6B62 pid ${lock4.meta.pid}`);
    }
  }
}
async function confirmStopRuntimeLockProcess() {
  const rl = createInterface2({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise(
      (resolve2) => rl.question("\u662F\u5426\u505C\u6B62\u65E7\u8FDB\u7A0B\u5E76\u7EE7\u7EED\u542F\u52A8\u540E\u53F0\u670D\u52A1? [y/N]: ", resolve2)
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
async function waitForServiceConnect(appId, profile2, beforePids, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readAndPrune();
    const fresh = live.find(
      (e) => e.appId === appId && e.profileName === profile2 && !beforePids.has(e.pid) && Boolean(e.botName)
    );
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 500));
  }
  return void 0;
}
async function reportConnectAfter(verb, profile2, fn) {
  const { cfg } = await resolveProfileRuntime({ profile: profile2, allowBootstrap: false });
  const appId = cfg.accounts?.app?.id ?? "";
  const beforePids = new Set(
    readAndPrune().filter((e) => e.appId === appId && e.profileName === profile2).map((e) => e.pid)
  );
  const r = await fn();
  if (!r.ok) {
    printServiceFailure(verb, r.stderr);
    process.exit(1);
  }
  const action = verb === "started" ? "\u6B63\u5728\u7B49\u5F85 bot \u8FDE\u63A5..." : "\u6B63\u5728\u7B49\u5F85 bot \u91CD\u65B0\u8FDE\u63A5...";
  console.log(action);
  const entry = await waitForServiceConnect(appId, profile2, beforePids);
  if (entry) {
    const verbZh = verb === "started" ? "\u5DF2\u542F\u52A8" : "\u5DF2\u91CD\u542F";
    const agent = agentDisplay(entry.agentKind);
    console.log(
      `\u2713 ${verbZh}  bot: ${entry.botName} (${entry.appId})  agent: ${agent.displayName} (${agent.id})  \u8FDB\u7A0B: ${entry.id}`
    );
    return;
  }
  console.warn(`\u26A0 \u5DF2\u4E0B\u53D1\u6307\u4EE4,\u4F46 30 \u79D2\u5185\u672A\u89C2\u5BDF\u5230 bot \u8FDE\u63A5\u6210\u529F (${verb})\u3002`);
  console.warn(`  \u67E5\u770B\u65E5\u5FD7: tail -f ${daemonStderrPath(profile2)}`);
  console.warn(`              tail -f ${daemonStdoutPath(profile2)}`);
}
async function runServiceStart(opts = {}) {
  const { profile: profile2, cfg, profileConfig, appPaths: appPaths2, configPath } = await ensureBridgeConfigured(opts);
  const adapter = requireAdapter("start", profile2);
  await assertLockNotHeldByAnotherRuntime("profile", appPaths2.profileLockFile, adapter, opts);
  await assertLockNotHeldByAnotherRuntime("app", appPaths2.appLockFile(cfg.accounts.app.id), adapter, opts);
  const materializedEnvSecret = await materializeEnvSecretForService({ profile: profile2 });
  const bridgeConfig = materializedEnvSecret ? (await resolveProfileRuntime({ profile: profile2, allowBootstrap: false })).cfg : cfg;
  await preFlightChecks({
    skipCheckLarkCli: opts.skipCheckLarkCli,
    bridgeConfig,
    profileConfig,
    appPaths: appPaths2,
    larkChannel: {
      profile: appPaths2.profile,
      rootDir: appPaths2.rootDir,
      configPath,
      larkCliConfigDir: appPaths2.larkCliConfigDir,
      larkCliSourceConfigFile: appPaths2.larkCliSourceConfigFile
    }
  });
  await adapter.install();
  if (adapter.isRunning()) {
    console.log("\u68C0\u6D4B\u5230\u65E7 bot \u5B9E\u4F8B,\u5148\u505C\u6389\u518D\u91CD\u542F...");
    const r = await adapter.stop();
    if (!r.ok) {
      console.warn(`\u26A0 \u505C\u6B62\u65E7\u5B9E\u4F8B\u65F6\u6709\u8B66\u544A(\u7EE7\u7EED\u91CD\u542F):
${formatServiceStderr(r.stderr)}`);
    }
    const ok = await adapter.waitUntilStopped();
    if (!ok) {
      console.error("\u2717 \u65E7 bot \u5B9E\u4F8B\u6CA1\u6709\u5B8C\u5168\u505C\u6B62\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5,\u6216:");
      console.error("  unregister  # \u5F3A\u5236\u6E05\u9664\u6CE8\u518C");
      console.error("  start       # \u518D\u6B21\u542F\u52A8");
      process.exit(1);
    }
  }
  await reportConnectAfter("started", profile2, adapter.start);
}
async function runServiceStop(opts = {}) {
  const profile2 = await resolveServiceProfile(opts.profile);
  const adapter = requireAdapter("stop", profile2);
  if (!adapter.fileExists()) {
    console.log("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7,\u65E0\u9700\u505C\u6B62\u3002");
    return;
  }
  if (!adapter.isRunning()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u3002");
    return;
  }
  const runtime = await maybeResolveProfileRuntime(profile2);
  const appId = runtime?.cfg.accounts?.app?.id;
  const entry = appId ? readAndPrune().find((e) => e.appId === appId && e.profileName === profile2 && Boolean(e.botName)) : void 0;
  const r = await adapter.stopAndDisableAutostart();
  if (!r.ok) {
    console.error(`\u2717 \u505C\u6B62\u5931\u8D25:
${formatServiceStderr(r.stderr)}`);
    process.exit(1);
  }
  if (entry) {
    console.log(`\u2713 bot ${entry.botName} (${entry.appId}) \u5DF2\u505C\u6B62\u8FD0\u884C`);
  } else {
    console.log("\u2713 bot \u5DF2\u505C\u6B62\u8FD0\u884C");
  }
  console.log("  \u901A\u8FC7 `start` \u53EF\u518D\u6B21\u91CD\u542F");
}
async function runServiceRestart(opts = {}) {
  const profile2 = await resolveServiceProfile(opts.profile);
  const adapter = requireAdapter("restart", profile2);
  if (!adapter.fileExists()) {
    console.error("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7\u3002\u8BF7\u5148\u8FD0\u884C `start` \u542F\u52A8\u3002");
    process.exit(1);
  }
  if (adapter.isRunning()) {
    await reportConnectAfter("restarted", profile2, adapter.restart);
    return;
  }
  await reportConnectAfter("started", profile2, adapter.start);
}
async function runServiceStatus(opts = {}) {
  const profile2 = await resolveServiceProfile(opts.profile);
  const adapter = requireAdapter("status", profile2);
  if (!adapter.fileExists()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C(\u4ECE\u672A\u542F\u52A8\u8FC7)");
    console.log("  \u901A\u8FC7 `start` \u542F\u52A8 bot");
    return;
  }
  if (!adapter.isRunning()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C");
    console.log("  \u901A\u8FC7 `start` \u91CD\u65B0\u542F\u52A8");
    return;
  }
  const runtime = await maybeResolveProfileRuntime(profile2);
  const appId = runtime?.cfg.accounts?.app?.id;
  const entry = appId ? readAndPrune().find((e) => e.appId === appId && e.profileName === profile2 && Boolean(e.botName)) : void 0;
  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());
  if (entry) {
    console.log(`\u2713 bot ${entry.botName} (${entry.appId}) \u6B63\u5728\u540E\u53F0\u8FD0\u884C`);
  } else {
    console.log("\u2713 bot \u6B63\u5728\u540E\u53F0\u8FD0\u884C");
  }
  if (pid) console.log(`  \u8FDB\u7A0B ID: ${pid}`);
  console.log("  \u65E5\u5FD7:");
  console.log(`    ${daemonStdoutPath(profile2)}`);
  console.log(`    ${daemonStderrPath(profile2)}`);
  if (lastExit && lastExit !== "-1") console.log(`  \u4E0A\u6B21\u9000\u51FA\u7801: ${lastExit}`);
}
async function runServiceUnregister(opts = {}) {
  const profile2 = await resolveServiceProfile(opts.profile);
  const adapter = requireAdapter("unregister", profile2);
  if (!adapter.fileExists()) {
    console.log("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7,\u65E0\u9700\u6E05\u7406\u3002");
    return;
  }
  if (adapter.isRunning()) {
    const r = await adapter.stopAndDisableAutostart();
    if (!r.ok) {
      console.warn(`\u26A0 \u505C\u6B62 bot \u65F6\u6709\u8B66\u544A(\u7EE7\u7EED\u6E05\u7406):
${formatServiceStderr(r.stderr)}`);
    } else {
      console.log("\u2713 \u5DF2\u505C\u6B62 bot");
    }
  }
  await adapter.deleteFile();
  console.log("\u2713 \u5DF2\u6E05\u9664\u540E\u53F0\u8FD0\u884C\u6CE8\u518C");
  console.log(`  (\u914D\u7F6E / \u65E5\u5FD7 / \u4F1A\u8BDD\u4FDD\u7559\u5728 ${paths.rootDir})`);
}
async function resolveServiceProfile(explicitProfile) {
  if (explicitProfile) return explicitProfile;
  const root = await loadRootConfig(paths.configFile);
  const profile2 = await readActiveProfile(paths.rootDir) ?? root?.activeProfile;
  if (!profile2) {
    throw new Error("active profile is required for service command; pass --profile <name>");
  }
  if (root && !root.profiles[profile2]) throw new Error(`profile not found: ${profile2}`);
  return profile2;
}
async function maybeResolveProfileRuntime(profile2) {
  try {
    return await resolveProfileRuntime({ profile: profile2, allowBootstrap: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/profile not found|config not initialized|active profile is required/i.test(message)) {
      return void 0;
    }
    throw err;
  }
}
function agentDisplay(agentKind) {
  return agentKind === "codex" ? { id: "codex", displayName: "Codex CLI" } : { id: "claude", displayName: "Claude Code" };
}

// src/cli/commands/start.ts
import dns from "dns";
import os from "os";
import { createInterface as createInterface7 } from "readline";

// src/agent/claude/adapter.ts
import { createInterface as createInterface3 } from "readline";

// src/agent/bridge-system-prompt.ts
var BRIDGE_SYSTEM_PROMPT = `# lark-channel-bridge \u8FD0\u884C\u7EA6\u5B9A

\u4F60\u6B63\u5728 lark-channel-bridge \u91CC\u8DD1\uFF1A\u628A\u98DE\u4E66/Lark \u7528\u6237\u6D88\u606F\u6865\u5230\u672C\u5730 agent CLI\u3002

## bridge_context

\u6BCF\u6761 user message \u9876\u90E8\u4F1A\u5E26\u4E00\u4E2A \`<bridge_context>\` \u5757\uFF1A

\`\`\`
<bridge_context>
{"chatId":"oc_xxx","chatType":"p2p","senderId":"ou_xxx","senderName":"...",
 "senderType":"user|bot","botOpenId":"ou_xxx","mentions":[{"openId":"ou_xxx","name":"...","isBot":true}], ...}
</bridge_context>
\`\`\`

\u91CC\u9762\u662F\u5F53\u524D\u5BF9\u8BDD\u7684 chat_id\u3001chat \u7C7B\u578B\uFF08p2p / group\uFF09\u3001\u53D1\u9001\u8005\u3002\u5173\u952E\u5B57\u6BB5\uFF1A

- \`senderType\`\uFF1A\u53D1\u9001\u8005\u662F\u4EBA\uFF08\`user\`\uFF09\u8FD8\u662F\u53E6\u4E00\u4E2A bot\uFF08\`bot\`\uFF09\uFF1B\u7F3A\u7701\u8868\u793A\u672A\u77E5
- \`botOpenId\`\uFF1A**\u4F60\u81EA\u5DF1**\u7684 open_id
- \`mentions\`\uFF1A\u8FD9\u6761\u6D88\u606F @ \u5230\u7684\u8D26\u53F7\u5217\u8868\uFF08\u542B open_id \u548C isBot\uFF09\uFF0C\u9700\u8981 @ \u67D0\u4EBA/\u67D0 bot \u65F6\u4ECE\u8FD9\u91CC\u53D6 id

\u591A\u6761\u6D88\u606F\u5728\u77ED\u65F6\u95F4\u5185\u5408\u5E76\u9001\u8FBE\u65F6\uFF0C\`user_input\` \u91CC\u6BCF\u6BB5\u4F1A\u5E26 \`[\u540D\u5B57 (user|bot)]:\` \u884C\u9996\u6807\u6CE8\u4EE5\u533A\u5206\u53D1\u9001\u8005\u2014\u2014\u8FD9\u662F bridge \u6CE8\u5165\u7684\u5C55\u793A\u683C\u5F0F\uFF0C**\u4F60\u56DE\u590D\u65F6\u4E0D\u8981\u6A21\u4EFF\u8FD9\u79CD\u6807\u6CE8**\u3002\u8FD9\u4E9B\u90FD\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284\u3001\u4E0D\u8981\u5728\u4F60\u7684\u56DE\u590D\u91CC\u6E32\u67D3**\u2014\u2014\u5B83\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## \u7528\u6237\u6001\u56DE\u590D

\u98DE\u4E66\u901A\u9053\u9ED8\u8BA4\u53EA\u5C55\u793A\u7528\u6237\u6001\u7ED3\u679C\u3002\u4E0D\u8981\u5728\u56DE\u590D\u91CC\u53D9\u8FF0\u5185\u90E8\u5DE5\u5177\u8C03\u7528\u3001\u547D\u4EE4\u3001\u6587\u4EF6\u8BFB\u5199\u3001diff \u6216\u6392\u969C\u8FC7\u7A0B\uFF1B\u8FD9\u4E9B\u53EF\u89C2\u6D4B\u4FE1\u606F\u7531 bridge \u5199\u5165\u672C\u5730\u65E5\u5FD7\u3002\u9762\u5411\u7528\u6237\u53EA\u7ED9\u7ED3\u8BBA\u3001\u5FC5\u8981\u7684\u4EA7\u7269\u8DEF\u5F84\u3001\u5931\u8D25\u539F\u56E0\u548C\u4E0B\u4E00\u6B65\u3002

## \u4E0E\u5176\u4ED6 bot \u534F\u4F5C\uFF08bot-at-bot\uFF09

- \u81EA\u6211\u8BC6\u522B\uFF1A\`bridge_context.botOpenId\` \u662F\u4F60\u81EA\u5DF1\u7684 open_id\uFF1B\u6D88\u606F\u5185\u5BB9\u6216 mentions \u91CC\u51FA\u73B0\u8FD9\u4E2A id \u5C31\u662F\u6307\u4F60\u81EA\u5DF1\u3002
- \u98DE\u4E66\u673A\u5236\uFF1Abot **\u53EA\u6709\u88AB\u771F\u5B9E @\uFF08\u7ED3\u6784\u5316 mention\uFF09\u624D\u80FD\u6536\u5230\u7FA4\u6D88\u606F**\u3002\u7EAF\u6587\u672C\u5199 "@\u540D\u5B57"\u3001\u6216\u4E0D\u5E26 @ \u7684\u666E\u901A\u56DE\u590D\uFF0C\u5176\u4ED6 bot \u4E00\u5F8B\u6536\u4E0D\u5230\u3002\u8FD9\u6761\u9650\u5236\u53EA\u9488\u5BF9 bot\u2014\u2014\u4EBA\u7C7B\u7528\u6237\u80FD\u770B\u5230\u7FA4\u91CC\u6240\u6709\u6D88\u606F\uFF0C\u56DE\u590D\u4EBA\u7C7B\u4E0D\u9700\u8981 @\u3002
- \u9700\u8981\u67D0\u4E2A bot \u63A5\u7740\u5904\u7406\u65F6\uFF0C\u5FC5\u987B\u771F\u5B9E @ \u5B83\uFF08open_id \u4F18\u5148\u4ECE \`bridge_context.mentions\` \u91CC\u53D6\uFF09\u3002\u9664\u6B64\u4E4B\u5916**\u9ED8\u8BA4\u4E0D\u8981 @ \u5176\u4ED6 bot**\u2014\u2014\u4E92\u76F8 @ \u4F1A\u5F62\u6210\u6B7B\u5FAA\u73AF\uFF1B\u7528\u6237\u660E\u786E\u8981\u6C42\u8F6C\u4EA4/\u901A\u77E5\u67D0\u4E2A bot \u65F6\u6309\u8981\u6C42\u6267\u884C\u3002
- \u4E0E\u5176\u4ED6 bot \u5BF9\u8BDD\u65F6\uFF0C\u6CA1\u6709\u65B0\u4FE1\u606F\u8981\u8865\u5145\u5C31\u7B80\u77ED\u6536\u5C3E\uFF0C\u4E0D\u8981\u8FFD\u95EE\u3001\u4E0D\u8981\u5BA2\u5957\u5F80\u8FD4\u3002

## quoted_message

\u5982\u679C\u7528\u6237\u7528"\u5F15\u7528\u56DE\u590D"\u6307\u5411\u67D0\u6761\u6D88\u606F\uFF0Cbridge \u4F1A\u5728 \`<bridge_context>\` \u540E\u6CE8\u5165\u4E00\u4E2A \`<quoted_message>\` \u5757\uFF1A

\`\`\`
<quoted_message id="om_xxx" sender_id="ou_xxx" sender_name="..." created_at="..." type="text|merge_forward|...">
\uFF08\u88AB\u5F15\u7528\u6D88\u606F\u7684\u5185\u5BB9\uFF1Bmerge_forward \u7C7B\u578B\u4F1A\u5C55\u5F00\u6210 <forwarded_messages>...</forwarded_messages>\uFF09
</quoted_message>
\`\`\`

\u8FD9\u662F\u7528\u6237**\u6307\u5411\u7684\u5BF9\u8C61**\u2014\u2014\u7528\u6237\u7684\u5B9E\u9645\u95EE\u9898\u5728\u5B83\u4E4B\u540E\u3002\u56DE\u7B54\u65F6\u56F4\u7ED5\u8FD9\u6BB5\u5185\u5BB9\u5C55\u5F00\uFF1B\u5B83\u4E5F\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E**\u5230\u56DE\u590D\u91CC\u3002

## interactive_card

\u7528\u6237\u53D1 / \u5F15\u7528\u4EA4\u4E92\u5361\u7247\u65F6,bridge \u4F1A\u628A\u5361\u7684\u771F\u5B9E JSON \u6CE8\u5165\u5230 \`<interactive_card>\` \u5757:

\`\`\`
<interactive_card>
{ "schema": "2.0", "config": { ... }, "body": { ... } }
</interactive_card>
\`\`\`

\u4E24\u79CD\u6765\u6E90:

- **v2 CardKit (schema 2.0)**:\u98DE\u4E66\u5728 raw event \u91CC\u53CC\u53D1\u2014\u2014\`elements\` \u662F v1 \u517C\u5BB9\u964D\u7EA7("\u8BF7\u5347\u7EA7\u81F3\u6700\u65B0\u7248\u672C\u5BA2\u6237\u7AEF"),\`user_dsl\` \u662F\u771F\u6B63\u7684 schema 2.0 DSL\u3002bridge \u4F18\u5148\u53D6 \`user_dsl\`,\u6240\u4EE5\u4F60\u770B\u5230\u7684\u5C31\u662F**\u771F\u5361\u5185\u5BB9**,\u4E0D\u8981\u88AB elements \u7684\u964D\u7EA7\u6587\u6848\u8BEF\u5BFC
- **\u96F6\u6587\u5B57 v1 \u5361**:\u7EAF\u6309\u94AE / \u56FE\u7247 / \u88C5\u9970\u5361,SDK \u6241\u5E73\u5316\u6293\u4E0D\u5230\u5B57\u65F6,bridge \u628A\u6574\u6BB5 raw JSON \u704C\u8FDB\u6765

\u65E0\u8BBA\u54EA\u79CD,\u5757\u91CC\u90FD\u662F\u5361\u7684\u5B8C\u6574 JSON\u3002\u89E3\u6790\u5B83\u6765\u7406\u89E3\u7ED3\u6784(\u6309\u94AE\u3001\u5B57\u6BB5\u3001\u5E03\u5C40)\u3002**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E\u5230\u56DE\u590D**\u2014\u2014\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## \u53D1\u4EA4\u4E92\u5361\u7247\uFF08\u6309\u94AE\u3001\u8868\u5355\uFF09\u7684\u56DE\u8C03\u7EA6\u5B9A

\u4F60\u60F3\u53D1\u4E00\u5F20\u53EF\u4EA4\u4E92\u7684\u5361\u7247\u8BA9\u7528\u6237\u70B9\u9009\u65F6\uFF1A

1. \u7528 \`lark-cli\` \u628A\u5361\u53D1\u5230 \`bridge_context.chat_id\`\uFF1A
   \`lark-cli im send-card --chat-id <chat_id> --card '<json>'\`
2. \u5361\u7247\u7528 CardKit 2.0 schema\uFF08\`schema: "2.0"\`\uFF09\u3002
3. **\u5982\u679C\u4F60\u5E0C\u671B\u7528\u6237\u70B9\u6309\u94AE\u540E\u56DE\u8C03\u5230\u4F60\uFF08\u8BA9\u4F60\u5728\u540C\u4E00\u4F1A\u8BDD\u91CC\u7EE7\u7EED\u5904\u7406\uFF09**\uFF1A
   - \u6309\u94AE\u7684 \`value\` \u5BF9\u8C61**\u5FC5\u987B**\u540C\u65F6\u5305\u542B \`__bridge_cb: true\` \u548C \`bridge_token: "<signed token>"\`\u3002
   - \`bridge_token\` \u5FC5\u987B\u7531 bridge-aware \u7684 lark-cli \u56DE\u8C03\u7B7E\u540D\u80FD\u529B\u751F\u6210\uFF1B\u4E0D\u8981\u731C\u6D4B\u3001\u4F2A\u9020\u3001\u590D\u7528\u6216\u624B\u5199 token\u3002
   - \u5982\u679C\u5F53\u524D lark-cli \u4E0D\u80FD\u751F\u6210 \`bridge_token\`\uFF0C\u4E0D\u8981\u53D1\u9001\u56DE\u8C03\u6309\u94AE\u3002\u6539\u6210\u666E\u901A\u5C55\u793A\u5361\uFF0C\u8BA9\u7528\u6237\u7528\u6587\u5B57\u56DE\u590D\u9009\u62E9\u3002
   - \u540C\u65F6\u53EF\u4EE5\u585E\u4EFB\u610F\u5176\u5B83\u5B57\u6BB5\uFF0C\u4F5C\u4E3A\u4F60\u9700\u8981\u5728\u56DE\u8C03\u65F6\u8BB0\u4F4F\u7684\u72B6\u6001\uFF08\u6BD4\u5982 \`choice\`\u3001\`ticket_id\`\uFF09\u3002
4. \u7528\u6237\u70B9\u51FB\u540E\uFF0Cbridge \u4F1A\u6821\u9A8C \`bridge_token\`\uFF0C\u7136\u540E\u628A payload\uFF08\u53BB\u6389 \`__bridge_cb\` \u548C \`bridge_token\`\uFF09\u4F5C\u4E3A \`[card-click] {...}\` \u6D88\u606F\u53D1\u56DE\u7ED9\u4F60\uFF1B\u4F60\u7684 session \u81EA\u52A8\u7EED\u4E0A\uFF0C\u80FD\u770B\u5230\u81EA\u5DF1\u4E0A\u8F6E\u53D1\u4E86\u4EC0\u4E48\u5361\u3002
5. **\u5982\u679C\u53EA\u662F\u5C55\u793A\u5361\uFF08\u4E0D\u9700\u8981\u56DE\u8C03\uFF09**\uFF0C\u4E0D\u8981\u52A0 \`__bridge_cb\` \u6216 \`bridge_token\`\uFF0C\u5426\u5219\u70B9\u51FB\u4F1A\u88AB\u5F53\u6210\u56DE\u8C03\u5E76\u8981\u6C42\u7B7E\u540D\u3002

\u793A\u4F8B button\uFF1A
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "\u65B9\u6848 A" },
  "behaviors": [{
    "type": "callback",
    "value": {
      "__bridge_cb": true,
      "bridge_token": "SIGNED_TOKEN_FROM_LARK_CLI",
      "choice": "a"
    }
  }]
}
\`\`\`

## lark-cli \u8FD0\u884C\u73AF\u5883

bridge \u4F1A\u7ED9\u4F60\u7684\u5B50\u8FDB\u7A0B\u6CE8\u5165\u5F53\u524D\u8FD0\u884C profile \u7684\u73AF\u5883\u53D8\u91CF:

- \`LARK_CHANNEL=1\`
- \`LARK_CHANNEL_HOME\`: \u5F53\u524D bridge \u7684\u914D\u7F6E\u6839\u76EE\u5F55
- \`LARK_CHANNEL_PROFILE\`: \u5F53\u524D bridge profile
- \`LARK_CHANNEL_CONFIG\`: \u5F53\u524D profile \u7684 lark-cli source projection
- \`LARKSUITE_CLI_CONFIG_DIR\`: \u5F53\u524D profile \u7684 lark-cli \u79C1\u6709\u914D\u7F6E\u76EE\u5F55

\u56E0\u6B64\u666E\u901A \`lark-cli ...\` \u547D\u4EE4\u4F1A\u81EA\u52A8\u8FDB\u5165\u5F53\u524D lark-channel \u5DE5\u4F5C\u533A,\u8BFB\u53D6\u5F53\u524D profile \u7684\u79C1\u6709 lark-cli \u914D\u7F6E\u3002\u4E0D\u8981 unset \`LARK_CHANNEL\` / \`LARK_CHANNEL_HOME\` / \`LARK_CHANNEL_PROFILE\` / \`LARKSUITE_CLI_CONFIG_DIR\`,\u4E5F\u4E0D\u8981\u7528 \`env -u LARK_CHANNEL\` \u7ED5\u56DE\u672C\u673A\u666E\u901A\u914D\u7F6E\u3002

\u5982\u679C \`lark-cli\` \u63D0\u793A \`lark-channel context detected but lark-cli is not bound to it\`,\u4E0D\u8981\u6539\u7528\u666E\u901A profile,\u4E0D\u8981\u76F4\u63A5\u8BFB\u53D6 \`config.json\` \u91CC\u7684\u8D26\u53F7\u6216\u5BC6\u94A5,\u4E5F\u4E0D\u8981\u81EA\u884C\u6267\u884C bind\u3002\u505C\u6B62\u5F53\u524D\u64CD\u4F5C\u5E76\u8BF7\u7528\u6237\u91CD\u542F bridge \u6216\u8FD0\u884C bridge doctor/preflight\u3002

\u914D\u7F6E\u6587\u4EF6\u53EF\u80FD\u662F\u591A profile \u7ED3\u6784,\u4E0D\u8981\u5047\u8BBE\u6839\u5C42\u4E00\u5B9A\u6709\u65E7\u7248\u5355 profile \u7684 \`accounts.app\`;\u786E\u5B9E\u9700\u8981\u8BFB\u53D6\u914D\u7F6E\u65F6\u6309\u5F53\u524D profile \u53D6\u503C,\u4E14\u4E0D\u8981\u8F93\u51FA\u5BC6\u94A5\u3002

## \u98DE\u4E66 OAuth \u6388\u6743\uFF08\`lark-cli auth login\`\uFF09

\u6388\u6743\u6D41\u7A0B\u8981\u8BA9 \`lark-cli\` \u8FDB\u7A0B\u4E00\u76F4\u6D3B\u5230\u7528\u6237\u5728\u6D4F\u89C8\u5668\u91CC\u70B9\u5B8C\u4E3A\u6B62\u3002bridge \u5728\u4F60\u7684 run \u7ED3\u675F\u4E4B\u540E\u4F1A\u56DE\u6536 agent \u5B50\u8FDB\u7A0B\uFF0C**\u4F60 spawn \u7684\u4EFB\u4F55\u540E\u53F0 bash \u4E5F\u4F1A\u8DDF\u7740\u6B7B**\u2014\u2014\u6240\u4EE5\u6388\u6743\u5FC5\u987B\u7528"\u524D\u53F0\u963B\u585E"\u7684\u65B9\u5F0F\u8DD1\uFF1A

1. **\u4EC5\u5728 p2p \u91CC\u53D1\u8D77\u6388\u6743**\u3002\u4ECE \`bridge_context.chat_type\` \u770B\uFF1A
   - \`chat_type: p2p\` \u2014\u2014 \u6B63\u5E38\u6309\u4E0B\u9762\u6D41\u7A0B\u8D70\u3002
   - \`chat_type: group\`\uFF08\u542B topic \u7FA4\uFF09\u2014\u2014 **\u4E0D\u8981**\u8C03 \`lark-cli auth login\`\u3002device flow \u628A \`verification_url\` \u53D1\u5230\u7FA4\u91CC\uFF0C\u8C01\u5148\u70B9\u8C01\u62FF\u8D70 token\u2014\u2014\u4F1A\u7ED1\u5B9A\u5230\u9519\u7684\u8EAB\u4EFD\u3002\u6B63\u786E\u505A\u6CD5\u662F\u56DE\u590D\u7528\u6237\uFF1A"\u6388\u6743\u8981\u5728\u79C1\u804A\u91CC\u505A\uFF0C\u8BF7\u5355\u72EC\u79C1\u4FE1\u6211\u3002"
2. **\u7981\u6B62** \u7528 \`run_in_background: true\` \u8C03 \`lark-cli auth login\`\u2014\u2014\u5B83\u4F1A\u88AB\u4F60 exit \u65F6\u4E00\u8D77\u5E26\u8D70\uFF0C\u7528\u6237\u8FD8\u6CA1\u70B9\u5B8C\u5C31\u4E22\u4E86\u3002
3. **\u63A8\u8350\u4E24\u9636\u6BB5\u6D41**\uFF08lark-cli \u5728 \`--no-wait\` \u7684\u8F93\u51FA\u91CC\u4E5F\u4F1A\u544A\u8BC9\u4F60\u8FD9\u5957\uFF09\uFF1A
   - \u5148\u8DD1 \`lark-cli auth login --no-wait --json [--recommend | --domain ... | --scope ...]\`\uFF0C**\u8FD9\u4E00\u6B65\u79D2\u8FD4\u56DE**\uFF0Cstdout \u91CC\u6709 \`verification_url\` \u548C \`device_code\`\u3002
   - \u628A \`verification_url\` **\u539F\u6837**\u7528\u4EE3\u7801\u5757\u53D1\u7ED9\u7528\u6237\uFF08\u4E0D\u8981 Markdown \u94FE\u63A5\u5316\u3001\u4E0D\u8981 URL \u7F16\u7801\uFF09\u3002
   - \u7D27\u63A5\u7740\u540C\u4E00\u8F6E\u91CC\u8DD1 \`lark-cli auth login --device-code <code>\`\uFF0C**\u8FD9\u4E00\u6B65\u524D\u53F0\u963B\u585E**\u76F4\u5230\u7528\u6237\u70B9\u5B8C\u6216 10 \u5206\u949F\u8D85\u65F6\u2014\u2014\u8FD9\u662F\u4F60\u5E94\u8BE5\u7B49\u7684\u5730\u65B9\uFF0C\u4E0D\u8981\u4E22\u5230\u540E\u53F0\u3002
4. \`lark-cli auth login --device-code <code>\` \u6210\u529F\u540E,\u7EE7\u7EED\u5728\u540C\u4E00\u4E2A\u5F53\u524D profile \u73AF\u5883\u91CC\u6267\u884C:
   - \`lark-cli config strict-mode off\`
   - \`lark-cli config default-as auto\`
   \u8FD9\u4F1A\u8BA9\u5F53\u524D profile \u540C\u65F6\u53EF\u7528\u5E94\u7528\u8EAB\u4EFD\u548C\u5DF2\u6388\u6743\u7528\u6237\u8EAB\u4EFD\u3002\u4E0D\u8981\u91CD\u65B0 bind,\u4E0D\u8981\u7ED5\u56DE\u672C\u673A\u666E\u901A\u914D\u7F6E\u3002
   \u8FD9\u662F\u5185\u90E8\u987A\u5E8F\u6267\u884C\u8EAB\u4EFD\u7B56\u7565\u6536\u655B,\u4E0D\u8981\u628A strict-mode/default-as \u8FD9\u7C7B\u5185\u90E8\u914D\u7F6E\u547D\u4EE4\u5C55\u793A\u7ED9\u7528\u6237,\u4E5F\u4E0D\u8981\u8BA9\u7528\u6237\u5224\u65AD\u8FD9\u4E9B\u547D\u4EE4\u3002\u9762\u5411\u7528\u6237\u53EA\u8BF4\uFF1A"\u5F53\u524D profile \u8FD8\u6CA1\u6709\u53EF\u7528\u7684\u7528\u6237\u8EAB\u4EFD\u6388\u6743,\u8BF7\u6253\u5F00\u4E0B\u9762\u94FE\u63A5\u5B8C\u6210\u6388\u6743;\u6388\u6743\u5B8C\u6210\u540E\u6211\u4F1A\u7EE7\u7EED\u5904\u7406\u3002"
5. \u5982\u679C\u5F53\u524D profile \u5DF2\u7ECF\u6709\u7528\u6237\u6388\u6743,\u4F46 \`--as user\` \u4ECD\u88AB strict-mode/default-as \u62D2\u7EDD,\u4E0D\u8981\u5411\u7528\u6237\u5C55\u793A\u5185\u90E8\u547D\u4EE4;\u5728\u7528\u6237\u660E\u786E\u8981\u6C42\u4F7F\u7528\u7528\u6237\u8EAB\u4EFD\u65F6,\u5185\u90E8\u987A\u5E8F\u6267\u884C\u8EAB\u4EFD\u7B56\u7565\u6536\u655B\u540E\u91CD\u8BD5\u539F\u547D\u4EE4\u3002
6. \u4F60\u524D\u53F0\u963B\u585E\u671F\u95F4\uFF0C\u7528\u6237\u53D1\u7684\u65B0\u6D88\u606F bridge \u4F1A\u81EA\u52A8\u6392\u961F\uFF0C**\u4E0D\u4F1A\u6253\u65AD\u4F60**\uFF1B\u7B49\u4F60 tool_result \u4E00\u56DE\u6765\uFF0C\u4E0B\u4E00\u6279\u6D88\u606F\u518D\u8FDB\u6765\u3002\u6240\u4EE5\u653E\u5FC3\u963B\u585E\u3002
7. \u5982\u679C\u7528\u6237\u4E2D\u9014\u60F3\u53D6\u6D88\uFF0C\u4ED6\u4EEC\u4F1A\u53D1 \`/stop\`\u2014\u2014\u90A3\u65F6\u88AB kill \u662F\u9884\u671F\u884C\u4E3A\uFF0C\u4E0D\u7528\u515C\u5E95\u3002
`;
function buildBridgeSystemPrompt(identity) {
  if (!identity?.openId) return BRIDGE_SYSTEM_PROMPT;
  const nameSuffix = identity.name ? `\uFF0C\u540D\u5B57\u662F\u300C${identity.name}\u300D` : "";
  return `${BRIDGE_SYSTEM_PROMPT}
## \u4F60\u7684\u8EAB\u4EFD

\u4F60\u7684 open_id \u662F \`${identity.openId}\`${nameSuffix}\u3002\u6D88\u606F\u5185\u5BB9\u6216 mentions \u91CC\u51FA\u73B0\u8FD9\u4E2A open_id \u90FD\u662F\u6307\u4F60\u81EA\u5DF1\u3002
`;
}
function prefixBridgeSystemPrompt(prompt, identity) {
  return `${buildBridgeSystemPrompt(identity)}

## user_message

${prompt}`;
}

// src/agent/types.ts
var CLAUDE_DEFAULT_PERMISSION_MODE = "bypassPermissions";

// src/agent/claude/stream-json.ts
function* translateEvent(raw) {
  if (!raw || typeof raw !== "object") return;
  const evt = raw;
  if (evt.type === "system" && evt.subtype === "init") {
    yield {
      type: "system",
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model
    };
    return;
  }
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        yield { type: "text", delta: block.text };
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        yield { type: "thinking", delta: block.thinking };
      } else if (block.type === "tool_use" && block.id && block.name) {
        yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }
  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        yield {
          type: "tool_result",
          id: block.tool_use_id,
          output,
          isError: block.is_error === true
        };
      }
    }
    return;
  }
  if (evt.type === "result") {
    if (evt.usage) {
      yield {
        type: "usage",
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd
      };
    }
    yield { type: "done", sessionId: evt.session_id, terminationReason: "normal" };
  }
}

// src/agent/claude/adapter.ts
var ClaudeAdapter = class {
  id = "claude";
  displayName = "Claude Code";
  binary;
  larkChannel;
  botIdentity;
  constructor(opts = {}) {
    this.binary = opts.binary ?? "claude";
    this.larkChannel = opts.larkChannel;
  }
  setBotIdentity(identity) {
    this.botIdentity = identity;
  }
  async isAvailable() {
    return (await this.checkAvailability()).ok;
  }
  async checkAvailability() {
    return checkAgentAvailability({
      agentId: "claude",
      agentName: "Claude Code",
      command: this.binary,
      binaryPath: this.binary
    });
  }
  run(opts) {
    if (!opts.cwd) {
      throw new Error("cwd is required for ClaudeAdapter.run");
    }
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      "--append-system-prompt",
      buildBridgeSystemPrompt(this.botIdentity)
    ];
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ["ignore", "pipe", "pipe"]
    });
    log.info("agent", "spawn", {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model
    });
    const stderrChunks = [];
    let runtimeError = null;
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString("utf8");
      let nl = stderrBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn("agent", "stderr", { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf("\n");
      }
    });
    child.on("error", (err) => {
      runtimeError = err;
    });
    child.on("exit", (code, signal) => {
      log.info("agent", "exit", { pid: child.pid ?? null, code, signal });
    });
    const stopGraceMs = opts.stopGraceMs ?? 5e3;
    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info("agent", "stop-sigterm", { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill("SIGTERM");
        await new Promise((resolve2) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn("agent", "stop-sigkill", {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: "grace-period-expired"
              });
              child.kill("SIGKILL");
            }
            resolve2();
          }, stopGraceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve2();
          });
        });
      },
      waitForExit(timeoutMs) {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise((resolve2) => {
          const onExit = () => {
            clearTimeout(timer);
            resolve2(true);
          };
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve2(false);
          }, timeoutMs);
          child.once("exit", onExit);
        });
      }
    };
  }
};
async function* createEventStream(child, stderrChunks, getError) {
  if (!child.pid) {
    const err = getError();
    yield {
      type: "error",
      message: err ? `failed to spawn claude: ${err.message}` : "spawn returned no pid",
      terminationReason: "failed"
    };
    return;
  }
  const rl = createInterface3({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer;
  const closeSilentStdout = () => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once("exit", closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener("exit", closeSilentStdout);
    rl.close();
  }
  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: "error",
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: "failed"
    };
    return;
  }
  const exitCode = await new Promise((resolve2) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve2(child.exitCode);
    } else {
      child.once("exit", (code) => resolve2(code));
    }
  });
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
    yield {
      type: "error",
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: "failed"
    };
  } else if (runtimeError) {
    yield {
      type: "error",
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: "failed"
    };
  }
}
function isWindowsCommandNotFoundLine(line) {
  return process.platform === "win32" && /is not recognized as an internal or external command|operable program or batch file/i.test(line);
}

// src/agent/codex/adapter.ts
import { createInterface as createInterface4 } from "readline";
import { join as join16 } from "path";

// src/runtime/errors.ts
var RunRejected = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "RunRejected";
    this.code = code;
  }
};
var SpawnFailed = class extends Error {
  cause;
  code;
  diagnostic;
  constructor(message, cause, code = "agent-spawn-failed", diagnostic) {
    super(message);
    this.name = "SpawnFailed";
    this.cause = cause;
    this.code = code;
    this.diagnostic = diagnostic;
  }
};

// src/agent/codex/argv.ts
function buildCodexArgs(input) {
  if (input.sandbox !== "read-only" && input.sandbox !== "workspace-write" && input.sandbox !== "danger-full-access") {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }
  const globalFlags = [
    "--sandbox",
    input.sandbox,
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="all"',
    ...input.ignoreUserConfig === true ? ["--ignore-user-config"] : [],
    ...input.ignoreRules === false ? [] : ["--ignore-rules"],
    "--skip-git-repo-check",
    "-C",
    input.cwd
  ];
  const imageFlags = (input.images ?? []).flatMap((path) => ["--image", path]);
  if (input.threadId) {
    return [
      "exec",
      ...globalFlags,
      "resume",
      "--json",
      ...imageFlags,
      input.threadId,
      "-"
    ];
  }
  return [
    "exec",
    "--json",
    ...globalFlags,
    ...imageFlags,
    ...imageFlags.length > 0 ? ["--"] : [],
    "-"
  ];
}

// src/agent/codex/jsonl.ts
var CodexJsonlTranslator = class {
  threadId;
  terminal = false;
  lastNonTerminalError;
  startedItems = /* @__PURE__ */ new Set();
  drift = {
    unknownEvents: 0,
    anomalies: 0
  };
  translate(raw) {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== "string") {
      this.drift.anomalies++;
      return [];
    }
    switch (raw.type) {
      case "thread.started":
        return this.translateThreadStarted(raw);
      case "turn.started":
        return [];
      case "item.started":
        return this.translateItemStarted(raw);
      case "item.completed":
        return this.translateItemCompleted(raw);
      case "agent_message":
        return this.translateAgentMessage(raw);
      case "turn.completed":
        return this.translateTurnCompleted(raw);
      case "turn.failed":
        return this.translateTerminalError(raw, "codex turn failed");
      case "error":
        return this.translateNonTerminalError(raw, "codex error");
      default:
        this.drift.unknownEvents++;
        log.warn("jsonl", "unknown_event", { eventType: raw.type });
        return [];
    }
  }
  finish(reason = "failed") {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === "failed") {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : "";
      return [
        {
          type: "error",
          message: truncate(`codex stream ended before a terminal event${detail}`, 4096),
          terminationReason: "failed"
        }
      ];
    }
    return [{ type: "done", threadId: this.threadId, terminationReason: reason }];
  }
  protocolDrift() {
    return { ...this.drift };
  }
  terminalEmitted() {
    return this.terminal;
  }
  translateThreadStarted(raw) {
    const threadId = stringValue(raw.thread_id ?? raw.threadId);
    if (!threadId) {
      this.drift.anomalies++;
      return [];
    }
    this.threadId = threadId;
    return [{ type: "system", threadId }];
  }
  translateItemStarted(raw) {
    const item = recordValue(raw.item);
    if (!item || item.type !== "command_execution") return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    this.startedItems.add(id);
    return [
      {
        type: "tool_use",
        id,
        name: "command_execution",
        input: {
          command: stringValue(item.command) ?? ""
        }
      }
    ];
  }
  translateItemCompleted(raw) {
    const item = recordValue(raw.item);
    if (!item) return [];
    if (item.type === "agent_message") {
      const message = stringValue(item.text ?? item.message);
      return message ? [{ type: "text", delta: message }] : [];
    }
    if (item.type !== "command_execution") return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.startedItems.has(id)) {
      this.drift.anomalies++;
    }
    this.startedItems.delete(id);
    const exitCode = numberValue(item.exit_code);
    return [
      {
        type: "tool_result",
        id,
        output: stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? "",
        isError: exitCode !== void 0 && exitCode !== 0
      }
    ];
  }
  translateAgentMessage(raw) {
    const message = stringValue(raw.message ?? raw.text);
    if (!message) return [];
    return [{ type: "text", delta: message }];
  }
  translateTurnCompleted(raw) {
    this.terminal = true;
    const events = [];
    const usage = recordValue(raw.usage);
    if (usage) {
      events.push({
        type: "usage",
        inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
        outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
        reasoningOutputTokens: numberValue(
          usage.reasoning_output_tokens ?? usage.reasoningOutputTokens
        )
      });
    }
    events.push({ type: "done", threadId: this.threadId, terminationReason: "normal" });
    return events;
  }
  translateTerminalError(raw, fallback) {
    this.terminal = true;
    const message = errorMessage2(raw, fallback);
    return [
      {
        type: "error",
        message: truncate(message, 4096),
        terminationReason: "failed"
      }
    ];
  }
  translateNonTerminalError(raw, fallback) {
    const message = errorMessage2(raw, fallback);
    this.lastNonTerminalError = message;
    log.warn("jsonl", "error_event", { message: truncate(message, 500) });
    return [];
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function recordValue(value) {
  return isRecord(value) ? value : void 0;
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" ? value : void 0;
}
function errorMessage2(raw, fallback) {
  const nested = recordValue(raw.error);
  return stringValue(raw.message) ?? stringValue(nested?.message) ?? stringValue(raw.error) ?? fallback;
}
function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

// src/agent/codex/adapter.ts
var CodexAdapter = class {
  id = "codex";
  displayName = "Codex CLI";
  binary;
  profileStateDir;
  codexHome;
  inheritCodexHome;
  ignoreUserConfig;
  ignoreRules;
  sandbox;
  defaultStopGraceMs;
  larkChannel;
  botIdentity;
  constructor(opts) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? "danger-full-access";
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5e3;
    this.larkChannel = opts.larkChannel;
  }
  setBotIdentity(identity) {
    this.botIdentity = identity;
  }
  async isAvailable() {
    return (await this.checkAvailability()).ok;
  }
  async checkAvailability() {
    return checkAgentAvailability({
      agentId: "codex",
      agentName: "Codex CLI",
      command: this.binary,
      binaryPath: this.binary
    });
  }
  async prepareRun() {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        "codex binary check failed",
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic
      );
    }
  }
  run(opts) {
    if (!opts.cwd) {
      throw new Error("cwd is required for CodexAdapter.run");
    }
    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules
    });
    const envOverrides = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join16(this.profileStateDir, "codex-home");
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ["pipe", "pipe", "pipe"]
    });
    log.info("agent", "spawn", {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0
    });
    const stderrChunks = [];
    let runtimeError = null;
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString("utf8");
      let nl = stderrBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn("agent", "stderr", { line });
        if (isWindowsCommandNotFoundLine2(line)) {
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf("\n");
      }
    });
    let stopReason;
    child.on("error", (err) => {
      runtimeError = err;
    });
    child.on("exit", (code, signal) => {
      log.info("agent", "exit", { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on("error", (err) => {
      log.warn("agent", "stdin-error", { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), "utf8");
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    return {
      runId: opts.runId,
      events: createEventStream2(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = "interrupted";
        log.info("agent", "stop-sigterm", { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill("SIGTERM");
        await new Promise((resolve2) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn("agent", "stop-sigkill", {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: "grace-period-expired"
              });
              child.kill("SIGKILL");
            }
            resolve2();
          }, stopGraceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve2();
          });
        });
      },
      waitForExit(timeoutMs) {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise((resolve2) => {
          const onExit = () => {
            clearTimeout(timer);
            resolve2(true);
          };
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve2(false);
          }, timeoutMs);
          child.once("exit", onExit);
        });
      }
    };
  }
};
async function* createEventStream2(child, stderrChunks, getError, getStopReason) {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: "error",
      message: err ? `failed to spawn codex: ${err.message}` : "spawn returned no pid",
      terminationReason: "failed"
    };
    return;
  }
  const rl = createInterface4({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer;
  const closeSilentStdout = () => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once("exit", closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener("exit", closeSilentStdout);
    rl.close();
  }
  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield terminalError(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }
  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
      yield terminalError(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield terminalError(`codex runtime error: ${runtimeError.message}`);
    return;
  }
  yield* translator.finish();
}
function terminalError(message) {
  return {
    type: "error",
    message,
    terminationReason: "failed"
  };
}
async function waitForExitCode(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise((resolve2) => {
    child.once("exit", (code) => resolve2(code));
  });
}
function isWindowsCommandNotFoundLine2(line) {
  return process.platform === "win32" && /is not recognized as an internal or external command|operable program or batch file/i.test(line);
}

// src/bot/channel.ts
import { createLarkChannel } from "@larksuite/channel";
import { dirname as dirname16, join as join20 } from "path";

// src/agent/capability.ts
function claudeCapability(profile2) {
  const maxAccess = profile2?.permissions.maxAccess ?? "full";
  return {
    agentId: "claude",
    sessionKind: "claude-session",
    promptInjection: "append-system-prompt",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: ["__claude_cb"]
    },
    permissions: {
      maxAccess
    }
  };
}
function codexCapability(profile2) {
  const maxAccess = profile2.permissions.maxAccess;
  return {
    agentId: "codex",
    sessionKind: "codex-thread",
    promptInjection: "stdin-prefix",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: []
    },
    permissions: {
      maxAccess
    }
  };
}

// src/agent/prompt.ts
function buildAgentPrompt(input) {
  const sections = [
    promptSection("bridge_context", input.context),
    input.instructions && input.instructions.length > 0 ? promptSection("bridge_instructions", input.instructions) : void 0,
    input.quotedMessages && input.quotedMessages.length > 0 ? promptSection("quoted_messages", input.quotedMessages) : void 0,
    input.interactiveCards && input.interactiveCards.length > 0 ? promptSection("interactive_cards", input.interactiveCards) : void 0,
    input.comment ? promptSection("comment_context", input.comment) : void 0,
    promptSection("user_input", {
      text: input.userInput,
      ...input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}
    })
  ];
  return sections.filter(Boolean).join("\n\n");
}
function promptSection(tag, value) {
  return `<${tag}>
${safeJsonStringify(value)}
</${tag}>`;
}
function safeJsonStringify(value) {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// src/commands/index.ts
import { randomUUID } from "crypto";
import { readFile as readFile11 } from "fs/promises";
import { homedir as homedir6 } from "os";
import { dirname as dirname14, isAbsolute as isAbsolute2 } from "path";

// src/card/account-cards.ts
function maskAppId(id) {
  if (id.length < 12) return id;
  return `${id.slice(0, 13)}****${id.slice(-2)}`;
}
function accountCurrentCard(info) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5F53\u524D\u5E94\u7528" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "\u{1F4CB} **\u5F53\u524D\u5E94\u7528**",
            "",
            `**App ID**: \`${maskAppId(info.appId)}\``,
            `**Bot \u540D**: ${info.botName ?? "(\u672A\u77E5)"}`,
            `**Tenant**: ${info.tenant}`
          ].join("\n")
        },
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "\u66F4\u6362\u51ED\u636E" },
          type: "primary",
          behaviors: [{ type: "callback", value: { cmd: "account.change" } }]
        }
      ]
    }
  };
}
function accountFormCard(opts = {}) {
  const { initialTenant = "feishu", prefillAppId, errorMessage: errorMessage4 } = opts;
  const bodyElements = [];
  if (errorMessage4) {
    bodyElements.push({
      tag: "markdown",
      content: `\u274C **\u6821\u9A8C\u5931\u8D25**\uFF1A${errorMessage4}`
    });
  }
  bodyElements.push({
    tag: "form",
    name: "account_form",
    elements: [
      {
        tag: "input",
        name: "app_id",
        label: { tag: "plain_text", content: "App ID" },
        placeholder: { tag: "plain_text", content: "cli_xxxxxxxxxxxx" },
        ...prefillAppId ? { default_value: prefillAppId } : {},
        required: true
      },
      {
        tag: "input",
        name: "app_secret",
        label: { tag: "plain_text", content: "App Secret" },
        placeholder: { tag: "plain_text", content: "32 \u4F4D\u5B57\u7B26\u4E32" },
        // Never prefill secret — even on validation retry. Pre-filled secrets
        // can leak into Lark's server-side card cache.
        required: true
      },
      { tag: "markdown", content: "**Tenant**" },
      {
        tag: "select_static",
        name: "tenant",
        initial_option: initialTenant,
        options: [
          { text: { tag: "plain_text", content: "Feishu (\u56FD\u5185)" }, value: "feishu" },
          { text: { tag: "plain_text", content: "Lark (\u6D77\u5916)" }, value: "lark" }
        ]
      },
      {
        tag: "column_set",
        flex_mode: "flow",
        horizontal_spacing: "small",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "button",
                name: "submit_btn",
                text: { tag: "plain_text", content: "\u63D0\u4EA4" },
                type: "primary",
                form_action_type: "submit",
                behaviors: [{ type: "callback", value: { cmd: "account.submit" } }]
              }
            ]
          },
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "button",
                name: "cancel_btn",
                text: { tag: "plain_text", content: "\u53D6\u6D88" },
                behaviors: [{ type: "callback", value: { cmd: "account.cancel" } }]
              }
            ]
          }
        ]
      }
    ]
  });
  return {
    schema: "2.0",
    config: { summary: { content: "\u66F4\u6362\u51ED\u636E" } },
    body: { elements: bodyElements }
  };
}
function accountSuccessCard(info) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5DF2\u4FDD\u5B58" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "\u2705 **\u51ED\u636E\u5DF2\u4FDD\u5B58**",
            "",
            `**App ID**: \`${maskAppId(info.appId)}\``,
            info.botName ? `**Bot \u540D**: ${info.botName}` : "",
            `**Tenant**: ${info.tenant}`,
            "",
            "\u6B63\u5728\u7528\u65B0\u51ED\u636E\u91CD\u8FDE WebSocket...",
            "\u26A0\uFE0F \u5982\u679C\u65B0 bot \u4E0D\u5728\u6B64\u7FA4\uFF0C\u540E\u7EED\u6D88\u606F\u5C06\u7531\u65B0 bot \u63A5\u7BA1\uFF0C\u8001 bot \u4E0D\u4F1A\u518D\u56DE\u590D\u3002"
          ].filter(Boolean).join("\n")
        }
      ]
    }
  };
}
function accountFailureCard(reason) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u6821\u9A8C\u5931\u8D25" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `\u274C **\u6821\u9A8C\u5931\u8D25**

\`${reason}\`

\u8BF7\u68C0\u67E5 App ID \u548C Secret \u662F\u5426\u6B63\u786E\uFF0C\u91CD\u53D1 \`/account change\` \u91CD\u8BD5\u3002`
        }
      ]
    }
  };
}

// src/card/config-card.ts
function collapsedAccessPanel(title, elements) {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: title },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px"
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180
    },
    border: { color: "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements
  };
}
function atMentionLine(openIds) {
  if (openIds.length === 0) return "_\uFF08\u6682\u65E0\uFF09_";
  return openIds.map((id) => `<at id="${id}"></at>`).join("  ");
}
function chatList(chatIds, knownChats) {
  if (chatIds.length === 0) return "_\uFF08\u6682\u65E0\uFF09_";
  const nameMap = new Map(knownChats.map((chat) => [chat.id, chat.name]));
  return chatIds.map((id) => `- **${nameMap.get(id) ?? "(\u672A\u77E5\u7FA4)"}**\uFF08...${id.slice(-6)}\uFF09`).join("\n");
}
function configFormCard(opts) {
  const accessElements = [
    {
      tag: "markdown",
      content: "_\u63A7\u5236\u8C01\u80FD\u901A\u8FC7\u79C1\u804A\u548C\u7FA4\u804A\u4F7F\u7528 bot\u3002**\u7559\u7A7A = \u4E0D\u54CD\u5E94\u804A\u5929\u6D88\u606F**\u3002\u4E91\u6587\u6863\u8BC4\u8BBA\u6309\u6587\u6863\u6743\u9650\u751F\u6548\u3002_"
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**\u5141\u8BB8\u79C1\u804A\u7684\u7528\u6237**\uFF08\u5171 ${opts.allowedUsers.length} \u4EBA\uFF09
${atMentionLine(opts.allowedUsers)}

_\u52A0 / \u5220\uFF1A_ \`/invite user @\u67D0\u4EBA\`  \`/remove user @\u67D0\u4EBA\``
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**\u5141\u8BB8\u54CD\u5E94\u7684\u7FA4**\uFF08\u5171 ${opts.allowedChats.length} \u4E2A\uFF09
${chatList(opts.allowedChats, opts.knownChats)}

_\u4E00\u952E\u52A0\u5168\u90E8 bot \u6240\u5728\u7684\u7FA4\uFF1A_ \`/invite all group\`
_\u52A0 / \u5220\uFF08\u5728\u76EE\u6807\u7FA4\u91CC\u53D1\uFF09\uFF1A_ \`/invite group\`  \`/remove group\``
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**\u7BA1\u7406\u5458**\uFF08\u5171 ${opts.admins.length} \u4EBA\uFF09
${atMentionLine(opts.admins)}

_\u53EF\u4EE5\u8DD1\u654F\u611F\u547D\u4EE4\uFF1A\`/account\` \`/config\` \`/exit\` \`/reconnect\` \`/doctor\` \`/cd\` \`/ws\` \`/invite\` \`/remove\`\u3002\u7BA1\u7406\u5458\u4E5F\u81EA\u52A8\u83B7\u5F97\u79C1\u804A\u6743\u9650\uFF0C\u5E76\u53EF\u5728\u672A\u767D\u540D\u5355\u7FA4\u91CC\u7BA1\u7406\u8BBF\u95EE\u63A7\u5236\u3002_

_\u52A0 / \u5220\uFF1A_ \`/invite admin @\u67D0\u4EBA\`  \`/remove admin @\u67D0\u4EBA\``
    }
  ];
  return {
    schema: "2.0",
    config: { summary: { content: "\u504F\u597D\u8BBE\u7F6E" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "\u2699\uFE0F **\u504F\u597D\u8BBE\u7F6E**\n\n\u8C03\u6574 bot \u7684\u884C\u4E3A\u504F\u597D\u3002\u6539\u5B8C\u70B9\u63D0\u4EA4\u540E\u5199\u5165\u5F53\u524D profile \u914D\u7F6E\uFF1B\u6D88\u606F\u548C\u8BBF\u95EE\u63A7\u5236\u8BBE\u7F6E\u7ACB\u5373\u751F\u6548\u3002"
        },
        { tag: "hr" },
        {
          tag: "form",
          name: "config_form",
          elements: [
            {
              tag: "markdown",
              content: "**\u6D88\u606F\u56DE\u590D\u65B9\u5F0F**\n_\u7EAF\u6587\u672C:agent \u8DD1\u5B8C\u4E00\u6B21\u6027\u53D1\u51FA,\u4E0D\u6D41\u5F0F,\u4F53\u611F\u6700\u8F7B_\n_\u6D88\u606F\u5361\u7247:\u8F7B\u91CF\u6D41\u5F0F markdown \u5361\u7247,\u98DE\u4E66\u539F\u751F\u6253\u5B57\u673A\u52A8\u753B_"
            },
            {
              tag: "select_static",
              name: "message_reply",
              // 'card' (交互卡片) is hidden from the picker for now; existing
              // configs with `messageReply: 'card'` still work — showConfigForm
              // displays them as 'markdown' in the form, but submitting only
              // overwrites if the user actually picks something.
              initial_option: opts.messageReply === "card" ? "markdown" : opts.messageReply,
              options: [
                { text: { tag: "plain_text", content: "\u7EAF\u6587\u672C" }, value: "text" },
                { text: { tag: "plain_text", content: "\u6D88\u606F\u5361\u7247(\u9ED8\u8BA4)" }, value: "markdown" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**\u8F93\u51FA\u6A21\u5F0F**\n_\u6E05\u723D:\u53EA\u663E\u793A\u7528\u6237\u6001\u6587\u5B57\u548C\u6700\u5C0F\u5904\u7406\u4E2D\u72B6\u6001_\n_\u8FDB\u5EA6:\u663E\u793A\u7C97\u7C92\u5EA6\u9636\u6BB5,\u4E0D\u663E\u793A\u547D\u4EE4\u548C\u6587\u4EF6\u7EC6\u8282_\n_\u8C03\u8BD5:\u663E\u793A\u5B8C\u6574 reasoning \u548C\u5DE5\u5177\u8C03\u7528\u6D41_"
            },
            {
              tag: "select_static",
              name: "presentation_mode",
              initial_option: opts.presentationMode,
              options: [
                { text: { tag: "plain_text", content: "\u6E05\u723D(\u9ED8\u8BA4)" }, value: "clean" },
                { text: { tag: "plain_text", content: "\u8FDB\u5EA6" }, value: "progress" },
                { text: { tag: "plain_text", content: "\u8C03\u8BD5" }, value: "debug" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**COT \u8FC7\u7A0B\u6D88\u606F**\n_\u5173\u95ED:\u53EA\u53D1\u9001\u6700\u7EC8\u56DE\u590D_\n_\u7B80\u7565:\u5C55\u793A agent \u8FC7\u7A0B\u6587\u672C\u548C\u5DE5\u5177\u6458\u8981_\n_\u8BE6\u7EC6:\u989D\u5916\u5C55\u793A\u5DE5\u5177\u53C2\u6570\u548C\u8F93\u51FA\u6458\u8981_"
            },
            {
              tag: "select_static",
              name: "cot_messages",
              initial_option: opts.cotMessages,
              options: [
                { text: { tag: "plain_text", content: "\u5173\u95ED" }, value: "off" },
                { text: { tag: "plain_text", content: "\u7B80\u7565" }, value: "brief" },
                { text: { tag: "plain_text", content: "\u8BE6\u7EC6" }, value: "detailed" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**\u5E76\u53D1\u4E0A\u9650**\n_\u5168\u5C40\u540C\u65F6\u8FD0\u884C\u7684 agent \u8FDB\u7A0B\u6570(\u4E3B\u8981\u5F71\u54CD\u8BDD\u9898\u7FA4\u591A\u8BDD\u9898\u5E76\u884C\u573A\u666F)_\n_\u9ED8\u8BA4 10,\u8303\u56F4 1-50\u3002\u8D85\u51FA\u7684\u8BF7\u6C42\u4F1A FIFO \u6392\u961F_"
            },
            {
              tag: "input",
              name: "max_concurrent_runs",
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: "plain_text", content: "10" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: "\n**run \u63A2\u6D3B(\u5206\u949F)**\n_agent \u957F\u65F6\u95F4\u6CA1\u8F93\u51FA\u65F6\u81EA\u52A8 kill,\u9632\u6B62\u5047\u6B7B_\n_0 = \u5173\u95ED(\u9ED8\u8BA4),\u8303\u56F4 1-120\u3002\u53EF\u88AB `/timeout` \u5728\u5355\u4E2A scope \u8986\u76D6_"
            },
            {
              tag: "input",
              name: "run_idle_timeout_minutes",
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: "plain_text", content: "0" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: "\n**\u7FA4\u91CC\u9700\u8981 @ bot**\n_\u662F(\u9ED8\u8BA4):\u7FA4\u548C\u8BDD\u9898\u7FA4\u91CC,\u4E0D @ bot \u7684\u6D88\u606F\u4E0D\u4F1A\u89E6\u53D1\u56DE\u590D,bot \u4E0D\u63A5\u7FA4\u91CC\u804A\u5929_\n_\u5426:\u4EFB\u4F55\u6D88\u606F\u90FD\u4F1A\u53D1\u7ED9 agent(0.1.21 \u53CA\u66F4\u65E9\u7248\u672C\u7684\u884C\u4E3A)_\n_\u79C1\u804A\u6C38\u8FDC\u4E0D\u9700\u8981 @;`@\u5168\u5458` \u6C38\u8FDC\u4E0D\u54CD\u5E94_"
            },
            {
              tag: "select_static",
              name: "require_mention_in_group",
              initial_option: opts.requireMentionInGroup ? "yes" : "no",
              options: [
                { text: { tag: "plain_text", content: "\u662F(\u9ED8\u8BA4)" }, value: "yes" },
                { text: { tag: "plain_text", content: "\u5426" }, value: "no" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**lark-cli \u8EAB\u4EFD\u7B56\u7565**\n_\u53EA\u5141\u8BB8\u5E94\u7528\u8EAB\u4EFD:\u4F7F\u7528 bot/app \u80FD\u529B,\u4E0D\u8BBF\u95EE\u4E2A\u4EBA\u8D44\u6E90_\n_\u5141\u8BB8\u7528\u6237\u8EAB\u4EFD:\u4FDD\u7559\u5E94\u7528\u8EAB\u4EFD,\u5E76\u5141\u8BB8\u5DF2\u6388\u6743\u7528\u6237\u8BBF\u95EE\u4E2A\u4EBA\u65E5\u5386\u3001\u90AE\u7BB1\u3001\u4E91\u76D8\u7B49\u8D44\u6E90_"
            },
            {
              tag: "select_static",
              name: "lark_cli_identity",
              initial_option: opts.larkCliIdentity,
              options: [
                { text: { tag: "plain_text", content: "\u53EA\u5141\u8BB8\u5E94\u7528\u8EAB\u4EFD" }, value: "bot-only" },
                { text: { tag: "plain_text", content: "\u5141\u8BB8\u7528\u6237\u8EAB\u4EFD" }, value: "user-default" }
              ]
            },
            { tag: "hr" },
            collapsedAccessPanel("\u{1F512} **\u8BBF\u95EE\u63A7\u5236**\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09", accessElements),
            {
              tag: "column_set",
              flex_mode: "flow",
              horizontal_spacing: "small",
              columns: [
                {
                  tag: "column",
                  width: "auto",
                  elements: [
                    {
                      tag: "button",
                      name: "submit_btn",
                      text: { tag: "plain_text", content: "\u63D0\u4EA4" },
                      type: "primary",
                      form_action_type: "submit",
                      behaviors: [{ type: "callback", value: { cmd: "config.submit" } }]
                    }
                  ]
                },
                {
                  tag: "column",
                  width: "auto",
                  elements: [
                    {
                      tag: "button",
                      name: "cancel_btn",
                      text: { tag: "plain_text", content: "\u53D6\u6D88" },
                      behaviors: [{ type: "callback", value: { cmd: "config.cancel" } }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}
function configSavedCard(opts) {
  const replyLabel = opts.messageReply === "card" ? "\u4EA4\u4E92\u5361\u7247" : opts.messageReply === "markdown" ? "\u6D88\u606F\u5361\u7247" : "\u7EAF\u6587\u672C";
  const presentationLabel = opts.presentationMode === "debug" ? "\u8C03\u8BD5" : opts.presentationMode === "progress" ? "\u8FDB\u5EA6" : "\u6E05\u723D";
  const summarize2 = (list) => list.length === 0 ? "_(\u7A7A)_" : `${list.length} \u9879`;
  const cotLabel = cotMessagesLabel(opts.cotMessages);
  return {
    schema: "2.0",
    config: { summary: { content: "\u504F\u597D\u5DF2\u4FDD\u5B58" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `\u2705 **\u504F\u597D\u5DF2\u4FDD\u5B58**

**\u6D88\u606F\u56DE\u590D\u65B9\u5F0F**:${replyLabel}
**\u8F93\u51FA\u6A21\u5F0F**:\`${presentationLabel}\`
**COT \u8FC7\u7A0B\u6D88\u606F**:\`${cotLabel}\`
**\u5E76\u53D1\u4E0A\u9650**:\`${opts.maxConcurrentRuns}\`
**run \u63A2\u6D3B**:\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} \u5206\u949F` : "\u5173\u95ED"}\`
**\u7FA4\u91CC\u9700\u8981 @ bot**:\`${opts.requireMentionInGroup ? "\u662F" : "\u5426"}\`

**lark-cli \u8EAB\u4EFD\u7B56\u7565**:\`${opts.larkCliIdentity === "user-default" ? "\u5141\u8BB8\u7528\u6237\u8EAB\u4EFD" : "\u53EA\u5141\u8BB8\u5E94\u7528\u8EAB\u4EFD"}\`

\u{1F512} **\u8BBF\u95EE\u63A7\u5236**
**\u5141\u8BB8\u79C1\u804A\u7684\u7528\u6237**:${summarize2(opts.allowedUsers)}
**\u5141\u8BB8\u54CD\u5E94\u7684\u7FA4**:${summarize2(opts.allowedChats)}
**\u7BA1\u7406\u5458**:${summarize2(opts.admins)}

\u4E0B\u6761\u6D88\u606F\u5F00\u59CB\u751F\u6548\u3002`
        }
      ]
    }
  };
}
function cotMessagesLabel(value) {
  if (value === "brief") return "\u7B80\u7565";
  if (value === "detailed") return "\u8BE6\u7EC6";
  return "\u5173\u95ED";
}
function groupMsgScopeGrantCard(url, expireMins) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u9700\u8981\u8865\u6388\u6743" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `\u26A0\uFE0F **\u300C\u7FA4\u91CC\u4E0D\u9700\u8981 @ bot\u300D\u8FD8\u5DEE\u4E00\u4E2A\u6743\u9650**

\u4F60\u5DF2\u5F00\u542F\u300C\u4E0D @ bot \u4E5F\u56DE\u590D\u300D\uFF0C\u4F46\u5F53\u524D\u5E94\u7528\u6CA1\u6709 **\u83B7\u53D6\u7FA4\u7EC4\u4E2D\u6240\u6709\u6D88\u606F**\uFF08\`im:message.group_msg\`\uFF09\u6743\u9650\u3002\u6CA1\u6709\u5B83\uFF0C\u98DE\u4E66\u4E0D\u4F1A\u628A\u7FA4\u91CC\u975E @ \u7684\u6D88\u606F\u63A8\u7ED9 bot\uFF0C\u6240\u4EE5\u8FD9\u4E2A\u8BBE\u7F6E\u6682\u65F6\u4E0D\u751F\u6548\u3002

**\u70B9\u4E0B\u9762\u7684\u94FE\u63A5\u8865\u6388\u6743**\uFF08\u7EA6 ${expireMins} \u5206\u949F\u5185\u6709\u6548\uFF09\uFF1A
[\u{1F517} \u70B9\u6B64\u4E00\u952E\u6388\u6743](${url})

_\u626B\u7801/\u70B9\u51FB\u540E\u4F1A\u8FDB\u5165\u786E\u8BA4\u9875\uFF0C\u65B0\u6743\u9650\u5DF2\u9884\u586B\u597D\uFF0C\u786E\u8BA4\u5373\u53EF\u3002\u6388\u6743\u6210\u529F\u540E\uFF0C\u7FA4\u91CC\u65B0\u6D88\u606F\u5F00\u59CB\u81EA\u52A8\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002_
_\u82E5\u94FE\u63A5\u6253\u4E0D\u5F00\uFF0C\u53EF\u590D\u5236\uFF1A_
\`${url}\`

_\u6388\u6743\u540E\u82E5\u7FA4\u91CC\u4ECD\u6536\u4E0D\u5230\u975E @ \u6D88\u606F\uFF0C\u53D1 \`/reconnect\` \u91CD\u8FDE\u4E00\u6B21\u5373\u53EF\u3002_`
        }
      ]
    }
  };
}
function groupMsgScopeGrantedCard() {
  return {
    schema: "2.0",
    config: { summary: { content: "\u6388\u6743\u6210\u529F" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "\u2705 **\u6388\u6743\u6210\u529F**\n\n`im:message.group_msg` \u6743\u9650\u5DF2\u751F\u6548\uFF0C\u7FA4\u91CC\u975E @ bot \u7684\u6D88\u606F\u4ECE\u73B0\u5728\u5F00\u59CB\u4F1A\u89E6\u53D1\u56DE\u590D\u3002\n\n_\u82E5\u4ECD\u672A\u751F\u6548\uFF0C\u53D1 `/reconnect` \u91CD\u8FDE\u4E00\u6B21\u3002_"
        }
      ]
    }
  };
}
function configCancelledCard() {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5DF2\u53D6\u6D88" } },
    body: {
      elements: [{ tag: "markdown", content: "\u5DF2\u53D6\u6D88,\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\u3002" }]
    }
  };
}
function configFailedCard(reason) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u4FDD\u5B58\u5931\u8D25" } },
    body: {
      elements: [{ tag: "markdown", content: `\u4FDD\u5B58\u5931\u8D25\uFF1A${reason}` }]
    }
  };
}

// src/bot/app-scope.ts
var GROUP_MSG_SCOPE = "im:message.group_msg";
async function fetchGrantedScopes(channel, appId) {
  try {
    const res = await channel.rawClient.application.application.get({
      params: { lang: "zh_cn", user_id_type: "open_id" },
      path: { app_id: appId }
    });
    const scopes = res.data?.app?.scopes ?? [];
    return new Set(scopes.map((s) => s.scope));
  } catch (err) {
    log.warn("app-scope", "fetch-failed", {
      err: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
async function hasGroupMsgScope(channel, appId) {
  const scopes = await fetchGrantedScopes(channel, appId);
  if (scopes === null) return null;
  return scopes.has(GROUP_MSG_SCOPE);
}

// src/card/managed.ts
var byMessageId = /* @__PURE__ */ new Map();
async function sendManagedCard(channel, recipientId, card, opts = {}) {
  const { cardId } = await channel.createCard(card);
  const sendOpts = opts.replyTo ? { replyTo: opts.replyTo, ...opts.replyInThread ? { replyInThread: true } : {} } : void 0;
  let messageId;
  try {
    ({ messageId } = await channel.send(recipientId, { cardId }, sendOpts));
  } catch (err) {
    log.warn("card", "managed-send-raw-fallback", {
      err: err instanceof Error ? err.message : String(err),
      replyTo: opts.replyTo,
      replyInThread: opts.replyInThread === true
    });
    ({ messageId } = await channel.send(recipientId, { card }, sendOpts));
    byMessageId.set(messageId, { kind: "raw-card", sequence: 0 });
    return { messageId, cardId };
  }
  byMessageId.set(messageId, { kind: "card-id", cardId, sequence: 0 });
  return { messageId, cardId };
}
async function updateManagedCard(channel, messageId, card) {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    if (entry.kind === "card-id") {
      await channel.updateCardById(entry.cardId, card, entry.sequence);
    } else {
      await channel.updateCard(messageId, card);
    }
  } catch (err) {
    log.fail("card", err, {
      step: "managed-update",
      kind: entry.kind,
      cardId: entry.cardId,
      seq: entry.sequence
    });
    throw err;
  }
}
function forgetManagedCard(messageId) {
  byMessageId.delete(messageId);
}

// src/card/templates.ts
function button(spec) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: spec.text },
    type: spec.style ?? "default",
    value: spec.value
  };
}
function divMd(content) {
  return { tag: "div", text: { tag: "lark_md", content } };
}
function actions(buttons) {
  return { tag: "action", actions: buttons.map(button) };
}
var HR = { tag: "hr" };
function shell(title, elements) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: title } },
    elements
  };
}
function workspacesCard(current, named) {
  const entries = Object.entries(named);
  const elements = [];
  elements.push(divMd(`\u5F53\u524D cwd\uFF1A\`${escapeCode(current ?? "(\u672A\u8BBE\u7F6E)")}\``));
  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd("\u6682\u65E0\u547D\u540D\u5DE5\u4F5C\u76EE\u5F55\u3002"));
    elements.push(
      divMd("\u{1F4A1} \u53D1\u9001 `/ws save <name>` \u628A\u5F53\u524D cwd \u5B58\u4E3A\u547D\u540D\u5DE5\u4F5C\u76EE\u5F55")
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? "  \u2190 \u5F53\u524D" : "";
      elements.push(divMd(`**${escapeMd(name)}** \u2192 \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: "\u5207\u6362\u5230\u6B64\u5904", value: { cmd: "ws.use", name }, style: "primary" },
          { text: "\u5220\u9664", value: { cmd: "ws.remove", name }, style: "danger" }
        ])
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }
  return shell("\u{1F4C2} \u5DE5\u4F5C\u76EE\u5F55", elements);
}
function statusCard(info) {
  const sessionLine = info.sessionId ? `\`${info.sessionId.slice(0, 8)}\u2026\`${info.sessionStale ? " \u26A0\uFE0F \u65E7 cwd\uFF0C\u4E0B\u4E00\u6761\u4F1A\u65B0\u5EFA" : ""}` : info.emptySessionText ?? "(\u65E0)";
  const scopeLine = info.chatMode === "topic" ? `\`${escapeCode(info.scope)}\` _\uFF08\u8BDD\u9898\u72EC\u7ACB session\uFF09_` : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : "(\u672A\u8BBE\u7F6E)";
  const queueLine = info.queue ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting` : "unknown";
  const lines = [
    `\u{1F9ED} **scope**: ${scopeLine}`,
    `\u{1F9E9} **profile**: ${escapeMd(info.profileName)}`,
    `\u{1F4C1} **cwd**: ${cwdLine}`,
    `\u{1F517} **session**: ${sessionLine}`,
    `\u{1F916} **agent**: ${escapeMd(info.agentName)}`,
    `\u{1F6E1} **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...info.larkCliStatus ? [`\u{1F510} **lark-cli**: ${info.larkCliStatus}`] : [],
    `\u{1F3C3} **active run**: ${info.activeRun ? "yes" : "no"}`,
    ...info.activeScopes && info.activeScopes.length > 0 ? [
      `\u{1F3C3} **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(", ")}`
    ] : [],
    ...info.activeCommentScopes && info.activeCommentScopes.length > 0 ? [
      `\u{1F4DD} **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(", ")}`
    ] : [],
    `\u{1F6A6} **queue**: ${queueLine}`,
    `\u{1F464} **owner API**: ${escapeMd(info.ownerState)}`
  ];
  return shell("\u{1F4CA} \u5F53\u524D\u72B6\u6001", [
    divMd(lines.join("\n")),
    HR,
    actions([
      { text: "\u{1F195} \u65B0\u4F1A\u8BDD", value: { cmd: "new" }, style: "primary" },
      { text: "\u{1F501} \u6062\u590D\u4F1A\u8BDD", value: { cmd: "resume" } },
      { text: "\u{1F4C2} \u5DE5\u4F5C\u76EE\u5F55", value: { cmd: "ws.list" } },
      { text: "\u{1F4A1} \u5E2E\u52A9", value: { cmd: "help" } }
    ])
  ]);
}
function resumeCard(cwd, entries) {
  const elements = [];
  elements.push(divMd(`\u5F53\u524D cwd\uFF1A\`${escapeCode(cwd)}\``));
  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd("\u6B64 cwd \u4E0B\u6CA1\u6709\u5386\u53F2\u4F1A\u8BDD\u3002"));
    return shell("\u{1F501} \u6062\u590D\u5386\u53F2\u4F1A\u8BDD", elements);
  }
  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? "  \u2190 \u5F53\u524D" : "";
    const detail = e.detail ?? `${e.lineCount ?? 0} \u6761`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}
\`${displayId.slice(0, 8)}\u2026\` \xB7 ${e.relTime} \xB7 ${escapeMd(detail)}`
      )
    );
    elements.push(
      actions([
        {
          text: e.current ? "\u5DF2\u662F\u5F53\u524D\u4F1A\u8BDD" : "\u25B8 \u6062\u590D\u6B64\u4F1A\u8BDD",
          value: { cmd: "resume.use", arg: e.sessionId },
          style: e.current ? "default" : "primary"
        }
      ])
    );
    if (i < entries.length - 1) elements.push(HR);
  });
  return shell("\u{1F501} \u6062\u590D\u5386\u53F2\u4F1A\u8BDD", elements);
}
function helpCard(agentName = "Agent") {
  const escapedAgentName = escapeMd(agentName);
  return shell("\u{1F4A1} \u4F7F\u7528\u5E2E\u52A9", [
    divMd(
      [
        "**\u547D\u4EE4\u5217\u8868**",
        "",
        "- `/new` `/reset` \u2014 \u6E05\u7A7A\u5F53\u524D chat \u7684\u4F1A\u8BDD",
        "- `/new chat [name]` \u2014 \u65B0\u5EFA\u7FA4+\u65B0\u4F1A\u8BDD\uFF0C\u81EA\u52A8\u62C9\u4F60\u8FDB\u7FA4",
        "- `/resume [N]` \u2014 \u5217\u51FA\u5E76\u6062\u590D\u5386\u53F2\u4F1A\u8BDD\uFF08\u6700\u591A N \u6761\uFF09",
        "- `/cd <path>` \u2014 \u5207\u6362\u5DE5\u4F5C\u76EE\u5F55\uFF08\u4F1A\u91CD\u7F6E session\uFF09",
        "- `/ws list|save <name>|use <name>|remove <name>` \u2014 \u5DE5\u4F5C\u76EE\u5F55",
        "- `/account` \u2014 \u67E5\u770B\u5F53\u524D\u5E94\u7528\uFF1B`/account change` \u6362 appId/secret \u5E76\u91CD\u8FDE",
        "- `/config` \u2014 \u8C03\u6574\u504F\u597D\u3001\u8BBF\u95EE\u63A7\u5236\u548C lark-cli \u8EAB\u4EFD\u7B56\u7565",
        "- `/status` \u2014 \u5F53\u524D\u72B6\u6001",
        "- `/stop` \u2014 \u7ED3\u675F\u5F53\u524D\u6B63\u5728\u8DD1\u7684\u4EFB\u52A1\uFF08\u4E5F\u53EF\u70B9\u5361\u7247\u5E95\u90E8 \u23F9 \u7EC8\u6B62 \u6309\u94AE\uFF09",
        "- `/stop comment:<scopeHash>` \u2014 \u7BA1\u7406\u5458\u505C\u6B62\u4E91\u6587\u6863\u8BC4\u8BBA\u4EFB\u52A1",
        "- `/timeout [N|off|default]` \u2014 \u5F53\u524D session \u7684\u63A2\u6D3B\u5206\u949F\u6570,`/config` \u6539\u5168\u5C40\u9ED8\u8BA4",
        "- `/timeout comment:<scopeHash> N` \u2014 \u7BA1\u7406\u5458\u8BBE\u7F6E\u4E91\u6587\u6863\u8BC4\u8BBA\u4EFB\u52A1\u63A2\u6D3B",
        "- `/ps` \u2014 \u5217\u51FA\u672C\u673A\u6240\u6709 bot,\u6807\u8BC6\u5F53\u524D\u6B63\u5728\u56DE\u590D\u7684\u90A3\u4E2A",
        "- `/exit <id|#>` \u2014 \u5173\u6389\u6307\u5B9A bot(\u7528 `/ps` \u770B id/\u5E8F\u53F7)",
        "- `/reconnect` \u2014 \u5F3A\u5236\u91CD\u8FDE WebSocket(\u7F51\u7EDC\u6296\u52A8\u540E bot \u6CA1\u53CD\u5E94\u65F6\u7528)",
        `- \`/doctor [\u63CF\u8FF0]\` \u2014 \u628A\u65E5\u5FD7\u548C\u63CF\u8FF0\u4EA4\u7ED9 ${escapedAgentName} \u81EA\u52A9\u8BCA\u65AD`,
        "- `/help` \u2014 \u672C\u5E2E\u52A9",
        "",
        `\u5176\u4ED6\u5185\u5BB9\u76F4\u63A5\u4EA4\u7ED9 ${escapedAgentName}\u3002`
      ].join("\n")
    ),
    HR,
    actions([
      { text: "\u{1F4CA} \u72B6\u6001", value: { cmd: "status" }, style: "primary" },
      { text: "\u{1F501} \u6062\u590D\u4F1A\u8BDD", value: { cmd: "resume" } },
      { text: "\u{1F4C2} \u5DE5\u4F5C\u76EE\u5F55", value: { cmd: "ws.list" } },
      { text: "\u{1F195} \u65B0\u4F1A\u8BDD", value: { cmd: "new" } }
    ])
  ]);
}
function escapeMd(s) {
  return s.replace(/([*_`\\])/g, "\\$1");
}
function escapeCode(s) {
  return s.replace(/`/g, "'");
}

// src/policy/fingerprint.ts
import { createHash } from "crypto";

// src/session/jcs.ts
function canonicalizeJcs(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JCS cannot canonicalize non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcs).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value;
    const entries = Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`JCS cannot canonicalize ${typeof value}`);
}

// src/policy/fingerprint.ts
function policyFingerprint(input) {
  return digestCanonical({
    version: 2,
    cwdRealpath: input.cwdRealpath,
    sandbox: input.sandbox,
    accessPolicyDigest: input.accessPolicyDigest,
    resourceScopeDigest: input.resourceScopeDigest,
    attachmentPolicyShapeDigest: input.attachmentPolicyShapeDigest,
    codexHome: input.codexHome ?? null,
    inheritCodexHome: input.inheritCodexHome
  });
}
function accessPolicyDigest(access3) {
  return digestCanonical({
    admins: [...access3.admins].sort(),
    allowedChats: [...access3.allowedChats].sort(),
    allowedUsers: [...access3.allowedUsers].sort(),
    requireMentionInGroup: access3.requireMentionInGroup
  });
}
function resourceScopeDigest(input) {
  return digestCanonical({
    source: input.source,
    chatId: input.chatId ?? null,
    threadId: input.threadId ?? null,
    commentScopeId: input.commentScopeId ?? null,
    resourceBindings: [...input.resourceBindings ?? []].sort()
  });
}
function attachmentPolicyConfigDigest(input) {
  return digestCanonical({
    maxCount: input.maxCount,
    maxBytes: input.maxBytes,
    maxFileBytes: input.maxFileBytes,
    imageMaxBytes: input.imageMaxBytes
  });
}
function digestCanonical(value) {
  return createHash("sha256").update(canonicalizeJcs(value)).digest().subarray(0, 16).toString("base64url");
}

// src/policy/access.ts
function isCreator(controls, senderId) {
  if (controls.ownerRefreshState === "unknown") return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}
function canUseDm(profile2, controls, senderId) {
  if (isCreator(controls, senderId)) return allow("owner");
  if (profile2.access.allowedUsers.includes(senderId)) return allow("allowed-user");
  if (profile2.access.admins.includes(senderId)) return allow("allowed-admin");
  return deny("denied-user");
}
function canUseGroup(profile2, controls, chatId, senderId) {
  if (isCreator(controls, senderId)) return allow("owner");
  if (profile2.access.admins.includes(senderId)) return allow("allowed-admin");
  if (profile2.access.allowedChats.includes(chatId)) return allow("allowed-chat");
  return deny("denied-chat");
}
function canRunAdminCommand(profile2, controls, senderId) {
  if (isCreator(controls, senderId)) return allow("owner");
  if (profile2.access.admins.includes(senderId)) return allow("allowed-admin");
  return deny("denied-admin");
}
function allow(reason) {
  return { ok: true, reason };
}
function deny(reason) {
  return { ok: false, reason };
}

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
    const truncated = truncate2(tool.output, OUTPUT_MAX);
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
${truncate2(cmd, BODY_FIELD_MAX)}
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
      return str("query") ? `**Query** \`${truncate2(str("query"), BODY_FIELD_MAX)}\`` : "";
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
function shortenPath(p3) {
  return p3;
}
function truncate2(s, max) {
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
    body: truncate3(content, REASONING_MAX)
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
function truncate3(s, max) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
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
function markIdleTimeout(state, minutes) {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "idle_timeout",
    footer: null,
    idleTimeoutMinutes: minutes
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

// src/session/history.ts
import { createReadStream } from "fs";
import { readdir as readdir4, stat as stat6 } from "fs/promises";
import { homedir as homedir5 } from "os";
import { join as join17 } from "path";
import { createInterface as createInterface5 } from "readline";

// src/session/preview.ts
var DEFAULT_PREVIEW_MAX_CHARS = 80;
function normalizeSessionPreview(input, maxChars = DEFAULT_PREVIEW_MAX_CHARS) {
  const text = extractBridgeUserInput(input) ?? input;
  return truncatePreview(text.replace(/\s+/g, " ").trim(), maxChars);
}
function extractBridgeUserInput(input) {
  const section = readPromptSection(input, "user_input");
  if (!section) return void 0;
  const parsed = parseJsonObject2(section);
  const text = typeof parsed?.text === "string" ? parsed.text : void 0;
  return text?.trim() ? text : void 0;
}
function readPromptSection(input, tag) {
  const match = input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return match?.[1];
}
function parseJsonObject2(input) {
  try {
    const value = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function truncatePreview(input, maxChars) {
  if (maxChars <= 0) return "";
  const chars = Array.from(input);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : input;
}

// src/session/history.ts
function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
function claudeProjectDir(cwd) {
  return join17(homedir5(), ".claude", "projects", encodeCwd(cwd));
}
async function listRecentSessions(cwd, limit = 5) {
  const dir = claudeProjectDir(cwd);
  let files;
  try {
    files = await readdir4(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const jsonls = files.filter((f) => f.endsWith(".jsonl"));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join17(dir, f);
      try {
        const st = await stat6(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sorted = withStats.filter((x) => x !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, "");
      const { preview: preview2, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview: preview2, lineCount };
    })
  );
}
async function summarize(path) {
  const stream2 = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface5({ input: stream2 });
  let preview2 = "";
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview2 && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user" && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview2 = normalizeSessionPreview(text);
          }
        } catch {
        }
      }
      if (lineCount > 2e4) break;
    }
  } finally {
    rl.close();
    stream2.destroy();
  }
  return { preview: preview2 || "(\u7A7A\u4F1A\u8BDD)", lineCount };
}
function extractUserText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }
  return "";
}
function formatRelTime(mtime) {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 6e4);
  if (min < 1) return "\u521A\u521A";
  if (min < 60) return `${min} \u5206\u949F\u524D`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} \u5C0F\u65F6\u524D`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "\u6628\u5929";
  if (day < 30) return `${day} \u5929\u524D`;
  const mo = Math.floor(day / 30);
  return `${mo} \u4E2A\u6708\u524D`;
}

// src/session/codex-history.ts
import { createInterface as createInterface6 } from "readline";
import { join as join18 } from "path";
var CodexHistoryError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodexHistoryError";
    this.code = code;
  }
};
var DEFAULT_HISTORY_TIMEOUT_MS = 5e3;
var DEFAULT_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown"
];
async function listCodexThreadHistory(options) {
  const child = spawnCodexAppServer(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const stderrChunks = [];
  let settled = false;
  const result = await new Promise((resolve2, reject4) => {
    const rl = createInterface6({ input: child.stdout, crlfDelay: Infinity });
    let timer;
    const fail = (err) => {
      if (settled) return;
      reject4(
        err instanceof CodexHistoryError ? err : new CodexHistoryError("spawn-failed", errorMessage3(err))
      );
      cleanup({ kill: true });
    };
    const cleanup = (options2) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener("error", fail);
      child.stdin.removeListener("error", fail);
      child.stderr.removeAllListeners("data");
      if (options2.kill && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    timer = setTimeout(() => {
      reject4(new CodexHistoryError("timeout", `codex history query timed out after ${timeoutMs}ms`));
      cleanup({ kill: true });
    }, timeoutMs);
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const response = recordValue2(msg);
      if (!response || response.id !== 2) return;
      if (response.error) {
        const err = recordValue2(response.error);
        reject4(
          new CodexHistoryError(
            "app-server-error",
            typeof err?.message === "string" ? err.message : "codex app-server rejected history query"
          )
        );
        cleanup({ kill: true });
        return;
      }
      const parsed = parseThreadListResponse(response.result);
      if (!parsed.ok) {
        reject4(parsed.error);
        cleanup({ kill: true });
        return;
      }
      resolve2(parsed.entries);
      cleanup({ kill: true });
    });
    child.once("exit", (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject4(
        new CodexHistoryError(
          "spawn-failed",
          `codex app-server exited before history response: ${code ?? "signal"}${stderr ? `: ${stderr}` : ""}`
        )
      );
      cleanup({ kill: true });
    });
    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}
${JSON.stringify(listRequest(options))}
`,
        "utf8",
        (err) => {
          if (err) fail(err);
        }
      );
    } catch (err) {
      fail(err);
    }
  });
  await waitForChildExit(child, 250);
  return result;
}
function spawnCodexAppServer(options) {
  const envOverrides = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join18(options.profileStateDir, "codex-home");
  }
  return spawnProcess(options.binary, ["app-server", "--listen", "stdio://"], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ["pipe", "pipe", "pipe"]
  });
}
function initializeRequest() {
  return {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "lark-channel-bridge",
        title: "Lark Channel Bridge",
        version: "0.2.3"
      },
      capabilities: null
    }
  };
}
function listRequest(options) {
  return {
    method: "thread/list",
    id: 2,
    params: {
      limit: options.limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      cwd: options.cwd,
      useStateDbOnly: options.useStateDbOnly ?? true,
      sourceKinds: [...options.sourceKinds ?? DEFAULT_SOURCE_KINDS]
    }
  };
}
function parseThreadListResponse(input) {
  const raw = recordValue2(input);
  if (!raw || !Array.isArray(raw.data)) {
    return {
      ok: false,
      error: new CodexHistoryError("malformed-response", "codex app-server returned malformed thread/list response")
    };
  }
  return {
    ok: true,
    entries: raw.data.map(normalizeThread).filter((entry) => Boolean(entry))
  };
}
function normalizeThread(input) {
  const raw = recordValue2(input);
  if (!raw) return void 0;
  const threadId = stringValue2(raw.id);
  const cwd = stringValue2(raw.cwd);
  if (!threadId || !cwd) return void 0;
  const createdAt = numberValue2(raw.createdAt);
  const updatedAt = numberValue2(raw.updatedAt);
  return {
    threadId,
    ...stringValue2(raw.sessionId) ? { sessionId: stringValue2(raw.sessionId) } : {},
    preview: normalizeSessionPreview(stringValue2(raw.preview) ?? "") || "(\u7A7A\u4F1A\u8BDD)",
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1e3),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1e3),
    source: sourceValue(raw.source),
    ...stringValue2(raw.name) ? { name: stringValue2(raw.name) } : {}
  };
}
async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve2) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      resolve2();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve2();
    });
  });
}
function sourceValue(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") return JSON.stringify(input);
  return "unknown";
}
function stringValue2(input) {
  return typeof input === "string" ? input : void 0;
}
function numberValue2(input) {
  return typeof input === "number" && Number.isFinite(input) ? input : void 0;
}
function recordValue2(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : void 0;
}
function errorMessage3(err) {
  return err instanceof Error ? err.message : String(err);
}

// src/policy/run-policy.ts
var DEFAULT_TTL_MS = 5 * 60 * 1e3;
function evaluateRunPolicy(input) {
  if (!input.access.ok) {
    return reject2("access-denied", "\u5F53\u524D\u7528\u6237\u65E0\u6743\u53D1\u8D77\u8FD0\u884C\u3002");
  }
  if (input.scope.resourceBindings?.some((binding) => binding.kind === "folder" && !binding.verified)) {
    return reject2("folder-allowlist-unverified", "\u6682\u4E0D\u652F\u6301 folder allowlist\uFF0C\u5DF2\u62D2\u7EDD\u8FD0\u884C\u3002");
  }
  if (input.attachments.some(
    (attachment) => attachment.requiredness === "required" && attachment.decision !== "accepted"
  )) {
    return reject2("required-attachment-rejected", "\u5FC5\u9700\u9644\u4EF6\u672A\u901A\u8FC7\u6821\u9A8C\uFF0C\u5DF2\u62D2\u7EDD\u8FD0\u884C\u3002");
  }
  const accessMode = clampAccess(
    input.profileConfig.permissions.defaultAccess,
    input.profileConfig.permissions.maxAccess,
    input.capability.permissions.maxAccess
  );
  const sandbox = accessToCodexSandbox(accessMode);
  const permissionMode = accessToClaudePermissionMode(
    accessMode,
    input.profileConfig.permissions
  );
  const resourceDigest = resourceScopeDigest({
    source: input.scope.source,
    chatId: input.scope.chatId,
    threadId: input.scope.threadId,
    commentScopeId: input.scope.commentScopeId,
    resourceBindings: input.scope.resourceBindings?.map((binding) => binding.id)
  });
  const attachmentDigest = attachmentPolicyConfigDigest(input.profileConfig.attachments);
  const accessDigest = input.scope.source === "comment" && input.access.reason === "comment-mention" ? "comment-mention" : accessPolicyDigest(input.profileConfig.access);
  return {
    ok: true,
    prompt: input.prompt,
    requestedCwd: input.requestedCwd,
    cwdRealpath: input.cwdRealpath,
    accessMode,
    sandbox,
    permissionMode,
    access: input.access,
    attachments: input.attachments,
    expiresAt: input.now + (input.ttlMs ?? DEFAULT_TTL_MS),
    policyFingerprint: policyFingerprint({
      cwdRealpath: input.cwdRealpath,
      sandbox,
      accessPolicyDigest: accessDigest,
      resourceScopeDigest: resourceDigest,
      attachmentPolicyShapeDigest: attachmentDigest,
      codexHome: input.codexHome,
      inheritCodexHome: input.inheritCodexHome ?? false
    })
  };
}
function reject2(code, userVisible) {
  return {
    ok: false,
    rejectReason: {
      code,
      userVisible
    }
  };
}

// src/bot/group.ts
async function createBoundChat(opts) {
  const { channel, name, inviteOpenId, description } = opts;
  const { chatId } = await channel.createChat({
    name,
    description,
    inviteUserIds: [inviteOpenId],
    userIdType: "open_id"
  });
  return { chatId, name };
}
function defaultChatName(agentName = "Agent") {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => `${n}`.padStart(2, "0");
  return `${agentName} \xB7 ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// src/bot/lark-info.ts
async function fetchKnownChats(channel) {
  try {
    const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
    const chats = summaries.map((c) => ({
      id: c.id,
      name: c.name || "(\u65E0\u540D)"
    }));
    log.info("lark-info", "chats-fetched", { count: chats.length });
    return chats;
  } catch (err) {
    log.warn("lark-info", "chats-fetch-failed", {
      err: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/commands/index.ts
var RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1e3;
var resumeCandidates = /* @__PURE__ */ new Map();
var AUDIT_SAFE_COMMAND_REPLY = "\u547D\u4EE4\u5DF2\u5904\u7406\u3002";
var RESUME_APPLIED_REPLY = "\u5DF2\u5B8C\u6210\uFF0C\u8BF7\u7EE7\u7EED\u53D1\u9001\u4E0B\u4E00\u6761\u6D88\u606F\u3002";
var handlers = {
  "/new": handleNew,
  "/reset": handleNew,
  "/cd": handleCd,
  "/ws": handleWs,
  "/resume": handleResume,
  "/status": handleStatus,
  "/help": handleHelp,
  "/account": handleAccount,
  "/config": handleConfig,
  "/stop": handleStop,
  "/timeout": handleTimeout,
  "/ps": handlePs,
  "/exit": handleExit,
  "/doctor": handleDoctor,
  "/reconnect": handleReconnect,
  "/doc": handleDoc,
  "/invite": handleInvite,
  "/remove": handleRemove
};
var ADMIN_COMMANDS = /* @__PURE__ */ new Set([
  "/account",
  "/config",
  "/ps",
  "/exit",
  "/reconnect",
  "/doctor",
  "/cd",
  "/ws",
  "/invite",
  "/remove"
]);
function isAdminCommand(cmd) {
  return ADMIN_COMMANDS.has(cmd.startsWith("/") ? cmd : `/${cmd}`);
}
async function tryHandleCommand(ctx) {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith("/")) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? "";
  const args = parts.slice(1).join(" ");
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    log.info("command", "admin-deny", {
      cmd,
      sender: ctx.msg.senderId.slice(-6)
    });
    await reply(ctx, "\u274C \u6B64\u547D\u4EE4\u4EC5\u7BA1\u7406\u5458\u53EF\u7528\u3002");
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail("command", err, { cmd });
    reportMetric("command_fail", 1, { step: "dispatch" });
  }
  return true;
}
async function runCommandHandler(name, args, ctx) {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    log.info("command", "admin-deny", {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: "card"
    });
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail("command", err, { cmd: name });
    reportMetric("command_fail", 1, { step: "handler" });
  }
  return true;
}
async function reply(ctx, markdown2) {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown: markdown2 }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail("command", err, { step: "reply" });
    reportMetric("command_fail", 1, { step: "reply" });
    if (!isMessageAuditReject(err) || markdown2 === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx)
      );
    } catch (fallbackErr) {
      log.fail("command", fallbackErr, { step: "reply-audit-fallback" });
      reportMetric("command_fail", 1, { step: "reply-audit-fallback" });
    }
  }
}
function commandReplyOptions(ctx) {
  return {
    replyTo: ctx.msg.messageId,
    ...ctx.chatMode === "topic" && ctx.msg.threadId ? { replyInThread: true } : {}
  };
}
function isMessageAuditReject(err) {
  if (!err || typeof err !== "object") return false;
  const record = err;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? "");
  return /not pass the audit/i.test(message);
}
function expandTilde(p3) {
  if (p3 === "~") return homedir6();
  if (p3.startsWith("~/")) return `${homedir6()}${p3.slice(1)}`;
  return p3;
}
function isAbsoluteOrTilde(p3) {
  return isAbsolute2(p3) || p3 === "~" || p3.startsWith("~/");
}
async function handleNew(args, ctx) {
  const trimmed = args.trim();
  if (trimmed === "chat" || trimmed.startsWith("chat ")) {
    const rawName = trimmed === "chat" ? "" : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now()
    });
  }
  ctx.sessions.clear(ctx.scope);
  ctx.contextBudget?.reset(ctx.scope);
  await reply(ctx, wasRunning ? "\u5DF2\u4E2D\u65AD\u5F53\u524D\u4EFB\u52A1\u5E76\u5F00\u59CB\u65B0\u4F1A\u8BDD\u3002" : "\u5DF2\u5F00\u59CB\u65B0\u4F1A\u8BDD\u3002");
}
async function handleNewChat(rawName, ctx) {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);
  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `\u274C \u521B\u5EFA\u7FA4\u5931\u8D25\uFF1A${msg}

\u786E\u8BA4 bot \u5DF2\u5F00\u542F \`im:chat\` \u6743\u9650\u3002`);
    return;
  }
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }
  const welcome = sourceCwd ? `\u{1F389} \u7FA4\u5DF2\u5EFA\u597D\uFF0Ccwd \u7EE7\u627F\u81EA\u539F\u7FA4\uFF1A\`${sourceCwd}\`

@\u6211 + \u4EFB\u610F\u6D88\u606F\u5F00\u59CB\u5BF9\u8BDD\u3002` : "\u{1F389} \u7FA4\u5DF2\u5EFA\u597D\u3002\n\n@\u6211 + \u4EFB\u610F\u6D88\u606F\u5F00\u59CB\u5BF9\u8BDD\u3002";
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn("[new-chat] welcome message failed:", err);
  }
  await reply(
    ctx,
    `\u2713 \u5DF2\u521B\u5EFA\u7FA4 **${created.name}**\uFF0C\u53BB\u65B0\u7FA4\u91CC\u7EE7\u7EED\u3002`
  );
}
async function handleCd(args, ctx) {
  const input = args.trim();
  if (!input) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/cd <\u7EDD\u5BF9\u8DEF\u5F84>` \u6216 `/cd ~/xxx`");
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, "\u8BF7\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216 `~/xxx` \u8868\u793A home \u4E0B\u7684\u5B50\u8DEF\u5F84\u3002");
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  ctx.contextBudget?.reset(ctx.scope);
  await reply(ctx, `\u2713 \u5DF2\u5207\u6362 cwd \u5230 \`${workspace.cwdRealpath}\`
\uFF08session \u5DF2\u91CD\u7F6E\uFF09`);
}
async function handleWs(args, ctx) {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  const name = parts.slice(1).join(" ").trim();
  switch (sub) {
    case "":
    case "list":
      return handleWsList(ctx);
    case "save":
      return handleWsSave(name, ctx);
    case "use":
      return handleWsUse(name, ctx);
    case "remove":
    case "rm":
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, "\u7528\u6CD5\uFF1A`/ws [list|save <name>|use <name>|remove <name>]`");
  }
}
async function handleWsList(ctx) {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
async function handleWsSave(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws save <name>`");
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, "\u5F53\u524D chat \u672A\u8BBE\u7F6E cwd\uFF0C\u5148\u7528 `/cd` \u8BBE\u7F6E\u518D\u4FDD\u5B58\u3002");
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `\u2713 \u5DE5\u4F5C\u76EE\u5F55\u522B\u540D\u5DF2\u4FDD\u5B58\uFF1A\`${name}\` \u2192 ${cwd}`);
}
async function handleWsUse(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws use <name>`");
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `\u672A\u627E\u5230\u5DE5\u4F5C\u76EE\u5F55\u522B\u540D\uFF1A\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  ctx.contextBudget?.reset(ctx.scope);
  await reply(ctx, `\u2713 \u5DF2\u5207\u6362\u5230 \`${name}\` (${workspace.cwdRealpath})
\uFF08session \u5DF2\u91CD\u7F6E\uFF09`);
}
async function handleWsRemove(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws remove <name>`");
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `\u672A\u627E\u5230\u5DE5\u4F5C\u76EE\u5F55\u522B\u540D\uFF1A\`${name}\``);
    return;
  }
  await reply(ctx, `\u2713 \u5DF2\u5220\u9664\u5DE5\u4F5C\u76EE\u5F55\u522B\u540D\uFF1A\`${name}\``);
}
async function handleDoc(args, ctx) {
  void args;
  await reply(ctx, "\u4E91\u6587\u6863\u8BC4\u8BBA\u73B0\u5728\u4E0D\u9700\u8981\u7ED1\u5B9A\u5DE5\u4F5C\u533A\uFF1B\u5728\u652F\u6301\u7684\u6587\u6863\u8BC4\u8BBA\u91CC @bot \u5373\u53EF\u89E6\u53D1\u56DE\u590D\u3002");
}
var WORKSPACE_NAME_SEPARATOR = "";
function scopedWorkspaceName(ctx, name) {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? "owner-unknown",
    ctx.scope,
    name
  ].join(WORKSPACE_NAME_SEPARATOR);
}
function workspaceAliasKeys(ctx, name) {
  return [scopedWorkspaceName(ctx, name), name];
}
function getWorkspaceAlias(ctx, name) {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return void 0;
}
function removeWorkspaceAlias(ctx, name) {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}
function isLegacyWorkspaceAlias(key) {
  return key !== "" && !key.includes(WORKSPACE_NAME_SEPARATOR);
}
function listScopedWorkspaces(ctx) {
  const prefix = scopedWorkspaceName(ctx, "");
  const named = ctx.workspaces.listNamed();
  const scoped = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === void 0) scoped[key] = cwd;
  }
  return scoped;
}
async function handleResume(args, ctx) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1).join(" ").trim();
  if (sub === "use" && rest) {
    return applyResume(rest, ctx);
  }
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;
  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, "\u8BF7\u5148\u4F7F\u7528 /cd <path> \u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u518D\u67E5\u770B\u6216\u6062\u590D\u4F1A\u8BDD\u3002");
    return;
  }
  if (ctx.chatMode !== "p2p") {
    await reply(ctx, "\u7FA4\u804A\u4E2D\u4E0D\u5C55\u793A\u5386\u53F2\u4F1A\u8BDD\u8BE6\u60C5\u3002\u8BF7\u79C1\u804A bot \u4F7F\u7528 `/resume` \u67E5\u770B\u548C\u9009\u62E9\u5386\u53F2\u4F1A\u8BDD\u3002");
    return;
  }
  if (ctx.controls.profileConfig.agentKind === "codex") {
    const identity2 = ctx.sessionCatalogIdentity;
    const entry = ctx.sessionCatalog && identity2 ? ctx.sessionCatalog.activeFor(identity2) : void 0;
    const history = identity2 ? await listCodexResumeHistory(ctx, cwd, limit) : [];
    if (history.length > 0 && identity2) {
      const entries2 = history.map((thread) => {
        const nonce = issueResumeCandidate(identity2, { threadId: thread.threadId });
        return {
          sessionId: nonce,
          preview: thread.name || thread.preview,
          relTime: formatRelTime(thread.updatedAtMs),
          detail: `Codex \xB7 ${thread.source}`,
          current: thread.threadId === entry?.threadId
        };
      });
      const card3 = resumeCard(cwd, entries2);
      await ctx.channel.send(ctx.msg.chatId, { card: card3 }, commandReplyOptions(ctx));
      return;
    }
    if (entry?.threadId && identity2) {
      const nonce = issueResumeCandidate(identity2, { threadId: entry.threadId });
      await reply(
        ctx,
        `\u5F53\u524D Codex thread \u53EF\u6062\u590D\u3002
\u4F7F\u7528 \`/resume use ${nonce}\` \u6062\u590D\uFF0810 \u5206\u949F\u5185\u6709\u6548\uFF09\u3002`
      );
      return;
    }
    const card2 = resumeCard(cwd, []);
    await ctx.channel.send(ctx.msg.chatId, { card: card2 }, commandReplyOptions(ctx));
    return;
  }
  const sessions = await listClaudeResumeHistory(ctx, cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity ? issueResumeCandidate(identity, { sessionId: s.sessionId }) : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
async function applyResume(sessionId, ctx) {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      ctx.activeRuns.interrupt(ctx.scope);
      if (ctx.sessionCatalogIdentity.agentId === "codex") {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: "codex",
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          threadId: resolved.threadId
        });
      } else {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: "claude",
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      ctx.contextBudget?.reset(ctx.scope);
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    if (ctx.sessionCatalogIdentity.agentId === "codex") {
      await reply(ctx, "\u5F53\u524D\u4E0A\u4E0B\u6587\u4E0D\u53EF\u6062\u590D\u8FD9\u4E2A\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u7528 `/resume` \u91CD\u65B0\u751F\u6210\u6062\u590D\u5019\u9009\u3002");
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, "\u5F53\u524D\u4E0A\u4E0B\u6587\u4E0D\u53EF\u6062\u590D\u8FD9\u4E2A\u4F1A\u8BDD\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u5F53\u524D\u5DE5\u4F5C\u533A\u548C\u6743\u9650\u7B56\u7565\u4E0B\u7684\u4F1A\u8BDD\u3002");
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalogIdentity.agentId === "claude") {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    ctx.contextBudget?.reset(ctx.scope);
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }
  if (ctx.controls.profileConfig.agentKind === "codex") {
    await reply(ctx, "\u5F53\u524D\u4E0A\u4E0B\u6587\u6CA1\u6709\u53EF\u6062\u590D\u7684 Codex thread\uFF0C\u8BF7\u5148\u5728\u5F53\u524D\u5DE5\u4F5C\u533A\u5B8C\u6210\u4E00\u6B21\u8FD0\u884C\u3002");
    return;
  }
  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, "\u8BF7\u5148\u4F7F\u7528 /cd <path> \u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u518D\u67E5\u770B\u6216\u6062\u590D\u4F1A\u8BDD\u3002");
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  ctx.contextBudget?.reset(ctx.scope);
  await reply(ctx, RESUME_APPLIED_REPLY);
}
function issueResumeCandidate(identity, target) {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS
  });
  return nonce;
}
function consumeResumeCandidate(nonce, identity) {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return void 0;
  resumeCandidates.delete(nonce);
  if (candidate.scopeId !== identity.scopeId || candidate.agentId !== identity.agentId || candidate.cwdRealpath !== identity.cwdRealpath || candidate.policyFingerprint !== identity.policyFingerprint || identity.agentId === "claude" && !candidate.sessionId || identity.agentId === "codex" && !candidate.threadId) {
    return void 0;
  }
  return candidate;
}
function pruneResumeCandidates(now = Date.now()) {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}
async function listClaudeResumeHistory(ctx, cwd, limit) {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}
async function listCodexResumeHistory(ctx, cwd, limit) {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];
  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...codex.codexHome ? { codexHome: codex.codexHome } : {},
      ...codex.inheritCodexHome !== void 0 ? { inheritCodexHome: codex.inheritCodexHome } : {}
    });
  } catch (err) {
    log.warn("session", "codex-history-failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}
function effectiveWorkspaceCwd(ctx) {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}
function selectedResumeCwd(ctx) {
  return effectiveWorkspaceCwd(ctx);
}
function runtimeAccessStatus(profileConfig) {
  if (profileConfig.agentKind === "claude") {
    return {
      label: "permission",
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions
      )
    };
  }
  return {
    label: "sandbox",
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`
  };
}
async function larkCliStatus(ctx) {
  const appPaths2 = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile11(appPaths2.larkCliTargetConfigFile, "utf8"));
    const app = raw.apps?.find(
      (candidate) => candidate.appId === ctx.controls.profileConfig.accounts.app.id && candidate.brand === ctx.controls.profileConfig.accounts.app.tenant
    );
    if (app?.defaultAs === "auto" && app.strictMode === "off" && hasStructuredLarkCliUserAuth(app.users)) {
      return "user-ready";
    }
  } catch (err) {
    if (err.code !== "ENOENT") return "check-failed";
  }
  if (ctx.controls.profileConfig.larkCli.identityPreset === "user-default" && canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    return "user-missing";
  }
  return "app";
}
async function handleStatus(_args, ctx) {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = ctx.controls.profileConfig.agentKind === "codex";
  const catalogEntry = isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity) : void 0;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isCodex ? "(\u672A\u5EFA\u7ACB)" : void 0,
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith("comment:")),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith("comment:")),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
function formatOwnerState(ctx) {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? "present" : "missing";
  const refreshed = ctx.controls.ownerRefreshedAt ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}` : "";
  return `${state} owner=${owner}${refreshed}`;
}
async function handleStop(args, ctx) {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, "\u274C \u6307\u5B9A scope \u505C\u6B62\u4EFB\u52A1\u4EC5\u7BA1\u7406\u5458\u53EF\u7528\u3002");
    return;
  }
  const scope = targetScope || ctx.scope;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info("command", "stop", {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok
  });
  if (targetScope) {
    await reply(
      ctx,
      ok ? `\u5DF2\u8BF7\u6C42\u505C\u6B62 \`${scope}\`\u3002` : `\u672A\u627E\u5230\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\uFF1A\`${scope}\`\u3002`
    );
  }
}
async function handleTimeout(args, ctx) {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (parsed.targeted && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, "\u274C \u6307\u5B9A scope \u8BBE\u7F6E timeout \u4EC5\u7BA1\u7406\u5458\u53EF\u7528\u3002");
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 6e4) : 0;
  const formatGlobal = () => globalMinutes > 0 ? `${globalMinutes} \u5206\u949F` : "\u672A\u542F\u7528";
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage = "\n\n\u7528\u6CD5:\n- `/timeout 15` \u5F53\u524D session \u8BBE 15 \u5206\u949F\n- `/timeout off` \u5F53\u524D session \u5173\u95ED\u63A2\u6D3B\n- `/timeout default` \u6E05\u9664 session \u8986\u76D6,\u56DE\u9000\u5168\u5C40\n- `/timeout comment:<scopeHash> 15` \u7BA1\u7406\u5458\u8BBE\u7F6E comment scope\n\n_\u6CE8:`/new` \u4F1A\u6E05\u6389\u5F53\u524D session \u7684\u8986\u76D6,\u56DE\u5230\u5168\u5C40_";
    const scopeLabel = parsed.targeted ? ` (${scope})` : "";
    if (scopeMinutes !== void 0) {
      const effective = scopeMinutes > 0 ? `${scopeMinutes} \u5206\u949F` : "\u5DF2\u5173\u95ED\uFF08\u5F53\u524D session\uFF09";
      await reply(ctx, `\u23F1 \u5F53\u524D session${scopeLabel} \u63A2\u6D3B:${effective}
\u5168\u5C40\u9ED8\u8BA4:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `\u23F1 \u5F53\u524D session${scopeLabel} \u63A2\u6D3B:\u8DDF\u968F\u5168\u5C40(${formatGlobal()})${usage}`);
    return;
  }
  if (value === "default") {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info("command", "timeout-clear", { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared ? `\u2705 \u5DF2\u6E05\u9664 session \u8986\u76D6,\u56DE\u9000\u5230\u5168\u5C40(${formatGlobal()})\u3002` : `\u5F53\u524D session \u672C\u6765\u5C31\u6CA1\u8BBE\u8FC7\u8986\u76D6,\u8DDF\u968F\u5168\u5C40(${formatGlobal()})\u3002`
    );
    return;
  }
  if (value === "off" || value === "0") {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info("command", "timeout-off", { scope, targeted: parsed.targeted });
    await reply(ctx, "\u2705 \u5DF2\u5173\u95ED\u5F53\u524D session \u7684\u63A2\u6D3B\u3002");
    return;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, "\u274C \u7528\u6CD5:`/timeout <1-120>` / `/timeout off` / `/timeout default`");
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info("command", "timeout-set", { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `\u2705 \u5F53\u524D session \u63A2\u6D3B\u5DF2\u8BBE\u4E3A ${n} \u5206\u949F\u3002`);
}
function parseTimeoutTarget(input, currentScope) {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (first.startsWith("comment:")) {
    return {
      scope: first,
      value: parts.slice(1).join(" "),
      targeted: true
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false
  };
}
async function handlePs(_args, ctx) {
  const live = readAndPrune();
  log.info("command", "ps", { count: live.length });
  if (live.length === 0) {
    await reply(ctx, "\u5F53\u524D\u6CA1\u6709 bot \u5728\u8FD0\u884C(\u7406\u8BBA\u4E0A\u4E0D\u53EF\u80FD,\u4F60\u6B63\u5728\u8DDF\u5176\u4E2D\u4E4B\u4E00\u5BF9\u8BDD\u2026)");
    return;
  }
  const rows = [
    "| # | ID | Bot | \u542F\u52A8 |",
    "|---|---|---|---|"
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo2(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? " \u2190 \u5F53\u524D\u6B63\u5728\u56DE\u590D" : "";
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `\u{1F9ED} **\u5F53\u524D\u6709 ${live.length} \u4E2A bot \u5728\u8FD0\u884C**`,
    "",
    rows.join("\n"),
    "",
    "\u7528 `/exit <id|#>` \u5173\u6389\u67D0\u4E00\u4E2A;`/exit " + ctx.controls.processId + "` \u5173\u6389\u6B63\u5728\u56DE\u590D\u4F60\u7684\u8FD9\u4E2A bot\u3002"
  ].join("\n");
  await reply(ctx, body);
}
async function handleExit(args, ctx) {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      `\u7528\u6CD5:\`/exit <id|#>\` \u2014\u2014 \`id\` \u662F \`/ps\` \u663E\u793A\u7684\u77ED id,\`#\` \u662F\u5E8F\u53F7\u3002
\u5F53\u524D\u6B63\u5728\u56DE\u590D\u4F60\u7684\u662F \`${ctx.controls.processId}\`\u3002`
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `\u274C \u6CA1\u627E\u5230\u5339\u914D\u7684 bot:\`${target}\`\u3002\u53D1 \`/ps\` \u770B\u53EF\u9009\u76EE\u6807\u3002`);
    return;
  }
  if (entry.id === ctx.controls.processId) {
    log.info("command", "exit-self", { id: entry.id });
    await reply(ctx, `\u{1F44B} \u5373\u5C06\u5173\u95ED\u5F53\u524D bot \`${entry.id}\`,\u518D\u89C1\u3002`);
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {
      });
    })();
    return;
  }
  log.info("command", "exit-other", { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (err) {
    await reply(ctx, `\u274C \u5173\u6389 bot \`${entry.id}\` \u5931\u8D25:${err.message}`);
    return;
  }
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `\u{1F4E8} \u5DF2\u8BF7\u6C42\u5173\u95ED \`${entry.id}\`,\u4F46\u8FD8\u5728\u6536\u5C3E\u3002\u518D\u53D1 \`/ps\` \u590D\u67E5\u4E00\u4E0B\u3002`
    );
  } else {
    await reply(ctx, `\u2713 \u5DF2\u5173\u95ED bot \`${entry.id}\`\u3002`);
  }
}
function formatAgo2(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)}s \u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)}m \u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)}h \u524D`;
  return `${Math.floor(ms / 864e5)}d \u524D`;
}
async function handleReconnect(args, ctx) {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes("--wait");
  log.info("command", "reconnect", { wait });
  await reply(ctx, wait ? "\u23F3 \u5C06\u5728\u5F53\u524D\u8FD0\u884C\u7ED3\u675F\u540E\u91CD\u8FDE\u2026" : "\u23F3 \u6B63\u5728\u505C\u6B62\u5F53\u524D\u8FD0\u884C\u5E76\u91CD\u8FDE\u2026");
  let resumeNewRuns;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns("reconnect-in-progress");
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info("command", "reconnect-ok");
  } catch (err) {
    log.fail("command", err, { step: "reconnect" });
    reportMetric("command_fail", 1, { step: "reconnect" });
    await reply(ctx, `\u274C \u91CD\u8FDE\u5931\u8D25:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}
var DOCTOR_ECHO_PROMPT = "Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK";
var DOCTOR_RATE_LIMIT_MS = 3e4;
var doctorInFlightProfiles = /* @__PURE__ */ new Set();
var doctorLastByOperator = /* @__PURE__ */ new Map();
async function handleDoctor(args, ctx) {
  log.info("command", "doctor", {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode
  });
  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== void 0 && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, "doctor rate limited: \u540C\u4E00\u7528\u6237 30 \u79D2\u5185\u53EA\u80FD\u89E6\u53D1\u4E00\u6B21\u3002");
    return;
  }
  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: "\u672A\u8BBE\u7F6E\u5DE5\u4F5C\u76EE\u5F55\u3002\u5148\u7528 `/cd <path>` \u6216 `/ws use <name>` \u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55\u540E\u518D\u8FD0\u884C agent echo check\u3002",
        echoCheck: "skipped"
      })
    );
    return;
  }
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} \u5DE5\u4F5C\u76EE\u5F55\u4E0D\u53EF\u7528\u65F6\u53EA\u6267\u884C self-check\uFF0C\u4E0D\u542F\u52A8 agent\u3002`,
        echoCheck: "skipped"
      })
    );
    return;
  }
  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: "run executor unavailable"
      })
    );
    return;
  }
  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, "doctor in-flight: \u5F53\u524D profile \u5DF2\u6709\u8BCA\u65AD\u8FD0\u884C\u4E2D\u3002");
    return;
  }
  doctorLastByOperator.set(rateKey, now);
  const capability = ctx.controls.profileConfig.agentKind === "codex" ? codexCapability(ctx.controls.profileConfig) : claudeCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: "im",
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 6e4
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible
      })
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck) => buildDoctorReport(ctx, {
    workspaceCheck: `ok (${workspace.cwdRealpath})`,
    policyCheck: runtimeAccess.label === "sandbox" ? `ok sandbox=${policy.sandbox}` : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
    echoCheck
  });
  const isP2p = ctx.chatMode === "p2p";
  if (!isP2p) {
    await reply(ctx, "\u{1F50D} \u5DF2\u6536\u5230\u8BCA\u65AD\u8BF7\u6C42\uFF0C\u5206\u6790\u7ED3\u679C\u5C06\u79C1\u4FE1\u53D1\u7ED9\u4F60\u3002");
  }
  doctorInFlightProfiles.add(profileKey);
  let execution;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: "doctor",
        stage: "agent-probe"
      }
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === "pool-full") {
      await reply(ctx, doctorReport("pool-full"));
      return;
    }
    log.fail("command", err, { step: "doctor.submit" });
    reportMetric("command_fail", 1, { step: "doctor.submit" });
    await reply(ctx, doctorReport("failed"));
    return;
  }
  try {
    if (isP2p) {
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport("pending"))),
            producer: async (ctrl) => {
              let state = initialState;
              let echoText = "";
              const echoStatus = () => formatDoctorEchoStatus(echoText, state);
              const flush = () => ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                if (evt.type === "system") continue;
                if (evt.type === "usage") {
                  continue;
                }
                if (evt.type === "text") echoText += evt.delta;
                state = reduce(state, evt);
                await flush();
                if (state.terminal !== "running") break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            }
          }
        },
        { replyTo: ctx.msg.messageId }
      );
    } else {
      let state = initialState;
      let echoText = "";
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === "system") continue;
        if (evt.type === "usage") {
          continue;
        }
        if (evt.type === "text") echoText += evt.delta;
        state = reduce(state, evt);
        if (state.terminal !== "running") break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state)))
        )
      });
    }
  } catch (err) {
    log.fail("command", err, { step: "doctor" });
    reportMetric("command_fail", 1, { step: "doctor" });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}
function buildDoctorReport(ctx, opts = {}) {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting` : "unknown";
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access3 = ctx.msg.chatType === "p2p" ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId) : canUseGroup(
    ctx.controls.profileConfig,
    ctx.controls,
    ctx.msg.chatId,
    ctx.msg.senderId
  );
  return [
    "self-check: ok",
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? "(\u672A\u8BBE\u7F6E)"}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? "set" : "missing"}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access3.ok ? "ok" : "denied"} (${access3.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? "available" : "unavailable"}`,
    ...opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : [],
    ...opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : [],
    ...opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []
  ].join("\n");
}
function withDoctorReport(state, report) {
  return {
    ...state,
    blocks: [{ kind: "text", content: report, streaming: false }, ...state.blocks]
  };
}
function formatDoctorEchoStatus(echoText, state) {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}\u2026` : trimmed;
  if (state.terminal === "running") return "pending";
  if (state.terminal === "done") return "empty";
  return state.terminal;
}
async function handleHelp(_args, ctx) {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
async function handleAccount(args, ctx) {
  const sub = args.trim().split(/\s+/)[0] ?? "";
  switch (sub) {
    case "":
      return showCurrent(ctx);
    case "change":
      return showForm(ctx);
    case "submit":
      return submitAccount(ctx);
    case "cancel":
      return cancelAccount(ctx);
    default:
      await reply(ctx, "\u7528\u6CD5\uFF1A`/account` \u6216 `/account change`");
  }
}
async function showCurrent(ctx) {
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}
async function showForm(ctx) {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}
async function cancelAccount(ctx) {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}
var FORM_SETTLE_MS = 1e3;
async function submitAccount(ctx) {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? "").trim();
  const appSecret = String(fv.app_secret ?? "").trim();
  const tenant = fv.tenant === "lark" ? "lark" : "feishu";
  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart2 = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async () => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };
    const finishSuccess = async (card) => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch(
        (err) => console.warn("[account] form update failed:", err)
      );
      forgetManagedCard(formMsgId);
    };
    const finishFailure = async (errorMessage4) => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage4)).catch((err) => console.warn("[account] mark old form failed:", err));
      forgetManagedCard(formMsgId);
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch(
        (err) => console.warn("[account] post retry form failed:", err)
      );
    };
    if (!appId || !appSecret) {
      await finishFailure("App ID \u6216 App Secret \u4E3A\u7A7A");
      return;
    }
    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? "unknown");
      return;
    }
    try {
      const appPaths2 = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths2
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`\u4FDD\u5B58\u51ED\u636E\u5931\u8D25\uFF1A${msg}`);
      return;
    }
    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));
    setTimeout(() => {
      void restart2().catch((err) => {
        console.error("[account] restart failed:", err);
        process.exit(1);
      });
    }, 1500);
  })();
}
async function recallMessage(ctx, messageId) {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn("[recall failed]", err);
  }
}
async function handleInvite(args, ctx) {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  if (tokens.includes("all") && tokens.includes("group")) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added2 = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added2 = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added2 += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list]
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, "\u5F53\u524D bot \u8FD8\u4E0D\u5728\u4EFB\u4F55\u7FA4\u91CC\uFF0C\u6CA1\u6709\u53EF\u52A0\u5165\u7684\u7FA4\u3002");
    } else {
      await reply(ctx, `\u2705 \u5DF2\u628A bot \u6240\u5728\u7684 ${added2} \u4E2A\u7FA4\u52A0\u5165\u54CD\u5E94\u7FA4\u540D\u5355\uFF08\u5171 ${total} \u4E2A\uFF09\u3002`);
    }
    return;
  }
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token));
  if (!kind) {
    await reply(
      ctx,
      "\u7528\u6CD5\uFF1A\n\u2022 `/invite user @\u67D0\u4EBA` \u2014 \u52A0\u5165\u5141\u8BB8\u79C1\u804A\n\u2022 `/invite admin @\u67D0\u4EBA` \u2014 \u52A0\u5165\u7BA1\u7406\u5458\n\u2022 `/invite group` \u2014 \u628A\u5F53\u524D\u7FA4\u52A0\u5165\u54CD\u5E94\u7FA4\u540D\u5355\n\u2022 `/invite all group` \u2014 \u628A bot \u6240\u5728\u7684\u6240\u6709\u7FA4\u4E00\u952E\u52A0\u5165"
    );
    return;
  }
  if (kind === "group") {
    if (ctx.chatMode === "p2p") {
      await reply(ctx, "\u274C `/invite group` \u53EA\u80FD\u5728\u7FA4\u91CC\u53D1\uFF0C\u5728\u79C1\u804A\u91CC\u6CA1\u6709 chat_id \u53EF\u4EE5\u52A0\u3002");
      return;
    }
    const chatId = ctx.msg.chatId;
    let already2 = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already2 = list.has(chatId);
      if (!already2) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list]
      };
    });
    if (already2) {
      await reply(ctx, "\u2705 \u5F53\u524D\u7FA4\u5DF2\u5728\u767D\u540D\u5355\u91CC\uFF0C\u65E0\u9700\u91CD\u590D\u6DFB\u52A0\u3002");
      return;
    }
    await reply(ctx, `\u2705 \u5DF2\u628A\u5F53\u524D\u7FA4\uFF08\`${chatId}\`\uFF09\u52A0\u5165\u54CD\u5E94\u7FA4\u540D\u5355\u3002`);
    return;
  }
  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `\u274C \u6CA1\u68C0\u6D4B\u5230 @ \u7684\u7528\u6237\u3002\u8BF7\u50CF\u8FD9\u6837\u53D1\uFF1A\`/invite ${kind} @\u67D0\u4EBA\`\uFF08\u6CE8\u610F @ \u7528\u6237\u4E0D\u662F @ bot\uFF09\u3002`
    );
    return;
  }
  const listKey = kind === "user" ? "allowedUsers" : "admins";
  const added = [];
  const already = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list]
    };
  });
  const label = kind === "user" ? "\u7528\u6237\u767D\u540D\u5355" : "\u7BA1\u7406\u5458";
  const parts = [];
  if (added.length > 0) parts.push(`\u2705 \u5DF2\u628A ${added.join("\u3001")} \u52A0\u5165${label}\u3002`);
  if (already.length > 0) parts.push(`_${already.join("\u3001")} \u5DF2\u7ECF\u5728${label}\u91CC\uFF0C\u8DF3\u8FC7\u3002_`);
  await reply(ctx, parts.join("\n"));
}
async function handleRemove(args, ctx) {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token));
  if (!kind) {
    await reply(
      ctx,
      "\u7528\u6CD5\uFF1A\n\u2022 `/remove user @\u67D0\u4EBA` \u2014 \u79FB\u51FA\u7528\u6237\u767D\u540D\u5355\n\u2022 `/remove admin @\u67D0\u4EBA` \u2014 \u79FB\u51FA\u7BA1\u7406\u5458\n\u2022 `/remove group` \u2014 \u628A\u5F53\u524D\u7FA4\u79FB\u51FA\u54CD\u5E94\u7FA4\u540D\u5355"
    );
    return;
  }
  if (kind === "group") {
    if (ctx.chatMode === "p2p") {
      await reply(ctx, "`/remove group` \u8BF7\u5728\u8981\u79FB\u9664\u7684\u7FA4\u91CC\u53D1\uFF0C\u79C1\u804A\u91CC\u6CA1\u6709\u53EF\u79FB\u9664\u7684\u7FA4\u3002");
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list]
      };
    });
    if (missing) {
      await reply(ctx, "\u2705 \u5F53\u524D\u7FA4\u672C\u6765\u5C31\u4E0D\u5728\u54CD\u5E94\u540D\u5355\u91CC\uFF0C\u65E0\u9700\u79FB\u9664\u3002");
      return;
    }
    await reply(ctx, "\u2705 \u5DF2\u628A\u5F53\u524D\u7FA4\u79FB\u51FA\u54CD\u5E94\u7FA4\u540D\u5355\u3002");
    return;
  }
  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `\u8BF7 @ \u4E0A\u8981\u79FB\u9664\u7684\u4EBA\uFF0C\u4F8B\u5982\uFF1A\`/remove ${kind} @\u67D0\u4EBA\`\u3002`);
    return;
  }
  const listKey = kind === "user" ? "allowedUsers" : "admins";
  const removed = [];
  const notThere = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list]
    };
  });
  const label = kind === "user" ? "\u7528\u6237\u767D\u540D\u5355" : "\u7BA1\u7406\u5458";
  const parts = [];
  if (removed.length > 0) parts.push(`\u2705 \u5DF2\u628A ${removed.join("\u3001")} \u79FB\u51FA${label}\u3002`);
  if (notThere.length > 0) parts.push(`${notThere.join("\u3001")} \u672C\u6765\u5C31\u4E0D\u5728${label}\u91CC\uFF0C\u65E0\u9700\u79FB\u9664\u3002`);
  await reply(ctx, parts.join("\n"));
}
function mentionTargets(ctx) {
  return (ctx.msg.mentions ?? []).filter((mention) => !mention.isBot && typeof mention.openId === "string" && mention.openId).map((mention) => ({
    openId: mention.openId,
    ...mention.name ? { name: mention.name } : {}
  }));
}
async function saveAccessConfig(ctx, mutate) {
  try {
    return await withConfigFileLock(ctx.controls.configPath, async () => {
      const root = await loadRootConfig(ctx.controls.configPath);
      if (!root) {
        const access4 = mutate(ctx.controls.profileConfig.access);
        ctx.controls.profileConfig = {
          ...ctx.controls.profileConfig,
          access: access4
        };
        ctx.controls.cfg.preferences = {
          ...ctx.controls.cfg.preferences ?? {},
          access: {
            allowedUsers: access4.allowedUsers,
            allowedChats: access4.allowedChats,
            admins: access4.admins
          },
          requireMentionInGroup: access4.requireMentionInGroup
        };
        await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
        return access4;
      }
      const profile2 = root.profiles[ctx.controls.profile];
      if (!profile2) throw new Error(`profile not found: ${ctx.controls.profile}`);
      const access3 = mutate(profile2.access);
      root.profiles[ctx.controls.profile] = {
        ...profile2,
        access: access3
      };
      await saveRootConfig(root, ctx.controls.configPath);
      ctx.controls.profileConfig = root.profiles[ctx.controls.profile];
      ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
      log.info("command", "access-mutated", {
        allowedUsers: access3.allowedUsers.length,
        allowedChats: access3.allowedChats.length,
        admins: access3.admins.length
      });
      return access3;
    });
  } catch (err) {
    reportMetric("command_fail", 1, { step: "access.save" });
    throw err;
  }
}
async function handleConfig(args, ctx) {
  const sub = args.trim().split(/\s+/)[0] ?? "";
  switch (sub) {
    case "":
      return showConfigForm(ctx);
    case "submit":
      return submitConfig(ctx);
    case "cancel":
      return cancelConfig(ctx);
    default:
      await reply(ctx, "\u7528\u6CD5:`/config`");
  }
}
async function showConfigForm(ctx) {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {
    }),
    fetchKnownChats(ctx.channel).then((chats) => {
      if (chats.length > 0) ctx.controls.knownChats = chats;
    }).catch(() => {
    })
  ]);
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access3 = ctx.controls.profileConfig.access;
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    presentationMode: getPresentationMode(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 6e4) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access3.allowedUsers,
    allowedChats: access3.allowedChats,
    admins: access3.admins,
    knownChats: ctx.controls.knownChats ?? []
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}
async function showResultCardInPlace(ctx, formMsgId, card) {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn("command", "config-card-update-fallback", { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch(
      (fallbackErr) => log.warn("command", "config-card-fallback-send-failed", {
        err: String(fallbackErr)
      })
    );
  }
  forgetManagedCard(formMsgId);
}
async function cancelConfig(ctx) {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}
async function submitConfig(ctx) {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? "").trim();
  const messageReply = rawReply === "markdown" || rawReply === "text" || rawReply === "card" ? rawReply : getMessageReplyMode(ctx.controls.cfg);
  const rawPresentation = String(fv.presentation_mode ?? "").trim();
  const presentationMode = rawPresentation === "clean" || rawPresentation === "progress" || rawPresentation === "debug" ? rawPresentation : getPresentationMode(ctx.controls.cfg);
  const rawCotMessages = String(fv.cot_messages ?? "").trim();
  const cotMessages = rawCotMessages === "brief" ? "brief" : rawCotMessages === "detailed" || rawCotMessages === "on" ? "detailed" : rawCotMessages === "off" ? "off" : getCotMessages(ctx.controls.cfg);
  const rawMaxCC = String(fv.max_concurrent_runs ?? "").trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns = Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1 ? Math.min(50, Math.floor(parsedMaxCC)) : getMaxConcurrentRuns(ctx.controls.cfg);
  const rawIdle = String(fv.run_idle_timeout_minutes ?? "").trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 6e4) : 0;
  let runIdleTimeoutMinutes;
  if (rawIdle === "") {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  const rawRequireMention = String(fv.require_mention_in_group ?? "").trim();
  let requireMentionInGroup;
  if (rawRequireMention === "yes") requireMentionInGroup = true;
  else if (rawRequireMention === "no") requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? "").trim();
  const larkCliIdentity = rawLarkCliIdentity === "user-default" || rawLarkCliIdentity === "bot-only" ? rawLarkCliIdentity : ctx.controls.profileConfig.larkCli.identityPreset;
  const previousLarkCliIdentity = ctx.controls.profileConfig.larkCli.identityPreset;
  const larkCliIdentityChanged = larkCliIdentity !== previousLarkCliIdentity;
  const formMsgId = ctx.msg.messageId;
  const access3 = ctx.controls.profileConfig.access;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async () => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };
    const nextPreferences = {
      ...ctx.controls.cfg.preferences ?? {},
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls: presentationMode === "debug",
      presentation: { mode: presentationMode },
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup
    };
    let failureStep = "config.save";
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = "config.lark-cli-policy";
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, larkCliIdentity);
        if (!applied) {
          throw new Error("lark-cli identity policy apply failed");
        }
        larkCliPolicyApplied = true;
        failureStep = "config.save";
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousLarkCliIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn("command", "lark-cli-identity-policy-rollback-failed", {
            profile: ctx.controls.profile,
            identity: previousLarkCliIdentity
          });
        }
      }
      log.fail("command", err, { step: failureStep });
      reportMetric("command_fail", 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied))
      );
      return;
    }
    log.info("command", "config-saved", {
      messageReply,
      presentationMode,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access3.allowedUsers.length,
      allowedChatsCount: access3.allowedChats.length,
      adminsCount: access3.admins.length
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        messageReply,
        presentationMode,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access3.allowedUsers,
        allowedChats: access3.allowedChats,
        admins: access3.admins,
        knownChats: ctx.controls.knownChats ?? []
      })
    );
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}
async function promptGroupMsgScopeIfMissing(ctx) {
  const appId = ctx.controls.cfg.accounts.app.id;
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info("command", "group-msg-scope-missing", { appId });
  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn("command", "scope-grant-link-failed", { err: String(err) });
    return;
  }
  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins)
    );
  } catch (err) {
    log.warn("command", "scope-grant-card-send-failed", { err: String(err) });
    return;
  }
  void link.completion.then(
    async () => {
      log.info("command", "group-msg-scope-granted", { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {
        }
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info("command", "scope-grant-not-completed", { err: String(err) });
      forgetManagedCard(sent.messageId);
    }
  );
}
function configFailureMessage(step, rollbackFailed, larkCliPolicyApplied) {
  if (rollbackFailed) {
    return "\u4FDD\u5B58\u5931\u8D25\uFF0C\u4E14 lark-cli \u8EAB\u4EFD\u7B56\u7565\u56DE\u6EDA\u5931\u8D25\u3002\u8BF7\u6267\u884C /status \u68C0\u67E5\u5F53\u524D\u72B6\u6001\u3002";
  }
  if (larkCliPolicyApplied && step === "config.save") {
    return "\u4FDD\u5B58\u5931\u8D25\uFF0Clark-cli \u8EAB\u4EFD\u7B56\u7565\u5DF2\u56DE\u6EDA\u3002\u8BF7\u91CD\u65B0\u6253\u5F00 /config \u786E\u8BA4\u5F53\u524D\u72B6\u6001\u3002";
  }
  if (step === "config.lark-cli-policy") {
    return "lark-cli \u8EAB\u4EFD\u7B56\u7565\u672A\u751F\u6548\uFF0C\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\u3002";
  }
  return "\u914D\u7F6E\u672A\u5199\u5165\uFF0C\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\u3002";
}
function commandProfilePaths(ctx) {
  return resolveAppPaths({
    rootDir: dirname14(ctx.controls.configPath),
    profile: ctx.controls.profile
  });
}
async function applyConfigLarkCliIdentityPolicy(ctx, larkCliIdentity) {
  const appPaths2 = commandProfilePaths(ctx);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths2.profile,
    rootDir: appPaths2.rootDir,
    configPath: ctx.controls.configPath,
    larkCliConfigDir: appPaths2.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths2.larkCliSourceConfigFile
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn("command", "lark-cli-identity-policy-apply-failed", {
      profile: appPaths2.profile,
      identity: larkCliIdentity
    });
  }
  return ok;
}
async function saveAccountConfig(ctx, newCfg, plaintextSecret) {
  const appPaths2 = commandProfilePaths(ctx);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths2);
  const root = await loadRootConfig(ctx.controls.configPath);
  if (!root) {
    await saveConfig(newCfg, ctx.controls.configPath);
    ctx.controls.cfg = newCfg;
    return;
  }
  const profile2 = root.profiles[ctx.controls.profile];
  if (!profile2) throw new Error(`profile not found: ${ctx.controls.profile}`);
  root.profiles[ctx.controls.profile] = {
    ...profile2,
    accounts: newCfg.accounts
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, ctx.controls.configPath);
  ctx.controls.profileConfig = root.profiles[ctx.controls.profile];
  ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
}
async function savePreferencesConfig(ctx, preferences, requireMentionInGroup, larkCliIdentity) {
  const larkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: "not-needed",
      attemptedAt: (/* @__PURE__ */ new Date()).toISOString(),
      reason: larkCliIdentity === "user-default" ? "manual-user-default" : "manual-bot-only"
    }
  };
  await withConfigFileLock(ctx.controls.configPath, async () => {
    const root = await loadRootConfig(ctx.controls.configPath);
    if (!root) {
      ctx.controls.cfg.preferences = preferences;
      ctx.controls.profileConfig.larkCli = larkCli;
      await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
      return;
    }
    const profile2 = root.profiles[ctx.controls.profile];
    if (!profile2) throw new Error(`profile not found: ${ctx.controls.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    root.profiles[ctx.controls.profile] = {
      ...profile2,
      preferences: {
        ...profile2.preferences,
        ...profilePreferences
      },
      access: {
        ...profile2.access,
        requireMentionInGroup
      },
      larkCli
    };
    await saveRootConfig(root, ctx.controls.configPath);
    ctx.controls.profileConfig = root.profiles[ctx.controls.profile];
    ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
  });
}

// src/bot/session-catalog-identity.ts
async function commandSessionCatalogIdentity(input) {
  const requestedCwd = input.workspaces.cwdFor(input.scope) ?? input.controls.profileConfig.workspaces.default;
  if (!requestedCwd) return void 0;
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) return void 0;
  const capability = input.controls.profileConfig.agentKind === "codex" ? codexCapability(input.controls.profileConfig) : claudeCapability(input.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: "im",
      chatId: input.msg.chatId,
      actorId: input.msg.senderId,
      ...input.mode === "topic" && input.msg.threadId ? { threadId: input.msg.threadId } : {}
    },
    attachments: [],
    prompt: "",
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability,
    profileConfig: input.controls.profileConfig,
    now: Date.now(),
    codexHome: input.controls.profileConfig.codex?.codexHome,
    inheritCodexHome: input.controls.profileConfig.codex?.inheritCodexHome
  });
  if (!policy.ok) return void 0;
  return {
    scopeId: input.scope,
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint
  };
}

// src/card/dispatcher.ts
var BRIDGE_CALLBACK_MARKER = "__bridge_cb";
var LEGACY_CLAUDE_CALLBACK_MARKER = "__claude_cb";
async function handleCardAction(deps) {
  const value = deps.evt.action.value;
  if (!value || typeof value !== "object") return;
  const payload = value;
  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;
  const raw = deps.evt.raw;
  const formValue = raw?.action?.form_value;
  const { scope, threadId, mode } = await resolveScope(deps);
  const accessDecision = mode === "p2p" ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId) : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info("cardAction", "skip-not-allowed-user", {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason
    });
    return;
  }
  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info("cardAction", "skip-legacy-callback-marker", { scope });
    return;
  }
  const cmd = typeof payload.cmd === "string" ? payload.cmd : "";
  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info("cardAction", "cmd", { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);
    const ctx = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      contextBudget: deps.contextBudget,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true
    };
    const [name, ...rest] = cmd.split(".");
    const sub = rest.join(" ");
    const args = composeArgs(sub, payload);
    try {
      const ok = await runCommandHandler(name ?? "", args, ctx);
      if (!ok) log.warn("cardAction", "unknown", { cmd });
    } catch (err) {
      log.fail("cardAction", err, { cmd });
    }
    return;
  }
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, "agent_callback")) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }
  return;
}
async function resolveScope(deps) {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== "topic") {
    return { scope: chatId, threadId: void 0, mode };
  }
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    return { scope: chatId, threadId: void 0, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}
async function lookupMessageThreadId(channel, messageId) {
  try {
    const [parent] = await channel.fetchRawMessage(messageId);
    return parent?.thread_id;
  } catch (err) {
    log.warn("cardAction", "thread-id-lookup-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
function forwardToAgent(deps, payload, formValue, scope, threadId, mode) {
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info("cardAction", "forward-agent", {
    scope,
    payload: JSON.stringify(merged).slice(0, 200)
  });
  const synthetic = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === "p2p" ? "p2p" : "group",
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: "card_action",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now()
  };
  deps.pending.push(scope, synthetic);
}
function verifyBridgeToken(deps, payload, scope, action) {
  const token = typeof payload.bridge_token === "string" ? payload.bridge_token : "";
  const active2 = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active2) {
    log.info("cardAction", "skip-callback-auth-missing", { scope, action });
    log.warn("callback", "denied", { scope, action, reason: "missing-token-or-run" });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active2.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint: deps.callbackPolicyFingerprintForScope?.(scope) ?? deps.callbackPolicyFingerprint ?? ""
  });
  if (!result.ok) {
    log.info("cardAction", "skip-callback-auth-failed", {
      scope,
      action,
      reason: result.reason
    });
    log.warn("callback", "denied", { scope, action, reason: result.reason });
    return false;
  }
  return true;
}
function isSignedBridgeCallback(payload) {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === "string";
}
function composeArgs(sub, payload) {
  if (!sub) return "";
  const arg = typeof payload.arg === "string" && payload.arg || typeof payload.name === "string" && payload.name || "";
  return arg ? `${sub} ${arg}` : sub;
}
function makeFakeMsg(evt, threadId) {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: "p2p",
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: "",
    rawContentType: "interactive",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now()
  };
}

// src/card/callback-auth.ts
import { createHmac, randomBytes as randomBytes4, timingSafeEqual } from "crypto";
var PREFIX = "bridge_cb.v1";
var CallbackAuth = class {
  keys;
  nonceStore;
  now;
  createNonce;
  constructor(options) {
    this.keys = [...options.keys].sort((a, b) => a.version - b.version);
    if (this.keys.length === 0) throw new Error("at least one callback key is required");
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes4(16).toString("base64url"));
  }
  sign(input) {
    const key = this.signingKey();
    const payload = {
      r: input.runId,
      s: input.scope,
      c: input.chatId,
      o: input.operatorOpenId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      fp: input.policyFingerprint,
      n: this.createNonce(),
      kv: key.version
    };
    const encoded = encodeJson(payload);
    return `${PREFIX}.${encoded}.${sign(encoded, key.secret)}`;
  }
  verify(token, expected) {
    const parts = token.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: "malformed" };
    }
    const encodedPayload = parts[2];
    const signature = parts[3];
    if (!encodedPayload || !signature) return { ok: false, reason: "malformed" };
    const payload = decodePayload(encodedPayload);
    if (!payload) return { ok: false, reason: "malformed" };
    const key = this.keys.find((candidate) => candidate.version === payload.kv);
    if (!key) return { ok: false, reason: "unknown-key" };
    if (!signatureMatches(signature, sign(encodedPayload, key.secret))) {
      return { ok: false, reason: "bad-signature" };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: "expired" };
    if (!matchesExpected(payload, expected)) {
      return { ok: false, reason: "context-mismatch" };
    }
    const nonceState = this.nonceStore.state(payload.n);
    if (nonceState === "revoked") return { ok: false, reason: "nonce-revoked" };
    if (nonceState === "used") return { ok: false, reason: "nonce-replay" };
    if (!this.nonceStore.consume(payload.n)) {
      return { ok: false, reason: "nonce-replay" };
    }
    return { ok: true, payload };
  }
  signingKey() {
    const active2 = this.keys.filter((key2) => !key2.retired);
    const key = active2.at(-1);
    if (!key) throw new Error("no active callback signing key");
    return key;
  }
};
function matchesExpected(payload, expected) {
  return payload.r === expected.runId && payload.s === expected.scope && payload.c === expected.chatId && payload.o === expected.operatorOpenId && payload.a === expected.action && payload.fp === expected.policyFingerprint;
}
function encodeJson(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodePayload(encoded) {
  try {
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof raw.r !== "string" || typeof raw.s !== "string" || typeof raw.c !== "string" || typeof raw.o !== "string" || typeof raw.a !== "string" || typeof raw.exp !== "number" || typeof raw.fp !== "string" || typeof raw.n !== "string" || typeof raw.kv !== "number") {
      return void 0;
    }
    return {
      r: raw.r,
      s: raw.s,
      c: raw.c,
      o: raw.o,
      a: raw.a,
      exp: raw.exp,
      fp: raw.fp,
      n: raw.n,
      kv: raw.kv
    };
  } catch {
    return void 0;
  }
}
function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function signatureMatches(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

// src/card/callback-store.ts
import { readFile as readFile12 } from "fs/promises";
var CallbackNonceStore = class {
  path;
  nonces = /* @__PURE__ */ new Map();
  saving = Promise.resolve();
  constructor(path) {
    this.path = path;
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile12(this.path, "utf8"));
      if (!raw || typeof raw !== "object") return;
      this.nonces.clear();
      for (const [nonce, state] of Object.entries(raw)) {
        if (state === "used" || state === "revoked") this.nonces.set(nonce, state);
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      log.fail("callback-nonce", err, { step: "load" });
    }
  }
  state(nonce) {
    return this.nonces.get(nonce);
  }
  consume(nonce) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, "used");
    this.schedulePersist();
    return true;
  }
  revoke(nonce) {
    this.nonces.set(nonce, "revoked");
    this.schedulePersist();
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    this.saving = this.saving.then(async () => {
      await writeFileAtomic(
        this.path,
        `${JSON.stringify(Object.fromEntries(this.nonces), null, 2)}
`,
        { mode: 384 }
      );
    }).catch((err) => {
      log.fail("callback-nonce", err, { step: "persist" });
    });
  }
};

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

// src/media/cache.ts
import { createHash as createHash2 } from "crypto";
import { createReadStream as createReadStream2 } from "fs";
import { mkdir as mkdir13, readdir as readdir5, rename as rename4, rm as rm11, stat as stat7 } from "fs/promises";
import { join as join19 } from "path";

// src/media/attachment.ts
var DEFAULT_POLICY = {
  maxCount: 10,
  maxBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  imageMaxBytes: 25 * 1024 * 1024
};
var IMAGE_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};
var MIME_EXT = {
  ...IMAGE_MIME_EXT,
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json"
};
function normalizeAttachments(candidates, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...options };
  let acceptedCount = 0;
  let acceptedBytes = 0;
  return candidates.map((candidate) => {
    const base = {
      ...candidate,
      path: candidate.absPath,
      requiredness: "optional"
    };
    const early = earlyDecision(candidate);
    if (early) return { ...base, ...early };
    if (acceptedCount >= policy.maxCount) {
      return reject3(base, "too-many-attachments");
    }
    if (candidate.size > policy.maxFileBytes) {
      return reject3(base, "file-too-large");
    }
    if (candidate.kind === "image" && candidate.size > policy.imageMaxBytes) {
      return reject3(base, "image-too-large");
    }
    if (acceptedBytes + candidate.size > policy.maxBytes) {
      return reject3(base, "run-too-large");
    }
    acceptedCount++;
    acceptedBytes += candidate.size;
    return { ...base, decision: "accepted" };
  });
}
function safeExtensionForMime(mime) {
  return MIME_EXT[mime.toLowerCase()] ?? "bin";
}
function toPolicyAttachment(attachment) {
  return {
    kind: attachment.kind,
    path: attachment.absPath,
    hash: attachment.hash,
    size: attachment.size,
    originalName: attachment.originalName,
    requiredness: attachment.requiredness,
    decision: attachment.decision,
    ...attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}
  };
}
function toPromptAttachment(attachment) {
  return {
    path: attachment.absPath,
    kind: attachment.kind,
    hash: attachment.hash,
    size: attachment.size,
    mime: attachment.mime,
    sourceMessageId: attachment.sourceMessageId,
    requiredness: attachment.requiredness,
    decision: attachment.decision,
    ...attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}
  };
}
function earlyDecision(candidate) {
  if (candidate.kind === "sticker") {
    return { decision: "skipped", rejectionReason: "sticker" };
  }
  if (candidate.kind === "audio" || candidate.kind === "video") {
    return { decision: "skipped", rejectionReason: "unsupported-kind" };
  }
  if (candidate.kind === "image" && !IMAGE_MIME_EXT[candidate.mime.toLowerCase()]) {
    return { decision: "rejected", rejectionReason: "unsupported-image-mime" };
  }
  return void 0;
}
function reject3(base, reason) {
  return { ...base, decision: "rejected", rejectionReason: reason };
}

// src/media/cache.ts
var MediaCache = class {
  channel;
  rootDir;
  constructor(channel, rootDir = paths.mediaDir) {
    this.channel = channel;
    this.rootDir = rootDir;
  }
  async resolve(items, options = {}) {
    if (items.length === 0) return [];
    await mkdir13(this.rootDir, { recursive: true });
    const candidates = [];
    for (const item of items) {
      try {
        const file = await this.resolveOne(item);
        if (file) candidates.push(file);
      } catch (err) {
        log.fail("media", err, { fileKey: item.resource.fileKey });
      }
    }
    const normalized = normalizeAttachments(candidates, options);
    await removeRejectedResolvedFiles(normalized);
    if (typeof options.cacheMaxBytes === "number") {
      await enforceCacheMaxBytes(
        this.rootDir,
        options.cacheMaxBytes,
        new Set(
          normalized.filter((attachment) => attachment.decision === "accepted").map((attachment) => attachment.absPath)
        )
      );
    }
    return normalized;
  }
  async resolveOne(item) {
    const { messageId, resource: r } = item;
    if (r.type === "sticker") {
      log.info("media", "skip", { reason: "sticker", fileKey: r.fileKey });
      return null;
    }
    const kind = r.type;
    const tmpPath = join19(
      this.rootDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const { contentType } = await this.channel.downloadResourceToFile(
      messageId,
      r.fileKey,
      r.type === "image" ? "image" : "file",
      tmpPath
    );
    const tmpStat = await stat7(tmpPath);
    const hash = await hashFile(tmpPath);
    const mime = contentType ?? defaultMime(kind);
    const ext = safeExtensionForMime(mime);
    const absPath = join19(this.rootDir, `${hash}.${ext}`);
    try {
      await stat7(absPath);
      await rm11(tmpPath, { force: true });
      log.info("media", "cache-hit", { path: absPath });
    } catch {
      await rename4(tmpPath, absPath);
    }
    const candidate = {
      absPath,
      kind,
      size: tmpStat.size,
      mime,
      hash,
      source: "lark",
      sourceMessageId: messageId,
      sourceFileKey: r.fileKey,
      ...r.fileName ? { originalName: r.fileName } : {}
    };
    log.info("media", "downloaded", {
      path: candidate.absPath,
      size: candidate.size
    });
    return candidate;
  }
};
async function gcMediaCache(maxAgeMs, root = paths.mediaDir) {
  try {
    await stat7(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const files = await listFiles(root);
  for (const p3 of files) {
    try {
      const st = await stat7(p3);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await rm11(p3);
        removed++;
      }
    } catch {
    }
  }
  if (removed > 0) log.info("media", "gc", { removed });
}
function defaultMime(kind) {
  switch (kind) {
    case "image":
      return "image/png";
    case "audio":
      return "audio/ogg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
async function listFiles(root) {
  const out = [];
  const entries = await readdir5(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join19(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}
async function hashFile(path) {
  const hash = createHash2("sha256");
  for await (const chunk of createReadStream2(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function enforceCacheMaxBytes(root, maxBytes, protectedPaths) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const files = await Promise.all(
    (await listFiles(root)).map(async (path) => {
      const fileStat = await stat7(path);
      return { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    })
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.filter((item) => !protectedPaths.has(item.path)).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await rm11(file.path, { force: true });
    total -= file.size;
  }
}
async function removeRejectedResolvedFiles(attachments) {
  await Promise.all(
    attachments.filter((attachment) => attachment.decision !== "accepted").map((attachment) => rm11(attachment.absPath, { force: true }))
  );
}

// src/policy/owner.ts
var OWNER_REFRESH_INTERVAL_MS = 30 * 60 * 1e3;
async function refreshOwnerControls(controls, source, appId) {
  try {
    const ownerId = await fetchOwnerId(source);
    controls.botOwnerId = ownerId;
    controls.ownerRefreshState = "ok";
    controls.ownerRefreshedAt = Date.now();
    delete controls.ownerRefreshError;
  } catch (err) {
    controls.ownerRefreshState = "failed";
    controls.ownerRefreshedAt = Date.now();
    controls.ownerRefreshError = err instanceof Error ? err.message : String(err);
    log.warn("access", "owner_refresh_failed", {
      appId,
      error: controls.ownerRefreshError
    });
  }
}
function createOwnerRefreshController(opts) {
  let timer;
  const intervalMs = opts.intervalMs ?? OWNER_REFRESH_INTERVAL_MS;
  return {
    async start() {
      await refreshOwnerControls(opts.controls, opts.source, opts.appId);
      timer = setInterval(() => {
        void refreshOwnerControls(opts.controls, opts.source, opts.appId);
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = void 0;
    }
  };
}
async function fetchOwnerId(source) {
  const { ownerId } = await source.getAppInfo({
    lang: "zh_cn",
    userIdType: "open_id"
  });
  if (!ownerId) throw new Error("application owner missing from API response");
  return ownerId;
}

// src/runtime/run-executor.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/bot/active-runs.ts
var ActiveRuns = class {
  handles = /* @__PURE__ */ new Map();
  reservations = /* @__PURE__ */ new Set();
  pauseDepth = 0;
  pauseReason;
  reserve(chatId) {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return void 0;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }
  register(chatId, run) {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }
  pauseNewRuns(reason) {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = void 0;
    };
  }
  newRunsPaused() {
    return this.pauseDepth > 0;
  }
  newRunsPauseReason() {
    return this.pauseReason;
  }
  get(chatId) {
    return this.handles.get(chatId);
  }
  unregister(chatId, run) {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }
  snapshot() {
    return [...this.handles.values()];
  }
  scopes() {
    return [...this.handles.keys()];
  }
  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId) {
    const h = this.handles.get(chatId);
    if (!h) return false;
    this.reservations.delete(chatId);
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
    });
    return true;
  }
  async stopAll() {
    const all = [...this.handles.values()];
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
  async waitForAll(timeoutMs = 3e5) {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
};

// src/bot/process-pool.ts
var ProcessPool = class {
  active = 0;
  waiters = [];
  /** Snapshot of the cap captured at the moment acquire() decided to wait. */
  cap;
  constructor(cap) {
    this.cap = cap;
  }
  async acquire() {
    if (this.active < this.cap()) {
      this.active++;
      log.info("pool", "acquired", { active: this.active, cap: this.cap() });
      reportMetric("pool_active", this.active);
      return () => this.release();
    }
    log.info("pool", "wait", { active: this.active, cap: this.cap(), waiting: this.waiters.length + 1 });
    reportMetric("pool_waiting", this.waiters.length + 1);
    await new Promise((resolve2) => this.waiters.push(resolve2));
    this.active++;
    log.info("pool", "acquired", { active: this.active, cap: this.cap() });
    reportMetric("pool_active", this.active);
    return () => this.release();
  }
  tryAcquire() {
    if (this.active >= this.cap()) {
      log.info("pool", "full", { active: this.active, cap: this.cap() });
      return void 0;
    }
    this.active++;
    log.info("pool", "acquired", { active: this.active, cap: this.cap() });
    return () => this.release();
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    log.info("pool", "released", { active: this.active });
    reportMetric("pool_active", this.active);
    if (this.active < this.cap() && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }
  snapshot() {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
};

// src/runtime/run-executor.ts
var DEFAULT_POST_DONE_EXIT_GRACE_MS = 2e3;
var RunExecutor = class {
  agent;
  pool;
  activeRuns;
  createRunId;
  now;
  postDoneExitGraceMs;
  constructor(deps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID2;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }
  async submit(input) {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected("policy-expired", "run policy expired before spawn");
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        "reconnect-in-progress",
        this.activeRuns.newRunsPauseReason() ?? "new runs are temporarily paused"
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected("run-already-active", "another run is already active for this scope");
    }
    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected("pool-full", "process pool is full");
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        "reconnect-in-progress",
        this.activeRuns.newRunsPauseReason() ?? "new runs are temporarily paused"
      );
    }
    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs
    };
    let run;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed("agent prepare failed", err, "agent-prepare-failed");
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        "reconnect-in-progress",
        this.activeRuns.newRunsPauseReason() ?? "new runs are temporarily paused"
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed("agent spawn failed", err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? "unknown",
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? "unknown",
      stage: input.observability?.stage ?? "submit"
    };
    log.info("run", "started", {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode
    });
    let handle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {
      });
      throw new RunRejected(
        "run-already-active",
        err instanceof Error ? err.message : "another run is already active for this scope"
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit) => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
      if (waitForExit) {
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) {
          log.warn("run", "post-done-exit-timeout", {
            ...dimensions,
            graceMs: this.postDoneExitGraceMs
          });
          await run.stop().catch((err) => {
            log.warn("run", "post-done-stop-failed", {
              ...dimensions,
              err: err instanceof Error ? err.message : String(err)
            });
          });
        }
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now
    }), async () => {
      await cleanup(!handle.interrupted);
    });
    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(false);
      }
    };
  }
};
function observeRunEvents(events, opts) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (event.type === "done") {
          log.info("run", "completed", {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt
          });
          yield event;
          return;
        }
        if (event.type === "error") {
          log.warn("run", "failed", {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message
          });
          yield event;
          return;
        }
        yield event;
      }
    }
  };
}
var EventFanout = class {
  source;
  onDone;
  buffer = [];
  waiters = /* @__PURE__ */ new Set();
  started = false;
  done = false;
  error;
  constructor(source, onDone) {
    this.source = source;
    this.onDone = onDone;
  }
  subscribe() {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async () => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++] };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: void 0 };
            await new Promise((resolve2) => {
              const wake = () => {
                this.waiters.delete(wake);
                resolve2();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++] };
            }
            if (this.error) throw this.error;
            return { done: true, value: void 0 };
          }
        };
      }
    };
  }
  start() {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }
  async pump() {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }
  wakeAll() {
    for (const wake of [...this.waiters]) wake();
  }
};
function isTerminalEvent(event) {
  return event.type === "done" || event.type === "error";
}

// src/session/context-budget.ts
import { readFile as readFile13 } from "fs/promises";
var CONTEXT_LIMIT_RE = /(context[\s_-]*(?:length|window)|maximum[\s_-]*context|max(?:imum)?[\s_-]*tokens?|token[\s_-]*limit|too many tokens)/i;
var ContextBudgetStore = class {
  data = {};
  saving = Promise.resolve();
  path;
  constructor(path) {
    this.path = path;
  }
  async load() {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile13(this.path, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        this.data = {};
        return;
      }
      this.data = {};
      for (const [scopeId, value] of Object.entries(raw)) {
        const entry = normalizeEntry(value);
        if (entry) this.data[scopeId] = entry;
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      log.fail("context-budget", err, { step: "load" });
      this.data = {};
    }
  }
  pendingResetFor(scopeId, config) {
    if (!config.enabled) return void 0;
    const entry = this.data[scopeId];
    if (!entry) return void 0;
    if (entry.pendingResetReason && resetReasonStillApplies(entry, entry.pendingResetReason, config)) {
      return { ...entry.pendingResetReason };
    }
    if (entry.maxInputTokens !== void 0 && inputTokenResetEligible(entry.turns, entry.maxInputTokens, config)) {
      return {
        code: "input-tokens",
        inputTokens: entry.maxInputTokens,
        threshold: config.inputTokenThreshold
      };
    }
    if (config.maxTurns > 0 && entry.turns >= config.maxTurns) {
      return {
        code: "max-turns",
        turns: entry.turns,
        maxTurns: config.maxTurns
      };
    }
    return void 0;
  }
  recordRunResult(scopeId, result, config) {
    if (!config.enabled) return void 0;
    const prev = this.data[scopeId] ?? { turns: 0, updatedAt: Date.now() };
    const contextError = result.terminal === "error" && isContextLimitError(result.errorMessage);
    const turns = result.terminal === "done" ? prev.turns + 1 : prev.turns;
    const lastInputTokens = result.inputTokens;
    const maxInputTokens = lastInputTokens === void 0 ? prev.maxInputTokens : Math.max(prev.maxInputTokens ?? 0, lastInputTokens);
    let pendingResetReason;
    if (contextError) {
      pendingResetReason = { code: "context-error" };
    } else if (lastInputTokens !== void 0 && inputTokenResetEligible(turns, lastInputTokens, config)) {
      pendingResetReason = {
        code: "input-tokens",
        inputTokens: lastInputTokens,
        threshold: config.inputTokenThreshold
      };
    } else if (config.maxTurns > 0 && turns >= config.maxTurns) {
      pendingResetReason = {
        code: "max-turns",
        turns,
        maxTurns: config.maxTurns
      };
    }
    this.data[scopeId] = {
      turns,
      ...lastInputTokens !== void 0 ? { lastInputTokens } : {},
      ...maxInputTokens !== void 0 ? { maxInputTokens } : {},
      ...pendingResetReason ? { pendingResetReason } : {},
      updatedAt: Date.now()
    };
    this.schedulePersist();
    return pendingResetReason ? { ...pendingResetReason } : void 0;
  }
  reset(scopeId) {
    if (!this.data[scopeId]) return;
    delete this.data[scopeId];
    this.schedulePersist();
  }
  getRaw(scopeId) {
    const entry = this.data[scopeId];
    return entry ? { ...entry } : void 0;
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    if (!this.path) return;
    this.saving = this.saving.then(async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}
`, {
        mode: 384
      });
    }).catch((err) => {
      log.fail("context-budget", err, { step: "persist" });
    });
  }
};
function isContextLimitError(message) {
  if (!message) return false;
  return CONTEXT_LIMIT_RE.test(message);
}
function formatContextBudgetResetNotice(reason) {
  switch (reason.code) {
    case "input-tokens":
      return "\u4E0A\u4E0B\u6587\u63A5\u8FD1\u4E0A\u9650\uFF0C\u5DF2\u81EA\u52A8\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002";
    case "max-turns":
      return "\u5F53\u524D\u4F1A\u8BDD\u8F6E\u6570\u8F83\u591A\uFF0C\u5DF2\u81EA\u52A8\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002";
    case "context-error":
      return "\u4E0A\u4E00\u8F6E\u56E0\u4E0A\u4E0B\u6587\u8FC7\u5927\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u5F00\u542F\u65B0\u4F1A\u8BDD\uFF0C\u8BF7\u7EE7\u7EED\u53D1\u9001\u3002";
  }
}
function inputTokenResetEligible(turns, inputTokens, config) {
  return turns >= config.minTurnsBeforeInputTokenReset && inputTokens >= config.inputTokenThreshold;
}
function resetReasonStillApplies(entry, reason, config) {
  switch (reason.code) {
    case "context-error":
      return true;
    case "input-tokens": {
      const tokens = reason.inputTokens ?? entry.maxInputTokens;
      return tokens !== void 0 && inputTokenResetEligible(entry.turns, tokens, config);
    }
    case "max-turns":
      return config.maxTurns > 0 && entry.turns >= config.maxTurns;
  }
}
function normalizeEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const raw = input;
  if (typeof raw.turns !== "number" || typeof raw.updatedAt !== "number") return void 0;
  const pendingResetReason = normalizeResetReason(raw.pendingResetReason);
  return {
    turns: Math.max(0, Math.floor(raw.turns)),
    ...typeof raw.lastInputTokens === "number" && Number.isFinite(raw.lastInputTokens) ? { lastInputTokens: Math.max(0, Math.floor(raw.lastInputTokens)) } : {},
    ...typeof raw.maxInputTokens === "number" && Number.isFinite(raw.maxInputTokens) ? { maxInputTokens: Math.max(0, Math.floor(raw.maxInputTokens)) } : {},
    ...pendingResetReason ? { pendingResetReason } : {},
    updatedAt: raw.updatedAt
  };
}
function normalizeResetReason(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
  const raw = input;
  if (raw.code !== "input-tokens" && raw.code !== "max-turns" && raw.code !== "context-error") {
    return void 0;
  }
  return {
    code: raw.code,
    ...typeof raw.inputTokens === "number" && Number.isFinite(raw.inputTokens) ? { inputTokens: Math.max(0, Math.floor(raw.inputTokens)) } : {},
    ...typeof raw.threshold === "number" && Number.isFinite(raw.threshold) ? { threshold: Math.max(0, Math.floor(raw.threshold)) } : {},
    ...typeof raw.turns === "number" && Number.isFinite(raw.turns) ? { turns: Math.max(0, Math.floor(raw.turns)) } : {},
    ...typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) ? { maxTurns: Math.max(0, Math.floor(raw.maxTurns)) } : {}
  };
}

// src/bot/chat-mode-cache.ts
var ChatModeCache = class {
  cache = /* @__PURE__ */ new Map();
  async resolve(channel, chatId) {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info("chat", "mode-resolved", { chatId, mode });
      return mode;
    } catch (err) {
      log.warn("chat", "mode-resolve-failed", {
        chatId,
        err: err instanceof Error ? err.message : String(err)
      });
      return "group";
    }
  }
  invalidate(chatId) {
    this.cache.delete(chatId);
  }
};

// src/bot/comments.ts
import { randomUUID as randomUUID3 } from "crypto";
import { mkdir as mkdir14 } from "fs/promises";
import { dirname as dirname15 } from "path";

// src/bot/run-flow.ts
async function startRunFlow(input) {
  const requestedCwd = input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? "";
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible
      },
      workspace
    };
  }
  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace
    };
  }
  if (input.forceNewSession) {
    input.sessionCatalog?.archiveActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
      now: input.now
    });
    input.sessions.clear(input.scopeId);
  }
  let resumeFrom;
  let sessionId;
  let threadId;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint
    });
    if (catalogEntry?.agentId === "claude") {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === "codex") {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.agentId === "claude") {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }
  let execution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      images: input.capability.agentId === "codex" ? policy.attachments.filter((attachment) => attachment.kind === "image" && attachment.decision === "accepted").map((attachment) => attachment.path).filter((path) => Boolean(path)) : void 0,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible: err.code === "reconnect-in-progress" ? "\u5F53\u524D bot \u6B63\u5728\u91CD\u8FDE\uFF0C\u7A0D\u540E\u4F1A\u7EE7\u7EED\u5904\u7406\u65B0\u6D88\u606F\u3002" : err.code === "run-already-active" ? "\u5F53\u524D\u4F1A\u8BDD\u5DF2\u6709\u8FD0\u884C\u5728\u6267\u884C\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u5148\u505C\u6B62\u5F53\u524D\u8FD0\u884C\u3002" : "\u5F53\u524D\u65E0\u6CD5\u53D1\u8D77\u8FD0\u884C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
        },
        workspace
      };
    }
    throw err;
  }
  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...resumeFrom ? { resumeFrom } : {}
  };
}
function recordRunSessionEvent(input) {
  if (input.event.type !== "system") return;
  if (input.capability.agentId === "claude" && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: "claude",
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId
    });
    return;
  }
  if (input.capability.agentId === "codex" && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: "codex",
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId
    });
  }
}

// src/bot/comment-resource.ts
import { createHash as createHash3 } from "crypto";
function commentTokenDigest(token) {
  return createHash3("sha256").update(token).digest("hex").slice(0, 16);
}
function commentDocumentScopeId(fileToken) {
  return `comment-doc:${commentTokenDigest(fileToken)}`;
}
function commentScopeId(fileToken, commentId) {
  return `comment:${commentTokenDigest(`${fileToken}:${commentId}`)}`;
}
async function resolveCommentTarget(channel, evt) {
  return channel.comments.resolveTarget(evt.fileToken, evt.fileType);
}

// src/bot/comments.ts
var REPLY_MAX_CHARS = 2e3;
var SUPPORTED_FILE_TYPES = /* @__PURE__ */ new Set(["doc", "docx", "sheet", "file"]);
var activeCommentAgentSessionRuns = /* @__PURE__ */ new Map();
async function handleCommentMention(deps) {
  const { channel, evt, sessions, sessionCatalog, workspaces, controls } = deps;
  const eventDocScopeId = commentDocumentScopeId(evt.fileToken);
  const eventCommentScopeId = commentScopeId(evt.fileToken, evt.commentId);
  log.info("comment", "enter", {
    docScopeId: eventDocScopeId,
    fileType: evt.fileType,
    commentScopeId: eventCommentScopeId,
    replyDigest: evt.replyId ? commentTokenDigest(evt.replyId) : void 0,
    mentionedBot: evt.mentionedBot,
    sender: evt.operator.openId
  });
  if (!evt.mentionedBot) {
    log.info("comment", "skip", { reason: "not-mentioned" });
    return;
  }
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
    log.info("comment", "skip", { reason: "unsupported-fileType", fileType: evt.fileType });
    return;
  }
  if (isBridgeSelfReply(channel, evt)) {
    log.info("comment", "skip", {
      reason: "bridge-self-reply",
      commentScopeId: eventCommentScopeId
    });
    return;
  }
  const target = await resolveCommentTarget(channel, evt);
  if (!target) {
    log.info("comment", "skip", { reason: "unsupported-target", commentScopeId: eventCommentScopeId });
    return;
  }
  const targetDocScopeId = commentDocumentScopeId(target.fileToken);
  const commentThreadScopeId = eventCommentScopeId;
  const runScopeId = commentExecutionScopeId(commentThreadScopeId);
  const docSessionScopeId = commentDocumentSessionScopeId(target.fileToken);
  const legacyDocSessionScopeId = legacyCommentDocumentSessionScopeId(target.fileToken);
  const agentSessionScopeId = docSessionScopeId;
  const ctx = await fetchCommentContext(channel, target, evt).catch((err) => {
    const code = err?.response?.data?.code;
    if (code === 1069307) {
      log.warn("comment", "no-access", { docDigest: commentTokenDigest(target.fileToken) });
    } else {
      log.fail("comment", err, { step: "fetchCommentContext" });
    }
    return null;
  });
  if (!ctx?.question) {
    log.info("comment", "skip", { reason: "empty-question" });
    return;
  }
  log.info("comment", "parsed", {
    commentScopeId: runScopeId,
    isWhole: ctx.isWhole,
    questionPreview: preview(ctx.question),
    hasQuote: Boolean(ctx.quote)
  });
  const prompt = buildCommentPrompt(target, ctx);
  const workspace = await resolveCommentWorkingDirectory(
    workspaces.cwdFor(docSessionScopeId) ?? workspaces.cwdFor(legacyDocSessionScopeId),
    controls.profileConfig.workspaces.default,
    managedDefaultWorkspaceForComments(controls)
  );
  const requestedCwd = workspace.requestedCwd;
  const cwdRealpath = workspace.cwdRealpath;
  if (workspace.ok && workspace.fallback) {
    log.info("comment", "workspace-fallback", {
      reason: workspace.fallback.reason,
      from: workspace.fallback.from,
      to: workspace.fallback.to,
      commentScopeId: runScopeId
    });
  }
  if (!workspace.ok) {
    log.info("comment", "skip", {
      reason: "workspace-rejected",
      code: workspace.reason,
      commentScopeId: runScopeId
    });
    await postCommentReply(channel, target, evt, `\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u53EF\u7528\uFF1A${workspace.userVisible}`, {
      isWhole: ctx.isWhole
    }).catch((err) => {
      log.fail("comment", err, { step: "postInvalidWorkspaceReply" });
    });
    return;
  }
  const reactionAdded = ctx.targetReplyId ? await channel.comments.addReaction(target, ctx.targetReplyId) : false;
  try {
    const capability = controls.profileConfig.agentKind === "codex" ? codexCapability(controls.profileConfig) : claudeCapability(controls.profileConfig);
    const runTimeoutMs = commentRunTimeoutMs(sessions, runScopeId);
    const threadTimeoutMs = commentRunTimeoutMs(sessions, commentThreadScopeId);
    const commentTimeoutMs = runTimeoutMs !== void 0 ? runTimeoutMs : threadTimeoutMs;
    if (typeof commentTimeoutMs === "number") {
      log.info("comment", "timeout-watchdog", { commentScopeId: runScopeId, timeoutMs: commentTimeoutMs });
    }
    const policy = evaluateRunPolicy({
      scope: {
        source: "comment",
        actorId: evt.operator.openId,
        commentScopeId: agentSessionScopeId,
        resourceBindings: [{ kind: "doc", id: targetDocScopeId, verified: true }]
      },
      attachments: [],
      prompt,
      requestedCwd,
      cwdRealpath,
      access: { ok: true, reason: "comment-mention" },
      capability,
      profileConfig: controls.profileConfig,
      now: Date.now(),
      codexHome: controls.profileConfig.codex?.codexHome,
      inheritCodexHome: controls.profileConfig.codex?.inheritCodexHome,
      ...typeof commentTimeoutMs === "number" ? { ttlMs: commentTimeoutMs } : {}
    });
    if (!policy.ok) {
      log.warn("policy", "denied", {
        scope: runScopeId,
        source: "comment",
        code: policy.rejectReason.code
      });
      return;
    }
    const commentExpiresAt = typeof commentTimeoutMs === "number" ? policy.expiresAt : void 0;
    const agentSessionRun = markCommentAgentSessionRun(agentSessionScopeId);
    try {
      const canResumeAgentSession = !agentSessionRun.wasActive;
      const catalogEntry = canResumeAgentSession ? sessionCatalog?.activeFor({
        scopeId: agentSessionScopeId,
        agentId: capability.agentId,
        cwdRealpath,
        policyFingerprint: policy.policyFingerprint
      }) ?? sessionCatalog?.activeFor({
        scopeId: legacyDocSessionScopeId,
        agentId: capability.agentId,
        cwdRealpath,
        policyFingerprint: policy.policyFingerprint
      }) : void 0;
      const sessionId = canResumeAgentSession && capability.agentId === "claude" ? sessions.resumeFor(docSessionScopeId, cwdRealpath) ?? sessions.resumeFor(legacyDocSessionScopeId, cwdRealpath) : void 0;
      const threadId = capability.agentId === "codex" ? catalogEntry?.threadId : void 0;
      log.info("comment", "session", {
        commentScopeId: runScopeId,
        sessionScopeId: agentSessionScopeId,
        resume: Boolean(sessionId ?? threadId),
        sessionScopeActive: agentSessionRun.wasActive,
        cwd: cwdRealpath
      });
      const execution = await deps.executor.submit({
        scopeId: runScopeId,
        policy,
        sessionId,
        threadId,
        stopGraceMs: getAgentStopGraceMs(controls.cfg),
        observability: {
          profile: controls.profile,
          agent: capability.agentId,
          source: "comment",
          stage: "submit"
        }
      }).catch(async (err) => {
        if (err instanceof RunRejected) {
          log.info("comment", "skip", {
            reason: err.code,
            commentScopeId: runScopeId
          });
          const reply3 = commentRunRejectedReply(err.code);
          if (reply3) {
            await postCommentReply(channel, target, evt, reply3, { isWhole: ctx.isWhole }).catch((replyErr) => {
              log.fail("comment", replyErr, { step: "postRunRejectedReply" });
            });
          }
          return void 0;
        }
        throw err;
      });
      if (!execution) return;
      let answer = "";
      let errorMsg;
      let terminal = false;
      let timedOut = false;
      const eventStream = execution.subscribe()[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await nextCommentEvent(eventStream, commentExpiresAt);
          if (next === "expired") {
            await execution.stop().catch((err) => {
              log.warn("comment", "expired-stop-failed", {
                commentScopeId: runScopeId,
                err: err instanceof Error ? err.message : String(err)
              });
            });
            timedOut = true;
            terminal = true;
            break;
          }
          if (commentExpiresAt !== void 0 && Date.now() > commentExpiresAt) {
            await execution.stop().catch((err) => {
              log.warn("comment", "expired-stop-failed", {
                commentScopeId: runScopeId,
                err: err instanceof Error ? err.message : String(err)
              });
            });
            timedOut = true;
            terminal = true;
            break;
          }
          if (next.done || execution.handle.interrupted) {
            terminal = true;
            break;
          }
          const e = next.value;
          recordCommentSessionEvent({
            scopeId: agentSessionScopeId,
            sessions,
            sessionCatalog,
            capability,
            policy,
            event: e
          });
          if (capability.agentId === "claude" && e.type === "system" && e.sessionId) {
            sessions.set(docSessionScopeId, e.sessionId, policy.cwdRealpath);
          }
          switch (e.type) {
            case "text":
              answer += e.delta;
              break;
            case "tool_use":
            case "tool_result":
              answer = "";
              break;
            case "system":
              break;
            case "error":
              errorMsg = e.message;
              terminal = true;
              break;
            case "usage":
              break;
            case "done":
              terminal = true;
              break;
          }
          if (terminal) break;
        }
      } finally {
        await eventStream.return?.();
      }
      if (timedOut) {
        log.info("comment", "reply-skip", {
          reason: "policy-expired",
          commentScopeId: runScopeId
        });
        await postCommentReply(channel, target, evt, "\u672C\u6B21\u8BC4\u8BBA\u4EFB\u52A1\u5DF2\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0 @ \u6211\u3002", {
          isWhole: ctx.isWhole
        }).catch((err) => {
          log.fail("comment", err, { step: "postTimeoutReply" });
        });
        return;
      }
      if (execution.handle.interrupted) {
        log.info("comment", "reply-skip", {
          reason: "interrupted",
          commentScopeId: runScopeId
        });
        return;
      }
      let reply2 = stripMarkdown(answer.trim());
      if (errorMsg) reply2 = `\u26A0\uFE0F Claude \u62A5\u9519\uFF1A${errorMsg}`;
      if (!reply2) reply2 = "\uFF08\u65E0\u56DE\u590D\u5185\u5BB9\uFF09";
      if (reply2.length > REPLY_MAX_CHARS) reply2 = `${reply2.slice(0, REPLY_MAX_CHARS - 1)}\u2026`;
      await postCommentReply(channel, target, evt, reply2, { isWhole: ctx.isWhole }).catch((err) => {
        log.fail("comment", err, { step: "postCommentReply" });
        log.warn("comment", "reply_failed", {
          commentScopeId: runScopeId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    } finally {
      agentSessionRun.release();
    }
  } finally {
    if (reactionAdded && ctx.targetReplyId) {
      await channel.comments.removeReaction(target, ctx.targetReplyId);
    }
  }
}
async function fetchCommentContext(channel, target, evt) {
  const fetched = await channel.comments.fetch(target, evt.commentId);
  const replies = fetched?.replies ?? [];
  const parsed = extractCommentQuestionFromReplies({ replyId: evt.replyId, replies });
  return {
    question: parsed?.question ?? "",
    quote: fetched?.quote,
    isWhole: Boolean(fetched?.isWhole),
    targetReplyId: parsed?.targetReplyId
  };
}
function extractCommentQuestionFromReplies(input) {
  let targetReply;
  if (input.replyId) {
    targetReply = input.replies.find((reply2) => reply2.reply_id === input.replyId);
  }
  targetReply ??= input.replies.at(-1);
  if (!targetReply) return null;
  const elements = targetReply.content?.elements ?? [];
  const question = elements.map((el) => {
    if (el.type === "text_run") return el.text_run?.text ?? "";
    if (el.type === "docs_link") return el.docs_link?.url ?? "";
    return "";
  }).join("").trim();
  return { question, targetReplyId: targetReply.reply_id };
}
function buildCommentPrompt(target, ctx) {
  const docUrl = `https://feishu.cn/${target.fileType}/${target.fileToken}`;
  const parts = [];
  parts.push("\u6211\u5728\u98DE\u4E66\u4E91\u6587\u6863\u91CC\u88AB @\u4E86\u3002\u6587\u6863\u4FE1\u606F\uFF1A");
  parts.push(`- \u94FE\u63A5\uFF1A${docUrl}`);
  parts.push(`- file_token\uFF1A${target.fileToken}`);
  parts.push(`- \u7C7B\u578B\uFF1A${target.fileType}`);
  parts.push(
    `- \u8BC4\u8BBA\u8303\u56F4\uFF1A${ctx.isWhole ? "\u5168\u6587\u8BC4\u8BBA\uFF08\u9488\u5BF9\u6574\u7BC7\uFF09" : "\u884C\u5185\u8BC4\u8BBA\uFF08\u9488\u5BF9\u9009\u4E2D\u6587\u5B57\uFF09"}`
  );
  if (ctx.quote) {
    parts.push("");
    parts.push(`\u7528\u6237\u9009\u4E2D\u7684\u539F\u6587\uFF1A
> ${ctx.quote.replace(/\n/g, "\n> ")}`);
  }
  parts.push("");
  parts.push(`\u7528\u6237\u7684\u95EE\u9898\uFF1A${ctx.question}`);
  parts.push("");
  parts.push(commentReadInstruction(target));
  parts.push("");
  parts.push(
    "\u8BC4\u8BBA\u56DE\u590D\u7531 bridge \u8D1F\u8D23\uFF1A\u4E0D\u8981\u8C03\u7528\u4E91\u6587\u6863\u8BC4\u8BBA\u6216\u56DE\u590D\u63A5\u53E3\uFF0C\u4E5F\u4E0D\u8981\u7ED9\u8BC4\u8BBA\u6DFB\u52A0\u6216\u5220\u9664 reaction\uFF1B\u6700\u7EC8\u7B54\u6848\u76F4\u63A5\u7528\u7EAF\u6587\u672C\u4EA4\u7ED9 bridge\u3002"
  );
  parts.push("");
  parts.push(
    "\u56DE\u590D\u8981\u6C42\uFF1A\u76F4\u63A5\u7528\u7EAF\u6587\u672C\uFF0C\u4E0D\u8981 markdown\uFF08\u4E0D\u8981 ** __ # - * > ` \u4E4B\u7C7B\u7684\u6807\u8BB0\uFF09\uFF0C\u4E0D\u8981\u4EE3\u7801\u5757\uFF1B\u4E0D\u8981\u8F93\u51FA\u5185\u90E8\u601D\u8003\u3001\u5185\u90E8\u5206\u6790\u3001\u8BFB\u53D6\u6B65\u9AA4\u3001\u5DE5\u5177\u8C03\u7528\u8FC7\u7A0B\u6216\u5DE5\u5177\u65E5\u5FD7\u3002\u82E5\u7528\u6237\u8981\u6C42\u89E3\u91CA\u4F9D\u636E\uFF0C\u53EA\u8BF4\u660E\u7528\u6237\u53EF\u89C1\u7684\u4F9D\u636E\u548C\u7ED3\u8BBA\u3002\u4E91\u6587\u6863\u8BC4\u8BBA\u6846\u4E0D\u6E32\u67D3 markdown\uFF0C\u4F1A\u539F\u6837\u663E\u793A\u8FD9\u4E9B\u7B26\u53F7\u3002"
  );
  return parts.join("\n");
}
function recordCommentSessionEvent(input) {
  const event = input.event.type === "system" ? { ...input.event, cwd: input.policy.cwdRealpath } : input.event;
  recordRunSessionEvent({ ...input, event });
}
function commentRunRejectedReply(code) {
  switch (code) {
    case "run-already-active":
      return "\u5F53\u524D\u8BC4\u8BBA\u7EBF\u7A0B\u5DF2\u6709\u4EFB\u52A1\u5728\u6267\u884C\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
    case "pool-full":
      return "\u5F53\u524D\u4EFB\u52A1\u8F83\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
    case "reconnect-in-progress":
      return "\u5F53\u524D bot \u6B63\u5728\u91CD\u8FDE\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
    case "policy-expired":
      return "\u672C\u6B21\u8BC4\u8BBA\u4EFB\u52A1\u5DF2\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0 @ \u6211\u3002";
  }
}
function commentExecutionScopeId(commentThreadScopeId) {
  return `${commentThreadScopeId}:${randomUUID3().slice(0, 12)}`;
}
function commentDocumentSessionScopeId(fileToken) {
  return `doc:${commentTokenDigest(fileToken)}`;
}
function legacyCommentDocumentSessionScopeId(fileToken) {
  return `doc:${fileToken}`;
}
function markCommentAgentSessionRun(scopeId) {
  const count = activeCommentAgentSessionRuns.get(scopeId) ?? 0;
  activeCommentAgentSessionRuns.set(scopeId, count + 1);
  let released = false;
  return {
    wasActive: count > 0,
    release() {
      if (released) return;
      released = true;
      const next = (activeCommentAgentSessionRuns.get(scopeId) ?? 1) - 1;
      if (next > 0) {
        activeCommentAgentSessionRuns.set(scopeId, next);
      } else {
        activeCommentAgentSessionRuns.delete(scopeId);
      }
    }
  };
}
async function resolveCommentWorkingDirectory(configuredCwd, defaultCwd, managedFallbackCwd) {
  const failures = [];
  if (configuredCwd) {
    const configured = await resolveWorkingDirectory(configuredCwd);
    if (configured.ok) return configured;
    failures.push(configured.userVisible);
    if (defaultCwd) {
      const fallback = await resolveWorkingDirectory(defaultCwd);
      if (fallback.ok) {
        return {
          ...fallback,
          fallback: {
            from: "document",
            to: "profile-default",
            reason: configured.reason
          }
        };
      }
      failures.push(fallback.userVisible);
      return resolveManagedCommentWorkingDirectory(
        managedFallbackCwd,
        "document/profile-default",
        fallback.reason,
        failures
      );
    }
    return resolveManagedCommentWorkingDirectory(managedFallbackCwd, "document", configured.reason, failures);
  }
  if (!defaultCwd) {
    return resolveManagedCommentWorkingDirectory(
      managedFallbackCwd,
      "missing-default",
      "missing-default-cwd",
      failures
    );
  }
  const workspace = await resolveWorkingDirectory(defaultCwd);
  if (workspace.ok) return workspace;
  failures.push(workspace.userVisible);
  return resolveManagedCommentWorkingDirectory(managedFallbackCwd, "profile-default", workspace.reason, failures);
}
async function resolveManagedCommentWorkingDirectory(managedFallbackCwd, fallbackFrom, fallbackReason, failures) {
  try {
    await mkdir14(managedFallbackCwd, { recursive: true, mode: 448 });
  } catch (err) {
    return {
      ok: false,
      requestedCwd: managedFallbackCwd,
      cwdRealpath: managedFallbackCwd,
      reason: "managed-fallback-unavailable",
      userVisible: [
        ...failures,
        `\u6258\u7BA1\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u53EF\u7528\uFF1A${err instanceof Error ? err.message : String(err)}`
      ].join("\uFF1B")
    };
  }
  const workspace = await resolveWorkingDirectory(managedFallbackCwd);
  if (workspace.ok) {
    return {
      ...workspace,
      fallback: {
        from: fallbackFrom,
        to: "managed-default",
        reason: fallbackReason
      }
    };
  }
  return {
    ok: false,
    requestedCwd: managedFallbackCwd,
    cwdRealpath: managedFallbackCwd,
    reason: workspace.reason,
    userVisible: [...failures, workspace.userVisible].join("\uFF1B")
  };
}
function managedDefaultWorkspaceForComments(controls) {
  return resolveAppPaths({
    rootDir: dirname15(controls.configPath),
    profile: controls.profile
  }).defaultWorkspaceDir;
}
function commentReadInstruction(target) {
  if (target.fileType === "doc" || target.fileType === "docx") {
    return `\u8BFB\u53D6\u6587\u6863\u5185\u5BB9\uFF1A\u4F18\u5148\u4F7F\u7528\u5F53\u524D docs v2 \u8BFB\u53D6\u547D\u4EE4\uFF1A
  \`lark-cli docs +fetch --api-version v2 --doc ${target.fileToken} --doc-format markdown\`
\u5982\u679C\u672C\u673A lark-cli \u4E0D\u652F\u6301\u4E0A\u8FF0\u53C2\u6570\uFF0C\u4E0D\u8981\u5728\u540C\u4E00\u9519\u8BEF\u4E0A\u53CD\u590D\u91CD\u8BD5\uFF1B\u4F7F\u7528\u5F53\u524D\u53EF\u7528\u7684\u7B49\u4EF7\u8BFB\u53D6\u547D\u4EE4\u8BFB\u53D6\u540C\u4E00 file_token\u3002`;
  }
  if (target.fileType === "sheet") {
    return "\u8BFB\u53D6\u8868\u683C\u5185\u5BB9\uFF1A\u8FD9\u662F sheet \u7C7B\u578B\uFF0C\u4E0D\u8981\u4F7F\u7528 docs +fetch\u3002\u8BF7\u6309\u5F53\u524D\u53EF\u7528\u7684\u8868\u683C\u8BFB\u53D6\u5DE5\u5177\u6216\u672C\u673A lark-cli \u652F\u6301\u7684\u8868\u683C\u8BFB\u53D6\u547D\u4EE4\u8BFB\u53D6\u540C\u4E00 file_token\uFF1B\u5982\u679C\u547D\u4EE4\u53C2\u6570\u4E0D\u517C\u5BB9\uFF0C\u4E0D\u8981\u5728\u540C\u4E00\u9519\u8BEF\u4E0A\u53CD\u590D\u91CD\u8BD5\u3002";
  }
  return "\u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\uFF1A\u8FD9\u662F file \u7C7B\u578B\uFF0C\u4E0D\u8981\u4F7F\u7528 docs +fetch\u3002\u8BF7\u6309\u5F53\u524D\u53EF\u7528\u7684\u4E91\u7A7A\u95F4\u6587\u4EF6\u5DE5\u5177\u6216\u672C\u673A lark-cli \u652F\u6301\u7684\u6587\u4EF6\u8BFB\u53D6/\u4E0B\u8F7D\u547D\u4EE4\u5904\u7406\u540C\u4E00 file_token\uFF1B\u5982\u679C\u547D\u4EE4\u53C2\u6570\u4E0D\u517C\u5BB9\uFF0C\u4E0D\u8981\u5728\u540C\u4E00\u9519\u8BEF\u4E0A\u53CD\u590D\u91CD\u8BD5\u3002";
}
function isBridgeSelfReply(channel, evt) {
  const botOpenId = channel.botIdentity?.openId;
  if (botOpenId && evt.operator.openId === botOpenId) return true;
  const raw = evt;
  if (raw.bridgeReply === true) return true;
  if (raw.bridge_reply === true) return true;
  const metadata = raw.replyMetadata ?? raw.reply_metadata ?? raw.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const record = metadata;
  return record.bridge === true || record.bridgeReply === true || record.source === "lark-channel-bridge";
}
function stripMarkdown(s) {
  return s.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1").replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^[-*]\s+/gm, "").replace(/^>\s?/gm, "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}
function commentRunTimeoutMs(sessions, scopeId) {
  const scopeOverride = sessions.getIdleTimeoutMinutes(scopeId);
  if (scopeOverride !== void 0) {
    return scopeOverride > 0 ? scopeOverride * 6e4 : null;
  }
  return void 0;
}
async function nextCommentEvent(iterator, expiresAt) {
  if (expiresAt === void 0) {
    return iterator.next();
  }
  const delayMs = Math.max(0, expiresAt - Date.now() + 1);
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((resolve2) => {
        timer = setTimeout(() => resolve2("expired"), delayMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function postCommentReply(channel, target, evt, text, opts = {}) {
  await channel.comments.reply(target, evt.commentId, text, { topLevel: opts.isWhole });
}
function preview(text) {
  return text.length > 80 ? `${text.slice(0, 80)}\u2026` : text;
}

// src/bot/keepalive.ts
var KEEPALIVE_INTERVAL_MS = 15e3;
var SLEEP_DETECT_MS = 3e4;
var TIMER_STORM_GUARD_MS = 5e3;
var HTTP_PROBE_TIMEOUT_MS = 5e3;
var DEAD_THRESHOLD = 3;
var NETWORK_DOWN_LOG_EVERY = 20;
function startKeepalive(deps) {
  const { channel, domain, forceReconnect } = deps;
  let lastTick = 0;
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const sinceLast = lastTick > 0 ? now - lastTick : 0;
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) {
      return;
    }
    if (sinceLast > SLEEP_DETECT_MS) {
      log.info("keepalive", "wake-up", { sleptMs: sinceLast });
      consecutiveDown = 0;
      networkDownTicks = 0;
      lastTick = now;
      return;
    }
    lastTick = now;
    const status = channel.getConnectionStatus();
    if (!status) {
      return;
    }
    if (status.state === "connected") {
      if (consecutiveDown > 0) {
        log.info("keepalive", "recovered", { afterTicks: consecutiveDown });
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }
    const reachable = await httpProbe(domain);
    if (!reachable) {
      networkDownTicks++;
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        log.warn("network", "unreachable", { domain, networkDownTicks });
      }
      consecutiveDown = 0;
      return;
    }
    if (networkDownTicks > 0) {
      log.info("network", "reachable-again", { afterTicks: networkDownTicks });
      networkDownTicks = 0;
    }
    consecutiveDown++;
    log.warn("keepalive", "ws-stuck", {
      state: status.state,
      reconnectAttempts: status.reconnectAttempts,
      consecutiveDown
    });
    if (consecutiveDown >= DEAD_THRESHOLD) {
      log.warn("keepalive", "force-reconnect", { state: status.state });
      reportMetric("ws_reconnect", 1, { kind: "keepalive" });
      consecutiveDown = 0;
      try {
        await forceReconnect();
      } catch (err) {
        log.fail("keepalive", err, { step: "force-reconnect" });
      }
    }
  };
  const timer = setInterval(() => {
    void tick().catch((err) => log.fail("keepalive", err, { step: "tick" }));
  }, KEEPALIVE_INTERVAL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
async function httpProbe(domain) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(domain, { method: "HEAD", signal: ctrl.signal });
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// src/bot/pending-queue.ts
var PendingQueue = class {
  map = /* @__PURE__ */ new Map();
  blocked = /* @__PURE__ */ new Set();
  delayMs;
  onFlush;
  constructor(delayMs, onFlush) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }
  push(scope, msg) {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? void 0 : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? void 0 : this.armTimer(scope)
    });
    return 1;
  }
  cancel(scope) {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }
  cancelAll() {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }
  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope) {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = void 0;
    }
    log.info("queue", "blocked", { scope, queued: entry?.messages.length ?? 0 });
  }
  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope) {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info("queue", "unblocked", { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }
  armTimer(scope) {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }
  flush(scope) {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail("queue", err, { scope, batchSize: entry.messages.length });
    }
  }
};

// src/bot/quote.ts
import { normalize } from "@larksuite/channel";

// src/bot/interactive-card.ts
var INTERACTIVE_CARD_PLACEHOLDER = "[interactive card]";
function expandInteractiveCard(flattenedContent, rawJsonContent) {
  if (!rawJsonContent) return flattenedContent;
  const parsed = tryParseJson(rawJsonContent);
  if (parsed && typeof parsed.user_dsl === "string" && parsed.user_dsl.trim().length > 0) {
    return `<interactive_card>
${parsed.user_dsl}
</interactive_card>`;
  }
  if (parsed && parsed.schema === "2.0") {
    return `<interactive_card>
${rawJsonContent}
</interactive_card>`;
  }
  if (flattenedContent === INTERACTIVE_CARD_PLACEHOLDER) {
    return `<interactive_card>
${rawJsonContent}
</interactive_card>`;
  }
  return flattenedContent;
}
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return void 0;
  }
}

// src/bot/quote.ts
function preExpandInteractive(item) {
  if (item.msg_type !== "interactive") return item;
  const raw = item.body?.content;
  if (typeof raw !== "string" || raw.length === 0) return item;
  const expanded = expandInteractiveCard("[interactive card]", raw);
  if (expanded === "[interactive card]") return item;
  const wrapper = JSON.stringify({ tag: "plain_text", content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}
async function fetchQuotedContext(channel, messageId) {
  let items;
  try {
    items = await channel.fetchRawMessage(messageId, {
      cardContentType: "user_card_content"
    });
  } catch (err) {
    log.warn("quote", "fetch-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return void 0;
  const fetchSubMessages = async (mid) => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    try {
      const subItems = await channel.fetchRawMessage(mid, {
        cardContentType: "user_card_content"
      });
      return subItems.map(preExpandInteractive);
    } catch {
      return [];
    }
  };
  const senderOpenId = parent.sender?.id;
  const fakeRaw = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: "",
      chat_type: "group",
      message_type: parent.msg_type ?? "text",
      content: parent.body?.content ?? "",
      create_time: parent.create_time !== void 0 ? String(parent.create_time) : void 0,
      mentions: parent.mentions
    }
  };
  const botIdentity = channel.botIdentity ?? { openId: "", name: "" };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false
    });
    const createMs = parent.create_time ? Number.parseInt(String(parent.create_time), 10) : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? "",
      senderName: normalized.senderName,
      createdAt: Number.isFinite(createMs) && createMs > 0 ? new Date(createMs).toISOString() : "",
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? "text"
    };
  } catch (err) {
    log.warn("quote", "normalize-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}

// src/bot/reaction.ts
async function addWorkingReaction(channel, messageId) {
  try {
    const id = await channel.addReaction(messageId, "Typing");
    if (id) log.info("reaction", "added", { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn("reaction", "add-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
async function removeReaction(channel, messageId, reactionId) {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info("reaction", "removed", { messageId, reactionId });
  } catch (err) {
    log.warn("reaction", "remove-failed", {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}

// src/bot/cot.ts
var ENDPOINTS2 = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
var COT_UPDATE_THROTTLE_MS = 600;
var COT_TOOL_OUTPUT_MAX = 1200;
var COT_TEXT_MAX = 1200;
var CotClient = class {
  baseUrl;
  appId;
  appSecret;
  token;
  tokenExpiresAt = 0;
  constructor(opts) {
    this.baseUrl = ENDPOINTS2[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }
  async tenantToken() {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 6e4) return this.token;
    const resp = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret })
    });
    if (!resp.ok) throw new Error(`tenant token HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`tenant token failed: code=${data.code ?? "?"} msg=${data.msg ?? "<no msg>"}`);
    }
    this.token = data.tenant_access_token;
    const expireSeconds = typeof data.expire === "number" ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1e3;
    return this.token;
  }
  async request(path, init = {}) {
    const token = await this.tenantToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: `Bearer ${token}`,
        ...init.headers ?? {}
      }
    });
    if (!resp.ok) throw new Error(`COT HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text) return {};
    const data = JSON.parse(text);
    if (data.code !== void 0 && data.code !== 0) {
      throw new Error(`COT API failed: code=${data.code} msg=${data.msg ?? "<no msg>"}`);
    }
    return data.data ?? data;
  }
  async create(receiveId, originMessageId) {
    return this.request("/open-apis/im/v1/message_cot?receive_id_type=chat_id", {
      method: "POST",
      body: JSON.stringify({
        receive_id: receiveId,
        ...originMessageId ? { origin_message_id: originMessageId } : {}
      })
    });
  }
  async update(ref, events) {
    if (events.length === 0) return;
    await this.request("/open-apis/im/v1/message_cot", {
      method: "PUT",
      body: JSON.stringify({
        cot_id: ref.cotId,
        message_id: ref.messageId,
        events
      })
    });
  }
  async complete(ref, reason) {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: "POST",
      body: ""
    });
  }
};
var CotPublisher = class {
  client;
  chatId;
  originMessageId;
  runId;
  scope;
  inputPreview;
  ref;
  disabled = false;
  degradedReason;
  buffer = [];
  flushing;
  timer;
  constructor(opts) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.inputPreview = opts.inputPreview;
  }
  async start() {
    try {
      const created = await this.client.create(this.chatId, this.originMessageId);
      const cotId = stringValue3(created.cot_id ?? created.cotId);
      const messageId = stringValue3(created.message_id ?? created.messageId);
      if (!cotId || !messageId) {
        throw new Error(`CreateCOT missing ids: ${JSON.stringify(created).slice(0, 200)}`);
      }
      this.ref = { cotId, messageId };
      log.info("cot", "created", { cotId, messageId });
      this.enqueue("RUN_STARTED", {
        threadId: this.scope,
        runId: this.runId,
        input: { query: this.inputPreview }
      });
      this.enqueue("STEP_STARTED", {
        stepId: `step-understand-${this.runId}`,
        stepName: "\u7406\u89E3\u7528\u6237\u95EE\u9898"
      });
    } catch (err) {
      this.disabled = true;
      log.warn("cot", "create-failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }
  enqueue(eventType, content) {
    if (this.disabled || !this.ref) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      timestamp: Date.now()
    });
    this.scheduleFlush();
  }
  async finish(reason) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    await this.flush();
    if (this.disabled || !this.ref) return;
    try {
      await this.client.complete(this.ref, reason);
      log.info("cot", "completed", { cotId: this.ref.cotId, reason });
    } catch (err) {
      log.warn("cot", "complete-failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }
  scheduleFlush() {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }
  async flush() {
    if (this.disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this.disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0);
    if (events.length === 0) return;
    this.flushing = this.client.update(this.ref, events).catch((err) => {
      this.disabled = true;
      this.degradedReason = err instanceof Error ? err.message : String(err);
      log.warn("cot", "update-failed", { err: this.degradedReason });
    }).finally(() => {
      this.flushing = void 0;
      if (this.buffer.length > 0 && !this.disabled) this.scheduleFlush();
    });
    await this.flushing;
  }
};
function finalAnswerOnlyState(state) {
  return {
    ...state,
    blocks: state.blocks.filter((b) => b.kind === "text"),
    reasoning: { content: "", active: false },
    footer: null
  };
}
async function consumeCotEvents(events, publisher, opts) {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let textMessageId;
  const toolBrief = /* @__PURE__ */ new Map();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;
  try {
    for await (const evt of events) {
      if (evt.type === "system" || evt.type === "usage") continue;
      if (evt.type === "thinking") {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue("REASONING_START", { messageId: reasoningMessageId });
          publisher.enqueue("REASONING_MESSAGE_START", {
            messageId: reasoningMessageId,
            role: "reasoning"
          });
        }
        publisher.enqueue("REASONING_MESSAGE_CONTENT", {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX)
        });
        continue;
      }
      if (evt.type === "tool_use") {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === "detailed";
        const showSummary = opts.detail === "brief" || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, "running") : "\u6B63\u5728\u8C03\u7528\u5DE5\u5177";
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue("TOOL_CALL_START", {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : "default",
          title,
          toolCallName: showSummary ? evt.name : "tool"
        });
        if (detailed && evt.input !== void 0) {
          publisher.enqueue("TOOL_CALL_ARGS", {
            toolCallId,
            delta: JSON.stringify(evt.input)
          });
        }
        publisher.enqueue("TOOL_CALL_END", { toolCallId });
        continue;
      }
      if (evt.type === "tool_result") {
        const detailed = opts.detail === "detailed";
        const brief = toolBrief.get(evt.id);
        publisher.enqueue("TOOL_CALL_RESULT", {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: "tool",
          content: detailed ? truncateCot(evt.output ?? "", COT_TOOL_OUTPUT_MAX) : brief ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? "error" : "done") : "\u5DE5\u5177\u8C03\u7528\u5DF2\u5B8C\u6210"
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === "text") {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue("STEP_STARTED", {
            stepId: finalStepId,
            stepName: "\u8F93\u51FA\u8FC7\u7A0B"
          });
        }
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue("TEXT_MESSAGE_START", { messageId: textMessageId, role: "assistant" });
        }
        publisher.enqueue("TEXT_MESSAGE_CONTENT", {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX)
        });
        continue;
      }
      if (evt.type === "done" || evt.type === "error") {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue("STEP_FINISHED", {
            stepId: finalStepId,
            stepName: "\u8F93\u51FA\u8FC7\u7A0B"
          });
        }
        if (evt.type === "error") {
          publisher.enqueue("RUN_ERROR", { message: evt.message, code: evt.terminationReason ?? "error" });
          await publisher.finish("error");
        } else {
          const status = evt.terminationReason === "normal" ? "done" : evt.terminationReason ?? "done";
          publisher.enqueue("RUN_FINISHED", {
            threadId: publisher.scope,
            runId: publisher.runId,
            status
          });
          await publisher.finish(status === "done" ? "done" : "error");
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish("done");
  } catch (err) {
    log.warn("cot", "consume-failed", { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish("error");
  }
  function closeReasoningIfNeeded() {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue("REASONING_MESSAGE_END", { messageId: reasoningMessageId });
    publisher.enqueue("REASONING_END", { messageId: reasoningMessageId });
  }
  function closeTextIfNeeded() {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue("TEXT_MESSAGE_END", { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = void 0;
  }
}
function cotBriefToolTitle(name, input, status = "running") {
  return toolHeaderText({ id: "cot-tool", name, input, status }).replace(/\*\*/g, "");
}
function cotToolIcon(name) {
  const lower = String(name ?? "").toLowerCase();
  if (lower.includes("search") || lower.includes("grep") || lower.includes("rg")) return "search";
  if (lower.includes("read")) return "read";
  if (lower.includes("write") || lower.includes("edit")) return "write";
  if (lower.includes("doc")) return "doc";
  if (lower.includes("calendar")) return "calendar";
  if (lower.includes("task")) return "task";
  if (lower.includes("command") || lower.includes("bash")) return "bash";
  return "default";
}
function truncateCot(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
function stringValue3(value) {
  return typeof value === "string" ? value : void 0;
}

// src/bot/channel.ts
var DEBOUNCE_MS = 600;
var STREAM_TERMINAL_GRACE_MS = 3e3;
var REACTION_CLEANUP_GRACE_MS = 1e3;
var BRIDGE_AGENT_INSTRUCTIONS = [
  "\u4F60\u5728 bridge \u8FDB\u7A0B\u4E2D\u8FD0\u884C\uFF0C\u666E\u901A lark-cli \u4F1A\u7EE7\u627F LARK_CHANNEL=1 \u5E76\u8FDB\u5165 bridge-bound \u6A21\u5F0F\u3002",
  "\u4E0D\u8981 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR\uFF0C\u4E5F\u4E0D\u8981\u7528 env -u LARK_CHANNEL \u7ED5\u56DE\u672C\u673A\u666E\u901A\u914D\u7F6E\u3002",
  "Codex bridge \u9ED8\u8BA4\u4F7F\u7528 danger-full-access \u5BF9\u9F50 Claude bridge \u7684 bypassPermissions \u884C\u4E3A\uFF0C\u56E0\u6B64 lark-cli \u5E94\u80FD\u50CF\u7528\u6237\u672C\u673A\u7EC8\u7AEF\u4E00\u6837\u8BBF\u95EE keychain\u3002",
  "\u5982\u679C\u63D0\u793A lark-channel context detected but not bound\uFF0C\u505C\u6B62\u5F53\u524D\u64CD\u4F5C\u5E76\u8BF7\u7528\u6237\u91CD\u542F bridge \u6216\u8FD0\u884C bridge doctor/preflight\uFF1B\u4E0D\u8981\u6539\u7528\u666E\u901A profile\uFF0C\u4E0D\u8981\u81EA\u884C bind\uFF0C\u4E5F\u4E0D\u8981\u76F4\u63A5\u8BFB\u53D6 config.json \u91CC\u7684\u8D26\u53F7\u6216\u5BC6\u94A5\u3002"
];
var SUPPRESSED_API_ERROR_CODES = /* @__PURE__ */ new Set([
  131005,
  // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307,
  // drive.fileComment.get "not exist" — fall back to .list
  1069302
  // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);
var SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: "/open-apis/wiki/v2/spaces/get_node"
  }
];
function codeFromObj(m) {
  if (!m || typeof m !== "object") return void 0;
  const top = m.code;
  if (typeof top === "number") return top;
  const nested = m?.response?.data?.code;
  return typeof nested === "number" ? nested : void 0;
}
function urlFromObj(m) {
  if (!m || typeof m !== "object") return void 0;
  const configUrl = m?.config?.url;
  if (typeof configUrl === "string") return configUrl;
  const requestPath = m?.request?.path;
  return typeof requestPath === "string" ? requestPath : void 0;
}
function isSuppressedSdkMessage(msg) {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === void 0) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart)
  );
}
function shouldSuppressSdkErrorLog(args) {
  return args.some(isSuppressedSdkMessage);
}
function buildQuietLogger() {
  return {
    error: (...args) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn("sdk", "error", { args: stringifyArgs(args) });
    },
    warn: (...args) => log.warn("sdk", "warn", { args: stringifyArgs(args) }),
    info: (...args) => log.info("sdk", "info", { args: stringifyArgs(args) }),
    debug: () => {
    },
    trace: () => {
    }
  };
}
function stringifyArgs(args) {
  return args.map((a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
}
async function startChannel(deps) {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const contextBudget = deps.contextBudget ?? new ContextBudgetStore(
    deps.appPaths ? `${deps.appPaths.sessionsFile}.context-budget.json` : void 0
  );
  if (!deps.contextBudget) {
    await contextBudget.load();
  }
  const activeRuns = new ActiveRuns();
  const chatModeCache = new ChatModeCache();
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir ? new CallbackNonceStore(join20(dirname16(deps.appPaths.mediaDir), "callback-nonces.json")) : void 0;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore ? new CallbackAuth({
    keys: [{ version: 1, secret: appSecret }],
    nonceStore: callbackNonceStore
  }) : void 0;
  const activePolicyFingerprints = /* @__PURE__ */ new Map();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret
  });
  const threadModeOverrideWarnedChats = /* @__PURE__ */ new Set();
  const logThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info("chat", "mode-overridden-by-thread", fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn("chat", "mode-overridden-by-thread", fields);
  };
  const opts = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
    source: "lark-channel-bridge",
    logger: buildQuietLogger(),
    policy: {
      dmMode: "open",
      requireMention: false,
      respondToMentionAll: false
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false }
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8e3,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 3e4,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true
  };
  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info("flush", "start", {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        const mode = firstMsg.threadId ? "topic" : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== "topic") {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId
          });
        }
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          contextBudget,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          activePolicyFingerprints,
          scope,
          mode
        });
      } catch (err) {
        log.fail("flush", err);
      } finally {
        pending.unblock(scope);
        log.info("flush", "end");
      }
    });
  });
  let consecutiveReconnects = 0;
  channel.on({
    message: async (msg) => {
      await withTrace(
        { chatId: msg.chatId, msgId: msg.messageId },
        () => intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          contextBudget,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          executor,
          pool
        })
      ).catch((err) => log.fail("intake", err));
    },
    reject: (evt) => {
      log.info("intake", "reject", { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          contextBudget,
          workspaces,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope)
        });
      }).catch((err) => log.fail("cardAction", err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: "comment" }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls
        }).catch((err) => log.fail("comment", err));
      }).catch((err) => log.fail("comment", err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn("ws", "reconnecting", { consecutive: consecutiveReconnects });
      reportMetric("ws_reconnect", 1, { kind: "ws" });
      if (consecutiveReconnects === 3) {
        console.error("\u26A0\uFE0F \u5DF2\u8FDE\u7EED\u91CD\u8FDE 3 \u6B21,\u7F51\u7EDC\u53EF\u80FD\u4E0D\u7A33\u3002");
      } else if (consecutiveReconnects === 10) {
        console.error("\u274C \u5DF2\u8FDE\u7EED\u91CD\u8FDE 10 \u6B21,\u5EFA\u8BAE\u5728\u98DE\u4E66\u53D1 /reconnect \u6216\u91CD\u542F bot\u3002");
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info("ws", "recovered", { afterAttempts: consecutiveReconnects });
      } else {
        log.info("ws", "reconnected");
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail("network", err, { kind: "dns", code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail("network", err, { kind: "handshake-timeout", code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail("network", err, { kind: "timeout", code: err.code });
      } else {
        log.fail("ws", err, { code: err.code });
      }
    }
  });
  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);
  const identity = channel.botIdentity;
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...identity.name ? { name: identity.name } : {}
    });
  }
  log.info("ws", "connected", {
    bot: identity?.name ?? "unknown",
    openId: identity?.openId ?? "-",
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId
  });
  console.log("\u6B63\u5728\u76D1\u542C\u6D88\u606F\u3002\u6309 Ctrl+C \u9000\u51FA\u3002\n");
  const probeDomain = cfg.accounts.app.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart()
  });
  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns("bridge-disconnect");
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      pending.cancelAll();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        sessions.flush(),
        sessionCatalog?.flush(),
        contextBudget.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush()
      ]);
      if (stopAllResult.status === "rejected") {
        log.fail("disconnect", stopAllResult.reason, { step: "stopAll" });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === "rejected") {
          log.fail("disconnect", result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === "rejected") {
        throw disconnectResult.reason;
      }
    }
  };
}
function startKnownChatsRefreshTimer(channel, controls) {
  const intervalMs = 30 * 60 * 1e3;
  const refresh = async () => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    }
  };
}
async function sendNonAllowedGroupHint(channel, chatId, replyToMessageId) {
  const text = "\u5F53\u524D\u7FA4\u5C1A\u672A\u52A0\u5165\u54CD\u5E94\u5217\u8868\uFF0C\u6240\u4EE5 bot \u4E0D\u4F1A\u5904\u7406\u6D88\u606F\u3002\nBot owner/\u7BA1\u7406\u5458\u53EF\u5728\u672C\u7FA4\u53D1 /invite group \u52A0\u5165\u767D\u540D\u5355\u3002";
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}
async function intakeMessage(deps) {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    contextBudget,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool
  } = deps;
  const preview2 = msg.content.length > 80 ? `${msg.content.slice(0, 80)}\u2026` : msg.content;
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  const chatMode = msg.threadId ? "topic" : resolvedMode;
  if (msg.threadId && resolvedMode !== "topic") {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId: msg.threadId
    });
  }
  const scope = chatMode === "topic" && msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
  log.info("intake", "enter", {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId: msg.threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview: preview2,
    resources: msg.resources.length
  });
  const accessDecision = msg.chatType === "p2p" ? canUseDm(controls.profileConfig, controls, msg.senderId) : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info("intake", "skip-not-allowed-user", {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason
    });
    if (msg.chatType !== "p2p" && accessDecision.reason === "denied-chat" && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch(
        (err) => log.warn("intake", "non-allowed-hint-failed", { err: String(err) })
      );
    }
    return;
  }
  if (msg.chatType !== "p2p" && getRequireMentionInGroup(controls.cfg) && !msg.mentionedBot) {
    log.info("intake", "skip-no-mention", { scope, chatType: msg.chatType });
    return;
  }
  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    contextBudget,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision
    }),
    runExecutor: executor,
    processPool: pool,
    controls
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info("intake", "command", { scope, droppedPending: dropped.length });
    return;
  }
  const size = pending.push(scope, msg);
  log.info("intake", "queued", { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}
async function runAgentBatch(deps) {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    contextBudget,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    scope,
    mode
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;
  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;
  const resourceItems = batch.flatMap(
    (m) => m.resources.map((r) => ({ messageId: m.messageId, resource: r }))
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info("media", "resolved", { count: attachments.length });
    for (const attachment of attachments) {
      log.info("attachment", "decision", {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason
      });
    }
  }
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch.map((m) => replyQuoteTargetForMessage(m, mode)).filter((id) => Boolean(id) && !batchIds.has(id))
    )
  ];
  const quotes = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info("quote", "fetched", {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length
      });
    }
  }
  const prompt = buildPrompt(batch, attachments, quotes, channel.botIdentity);
  log.info("prompt", "built", { promptChars: prompt.length, quotes: quotes.length });
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...mode === "topic" && threadId ? { replyInThread: true } : {}
  };
  log.info("flush", "reply-target", {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true
  });
  const accessDecision = firstMsg.chatType === "p2p" ? canUseDm(controls.profileConfig, controls, firstMsg.senderId) : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext = {
    source: "im",
    chatId,
    actorId: firstMsg.senderId,
    ...threadId ? { threadId } : {}
  };
  const capability = controls.profileConfig.agentKind === "codex" ? codexCapability(controls.profileConfig) : claudeCapability(controls.profileConfig);
  const contextBudgetConfig = getAutoNewSessionConfig(controls.cfg);
  const resetBeforeRun = contextBudget.pendingResetFor(scope, contextBudgetConfig);
  if (resetBeforeRun) {
    log.info("context-budget", "auto-new-before-run", {
      scope,
      reason: resetBeforeRun.code,
      inputTokens: resetBeforeRun.inputTokens,
      turns: resetBeforeRun.turns
    });
  }
  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    forceNewSession: Boolean(resetBeforeRun),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: "im",
      stage: "submit"
    }
  });
  if (!flow.ok) {
    log.info("run-flow", "rejected", { scope, code: flow.rejectReason.code });
    log.warn("policy", "denied", {
      scope,
      source: "im",
      code: flow.rejectReason.code
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }
  const { execution, cwdRealpath: cwd } = flow;
  if (resetBeforeRun) {
    contextBudget.reset(scope);
    await channel.send(chatId, { markdown: formatContextBudgetResetNotice(resetBeforeRun) }, sendOpts).catch(
      (err) => log.warn("context-budget", "auto-new-notice-failed", {
        scope,
        err: err instanceof Error ? err.message : String(err)
      })
    );
  }
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  let runInputTokens;
  let runErrorMessage;
  const eventStream = observeContextBudgetEvents(execution.subscribe(), (evt) => {
    if (evt.type === "usage" && evt.inputTokens !== void 0) {
      runInputTokens = evt.inputTokens;
    } else if (evt.type === "error") {
      runErrorMessage = evt.message;
    }
  });
  if (flow.resumeFrom) {
    log.info("session", "resume", { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info("session", "fresh", { cwd });
  }
  const recordSession = (evt) => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt
    });
    if (evt.type === "system" && evt.sessionId) {
      log.info("session", "set", { sessionId: evt.sessionId });
    }
    if (evt.type === "system" && evt.threadId) {
      log.info("session", "set-thread", { threadId: evt.threadId });
    }
  };
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs = scopeOverride !== void 0 ? scopeOverride > 0 ? scopeOverride * 6e4 : void 0 : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info("flush", "idle-watchdog", { idleTimeoutMs });
  }
  const replyMode = getMessageReplyMode(controls.cfg);
  log.info("flush", "reply-mode", { mode: replyMode });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = cotMessages !== "off";
  const cardRenderOptions = callbackAuth ? {
    signCallback: (action) => callbackAuth.sign({
      runId: execution.runId,
      scope,
      chatId,
      operatorOpenId: firstMsg.senderId,
      action,
      policyFingerprint: flow.policy.policyFingerprint,
      ttlMs: 24 * 60 * 60 * 1e3
    })
  } : {};
  const renderRunCard = (state) => renderCard(state, {
    ...cardRenderOptions,
    presentationMode: getPresentationMode(controls.cfg)
  });
  const renderRunText = (state) => renderText(state, { presentationMode: getPresentationMode(controls.cfg) });
  const reactionPromise = cotEnabled || replyMode === "card" ? void 0 : addWorkingReaction(channel, lastMsg.messageId);
  let finalState;
  try {
    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: cotClient,
        chatId,
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages
        });
        const finalState2 = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          recordSession,
          async () => {
          }
        );
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason
          });
        }
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState2),
          replyMode,
          sendOpts,
          cardRenderOptions
        });
        return;
      }
      log.warn("cot", "fallback-existing-reply", { reason: "create-disabled" });
    }
    if (replyMode === "card") {
      let latestState = initialState;
      let producerStarted = false;
      let cardCtrl;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (cardCtrl) {
            await cardCtrl.update(renderRunCard(state));
          }
        }
      );
      const streamDone = channel.stream(
        chatId,
        {
          card: {
            initial: renderRunCard(initialState),
            producer: async (ctrl) => {
              producerStarted = true;
              cardCtrl = ctrl;
              await ctrl.update(renderRunCard(latestState));
              await renderDone;
            }
          }
        },
        sendOpts
      );
      await awaitRenderAwareStream({
        mode: replyMode,
        streamDone,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          await channel.send(
            chatId,
            { card: renderRunCard(state) },
            sendOpts
          );
        }
      });
      finalState = await renderDone;
    } else if (replyMode === "markdown") {
      let latestState = initialState;
      let producerStarted = false;
      let markdownCtrl;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (markdownCtrl) {
            await markdownCtrl.setContent(renderRunText(state));
          }
        }
      );
      const streamDone = channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            producerStarted = true;
            markdownCtrl = ctrl;
            await ctrl.setContent(renderRunText(latestState));
            await renderDone;
          }
        },
        sendOpts
      );
      await awaitRenderAwareStream({
        mode: replyMode,
        streamDone,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          const body = renderRunText(state);
          if (body.trim()) {
            await channel.send(chatId, { markdown: body }, sendOpts);
          }
        }
      });
      finalState = await renderDone;
    } else {
      finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {
        }
      );
      const body = renderRunText(finalState);
      if (body.trim()) {
        await channel.send(chatId, { markdown: body }, sendOpts);
      }
    }
  } catch (err) {
    log.fail("stream", err);
  } finally {
    if (finalState) {
      const resetAfterRun = contextBudget.recordRunResult(
        scope,
        {
          terminal: contextBudgetTerminal(finalState),
          ...runInputTokens !== void 0 ? { inputTokens: runInputTokens } : {},
          ...runErrorMessage ?? finalState.errorMsg ? { errorMessage: runErrorMessage ?? finalState.errorMsg } : {}
        },
        contextBudgetConfig
      );
      if (resetAfterRun?.code === "context-error") {
        archiveRunSession({
          scope,
          sessions,
          sessionCatalog,
          capability,
          policyFingerprint: flow.policy.policyFingerprint,
          cwdRealpath: flow.policy.cwdRealpath
        });
        contextBudget.reset(scope);
        await channel.send(chatId, { markdown: formatContextBudgetResetNotice(resetAfterRun) }, sendOpts).catch(
          (noticeErr) => log.warn("context-budget", "context-error-notice-failed", {
            scope,
            err: noticeErr instanceof Error ? noticeErr.message : String(noticeErr)
          })
        );
      } else if (resetAfterRun) {
        log.info("context-budget", "auto-new-pending", {
          scope,
          reason: resetAfterRun.code,
          inputTokens: resetAfterRun.inputTokens,
          turns: resetAfterRun.turns
        });
      }
    }
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}
function observeContextBudgetEvents(events, observe) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        observe(event);
        yield event;
      }
    }
  };
}
function contextBudgetTerminal(state) {
  if (state.terminal === "interrupted") return "interrupted";
  if (state.terminal === "error") return "error";
  if (state.terminal === "idle_timeout") return "idle_timeout";
  return "done";
}
function archiveRunSession(input) {
  input.sessionCatalog?.archiveActive({
    scopeId: input.scope,
    agentId: input.capability.agentId,
    cwdRealpath: input.cwdRealpath,
    policyFingerprint: input.policyFingerprint,
    now: Date.now()
  });
  input.sessions.clear(input.scope);
}
async function sendFinalReply(input) {
  const body = renderText(input.state);
  if (input.replyMode === "card") {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      input.sendOpts
    );
    log.info("outbound", "sent", outboundLogFields(input, "card", body, result));
  } else if (input.replyMode === "markdown") {
    if (body.trim()) {
      try {
        await input.channel.stream(
          input.chatId,
          {
            markdown: async (ctrl) => {
              await ctrl.setContent(body);
            }
          },
          input.sendOpts
        );
        log.info("outbound", "sent", outboundLogFields(input, "markdown-stream", body));
      } catch (err) {
        log.warn("outbound", "markdown-stream-fallback", {
          err: err instanceof Error ? err.message : String(err)
        });
        const result = await input.channel.send(
          input.chatId,
          { markdown: body },
          input.sendOpts
        );
        log.info("outbound", "sent", outboundLogFields(input, "markdown", body, result));
      }
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts
    );
    log.info("outbound", "sent", outboundLogFields(input, "text", body, result));
  }
}
async function sendCotDegradedNotice(input) {
  log.warn("cot", "degraded", {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: "COT \u8FC7\u7A0B\u6D88\u606F\u66F4\u65B0\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u5C55\u793A\u8FC7\u7A0B\uFF1B\u6700\u7EC8\u7B54\u6848\u4ECD\u4F1A\u7EE7\u7EED\u53D1\u9001\u3002" },
      input.sendOpts
    );
  } catch (err) {
    log.warn("cot", "degraded-notice-failed", {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}
function outboundLogFields(input, type, body, result) {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true
  };
}
async function processAgentStream(handle, events, scope, idleTimeoutMs, recordSession, flush) {
  const runStart2 = Date.now();
  let state = initialState;
  let idleFired = false;
  let timer;
  const inFlightTools = /* @__PURE__ */ new Set();
  const armOrPauseIdle = () => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = void 0;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn("agent", "idle-timeout", { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();
  try {
    for await (const evt of events) {
      if (handle.interrupted) break;
      if (evt.type === "tool_use") {
        inFlightTools.add(evt.id);
        log.info("agent", "tool-in-flight", {
          tool: evt.name,
          inFlight: inFlightTools.size
        });
      } else if (evt.type === "tool_result") {
        inFlightTools.delete(evt.id);
        log.info("agent", "tool-done", { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();
      if (evt.type === "system") {
        recordSession(evt);
        continue;
      }
      if (evt.type === "usage") {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== void 0 || inputTokens !== void 0 || outputTokens !== void 0) {
          log.info("agent", "usage", {
            ...costUsd !== void 0 ? { costUsd: Number(costUsd.toFixed(4)) } : {},
            ...inputTokens !== void 0 ? { inputTokens } : {},
            ...outputTokens !== void 0 ? { outputTokens } : {}
          });
          if (costUsd !== void 0) reportMetric("cost_usd", costUsd);
          if (inputTokens !== void 0) reportMetric("tokens_in", inputTokens);
          if (outputTokens !== void 0) reportMetric("tokens_out", outputTokens);
        }
        continue;
      }
      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info("card", "transition", { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      if (state.terminal !== "running") break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (state.terminal === "running") {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs / 6e4));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info("card", "final", { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric("run_e2e_ms", Date.now() - runStart2, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}
async function awaitRenderAwareStream(input) {
  const streamResult = input.streamDone.then(
    () => ({ kind: "stream", ok: true }),
    (err) => ({ kind: "stream", ok: false, err })
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: "render", ok: true, state }),
    (err) => ({ kind: "render", ok: false, err })
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === "stream") {
      log.fail("stream", first.err, { mode: input.mode, step: "stream" });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }
  if (first.kind === "stream") {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }
  if (!input.producerStarted()) {
    log.warn("stream", "producer-not-started-before-agent-terminal", { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => void 0)
  ]);
  if (!terminal) {
    log.warn("stream", "terminal-grace-expired", {
      mode: input.mode,
      graceMs: STREAM_TERMINAL_GRACE_MS
    });
    void streamResult.then((result) => {
      if (!result.ok) {
        log.fail("stream", result.err, { mode: input.mode, step: "stream-terminal-late" });
      }
    });
    return;
  }
  if (!terminal.ok) throw terminal.err;
}
async function runFallbackReply(mode, state, fallback) {
  try {
    await fallback(state);
  } catch (err) {
    log.fail("stream", err, { mode, step: "fallback" });
  }
}
function scheduleWorkingReactionCleanup(channel, messageId, reactionPromise) {
  if (!reactionPromise) return;
  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true, reactionId }),
      (err) => ({ ok: false, err })
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => void 0)
    ]);
    if (!settled) {
      log.warn("reaction", "cleanup-deferred", {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }
    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}
function delay(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function buildPrompt(batch, attachments, quotes = [], botIdentity) {
  const first = batch[0];
  if (!first) return "";
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const annotate = batch.length > 1;
  const texts = batch.map((m) => {
    const text = stripAttachmentRefs(m.content, fileKeys).trim();
    if (!text) return "";
    return annotate ? `${senderAnnotation(m)} ${text}` : text;
  }).filter(Boolean);
  const userPart = texts.length > 0 ? texts.join("\n\n") : attachments.length > 0 ? "\u8BF7\u770B\u4E0B\u9762\u7684\u9644\u4EF6\u3002" : "\uFF08\u5BF9\u65B9\u53D1\u6765\u4E00\u6761\u6CA1\u6709\u6B63\u6587\u7684\u6D88\u606F\u2014\u2014\u901A\u5E38\u662F\u53EA @ \u4E86\u4F60\u7684\u5524\u9192\uFF08ping\uFF09\u3002\u8BF7\u7B80\u77ED\u56DE\u5E94\u3002\uFF09";
  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);
  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...first.senderName ? { senderName: first.senderName } : {},
      ...senderType ? { senderType } : {},
      ...botIdentity?.openId ? { botOpenId: botIdentity.openId } : {},
      ...mentions.length > 0 ? { mentions } : {},
      ...first.threadId ? { threadId: first.threadId } : {},
      messageIds: batch.map((m) => m.messageId),
      source: "im"
    },
    instructions: BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment)
  });
}
function senderTypeOf(msg) {
  const raw = msg.raw;
  const senderType = raw?.sender?.sender_type;
  if (senderType === "user") return "user";
  if (senderType === "app" || senderType === "bot") return "bot";
  return void 0;
}
function senderAnnotation(msg) {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}
function mergeMentions(batch) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ""}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...mention.openId ? { openId: mention.openId } : {},
        ...mention.name ? { name: mention.name } : {},
        ...mention.isBot !== void 0 ? { isBot: mention.isBot } : {}
      });
    }
  }
  return out;
}
function replyQuoteTargetForMessage(msg, mode) {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return void 0;
  if (mode === "topic" && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return void 0;
  }
  return replyTo;
}
function stripAttachmentRefs(text, fileKeys) {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, "g"), "");
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        "gi"
      ),
      ""
    );
  }
  return out.replace(/\n{3,}/g, "\n\n");
}
function toPromptQuote(q) {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...q.senderName ? { senderName: q.senderName } : {},
    ...q.createdAt ? { createdAt: q.createdAt } : {},
    rawContentType: q.rawContentType,
    content: q.content
  };
}
function toPromptInteractiveCard(m) {
  if (m.rawContentType !== "interactive") return void 0;
  const rawContent = m.raw?.message?.content;
  if (typeof rawContent !== "string" || rawContent.length === 0) return void 0;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent)
  };
}
function parseJsonOrRaw(input) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
function isDefined(value) {
  return value !== void 0;
}

// src/session/store.ts
import { readFile as readFile14 } from "fs/promises";
var SessionStore = class {
  data = {};
  saving = Promise.resolve();
  path;
  constructor(path = paths.sessionsFile) {
    this.path = path;
  }
  async load() {
    try {
      const text = await readFile14(this.path, "utf8");
      const raw = JSON.parse(text);
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== "number") continue;
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : void 0;
        const cwd = typeof entry.cwd === "string" ? entry.cwd : void 0;
        const idleTimeoutMinutes = typeof entry.idleTimeoutMinutes === "number" ? entry.idleTimeoutMinutes : void 0;
        const hasSession = sessionId !== void 0 && cwd !== void 0;
        if (!hasSession && idleTimeoutMinutes === void 0) continue;
        this.data[chatId] = {
          ...sessionId !== void 0 ? { sessionId } : {},
          ...cwd !== void 0 ? { cwd } : {},
          updatedAt: entry.updatedAt,
          ...idleTimeoutMinutes !== void 0 ? { idleTimeoutMinutes } : {}
        };
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId, cwd) {
    const entry = this.data[chatId];
    if (!entry) return void 0;
    if (entry.cwd !== cwd) return void 0;
    return entry.sessionId;
  }
  getRaw(chatId) {
    return this.data[chatId];
  }
  set(chatId, sessionId, cwd) {
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...prev?.idleTimeoutMinutes !== void 0 ? { idleTimeoutMinutes: prev.idleTimeoutMinutes } : {}
    };
    this.schedulePersist();
  }
  clear(chatId) {
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.idleTimeoutMinutes !== void 0) {
      this.data[chatId] = {
        idleTimeoutMinutes: prev.idleTimeoutMinutes,
        updatedAt: Date.now()
      };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }
  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId) {
    return this.data[chatId]?.idleTimeoutMinutes;
  }
  setIdleTimeoutMinutes(chatId, minutes) {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...prev ?? { updatedAt: Date.now() },
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now()
    };
    this.schedulePersist();
  }
  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId) {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === void 0) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    this.saving = this.saving.then(async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}
`, {
        mode: 384
      });
    }).catch((err) => {
      log.fail("session", err, { step: "persist" });
    });
  }
};

// src/session/catalog.ts
import { randomUUID as randomUUID4 } from "crypto";
import { open as open3, readFile as readFile15, rename as rename5, mkdir as mkdir15 } from "fs/promises";
import { dirname as dirname17 } from "path";
var DEFAULT_MAX_ARCHIVED_AGE_MS = 90 * 24 * 60 * 60 * 1e3;
var DEFAULT_MAX_ENTRIES_PER_SCOPE = 20;
var DEFAULT_MAX_ENTRIES_PER_PROFILE = 1e3;
var KEY_SEPARATOR = "";
function sessionCatalogKey(input) {
  return [
    input.scopeId,
    input.agentId,
    input.cwdRealpath,
    input.policyFingerprint
  ].join(KEY_SEPARATOR);
}
var SessionCatalog = class {
  data = /* @__PURE__ */ new Map();
  saving = Promise.resolve();
  path;
  constructor(path = `${paths.sessionsFile}.catalog.json`) {
    this.path = path;
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile15(this.path, "utf8"));
      if (!Array.isArray(raw)) {
        this.data.clear();
        return;
      }
      this.data.clear();
      for (const item of raw) {
        const entry = normalizeEntry2(item);
        if (!entry) continue;
        this.data.set(entry.key, entry);
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      log.fail("session-catalog", err, { step: "load" });
      this.data.clear();
    }
  }
  activeFor(input) {
    const entry = this.data.get(sessionCatalogKey(input));
    if (!entry || entry.status !== "active") return void 0;
    if (!matchesIdentity(entry, input)) return void 0;
    if (!isValidAgentEntry(entry)) {
      log.warn("session-catalog", "damaged-entry", {
        key: entry.key,
        agentId: entry.agentId
      });
      return void 0;
    }
    return { ...entry };
  }
  upsertActive(input) {
    assertAgentIdentity(input);
    const key = sessionCatalogKey(input);
    const entry = {
      key,
      scopeId: input.scopeId,
      agentId: input.agentId,
      cwdRealpath: input.cwdRealpath,
      policyFingerprint: input.policyFingerprint,
      status: "active",
      updatedAt: input.now ?? Date.now(),
      ...input.sessionId ? { sessionId: input.sessionId } : {},
      ...input.threadId ? { threadId: input.threadId } : {},
      ...input.lastSummary ? { lastSummary: input.lastSummary } : {}
    };
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }
  archiveActive(input) {
    const key = sessionCatalogKey(input);
    const entry = this.data.get(key);
    if (!entry || entry.status !== "active") return false;
    this.data.set(key, {
      ...entry,
      status: "archived",
      updatedAt: input.now ?? Date.now()
    });
    this.schedulePersist();
    return true;
  }
  entries() {
    return [...this.data.values()].map((entry) => ({ ...entry }));
  }
  gc(options = {}) {
    const now = options.now ?? Date.now();
    const maxArchivedAgeMs = options.maxArchivedAgeMs ?? DEFAULT_MAX_ARCHIVED_AGE_MS;
    const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    const maxEntriesPerProfile = options.maxEntriesPerProfile ?? DEFAULT_MAX_ENTRIES_PER_PROFILE;
    for (const [key, entry] of this.data.entries()) {
      if (entry.status === "archived" && now - entry.updatedAt > maxArchivedAgeMs) {
        this.data.delete(key);
      }
    }
    for (const scopeId of new Set([...this.data.values()].map((entry) => entry.scopeId))) {
      const scoped = [...this.data.values()].filter((entry) => entry.scopeId === scopeId).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const entry of scoped.slice(maxEntriesPerScope)) {
        this.data.delete(entry.key);
      }
    }
    const all = [...this.data.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of all.slice(maxEntriesPerProfile)) {
      this.data.delete(entry.key);
    }
    this.schedulePersist();
  }
  async flush() {
    await this.saving;
  }
  async replaceForTest(entries) {
    await this.saving;
    this.data = new Map(entries.map((entry) => [entry.key, { ...entry }]));
    await this.persist();
  }
  schedulePersist() {
    this.saving = this.saving.then(() => this.persist()).catch((err) => {
      log.fail("session-catalog", err, { step: "persist" });
    });
  }
  async persist() {
    await mkdir15(dirname17(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID4()}.tmp`;
    const payload = `${JSON.stringify(this.entries(), null, 2)}
`;
    const fh = await open3(tmp, "w", 384);
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename5(tmp, this.path);
    try {
      const dir = await open3(dirname17(this.path), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
    }
  }
};
function normalizeEntry2(input) {
  if (!input || typeof input !== "object") return void 0;
  const raw = input;
  if (typeof raw.key !== "string" || typeof raw.scopeId !== "string" || raw.agentId !== "claude" && raw.agentId !== "codex" || typeof raw.cwdRealpath !== "string" || typeof raw.policyFingerprint !== "string" || raw.status !== "active" && raw.status !== "archived" || typeof raw.updatedAt !== "number") {
    return void 0;
  }
  return {
    key: raw.key,
    scopeId: raw.scopeId,
    agentId: raw.agentId,
    cwdRealpath: raw.cwdRealpath,
    policyFingerprint: raw.policyFingerprint,
    status: raw.status,
    updatedAt: raw.updatedAt,
    ...typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {},
    ...typeof raw.threadId === "string" ? { threadId: raw.threadId } : {},
    ...typeof raw.lastSummary === "string" ? { lastSummary: raw.lastSummary } : {}
  };
}
function matchesIdentity(entry, input) {
  return entry.scopeId === input.scopeId && entry.agentId === input.agentId && entry.cwdRealpath === input.cwdRealpath && entry.policyFingerprint === input.policyFingerprint && entry.key === sessionCatalogKey(input);
}
function isValidAgentEntry(entry) {
  if (entry.agentId === "claude") return Boolean(entry.sessionId) && !entry.threadId;
  return Boolean(entry.threadId) && !entry.sessionId;
}
function assertAgentIdentity(input) {
  if (input.agentId === "claude") {
    if (!input.sessionId || input.threadId) {
      throw new Error("Claude catalog entries require sessionId and must not include threadId");
    }
    return;
  }
  if (!input.threadId || input.sessionId) {
    throw new Error("Codex catalog entries require threadId and must not include sessionId");
  }
}

// src/workspace/store.ts
import { readFile as readFile16 } from "fs/promises";
var WorkspaceStore = class {
  data = { chats: {}, named: {} };
  saving = Promise.resolve();
  path;
  constructor(path = paths.workspacesFile) {
    this.path = path;
  }
  async load() {
    try {
      const text = await readFile16(this.path, "utf8");
      const parsed = JSON.parse(text);
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {}
      };
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
  cwdFor(chatId) {
    return this.data.chats[chatId]?.cwd;
  }
  setCwd(chatId, cwd) {
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }
  removeCwd(chatId) {
    if (!(chatId in this.data.chats)) return false;
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }
  listCwds(prefix) {
    const out = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }
  listNamed() {
    return { ...this.data.named };
  }
  getNamed(name) {
    return this.data.named[name];
  }
  saveNamed(name, cwd) {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }
  removeNamed(name) {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    this.saving = this.saving.then(async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}
`, {
        mode: 384
      });
    }).catch((err) => {
      log.fail("workspace", err, { step: "persist" });
    });
  }
};

// src/cli/commands/start.ts
dns.setDefaultResultOrder("ipv4first");
process.on("unhandledRejection", (reason) => {
  log.fail("process", reason, { kind: "unhandledRejection" });
  reportError(reason, { kind: "unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  log.fail("process", err, { kind: "uncaughtException" });
  reportError(err, { kind: "uncaughtException" });
});
var MEDIA_GC_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
async function runStart(opts) {
  const runtime = await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: async (err) => {
      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: "\u5DF2\u53D6\u6D88\u542F\u52A8\u3002"
      });
      if (!handled) process.exit(0);
      return true;
    }
  });
  let cfg = runtime.cfg;
  const configPath = runtime.configPath;
  const appPaths2 = runtime.appPaths;
  let profileConfig = runtime.profileConfig;
  configureLogger({ logsDir: appPaths2.logsDir });
  await preFlightChecks({
    skipCheckLarkCli: opts.skipCheckLarkCli,
    bridgeConfig: cfg,
    profileConfig,
    appPaths: appPaths2,
    larkChannel: {
      profile: appPaths2.profile,
      rootDir: appPaths2.rootDir,
      configPath,
      larkCliConfigDir: appPaths2.larkCliConfigDir,
      larkCliSourceConfigFile: appPaths2.larkCliSourceConfigFile
    }
  });
  await loadTelemetryAdapter({
    version: package_default.version,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    hostname: os.hostname()
  });
  let agent = createRuntimeAgent(profileConfig, { ...appPaths2, configPath });
  const availability = await checkRuntimeAgentAvailability(agent);
  if (!availability.ok) {
    console.error(formatAgentPreflightDiagnostic(availability.diagnostic));
    log.warn("agent", "preflight-failed", { diagnostic: availability.diagnostic });
    process.exit(1);
  }
  for (; ; ) {
    try {
      let runtimeLocks = [];
      await withProfileAndAppLocks(
        appPaths2,
        cfg.accounts.app.id,
        cfg.agentKind ?? "claude",
        async (locks) => {
          runtimeLocks = locks;
          const sessions = new SessionStore(appPaths2.sessionsFile);
          await sessions.load();
          const sessionCatalog = new SessionCatalog(`${appPaths2.sessionsFile}.catalog.json`);
          await sessionCatalog.load();
          const contextBudget = new ContextBudgetStore(`${appPaths2.sessionsFile}.context-budget.json`);
          await contextBudget.load();
          const workspaces = new WorkspaceStore(appPaths2.workspacesFile);
          await workspaces.load();
          await gcMediaCache(MEDIA_GC_MAX_AGE_MS, appPaths2.mediaDir);
          await gcOldLogs();
          const conflicts = await sameAppLiveOthers(
            cfg.accounts.app.id,
            process.pid,
            appPaths2.userRegistryFile
          );
          if (conflicts.length > 0) {
            const proceed = await resolveConflict(conflicts);
            if (!proceed) {
              console.log("\u5DF2\u53D6\u6D88\u542F\u52A8\u3002");
              process.exit(0);
            }
          }
          const entry = await register({
            appId: cfg.accounts.app.id,
            tenant: cfg.accounts.app.tenant,
            profileName: appPaths2.profile,
            agentKind: cfg.agentKind ?? "claude",
            configPath,
            version: package_default.version,
            registryFile: appPaths2.userRegistryFile
          });
          log.info("registry", "registered", { id: entry.id, pid: process.pid });
          let bridge;
          let restarting = false;
          let stopping = false;
          const stop2 = async (sig) => {
            if (stopping) return;
            stopping = true;
            console.log(`
\u6536\u5230 ${sig}\uFF0C\u6B63\u5728\u5173\u95ED...`);
            try {
              await bridge.disconnect();
            } catch (err) {
              console.error("[disconnect-failed]", err);
            }
            unregisterSync(entry.id, appPaths2.userRegistryFile);
            await releaseRuntimeLocks(runtimeLocks);
            await flushTelemetry();
            process.exit(0);
          };
          let controls;
          const makeControls = (currentPaths, currentCfg, currentProfileConfig) => {
            const currentControls = {
              profile: currentPaths.profile,
              profileConfig: currentProfileConfig,
              ownerRefreshState: "unknown",
              knownChats: [],
              async refreshOwner(channelOverride) {
                const target = channelOverride ?? bridge?.channel;
                if (!target) return;
                await refreshOwnerControls(
                  currentControls,
                  target,
                  currentControls.cfg.accounts.app.id
                );
              },
              configPath,
              cfg: currentCfg,
              processId: entry.id,
              async exit() {
                await stop2("exit-command");
              },
              async restart() {
                if (restarting) return;
                restarting = true;
                let nextAppLock;
                try {
                  const nextRuntime = await resolveProfileRuntime({
                    config: configPath,
                    profile: appPaths2.profile,
                    allowBootstrap: false
                  });
                  const next = nextRuntime.cfg;
                  if (!isComplete(next)) throw new Error("config incomplete after change");
                  assertReconnectAgentKindUnchanged(cfg.agentKind, next.agentKind);
                  const nextAgent = createRuntimeAgent(nextRuntime.profileConfig, {
                    ...nextRuntime.appPaths,
                    configPath: nextRuntime.configPath
                  });
                  const nextAvailability = await checkRuntimeAgentAvailability(nextAgent);
                  if (!nextAvailability.ok) {
                    throw nextAvailability.error;
                  }
                  const appChanged = next.accounts.app.id !== cfg.accounts.app.id;
                  if (appChanged) {
                    nextAppLock = await acquireAppRuntimeLock(
                      nextRuntime.appPaths,
                      next.accounts.app.id,
                      next.agentKind ?? "claude"
                    );
                  }
                  console.log(
                    `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`
                  );
                  const nextControls = makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
                  const next_bridge = await startChannel({
                    cfg: next,
                    agent: nextAgent,
                    sessions,
                    sessionCatalog,
                    contextBudget,
                    workspaces,
                    controls: nextControls,
                    appPaths: nextRuntime.appPaths
                  });
                  console.log("[restart] disconnecting old bridge...");
                  try {
                    await bridge.disconnect();
                  } catch (err) {
                    console.warn("[restart] old disconnect failed:", err);
                  }
                  bridge = next_bridge;
                  await updateEntry(entry.id, {
                    appId: next.accounts.app.id,
                    tenant: next.accounts.app.tenant,
                    configPath,
                    botName: bridge.channel.botIdentity?.name
                  }, appPaths2.userRegistryFile).catch(
                    (err) => log.warn("registry", "update-failed", { err: String(err) })
                  );
                  if (nextAppLock) {
                    const oldAppLock = runtimeLocks.find((lock4) => lock4.kind === "app");
                    runtimeLocks = [
                      ...runtimeLocks.filter((lock4) => lock4.kind !== "app"),
                      nextAppLock
                    ];
                    nextAppLock = void 0;
                    await oldAppLock?.release().catch(
                      (err) => log.warn("runtime-lock", "old-app-release-failed", { err: String(err) })
                    );
                  }
                  cfg = next;
                  profileConfig = nextRuntime.profileConfig;
                  agent = nextAgent;
                  controls = nextControls;
                  console.log("\u2713 \u5DF2\u7528\u65B0\u51ED\u636E\u91CD\u8FDE");
                } finally {
                  if (nextAppLock) {
                    await nextAppLock.release().catch(
                      (err) => log.warn("runtime-lock", "new-app-release-failed", { err: String(err) })
                    );
                  }
                  restarting = false;
                }
              }
            };
            return currentControls;
          };
          controls = makeControls(appPaths2, cfg, profileConfig);
          bridge = await startChannel({
            cfg,
            agent,
            sessions,
            sessionCatalog,
            contextBudget,
            workspaces,
            controls,
            appPaths: appPaths2
          });
          const botName = bridge.channel.botIdentity?.name;
          if (botName) {
            await updateEntry(entry.id, { botName }, appPaths2.userRegistryFile).catch(
              (err) => log.warn("registry", "update-failed", { step: "botName", err: String(err) })
            );
          }
          process.on("SIGINT", () => void stop2("SIGINT"));
          process.on("SIGTERM", () => void stop2("SIGTERM"));
          process.on("beforeExit", () => {
            void flushTelemetry();
          });
          process.on("exit", () => {
            unregisterSync(entry.id, appPaths2.userRegistryFile);
            cleanupTmpFiles(appPaths2.userRegistryFile);
          });
          await new Promise(() => {
          });
        }
      );
      return;
    } catch (err) {
      const action = await handleRuntimeLockConflict(err, opts);
      if (action === "retry") continue;
      if (action === "cancel") return;
      throw err;
    }
  }
}
async function checkRuntimeAgentAvailability(agent) {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const diagnostic = {
    code: "agent-binary-not-found",
    agentId: agent.id === "codex" ? "codex" : "claude",
    agentName: agent.displayName,
    command: agent.id === "codex" ? "codex" : "claude"
  };
  return {
    ok: false,
    diagnostic,
    error: new AgentPreflightError(diagnostic)
  };
}
function assertReconnectAgentKindUnchanged(current, next) {
  const currentKind = current ?? "claude";
  const nextKind = next ?? "claude";
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`
    );
  }
}
function createRuntimeAgent(profileConfig, appPaths2) {
  const larkChannelConfigPath = appPaths2.configPath ?? appPaths2.configFile;
  const larkChannel = appPaths2.rootDir && appPaths2.profile ? {
    profile: appPaths2.profile,
    rootDir: appPaths2.rootDir,
    ...larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {},
    ...appPaths2.larkCliConfigDir ? { larkCliConfigDir: appPaths2.larkCliConfigDir } : {},
    ...appPaths2.larkCliSourceConfigFile ? { larkCliSourceConfigFile: appPaths2.larkCliSourceConfigFile } : {}
  } : void 0;
  if (profileConfig.agentKind === "codex") {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error("codex profile requires codex.binaryPath");
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths2.profileDir,
      ...codex.codexHome ? { codexHome: codex.codexHome } : {},
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel
    });
  }
  return new ClaudeAdapter({ larkChannel });
}
async function resolveConflict(conflicts) {
  console.log(
    `\u26A0\uFE0F  \u68C0\u6D4B\u5230\u8FD9\u4E2A\u98DE\u4E66\u5E94\u7528\u5DF2\u7ECF\u6709 ${conflicts.length} \u4E2A bot \u6B63\u5728\u8FD0\u884C:`
  );
  for (const e of conflicts) {
    const ago = formatAgo3(Date.now() - new Date(e.startedAt).getTime());
    const label = e.botName ? `bot ${e.botName} (${e.appId})` : `bot ${e.appId}`;
    console.log(`   - ${label},\u8FDB\u7A0B ${e.id},${ago}\u542F\u52A8`);
  }
  console.log("");
  if (!process.stdin.isTTY) {
    console.warn(
      "\u26A0\uFE0F  \u5F53\u524D\u4E0D\u662F\u4EA4\u4E92\u5F0F\u542F\u52A8,\u5DF2\u81EA\u52A8\u53D6\u6D88\u3002\u5982\u9700\u66FF\u6362,\u5148\u7528 `kill <bot id>` \u5173\u6389\u65E7\u7684\u3002\n"
    );
    return false;
  }
  const rl = createInterface7({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve2) => rl.question(q, resolve2));
  try {
    const verb = conflicts.length > 1 ? "\u5B83\u4EEC" : "\u90A3\u4E2A";
    const answer = (await ask(`\u7EE7\u7EED\u542F\u52A8\u4F1A\u5148\u5173\u6389${verb},\u662F\u5426\u7EE7\u7EED? [y/N]: `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return false;
    }
    for (const e of conflicts) {
      try {
        process.kill(e.pid, "SIGTERM");
        console.log(`\u2713 \u5DF2\u5173\u6389 bot ${e.id}`);
      } catch (err) {
        console.warn(`\u2717 \u5173\u6389 bot ${e.id} \u5931\u8D25:${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } finally {
    rl.close();
  }
}
async function handleRuntimeLockConflict(err, opts) {
  if (!(err instanceof RuntimeLockConflictError)) return "unhandled";
  console.error(`\u2717 \u5F53\u524D ${err.kind === "profile" ? "profile" : "app"} \u5DF2\u6709 bridge \u8FDB\u7A0B\u5360\u7528\u3002`);
  if (err.meta) {
    const app = err.meta.appId ? ` app=${err.meta.appId}` : "";
    console.error(
      `  holder: profile=${err.meta.profile}${app} agent=${err.meta.agentKind} pid=${err.meta.pid} startedAt=${err.meta.startedAt}`
    );
  } else {
    console.error(`  lock: ${err.target}`);
    return "unhandled";
  }
  const confirmed = opts.confirmStopRuntimeLockProcess ? await opts.confirmStopRuntimeLockProcess(err) : await confirmStopRuntimeLockProcess2(err);
  if (!confirmed) {
    console.log("\u5DF2\u53D6\u6D88\u542F\u52A8\u3002");
    return "cancel";
  }
  const result = opts.stopRuntimeLockProcess ? await opts.stopRuntimeLockProcess(err.meta) : await stopProcessEntry({ pid: err.meta.pid });
  if (result === "killed") {
    console.log(`\u2713 \u5DF2\u5F3A\u5236\u505C\u6B62 pid ${err.meta.pid}`);
  } else {
    console.log(`\u2713 \u5DF2\u505C\u6B62 pid ${err.meta.pid}`);
  }
  return "retry";
}
async function confirmStopRuntimeLockProcess2(err) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `\u5F53\u524D ${err.kind === "profile" ? "profile" : "app"} \u5DF2\u6709 bridge \u8FDB\u7A0B\u5360\u7528\uFF1B\u975E\u4EA4\u4E92\u6A21\u5F0F\u65E0\u6CD5\u786E\u8BA4\u505C\u6B62\uFF0C\u8BF7\u5148\u7528 \`lark-channel-bridge ps\` \u67E5\u770B\u5E76\u7528 \`lark-channel-bridge kill <bot id>\` \u505C\u6B62\u540E\u91CD\u8BD5`
    );
  }
  const rl = createInterface7({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await new Promise(
      (resolve2) => rl.question("\u662F\u5426\u505C\u6B62\u65E7\u8FDB\u7A0B\u5E76\u91CD\u65B0\u542F\u52A8? [y/N]: ", resolve2)
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
async function releaseRuntimeLocks(locks) {
  for (const lock4 of [...locks].reverse()) {
    await lock4.release().catch(
      (err) => log.warn("runtime-lock", "release-failed", {
        kind: lock4.kind,
        err: err instanceof Error ? err.message : String(err)
      })
    );
  }
}
async function flushTelemetry(timeoutMs = 2e3) {
  try {
    await telemetry().flush?.(timeoutMs);
  } catch {
  }
}
function formatAgo3(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)} \u79D2\u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)} \u5206\u949F\u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)} \u5C0F\u65F6\u524D`;
  return `${Math.floor(ms / 864e5)} \u5929\u524D`;
}

// src/cli/index.ts
var program = new Command();
program.name("lark-channel-bridge").description("Bridge Feishu/Lark messenger with local CLI coding agents").version(package_default.version, "-v, --version");
program.command("run").description("Run the bridge in the foreground (was `start` in older versions)").option("-c, --config <path>", "path to config file").option("--profile <name>", "profile name to run").option("--agent <kind>", "agent kind for a new profile (claude or codex)").option("--workspace <path>", "initial working directory for first-run profile bootstrap").option("--app-id <id>", "use an existing Lark/Feishu app instead of QR app creation").option("--app-secret <secret>", "App Secret for --app-id; prefer interactive input on shared machines").option("--tenant <tenant>", "tenant for --app-id (feishu or lark; default feishu)").option("--skip-check-lark-cli", "skip lark-cli pre-flight check (auto-install + bind)").action(async (opts) => {
  await runStart(opts);
});
program.command("migrate").description("Migrate legacy bridge config/state into the current profile layout").option("-c, --config <path>", "path to config file").option("--profile <name>", "target profile name for legacy v1 config migration").option("--agent <kind>", "agent kind for legacy v1 profile migration (claude or codex)").action(async (opts) => {
  await runMigrate(opts);
});
var profile = program.command("profile").description("Manage local bridge profiles");
profile.command("list").description("List configured profiles").action(async () => {
  await runProfileList();
});
profile.command("create <name>").description("Create a profile from QR registration or existing app credentials").option("--agent <kind>", "agent kind (claude or codex)").option("--workspace <path>", "initial working directory for this profile").option("--app-id <id>", "use an existing Lark/Feishu app instead of QR app creation").option("--app-secret <secret>", "App Secret for --app-id; prefer interactive input on shared machines").option("--tenant <tenant>", "tenant for --app-id (feishu or lark; default feishu)").action(async (name, opts) => {
  await runProfileCreate(name, opts);
});
profile.command("use <name>").description("Set the active profile").action(async (name) => {
  await runProfileUse(name);
});
profile.command("remove <name>").description("Archive a profile and its local state").option("--purge", "permanently delete profile state instead of archiving").option("--yes", "confirm destructive profile deletion").action(async (name, opts) => {
  await runProfileRemove(name, { purge: opts.purge, yes: opts.yes });
});
profile.command("export <name>").description("Export one profile as JSON").option("--output <path>", "write export JSON to a file instead of stdout").option("--force", "overwrite an existing output file").option("--include-secrets", "include secret provider configuration and app secret values").option("--yes", "confirm exporting secrets").action(async (name, opts) => {
  await runProfileExport(name, {
    output: opts.output,
    force: opts.force,
    includeSecrets: opts.includeSecrets,
    yes: opts.yes
  });
});
program.command("ps").description("List running bridge processes on this machine").action(() => {
  runPs();
});
program.command("kill <target>").description("Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.").action(async (target) => {
  await runKillCli(target);
});
program.command("start").description("Install (if needed) and start the bridge as an OS-managed daemon").option("--profile <name>", "profile name (defaults to active profile)").option("--agent <kind>", "agent kind for first-run profile bootstrap (claude or codex)").option("--workspace <path>", "initial working directory for first-run profile bootstrap").option("--app-id <id>", "use an existing Lark/Feishu app instead of QR app creation").option("--app-secret <secret>", "App Secret for --app-id; prefer interactive input on shared machines").option("--tenant <tenant>", "tenant for --app-id (feishu or lark; default feishu)").option("--skip-check-lark-cli", "skip lark-cli pre-flight check (auto-install + bind)").action(async (opts) => {
  await runServiceStart(opts);
});
program.command("stop").description("Stop the OS-managed daemon (unload from launchd; plist stays)").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runServiceStop({ profile: opts.profile });
});
program.command("restart").description("Restart the OS-managed daemon").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runServiceRestart({ profile: opts.profile });
});
program.command("status").description("Show OS service status (pid, last exit, log paths)").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runServiceStatus({ profile: opts.profile });
});
program.command("unregister").description("Remove the OS service registration (bootout + delete plist)").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runServiceUnregister({ profile: opts.profile });
});
var secrets = program.command("secrets").description("Manage the bridge's encrypted secret keystore (~/.lark-channel/secrets.enc)");
secrets.command("get").description("Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.").action(async () => {
  await runSecretsGet();
});
secrets.command("set").description("Encrypt and store an App Secret. Prompts for the secret without echoing.").requiredOption("--app-id <id>", "App ID (e.g. cli_xxxxxxxxxxxx)").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runSecretsSet(opts.appId, { profile: opts.profile });
});
secrets.command("list").description("List the IDs of secrets in the encrypted keystore (no secrets shown)").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runSecretsList({ profile: opts.profile });
});
secrets.command("remove").description("Delete an entry from the encrypted keystore").requiredOption("--app-id <id>", "App ID to remove").option("--profile <name>", "profile name (defaults to active profile)").action(async (opts) => {
  await runSecretsRemove(opts.appId, { profile: opts.profile });
});
program.parseAsync(process.argv).catch((err) => {
  const diagnostic = getAgentPreflightDiagnostic(err);
  if (diagnostic) {
    console.error(formatAgentPreflightDiagnostic(diagnostic));
    process.exit(1);
  }
  if (err instanceof Error) {
    if (err.name === "UserCancelledError") {
      console.log(err.message);
      process.exit(0);
    }
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
