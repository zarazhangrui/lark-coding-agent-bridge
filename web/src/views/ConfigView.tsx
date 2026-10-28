import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiGet, apiPost } from "@/lib/api";
import type {
  ConfigView as ConfigData,
  DeviceLogin,
  KnownChat,
  MeetingConfig,
  MeetingPreflight,
  MeetingsView,
  UserAuthStatus,
  UserChat,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

export function ConfigView({ profile }: { profile: string }) {
  const [cfg, setCfg] = useState<ConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // chat_id → display name, for the allowed-chats list. Seeded from the bot's
  // known chats and topped up with names captured when adding from the picker.
  const [chatNames, setChatNames] = useState<Record<string, string>>({});

  const load = () =>
    apiGet<ConfigData>(`/api/config?profile=${encodeURIComponent(profile)}`)
      .then((c) => {
        setCfg(c);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));

  const loadChatNames = () =>
    apiGet<{ chats: { id: string; name: string }[] }>(`/api/chats?profile=${encodeURIComponent(profile)}`)
      .then((r) => setChatNames((m) => ({ ...m, ...Object.fromEntries(r.chats.map((c) => [c.id, c.name])) })))
      .catch(() => {});

  useEffect(() => {
    setCfg(null);
    setChatNames({});
    load();
    void loadChatNames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!cfg) return <p className="text-muted-foreground text-sm">加载中…</p>;

  const set = <K extends keyof ConfigData>(k: K, v: ConfigData[K]) =>
    setCfg({ ...cfg, [k]: v });
  const team = cfg.mode === "team";

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const next = await apiPost<ConfigData>(`/api/config?profile=${encodeURIComponent(profile)}`, {
        mode: cfg.mode,
        meeting: cfg.meeting,
        model: cfg.model,
        messageReply: cfg.messageReply,
        showToolCalls: cfg.showToolCalls,
        cotMessages: cfg.cotMessages,
        maxConcurrentRuns: cfg.maxConcurrentRuns,
        runIdleTimeoutMinutes: cfg.runIdleTimeoutMinutes,
        requireMentionInGroup: cfg.requireMentionInGroup,
        larkCliIdentity: cfg.larkCliIdentity,
      });
      setCfg(next);
      toast.success(next.live ? "已保存，立即生效" : "已保存，下次启动该 profile 生效");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function access(action: "add" | "remove", kind: "user" | "admin" | "chat", id: string) {
    if (!id.trim()) return;
    try {
      const acc = await apiPost<ConfigData["access"]>(
        `/api/access?profile=${encodeURIComponent(profile)}`,
        { action, kind, id: id.trim() },
      );
      setCfg((c) => (c ? { ...c, access: acc } : c));
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }

  // Set (true/false) or clear (null = follow global) a chat's @-mention override.
  async function setMention(id: string, requireMention: boolean | null) {
    try {
      const acc = await apiPost<ConfigData["access"]>(
        `/api/access?profile=${encodeURIComponent(profile)}`,
        { action: "set-mention", kind: "chat", id, requireMention },
      );
      setCfg((c) => (c ? { ...c, access: acc } : c));
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>运行模式</CardTitle>
          <Badge variant={cfg.live ? "success" : "secondary"}>
            {cfg.live ? "即时生效" : "下次启动生效"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="个人版 / 团队版" hint="团队版：任何人 @ 即可使用（不做白名单）；CLI 强制只用应用身份。管理命令仍限 owner/管理员。">
            <SelectRow value={cfg.mode} onChange={(v) => set("mode", v as ConfigData["mode"])}
              options={[["personal", "个人版（默认）"], ["team", "团队版"]]} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>回复与运行</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="模型">
            {cfg.agentKind === "omp" ? (
              <Input
                value={cfg.model === "default" ? "" : cfg.model}
                onChange={(e) => set("model", e.target.value.trim() ? e.target.value : "default")}
                placeholder="provider/model（留空=跟随 OMP 默认）"
              />
            ) : (
              <SelectRow value={cfg.model} onChange={(v) => set("model", v)}
                options={cfg.models.map((m) => [m.value, m.label])} />
            )}
          </Field>
          <Field label="消息回复方式">
            <SelectRow value={cfg.messageReply} onChange={(v) => set("messageReply", v as ConfigData["messageReply"])}
              options={[["markdown", "消息卡片（默认）"], ["text", "纯文本"]]} />
          </Field>
          <ToggleRow label="工具调用显示" hint="显示 bot 执行的命令与文件读写过程" checked={cfg.showToolCalls}
            onChange={(v) => set("showToolCalls", v)} />
          <Field label="COT 过程消息">
            <SelectRow value={cfg.cotMessages} onChange={(v) => set("cotMessages", v as ConfigData["cotMessages"])}
              options={[["off", "关闭"], ["brief", "简略"], ["detailed", "详细"]]} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="并发上限（1-50）">
              <Input type="number" min={1} max={50} value={cfg.maxConcurrentRuns}
                onChange={(e) => set("maxConcurrentRuns", Number(e.target.value))} />
            </Field>
            <Field label="探活分钟（0=关闭）">
              <Input type="number" min={0} max={120} value={cfg.runIdleTimeoutMinutes}
                onChange={(e) => set("runIdleTimeoutMinutes", Number(e.target.value))} />
            </Field>
          </div>
          <ToggleRow label="群里需要 @ bot（全局默认）"
            hint="关闭后群里任何消息都会触发（需 im:message.group_msg 权限）。可在下方「允许响应的群」为单个群单独设置，优先级高于此项。"
            checked={cfg.requireMentionInGroup} onChange={(v) => set("requireMentionInGroup", v)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>lark-cli 身份策略</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <SelectRow value={cfg.larkCliIdentity} onChange={(v) => set("larkCliIdentity", v as ConfigData["larkCliIdentity"])}
            options={[["bot-only", "只允许应用身份"], ["user-default", "允许用户身份"]]} />
          <p className="text-xs text-muted-foreground">
            只允许应用身份：不访问个人资源。允许用户身份：可访问已授权用户的日历/邮箱/云盘等。
          </p>
          {team && (
            <p className="text-xs text-primary">⚠️ 团队版已开启：本项被覆盖为「只允许应用身份」。切回个人版后恢复。</p>
          )}
        </CardContent>
      </Card>

      <MeetingCard
        profile={profile}
        cfg={cfg.meeting}
        onChange={(next) => set("meeting", next)}
      />

      <Card>
        <CardHeader><CardTitle>访问控制</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {team && (
            <p className="text-xs text-primary">团队版下访问控制不生效（任何人可用）；以下配置保留，切回个人版后恢复。</p>
          )}
          <AccessList label="允许私聊的用户（open_id）" placeholder="ou_..." ids={cfg.access.allowedUsers}
            onAdd={(id) => access("add", "user", id)} onRemove={(id) => access("remove", "user", id)} />
          <Separator />
          <AllowedChats
            profile={profile}
            ids={cfg.access.allowedChats}
            chatRequireMention={cfg.access.chatRequireMention}
            chatNames={chatNames}
            globalRequire={cfg.requireMentionInGroup}
            onAdd={(id, name) => {
              void access("add", "chat", id);
              if (name) setChatNames((m) => ({ ...m, [id]: name }));
            }}
            onRemove={(id) => access("remove", "chat", id)}
            onSetMention={setMention}
          />
          <Separator />
          <AccessList label="管理员（open_id）" placeholder="ou_..." ids={cfg.access.admins}
            onAdd={(id) => access("add", "admin", id)} onRemove={(id) => access("remove", "admin", id)} />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
        <Button variant="outline" onClick={() => load()} disabled={saving}>重新加载</Button>
        <Button onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
      </div>
    </div>
  );
}

/**
 * Permission pre-flight. When the app identity lacks a scope, Feishu's own
 * scope-apply URL comes back in the error — we render it as a button plus a QR
 * (for granting from a phone). The URL is opaque: linked/encoded as-is, never
 * rebuilt.
 */
function MeetingPreflightPanel({ pre, checking, onRecheck }: {
  pre: MeetingPreflight | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!pre) {
    return <p className="text-xs text-muted-foreground">{checking ? "检查权限中…" : "—"}</p>;
  }

  if (pre.status === "ok") {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="success">应用权限已就绪</Badge>
        <Button variant="ghost" size="sm" disabled={checking} onClick={onRecheck}>重新检查</Button>
      </div>
    );
  }

  const isScope = pre.status === "scope-missing";
  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="destructive">
          {isScope ? "缺少应用权限" : pre.status === "not-in-beta" ? "内测未开通" : "权限状态未知"}
        </Badge>
        <Button variant="ghost" size="sm" disabled={checking} onClick={onRecheck}>重新检查</Button>
      </div>
      <p className="text-xs text-muted-foreground">{pre.message}</p>

      {isScope && (
        <div className="space-y-1">
          <p className="text-xs">
            需要为应用（bot 身份）开通以下权限。探针一次只能报出撞到的那一个，建议一起开完，
            否则入会成功但发言仍会失败：
          </p>
          <ul className="space-y-0.5">
            {pre.requiredScopes.map((r) => {
              const missing = pre.missingScopes.includes(r.scope);
              return (
                <li key={r.scope} className="text-xs">
                  <span className={missing ? "font-mono text-destructive" : "font-mono"}>{r.scope}</span>
                  <span className="text-muted-foreground">
                    {" — "}{r.purpose}{missing ? "（已确认缺失）" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pre.consoleUrl && (
        <div className="flex items-start gap-4">
          <div className="space-y-2">
            <Button asChild size="sm">
              <a href={pre.consoleUrl} target="_blank" rel="noreferrer">去开通权限</a>
            </Button>
            <p className="text-xs text-muted-foreground">开通后点「重新检查」；生效后需重启该 profile。</p>
          </div>
          <div className="rounded-md border bg-white p-2">
            <QRCodeSVG value={pre.consoleUrl} size={96} />
          </div>
        </div>
      )}

      {pre.betaChatUrl && (
        <div className="flex items-start gap-4">
          <div className="space-y-2">
            <Button asChild size="sm">
              <a href={pre.betaChatUrl} target="_blank" rel="noreferrer">加入内测群申请开通</a>
            </Button>
            <p className="text-xs text-muted-foreground">开通后点「重新检查」。</p>
          </div>
          <div className="rounded-md border bg-white p-2">
            <QRCodeSVG value={pre.betaChatUrl} size={96} />
          </div>
        </div>
      )}

      <div className="space-y-1 border-t pt-2">
        <p className="text-xs">另外需在开发者后台以「长连接」模式订阅事件（无查询接口，只能人工确认）：</p>
        <ul className="space-y-0.5">
          {pre.requiredEvents.map((e) => (
            <li key={e} className="font-mono text-xs text-muted-foreground">{e}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">未订阅也可用：会自动降级为轮询，只是字幕慢几秒。</p>
      </div>
    </div>
  );
}

/**
 * In-meeting agent ("智能体入会"). Settings plus a live view of the joined
 * meetings — including whether `vc.bot.*` pushes are actually arriving, which
 * is the one thing that can't be verified from code alone.
 */
function MeetingCard({ profile, cfg, onChange }: {
  profile: string;
  cfg: MeetingConfig;
  onChange: (next: MeetingConfig) => void;
}) {
  const [live, setLive] = useState<MeetingsView | null>(null);
  const [pre, setPre] = useState<MeetingPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [joinNo, setJoinNo] = useState("");
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof MeetingConfig>(k: K, v: MeetingConfig[K]) => onChange({ ...cfg, [k]: v });

  const load = () =>
    apiGet<MeetingsView>(`/api/meetings?profile=${encodeURIComponent(profile)}`)
      .then(setLive)
      .catch(() => setLive(null));

  async function preflight() {
    setChecking(true);
    try {
      setPre(await apiGet<MeetingPreflight>(`/api/meetings/preflight?profile=${encodeURIComponent(profile)}`));
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setChecking(false); }
  }

  useEffect(() => {
    if (!cfg.enabled) return;
    void load();
    void preflight();
    // Sessions and push counters move on their own; poll while the card is open.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, cfg.enabled]);

  async function join() {
    const no = joinNo.replace(/\s/g, "");
    if (!/^\d{9}$/.test(no)) {
      toast.error("会议号必须是 9 位数字");
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/meetings/join", { profile, meetingNo: no });
      setJoinNo("");
      toast.success("已入会");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function leave(meetingId: string) {
    setBusy(true);
    try {
      await apiPost("/api/meetings/leave", { profile, meetingId });
      toast.success("已离会");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>会议智能体</CardTitle>
        <Switch checked={cfg.enabled} onCheckedChange={(v) => set("enabled", v)} />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          让 bot 作为参会人加入飞书会议，读字幕/弹幕并作答。需要应用已开通内测与
          <span className="font-mono"> vc:meeting.bot.join:write</span>。开关变更后需重启该 profile 生效。
        </p>

        {cfg.enabled && (
          <>
            <MeetingPreflightPanel pre={pre} checking={checking} onRecheck={preflight} />

            <div className="grid grid-cols-2 gap-4">
              <Field label="回答发到哪">
                <SelectRow
                  value={cfg.respondIn}
                  onChange={(v) => set("respondIn", v as MeetingConfig["respondIn"])}
                  options={[["meeting", "会中消息"], ["im", "IM 私聊"], ["both", "两者"]]}
                />
              </Field>
              <Field
                label="会中触发前缀"
                hint="会中弹幕以此开头才会问 agent。@ 加 bot 当前名字始终有效，这里只是额外再认一个前缀。"
              >
                <Input value={cfg.trigger} onChange={(e) => set("trigger", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="字幕上下文条数（10-2000）">
                <Input type="number" min={10} max={2000} value={cfg.transcript.keep}
                  onChange={(e) => set("transcript", { ...cfg.transcript, keep: Number(e.target.value) })} />
              </Field>
              <Field label="字幕定稿防抖 ms（0=不防抖）">
                <Input type="number" min={0} max={30000} value={cfg.transcript.stabilizeMs}
                  onChange={(e) => set("transcript", { ...cfg.transcript, stabilizeMs: Number(e.target.value) })} />
              </Field>
            </div>
            <ToggleRow label="被邀请时自动入会" hint="依赖 vc.bot.meeting_invited_v1 推送（需在开发者后台订阅）"
              checked={cfg.autoJoinOnInvite} onChange={(v) => set("autoJoinOnInvite", v)} />
            <ToggleRow label="会议结束自动出纪要" checked={cfg.summaryOnEnd}
              onChange={(v) => set("summaryOnEnd", v)} />
            {cfg.summaryOnEnd && (
              <Field
                label="纪要发到哪"
                hint="所选目标不可用时自动回落到另一个（从控制台入会没有来源聊天；owner 未解析出来时没有私聊），不会丢掉纪要。"
              >
                <SelectRow
                  value={cfg.summaryTarget}
                  onChange={(v) => set("summaryTarget", v as MeetingConfig["summaryTarget"])}
                  options={[
                    ["origin", "入会来源的聊天（群/私聊）"],
                    ["owner", "bot owner 私聊"],
                  ]}
                />
              </Field>
            )}

            <Separator />

            {/* Live state — needs the profile to be online. */}
            {!live?.available ? (
              <p className="text-xs text-muted-foreground">{live?.reason ?? "加载中…"}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>在会会议（{live.sessions.length}）</Label>
                  <Badge variant={live.push.hooked ? (live.push.received > 0 ? "success" : "secondary") : "destructive"}>
                    {live.push.hooked
                      ? live.push.received > 0
                        ? `推送正常 · ${live.push.received} 条`
                        : "推送已挂载 · 未收到"
                      : "推送未挂载"}
                  </Badge>
                </div>
                {live.push.hooked && live.push.received === 0 && (
                  <p className="text-xs text-muted-foreground">
                    钩子已装好但还没收到事件。确认开发者后台已用「长连接」模式订阅 vc.bot.* 三个事件；期间靠轮询兜底，功能可用。
                  </p>
                )}
                {!live.push.hooked && live.push.reason && (
                  <p className="text-xs text-destructive">{live.push.reason}</p>
                )}
                <div className="divide-y rounded-md border">
                  {live.sessions.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">（暂无）</p>
                  )}
                  {live.sessions.map((s) => (
                    <div key={s.meetingId} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{s.topic ?? s.meetingNo}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {s.meetingNo} · {s.source === "push" ? "推送" : "轮询"} · 字幕 {s.transcriptLines} 条 · 参会 {s.participants} 人
                        </div>
                        {/* Which activity types actually arrived — tells apart
                            "nothing was sent" from "sent but unparsed" (`?`). */}
                        <div className="truncate text-xs text-muted-foreground">
                          收到事件：{Object.keys(s.eventCounts).length === 0
                            ? "无"
                            : Object.entries(s.eventCounts).map(([k, v]) => `${k}×${v}`).join(" · ")}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => leave(s.meetingId)}>离会</Button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input placeholder="9 位会议号" value={joinNo} onChange={(e) => setJoinNo(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void join(); }} />
                  <Button variant="outline" disabled={busy} onClick={join}>入会</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SelectRow({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AllowedChats({
  profile,
  ids,
  chatRequireMention,
  chatNames,
  globalRequire,
  onAdd,
  onRemove,
  onSetMention,
}: {
  profile: string;
  ids: string[];
  chatRequireMention: Record<string, boolean>;
  chatNames: Record<string, string>;
  globalRequire: boolean;
  onAdd: (id: string, name?: string) => void;
  onRemove: (id: string) => void;
  onSetMention: (id: string, requireMention: boolean | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <div className="space-y-2">
      <Label>允许响应的群（{ids.length}）</Label>
      <div className="divide-y rounded-md border">
        {ids.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">（暂无）</p>}
        {ids.map((id) => {
          const override = chatRequireMention[id];
          const value = override === undefined ? "global" : override ? "on" : "off";
          return (
            <div key={id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                {chatNames[id] && <div className="truncate text-sm">{chatNames[id]}</div>}
                <div className="truncate font-mono text-xs text-muted-foreground">{id}</div>
              </div>
              <Select
                value={value}
                onValueChange={(v) => onSetMention(id, v === "global" ? null : v === "on")}
              >
                <SelectTrigger className="h-8 w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">@：跟随全局（{globalRequire ? "需@" : "无需@"}）</SelectItem>
                  <SelectItem value="on">需要 @</SelectItem>
                  <SelectItem value="off">无需 @</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" onClick={() => onRemove(id)}>移除</Button>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setPickerOpen(true)}>选择群</Button>
        <Input placeholder="或手动输入 oc_..." value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button variant="outline" onClick={() => { onAdd(draft); setDraft(""); }}>添加</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        每个群可单独设置是否需要 @ bot；「跟随全局」时用上面「回复与运行」里的默认值。
      </p>
      <GroupPicker
        profile={profile}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        added={ids}
        onPick={onAdd}
      />
    </div>
  );
}

function GroupPicker({ profile, open, onOpenChange, added, onPick }: {
  profile: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择群</DialogTitle>
          <DialogDescription>
            从 bot 已加入的群里选，或用你的飞书身份从「我的群」里选（可把 bot 拉进去）。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="bot" className="min-w-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="bot">bot 所在的群</TabsTrigger>
            <TabsTrigger value="mine">我的群</TabsTrigger>
          </TabsList>
          <TabsContent value="bot" className="min-w-0">
            <BotChatsPane profile={profile} open={open} added={added} onPick={onPick} />
          </TabsContent>
          <TabsContent value="mine" className="min-w-0">
            <MyChatsPane profile={profile} open={open} added={added} onPick={onPick} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function BotChatsPane({ profile, open, added, onPick }: {
  profile: string;
  open: boolean;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  const [chats, setChats] = useState<KnownChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChats(null);
    setError(null);
    apiGet<{ chats: KnownChat[] }>(`/api/chats?profile=${encodeURIComponent(profile)}`)
      .then((r) => setChats(r.chats))
      .catch((e) => setError(String((e as Error).message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile]);

  const addedSet = new Set(added);
  return (
    <div className="space-y-2 py-2">
      <p className="text-xs text-muted-foreground">只列出 bot 已加入的群（需要该 profile 在线）。</p>
      {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
      {!error && chats === null && <p className="text-sm text-muted-foreground">加载中…</p>}
      {chats && chats.length === 0 && (
        <p className="text-sm text-muted-foreground">没有找到群。确认该 profile 在线，且 bot 已被拉进群聊。</p>
      )}
      {chats && chats.length > 0 && (
        <div className="max-h-[46vh] divide-y overflow-y-auto rounded-md border">
          {chats.map((c) => (
            <div key={c.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{c.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{c.id}</div>
              </div>
              {addedSet.has(c.id) ? (
                <Badge variant="secondary">已添加</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { onPick(c.id, c.name); toast.success("添加成功"); }}>添加</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Minimal scopes, matching the backend. Listing needs only view; adding a
// member additionally needs the write scope (requested on demand).
const LIST_SCOPES = ["im:chat:read"];
const ADD_BOT_SCOPES = ["im:chat:read", "im:chat.members:write_only"];

function MyChatsPane({ profile, open, added, onPick }: {
  profile: string;
  open: boolean;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  const [status, setStatus] = useState<UserAuthStatus | null>(null);
  const [chats, setChats] = useState<UserChat[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  // A chat we couldn't add yet because the add-member scope was missing; retried
  // after the user grants it. Also drives the authorize-prompt wording.
  const [pendingPull, setPendingPull] = useState<string | null>(null);
  const addedSet = new Set(added);

  const canList = Boolean(status?.loggedIn && status?.scopes.includes("im:chat:read"));

  const loadStatus = () =>
    apiGet<UserAuthStatus>(`/api/auth/status?profile=${encodeURIComponent(profile)}`)
      .then((s) => { setStatus(s); return s; })
      .catch((e) => { setError(String((e as Error).message ?? e)); return null; });

  // Fetch a page of chats (8 at a time). reset=true starts over with the current
  // search query; otherwise it appends the next page via the pagination token.
  async function fetchChats(reset: boolean) {
    setListing(true);
    setError(null);
    if (reset) setChats(null);
    try {
      const params = new URLSearchParams({ profile });
      if (query.trim()) params.set("query", query.trim());
      if (!reset && nextToken) params.set("pageToken", nextToken);
      const r = await apiGet<{ chats: UserChat[]; nextPageToken?: string }>(`/api/user-chats?${params.toString()}`);
      setChats((prev) => (reset || !prev ? r.chats : [...prev, ...r.chats]));
      setNextToken(r.nextPageToken);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setListing(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setChats(null); setNextToken(undefined); setQuery("");
    setLogin(null); setError(null); setStatus(null); setPendingPull(null);
    void loadStatus().then((s) => {
      if (s?.loggedIn && s.scopes.includes("im:chat:read")) void fetchChats(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile]);

  async function startAuth(scopes: string[]) {
    setBusy(true); setError(null);
    try {
      setLogin(await apiPost<DeviceLogin>("/api/auth/login/start", { profile, scopes }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function completeAuth() {
    if (!login) return;
    setBusy(true);
    try {
      await apiPost("/api/auth/login/complete", { profile, deviceCode: login.deviceCode });
      setLogin(null);
      toast.success("授权成功");
      const s = await loadStatus();
      const pull = pendingPull;
      setPendingPull(null);
      if (pull) {
        await pullBot(pull);
      } else if (s?.loggedIn && s.scopes.includes("im:chat:read")) {
        await fetchChats(true);
      }
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function pullBot(id: string) {
    setBusy(true);
    try {
      const r = await apiPost<{ ok: boolean; pending?: boolean; needAuth?: boolean; message?: string }>(
        "/api/chats/add-bot",
        { profile, chatId: id },
      );
      if (r.needAuth) {
        // Missing the add-member scope → grant it, then retry this pull.
        setPendingPull(id);
        toast.message("拉bot进群需要额外授权（添加群成员）");
        await startAuth(ADD_BOT_SCOPES);
        return;
      }
      if (!r.ok) {
        toast.error(r.message ?? "把 bot 拉进群失败");
        return;
      }
      if (r.pending) {
        toast.success("已申请，等待群主/管理员通过");
      } else {
        onPick(id, chats?.find((c) => c.id === id)?.name);
        toast.success("已把 bot 拉进群，并加入允许列表");
      }
      // Mark it in-place so the row updates without losing the current page.
      setChats((prev) => prev?.map((c) => (c.id === id ? { ...c, botInIt: true } : c)) ?? prev);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  // Device flow in progress (either the initial view-groups grant, or the
  // on-demand add-member grant) → show the QR / completion UI.
  if (login) {
    return (
      <div className="space-y-3 py-2">
        <p className="text-sm text-muted-foreground">
          {pendingPull ? "把 bot 拉进群需要授权「添加群成员」权限。" : "列出「我的群」需要授权「查看群」权限。"}
        </p>
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-lg border bg-white p-3"><QRCodeSVG value={login.verificationUrl} size={160} /></div>
          <a href={login.verificationUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
            在浏览器打开授权
          </a>
          {login.userCode && (
            <p className="text-xs text-muted-foreground">验证码：<span className="font-mono">{login.userCode}</span></p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">在浏览器里同意授权后，点下面按钮完成。</p>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={completeAuth} disabled={busy}>{busy ? "确认中…" : "我已完成授权"}</Button>
          <Button variant="outline" onClick={() => { setLogin(null); setPendingPull(null); }} disabled={busy}>取消</Button>
        </div>
      </div>
    );
  }

  // Authorized for listing? If not, prompt the view-only grant.
  if (status && !canList) {
    return (
      <div className="space-y-3 py-2">
        <p className="text-sm text-muted-foreground">列出「我的群」需要用你的飞书身份授权一次（只需「查看群」权限）。</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => startAuth(LIST_SCOPES)} disabled={busy}>{busy ? "请稍候…" : "去授权（查看群）"}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-2">
      {status?.userName && <p className="text-xs text-muted-foreground">已授权：{status.userName}</p>}
      <div className="flex gap-2">
        <Input
          placeholder="按群名搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void fetchChats(true); }}
        />
        <Button variant="outline" disabled={listing} onClick={() => void fetchChats(true)}>搜索</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!error && chats === null && listing && <p className="text-sm text-muted-foreground">加载中…</p>}
      {chats && chats.length === 0 && (
        <p className="text-sm text-muted-foreground">{query.trim() ? "没搜到匹配的群。" : "没找到你所在的群。"}</p>
      )}
      {chats && chats.length > 0 && (
        <div className="max-h-[46vh] divide-y overflow-y-auto rounded-md border">
          {chats.map((c) => (
            <div key={c.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{c.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{c.id}</div>
              </div>
              {!c.botInIt && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => pullBot(c.id)}>拉bot进群</Button>
              )}
              {addedSet.has(c.id) ? (
                <Badge variant="secondary">已添加</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { onPick(c.id, c.name); toast.success("添加成功"); }}>添加</Button>
              )}
            </div>
          ))}
        </div>
      )}
      {nextToken && (
        <Button variant="ghost" size="sm" className="w-full" disabled={listing} onClick={() => void fetchChats(false)}>
          {listing ? "加载中…" : "加载更多"}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        bot 不在的群，先「拉bot进群」它才能在群里响应；「添加」只是把群加入允许列表。
      </p>
    </div>
  );
}

function AccessList({ label, placeholder, ids, onAdd, onRemove }: {
  label: string; placeholder: string; ids: string[];
  onAdd: (id: string) => void; onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="space-y-2">
      <Label>{label}（{ids.length}）</Label>
      <div className="rounded-md border divide-y">
        {ids.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">（暂无）</p>}
        {ids.map((id) => (
          <div key={id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1 truncate font-mono text-xs">{id}</span>
            <Button variant="ghost" size="sm" onClick={() => onRemove(id)}>移除</Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button variant="outline" onClick={() => { onAdd(draft); setDraft(""); }}>添加</Button>
      </div>
    </div>
  );
}
