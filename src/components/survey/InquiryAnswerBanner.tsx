// 새 문의 답변 배너 (F6). 답변 내용을 이 자리에서 바로 읽을 수 있게 하고, 확인하면
// 표시를 지운다 — 답변을 보려고 다른 화면까지 갈 필요는 없다.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listMyInquiries, markAnswerSeen, INQUIRY_CATEGORY_LABELS } from "@/lib/inquiry.functions";
import { SignalCard } from "@/components/SignalCard";

export const MY_INQUIRIES_QUERY_KEY = ["my-inquiries"];

export function InquiryAnswerBanner() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: MY_INQUIRIES_QUERY_KEY,
    queryFn: () => listMyInquiries(),
    staleTime: 30_000,
  });

  const unseen = (data ?? []).filter((r) => r.status === "답변완료" && !r.answer_seen_at);
  if (unseen.length === 0) return null;

  async function confirm(id: string) {
    if (confirming) return;
    setConfirming(id);
    try {
      await markAnswerSeen({ data: { id } });
      await queryClient.invalidateQueries({ queryKey: MY_INQUIRIES_QUERY_KEY });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "확인 처리에 실패했습니다.");
    } finally {
      setConfirming(null);
    }
  }

  return (
    <div className="space-y-3">
      {unseen.map((r) => (
        <SignalCard
          key={r.id}
          tone="good"
          signal={`「${INQUIRY_CATEGORY_LABELS[r.category as keyof typeof INQUIRY_CATEGORY_LABELS] ?? r.category}」 문의에 답변이 왔습니다`}
          evidence={[`문의: ${r.body}`, `답변: ${r.answer?.trim() || "(답변 내용 없음)"}`]}
          {...(r.answered_at ? { asOf: new Date(r.answered_at).toLocaleString("ko-KR") } : {})}
          actions={[
            {
              label: confirming === r.id ? "처리 중..." : "확인했습니다",
              onClick: () => void confirm(r.id),
            },
          ]}
        />
      ))}
    </div>
  );
}

export default InquiryAnswerBanner;
