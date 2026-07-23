import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/api";
import type { OnboardState, Status } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { ProfilesView } from "@/views/ProfilesView";
import { ProfileDetail } from "@/views/ProfileDetail";
import { OnboardWizard } from "@/views/OnboardWizard";

export function App() {
  const [onboard, setOnboard] = useState<OnboardState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const os = await apiGet<OnboardState>("/api/onboard/state");
      setOnboard(os);
      if (os.hasConfig) {
        setStatus(await apiGet<Status>("/api/status").catch(() => null));
      }
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <Shell><p className="text-destructive text-sm">加载失败：{error}</p></Shell>;
  if (!onboard) return <Shell><p className="text-muted-foreground text-sm">加载中…</p></Shell>;

  if (!onboard.hasConfig) {
    return (
      <Shell>
        <Card>
          <CardHeader><CardTitle>初始化 AI 助手</CardTitle></CardHeader>
          <CardContent>
            <OnboardWizard onCreated={() => void refresh()} />
          </CardContent>
        </Card>
        <Toaster />
      </Shell>
    );
  }

  return (
    <Shell>
      {selected ? (
        <ProfileDetail profile={selected} onBack={() => { setSelected(null); void refresh(); }} />
      ) : (
        <>
          <ProfilesView onOpen={setSelected} />
          {status && (
            <p className="mt-6 text-xs text-muted-foreground">
              单主进程托管所有 profile · v{status.version} · {status.online} 个在线 · 改在线 profile 的配置即时生效
            </p>
          )}
        </>
      )}
      <Toaster />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl p-6">{children}</div>;
}
