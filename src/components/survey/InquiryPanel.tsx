// 문의함 (F6) — 참여자 홈에 상시 노출되는 섹션. [문의하기] 로 새 문의를 남기고,
// 지금까지 낸 문의와 답변을 여기서 확인한다.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  listMyInquiries,
  markAnswerSeen,
  INQUIRY_CATEGORY_LABELS,
  INQUIRY_SLA_NOTICE,
  type InquiryCategory,
  type MyInquiry,
} from "@/lib/inquiry.functions";
import { InquiryComposer } from "@/components/survey/InquiryComposer";
import { MY_INQUIRIES_QUERY_KEY } from "@/components/survey/InquiryAnswerBanner";

function InquiryRow({ row }: { row: MyInquiry }) {
  const queryClient = useQueryClient();
  const unseen = row.status === "답변완료" && !row.answer_seen_at;

  // 답변을 펼쳐 읽으면 그 순간 확인 처리한다 — 배너와 목록 어느 쪽에서 읽어도 같이 지워진다.
  function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (e.currentTarget.open && unseen) {
      void markAnswerSeen({ data: { id: row.id } }).then(() =>
        queryClient.invalidateQueries({ queryKey: MY_INQUIRIES_QUERY_KEY }),
      );
    }
  }

  return (
    <li className="rounded-lg border bg-background p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {INQUIRY_CATEGORY_LABELS[row.category as keyof typeof INQUIRY_CATEGORY_LABELS] ??
              row.category}
          </Badge>
          <Badge variant={row.status === "답변완료" ? "default" : "secondary"}>
            {row.status === "답변완료" ? "답변완료" : "접수 · 확인 중"}
          </Badge>
          {unseen ? <Badge variant="destructive">새 답변</Badge> : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {new Date(row.created_at).toLocaleDateString("ko-KR")}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap">{row.body}</p>
      {row.status === "답변완료" ? (
        <details className="mt-2" onToggle={onToggle}>
          <summary className="cursor-pointer text-xs font-medium text-primary">답변 보기</summary>
          <p className="mt-1 whitespace-pre-wrap rounded-md bg-secondary p-2 text-sm">
            {row.answer?.trim() || "(답변 내용 없음)"}
          </p>
        </details>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{INQUIRY_SLA_NOTICE}</p>
      )}
    </li>
  );
}

export function InquiryPanel({ defaultCategory }: { defaultCategory?: InquiryCategory }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: MY_INQUIRIES_QUERY_KEY,
    queryFn: () => listMyInquiries(),
  });
  const rows = data ?? [];

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <MessageCircleQuestion className="size-4 text-primary" />
            문의하기
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            내 직무가 목록에 없거나 항목이 이해되지 않으면 남겨 주세요. {INQUIRY_SLA_NOTICE}
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          문의 남기기
        </Button>
      </div>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => (
            <InquiryRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}

      <InquiryComposer
        open={open}
        onOpenChange={setOpen}
        {...(defaultCategory ? { defaultCategory } : {})}
      />
    </section>
  );
}

export default InquiryPanel;
