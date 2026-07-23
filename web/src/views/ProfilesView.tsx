import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { ProfileInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { OnboardWizard } from "./OnboardWizard";

export function ProfilesView({ onOpen }: { onOpen: (profile: string) => void }) {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stopTarget, setStopTarget] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    apiGet<{ profiles: ProfileInfo[] }>("/api/profiles")
      .then((d) => { setProfiles(d.profiles); setError(null); })
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function start(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(name);
    try {
      await apiPost("/api/profiles/start", { profile: name });
      toast.success(`已启动 ${name}`);
      load();
    } catch (err) {
      toast.error(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  }

  async function confirmStop() {
    if (!stopTarget) return;
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile: stopTarget });
      toast.success(`已停止 ${stopTarget}`);
      setStopTarget(null);
      setTimeout(load, 500);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Profiles</h1>
          <p className="text-sm text-muted-foreground">选择一个 profile 查看运行状态与配置</p>
        </div>
        <Button onClick={() => setCreating(true)}>新建 Profile</Button>
      </div>
      {error && <p className="text-destructive text-sm">加载失败：{error}</p>}

      <div className="space-y-2">
        {profiles?.length === 0 && (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            暂无 profile，点「新建 Profile」开始。
          </p>
        )}
        {profiles?.map((p) => (
          <button
            key={p.name}
            onClick={() => onOpen(p.name)}
            className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <Badge variant="secondary">{p.agentKind}</Badge>
                {p.running ? <Badge variant="success">在线</Badge> : <Badge variant="outline">未运行</Badge>}
              </div>
            </div>
            {p.running ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={(e) => { e.stopPropagation(); setStopTarget(p.name); }}
              >
                停止
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy === p.name} onClick={(e) => start(p.name, e)}>
                {busy === p.name ? "启动中…" : "启动"}
              </Button>
            )}
            <ChevronRight className="text-muted-foreground" />
          </button>
        ))}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Profile</DialogTitle>
          </DialogHeader>
          <OnboardWizard
            onCreated={(name) => {
              setCreating(false);
              load();
              onOpen(name);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!stopTarget} onOpenChange={(o) => !o && setStopTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止 {stopTarget}？</DialogTitle>
            <DialogDescription>
              将停止该 profile 正在运行的 bot。若它是后台服务，会一并禁用自动重启（不会被 KeepAlive 拉起）；
              下次可用 <code>lark-channel-bridge start</code> 重新启动。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopTarget(null)} disabled={stopping}>取消</Button>
            <Button variant="destructive" onClick={confirmStop} disabled={stopping}>
              {stopping ? "停止中…" : "确认停止"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
