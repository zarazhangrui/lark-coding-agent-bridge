import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { AgentKind, OnboardState } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

// New-profile wizard: scan a Feishu QR to create a fresh app (same flow as the
// CLI `registerApp` wizard). The QR renders immediately; once scanned, the user
// names the new profile and confirms — so there's no rush and it never
// overwrites an existing profile.
type Phase = "loading" | "waiting" | "confirm" | "creating" | "error";

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function OnboardWizard({ onCreated }: { onCreated: (profile: string) => void }) {
  const [agentKind, setAgentKind] = useState<AgentKind>("claude");
  const [profileName, setProfileName] = useState("");
  const [botName, setBotName] = useState("");
  const [detected, setDetected] = useState<AgentKind[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [qr, setQr] = useState<{ sessionId: string; qrUrl: string; expireIn: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanned = useRef(false);

  useEffect(() => {
    apiGet<OnboardState>("/api/onboard/state")
      .then((s) => {
        setDetected(s.detectedAgents);
        setExisting(s.profiles);
        if (s.detectedAgents.length && !s.detectedAgents.includes("claude"))
          setAgentKind(s.detectedAgents[0]!);
      })
      .catch(() => {});
  }, []);

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  async function generate() {
    stopPolling();
    scanned.current = false;
    setQr(null);
    setPhase("loading");
    try {
      const r = await apiPost<{ sessionId: string; qrUrl: string; expireIn: number }>(
        "/api/profiles/qr/start",
        {},
      );
      setQr(r);
      setPhase("waiting");
      timer.current = setInterval(() => void poll(r.sessionId), 2000);
    } catch (e) {
      setPhase("error");
      toast.error(String((e as Error).message ?? e));
    }
  }

  async function poll(sessionId: string) {
    let s: { status: string; error?: string; botName?: string; suggestedProfile?: string };
    try {
      s = await apiGet(`/api/profiles/qr/status?sessionId=${encodeURIComponent(sessionId)}`);
    } catch {
      return; // transient; keep polling
    }
    if (s.status === "scanned" && !scanned.current) {
      scanned.current = true;
      stopPolling();
      // App created — prefill the profile name from the scanned app's name.
      setBotName(s.botName ?? "");
      setProfileName(s.suggestedProfile || uniqueName(agentKind, existing));
      setPhase("confirm");
    } else if (s.status === "error") {
      stopPolling();
      setPhase("error");
      toast.error(s.error ?? "扫码创建失败");
    }
  }

  async function confirmCreate() {
    if (!qr) return;
    setPhase("creating");
    try {
      const r = await apiPost<{ profile: string }>("/api/profiles/qr/finish", {
        sessionId: qr.sessionId,
        agentKind,
        profile: profileName.trim(),
      });
      toast.success(`profile「${r.profile}」已创建`);
      onCreated(r.profile);
    } catch (e) {
      setPhase("confirm"); // let the user fix the name / retry
      toast.error(String((e as Error).message ?? e));
    }
  }

  // Auto-render the QR on open.
  useEffect(() => {
    void generate();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "confirm" || phase === "creating") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="size-4" /> 应用已创建{botName ? `：${botName}` : ""}，确认后完成
        </div>
        <div className="space-y-1.5">
          <Label>AI Agent</Label>
          <Select value={agentKind} onValueChange={(v) => setAgentKind(v as AgentKind)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Profile 名称</Label>
          <Input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={agentKind}
          />
          {existing.includes(profileName.trim()) && (
            <p className="text-xs text-destructive">已存在同名 profile，请换个名字（不会覆盖现有的）。</p>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            onClick={confirmCreate}
            disabled={phase === "creating" || !profileName.trim() || existing.includes(profileName.trim())}
          >
            {phase === "creating" ? "创建中…" : "确定创建"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="flex size-[232px] items-center justify-center rounded-lg border bg-white p-4">
          {qr ? (
            <QRCodeSVG value={qr.qrUrl} size={200} />
          ) : (
            <span className="text-sm text-muted-foreground">
              {phase === "error" ? "二维码生成失败" : "生成二维码中…"}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {phase === "error" ? "请重试" : "用飞书 App 扫码创建新应用，扫完再填 Profile 名称"}
        </p>
        {qr && (
          <p className="text-xs text-muted-foreground">
            有效期约 {Math.max(1, Math.round(qr.expireIn / 60))} 分钟 ·{" "}
            <a href={qr.qrUrl} target="_blank" rel="noreferrer" className="text-primary underline">在浏览器打开</a>
          </p>
        )}
        {(phase === "error" || phase === "waiting") && (
          <Button variant="outline" size="sm" onClick={generate}>重新生成</Button>
        )}
      </div>
      {detected.length === 0 && (
        <p className="text-center text-xs text-muted-foreground">未检测到已安装的 agent，请确保 claude 或 codex 已安装。</p>
      )}
      <p className="text-center text-xs text-muted-foreground">扫码人会成为应用 owner，自动豁免访问控制。</p>
    </div>
  );
}
