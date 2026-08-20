// 변경 재확인 배너 (F10). 관리자가 조직·직무 기준정보를 고쳤을 때 참여자가 알아야 하는
// 최소한 — "무엇이 바뀌었는지" 와 "확인했다는 표시" 만 다룬다. 확인 전에도 조사 작성은
// 계속할 수 있어야 하므로 막는 화면이 아니라 배너로만 낸다.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { clearRecheck } from "@/lib/inquiry.functions";
import { SignalCard } from "@/components/SignalCard";

export const RECHECK_QUERY_KEY = ["my-recheck-status"];

export function RecheckBanner() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const { data } = useQuery({
    queryKey: RECHECK_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("responses")
        .select("id, recheck_required, recheck_reason")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 30_000,
  });

  if (!data?.recheck_required) return null;

  async function confirm() {
    if (!data || pending) return;
    setPending(true);
    try {
      await clearRecheck({ data: { responseId: data.id } });
      await queryClient.invalidateQueries({ queryKey: RECHECK_QUERY_KEY });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "확인 처리에 실패했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <SignalCard
      tone="attention"
      signal="관리자가 조직·직무 정보를 바꿨습니다 — 확인이 필요합니다"
      evidence={[
        data.recheck_reason?.trim() || "무엇이 바뀌었는지는 적혀 있지 않습니다.",
        "확인 전에도 조사 작성은 계속할 수 있습니다.",
      ]}
      actions={[{ label: pending ? "처리 중..." : "확인했습니다", onClick: () => void confirm() }]}
    />
  );
}

export default RecheckBanner;
