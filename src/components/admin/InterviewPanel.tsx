import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { deleteInterview, listInterviewTargets, upsertInterview } from "@/lib/review.functions";

/**
 * F7 인터뷰 관리 — 같은 직무 응답자가 1명이면 인터뷰 필수, 2~4명이면 심층 검토 대상이다.
 *
 * 예전에는 승인 창의 체크 한 칸이 전부여서 "인터뷰로 확인했다"는 사실만 남고 무엇을 확인했는지는
 * 어디에도 없었다. 이제 일정·담당·상태·메모를 기록으로 남기고, 1인 직무는 「완료」 기록이
 * 있어야 승인된다. 메모는 그대로 보관되어 직무기술서 작성에서 근거로 읽을 수 있다.
 */

const STATUSES = ["예정", "완료", "취소"] as const;

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

/** <input type="datetime-local"> 이 읽는 형식(YYYY-MM-DDTHH:mm)으로 맞춘다. */
function toLocalInput(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(value: string | null) {
  if (!value) return "일정 미정";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "일정 미정" : d.toLocaleString("ko-KR");
}

type TargetRow = Awaited<ReturnType<typeof listInterviewTargets>>["rows"][number];
type InterviewRow = TargetRow["interviews"][number];

/** 편집 중인 기록. id 가 없으면 새로 남기는 기록이다. */
type Draft = {
  responseId: string;
  id?: string;
  scheduledAt: string;
  interviewer: string;
  status: (typeof STATUSES)[number];
  memo: string;
};

function emptyDraft(responseId: string): Draft {
  return { responseId, scheduledAt: "", interviewer: "", status: "예정", memo: "" };
}

function draftFrom(responseId: string, row: InterviewRow): Draft {
  return {
    responseId,
    id: row.id,
    scheduledAt: toLocalInput(row.scheduled_at),
    interviewer: row.interviewer ?? "",
    status: (STATUSES.find((s) => s === row.status) ?? "예정") as (typeof STATUSES)[number],
    memo: row.memo ?? "",
  };
}

export function InterviewPanel({
  companyId,
  onSelect,
}: {
  companyId: string | null;
  /** 응답 원문을 열어 확인할 때. */
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["interview-targets", companyId],
    queryFn: () => listInterviewTargets({ data: { companyId } }),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["interview-targets"] });
    void queryClient.invalidateQueries({ queryKey: ["review-detail"] });
  }

  const save = useMutation({
    mutationFn: (d: Draft) =>
      upsertInterview({
        data: {
          ...(d.id ? { id: d.id } : {}),
          responseId: d.responseId,
          scheduledAt: d.scheduledAt || null,
          interviewer: d.interviewer.trim() || null,
          status: d.status,
          memo: d.memo.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("인터뷰 기록을 저장했습니다.");
      setDraft(null);
      refresh();
    },
    onError: (err) => toast.error(`저장하지 못했습니다: ${errorMessage(err)}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteInterview({ data: { id } }),
    onSuccess: () => {
      toast.success("인터뷰 기록을 삭제했습니다.");
      refresh();
    },
    onError: (err) => toast.error(`삭제하지 못했습니다: ${errorMessage(err)}`),
  });

  const rows = data?.rows ?? [];

  if (isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;

  if (rows.length === 0) {
    return (
      <EmptyState
        kind="nothing"
        title="인터뷰가 필요한 직무가 없습니다"
        description="같은 직무 응답자가 4명 이하인 경우에만 여기에 나타납니다. 응답이 더 들어오면 자동으로 다시 계산됩니다."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-secondary p-3 text-xs text-muted-foreground">
        응답자가 1명뿐인 직무는 응답만으로 확정할 수 없어 인터뷰가 필수입니다(「완료」 기록이 있어야
        승인됩니다). 2~4명인 직무는 내용을 한 번 더 확인하는 심층 검토 대상입니다. 지금 대상{" "}
        {rows.length}건 · 인터뷰 필수 중 미완료 {data?.pending ?? 0}건.
      </p>

      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.responseId} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">
                  {r.jobName ?? "직무 미입력"}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {r.jobCount}인 응답 · {r.participantName ?? "-"} ({r.orgText ?? "소속 미지정"})
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.companyName ?? "계열사 미지정"} · 사번 {r.empNo ?? "-"}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    r.kind === "인터뷰 필수"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-warning/15 text-warning",
                  )}
                >
                  {r.kind}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    r.done ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
                  )}
                >
                  {r.done ? "확인 완료" : "미확인"}
                </span>
              </div>
            </div>

            {r.interviews.length > 0 && (
              <ul className="mt-3 space-y-2">
                {r.interviews.map((iv) => (
                  <li key={iv.id} className="rounded-lg border bg-secondary/40 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {iv.status} · {formatWhen(iv.scheduled_at)} ·{" "}
                        {iv.interviewer || "담당 미지정"}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDraft(draftFrom(r.responseId, iv))}
                        >
                          수정
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(iv.id)}
                          aria-label="인터뷰 기록 삭제"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    {iv.memo && (
                      <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground">{iv.memo}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {draft?.responseId === r.responseId ? (
              <div className="mt-3 space-y-3 rounded-lg border p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`when-${r.responseId}`}>인터뷰 일시</Label>
                    <Input
                      id={`when-${r.responseId}`}
                      type="datetime-local"
                      value={draft.scheduledAt}
                      onChange={(e) => setDraft({ ...draft, scheduledAt: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`who-${r.responseId}`}>담당</Label>
                    <Input
                      id={`who-${r.responseId}`}
                      value={draft.interviewer}
                      onChange={(e) => setDraft({ ...draft, interviewer: e.target.value })}
                      placeholder="인터뷰를 진행한 사람"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`status-${r.responseId}`}>진행 상태</Label>
                    <Select
                      value={draft.status}
                      onValueChange={(v) =>
                        setDraft({ ...draft, status: v as (typeof STATUSES)[number] })
                      }
                    >
                      <SelectTrigger id={`status-${r.responseId}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`memo-${r.responseId}`}>인터뷰 내용</Label>
                  <Textarea
                    id={`memo-${r.responseId}`}
                    rows={4}
                    value={draft.memo}
                    onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                    placeholder="응답에서 확인·보완한 내용을 적어 주세요. 이 메모는 직무기술서 작성에서 근거로 함께 읽힙니다."
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                    저장
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => setDraft(null)}
                  >
                    취소
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setDraft(emptyDraft(r.responseId))}>
                  인터뷰 기록 남기기
                </Button>
                <Button variant="outline" size="sm" onClick={() => onSelect(r.responseId)}>
                  응답 원문 열기
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
