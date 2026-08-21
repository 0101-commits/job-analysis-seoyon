import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { screenSignals, type ScreenSignals } from "@/lib/dashboard.functions";

/**
 * 화면 상단 경고 배너 (v6 G4).
 *
 * 「확인할 일」은 대시보드에 모아 두는 대신, 그 일을 처리하는 화면의 상단에 붙인다.
 * `<ScreenAlert screen="review" />` 처럼 화면 이름만 주면 스스로 조회해서,
 * 그 화면 몫의 경고가 있을 때만 그린다. 0건이면 아무것도 렌더하지 않는다.
 * 메뉴 배지(AdminShell)와 같은 쿼리를 공유한다 — useScreenSignals 하나만 캐시된다.
 */

export type AlertScreen = Exclude<keyof ScreenSignals, "asOf">;

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

export function useScreenSignals() {
  return useQuery({
    queryKey: ["screen-signals"],
    queryFn: async () => screenSignals({ headers: await authHeaders() }),
    staleTime: 5 * 60_000,
  });
}

const TONE_CLASSES = {
  attention: "border-warning/50 bg-warning/10",
  critical: "border-destructive/50 bg-destructive/10",
} as const;

const TONE_ICON = {
  attention: "text-warning",
  critical: "text-destructive",
} as const;

export function ScreenAlert({ screen, className }: { screen: AlertScreen; className?: string }) {
  const { data } = useScreenSignals();
  const items = data?.[screen] ?? [];
  if (items.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)} role="status">
      {items.map((item) => (
        <div
          key={item.key}
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            TONE_CLASSES[item.tone],
          )}
        >
          <AlertTriangle className={cn("size-4 shrink-0", TONE_ICON[item.tone])} aria-hidden />
          <span className="min-w-0 flex-1 font-medium">
            {item.label} {item.count}건
          </span>
          <Button size="sm" variant="outline" asChild>
            <a href={item.href}>확인하기</a>
          </Button>
        </div>
      ))}
    </div>
  );
}
