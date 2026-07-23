import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { BotInfo, ProfileInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { ConfigView } from "./ConfigView";

function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function ProfileDetail({ profile, onBack }: { profile: string; onBack: () => void }) {
  const [info, setInfo] = useState<ProfileInfo | null>(null);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);

  const loadRuntime = useCallback(async () => {
    const [pr, bt] = await Promise.all([
      apiGet<{ profiles: ProfileInfo[] }>("/api/profiles").catch(() => ({ profiles: [] })),
      apiGet<{ bots: BotInfo[] }>("/api/bots").catch(() => ({ bots: [] })),
    ]);
    setInfo(pr.profiles.find((p) => p.name === profile) ?? null);
    setBots(bt.bots.filter((b) => b.profileName === profile));
  }, [profile]);

  useEffect(() => {
    void loadRuntime();
    const t = setInterval(loadRuntime, 5000);
    return () => clearInterval(t);
  }, [loadRuntime]);

  async function confirmStop() {
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile });
      toast.success(`已停止 ${profile}`);
      setConfirm(false);
      setTimeout(loadRuntime, 500);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setStopping(false);
    }
  }

  async function start() {
    setStarting(true);
    try {
      await apiPost("/api/profiles/start", { profile });
      toast.success(`已启动 ${profile}`);
      setTimeout(loadRuntime, 500);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setStarting(false);
    }
  }

  const running = info?.running ?? bots.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回">
          <ArrowLeft />
        </Button>
        <h1 className="text-2xl font-semibold">{profile}</h1>
        {info && <Badge variant="secondary">{info.agentKind}</Badge>}
        {running ? <Badge variant="success">在线</Badge> : <Badge variant="outline">未运行</Badge>}
        {!running && (
          <Button className="ml-auto" size="sm" disabled={starting} onClick={start}>
            {starting ? "启动中…" : "启动"}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>运行状态</CardTitle>
          {running && (
            <Button variant="destructive" size="sm" onClick={() => setConfirm(true)}>停止</Button>
          )}
        </CardHeader>
        <CardContent>
          {bots.length === 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">未运行。点右上角「启动」在主进程内上线。</p>
              <Button size="sm" disabled={starting} onClick={start}>{starting ? "启动中…" : "启动"}</Button>
            </div>
          ) : (
            <div className="space-y-2">
              {bots.map((b) => (
                <div key={b.id} className="rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{b.botName ?? "（连接中）"}</span>
                  <span className="text-muted-foreground"> · pid {b.pid} · 运行 {uptime(b.uptimeMs)} · v{b.version}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfigView profile={profile} />

      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止 {profile}？</DialogTitle>
            <DialogDescription>
              将停止该 profile 正在运行的 bot。若它是后台服务，会一并禁用自动重启（不会被 KeepAlive 拉起）；
              下次可用 <code>lark-channel-bridge start</code> 重新启动。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={stopping}>取消</Button>
            <Button variant="destructive" onClick={confirmStop} disabled={stopping}>
              {stopping ? "停止中…" : "确认停止"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
