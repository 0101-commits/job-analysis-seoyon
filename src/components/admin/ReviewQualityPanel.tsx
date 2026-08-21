import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { QualityBadge } from "@/components/admin/QualityBadge";
import { bulkApproveResponses, scoreResponses } from "@/lib/review.functions";
import type { QueueRow } from "@/components/admin/ReviewWorkbench";

/**
 * F16 점검 실행 · 일괄 승인 후보.
 *
 * 응답 500건을 한 사람이 본다. 규칙 점검을 한 번 돌려 위험한 건을 목록 위로 올리고,
 * 양호한 건은 사유를 확인한 뒤 묶어서 승인해 손이 가는 건에 시간을 남긴다.
 *
 * 일괄 승인도 승인 게이트를 건마다 그대로 통과해야 한다. 통과하지 못한 건은
 * 승인되지 않고 사유가 아래에 그대로 남는다 — 조용히 넘어가지 않는다.
 */

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

type SkipRow = { responseId: string; name: string; jobName: string; reason: string };

export function ReviewQualityPanel({
  rows,
  unchecked,
  companyId,
  onSelect,
}: {
  rows: QueueRow[];
  unchecked: number;
  companyId: string | null;
  /** 사유를 확인하려고 그 응답을 열 때. */
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [skipped, setSkipped] = useState<SkipRow[]>([]);

  // 후보 = 지금 목록에 있는 제출 상태 + 양호 등급. 게이트는 서버가 건마다 다시 본다.
  const candidates = useMemo(
    () => rows.filter((r) => r.status === "submitted" && r.grade === "양호"),
    [rows],
  );
  const selected = candidates.filter((r) => checked[r.id] !== false);

  const attention = rows.filter((r) => r.grade === "주의").length;

  const runCheck = useMutation({
    mutationFn: () => scoreResponses({ data: { companyId } }),
    onSuccess: (result) => {
      toast.success(
        result.checked === 0
          ? "점검할 응답이 없습니다."
          : `${result.checked}건을 점검했습니다. 주의 ${result.summary.주의} · 보통 ${result.summary.보통} · 양호 ${result.summary.양호}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["review-detail"] });
    },
    onError: (err) => toast.error(`점검에 실패했습니다: ${errorMessage(err)}`),
  });

  const bulk = useMutation({
    mutationFn: (ids: string[]) => bulkApproveResponses({ data: { responseIds: ids } }),
    onSuccess: (result) => {
      setSkipped(result.skipped);
      setChecked({});
      if (result.approved.length > 0) {
        toast.success(
          result.skipped.length > 0
            ? `${result.approved.length}건을 승인했습니다. ${result.skipped.length}건은 승인 조건에 걸려 남겨 두었습니다.`
            : `${result.approved.length}건을 승인했습니다.`,
        );
      } else {
        toast.error("승인된 건이 없습니다. 아래 사유를 확인하세요.");
      }
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (err) => toast.error(`일괄 승인에 실패했습니다: ${errorMessage(err)}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-semibold">
            지금 목록 {rows.length}건 중 점검 전 {unchecked}건 · 주의 {attention}건
          </p>
          <p className="text-xs text-muted-foreground">
            과업·활동 수, 문장 길이, 같은 문장 반복, 작성 예시 붙여쓰기, 역량·자격요건, 정의·목적을
            규칙으로 확인해 100점에서 깎습니다. 결과는 검토 목록 정렬과 아래 승인 후보에 함께
            쓰입니다.
          </p>
        </div>
        <Button onClick={() => runCheck.mutate()} disabled={runCheck.isPending}>
          {runCheck.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          점검 실행
        </Button>
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">일괄 승인 후보 {candidates.length}건</p>
          {candidates.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setChecked(
                    selected.length === candidates.length
                      ? Object.fromEntries(candidates.map((r) => [r.id, false]))
                      : {},
                  )
                }
              >
                {selected.length === candidates.length ? "전체 해제" : "전체 선택"}
              </Button>
              <Button
                size="sm"
                disabled={selected.length === 0 || bulk.isPending}
                onClick={() => bulk.mutate(selected.map((r) => r.id))}
              >
                {bulk.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                선택한 {selected.length}건 승인
              </Button>
            </div>
          )}
        </div>

        {candidates.length === 0 ? (
          <EmptyState
            kind="nothing"
            title="묶어서 승인할 만한 건이 없습니다"
            description={
              unchecked > 0
                ? "아직 점검하지 않은 응답이 있습니다. 위 「점검 실행」을 누르면 양호한 건이 여기에 모입니다."
                : "지금 조건에서는 양호 등급 제출 건이 없습니다. 상태 필터를 「제출」로 두고 다시 확인하세요."
            }
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              양호 등급만 모았습니다. 승인 조건(확정되지 않은 AI 초안, 1인 응답 직무의 인터뷰 기록,
              내용 없는 제출)은 건마다 그대로 확인하며, 걸린 건은 승인하지 않고 사유를 아래에
              남깁니다.
            </p>
            <ul className="divide-y rounded-lg border">
              {candidates.map((r) => (
                <li key={r.id} className="flex items-start gap-3 p-3">
                  <Checkbox
                    checked={checked[r.id] !== false}
                    onCheckedChange={(v) => setChecked((prev) => ({ ...prev, [r.id]: v === true }))}
                    aria-label={`${r.participants?.name ?? "응답"} 승인 대상 선택`}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelect(r.id)}
                  >
                    <p className="truncate text-sm font-medium">
                      {r.participants?.name ?? "-"}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {r.job_name ?? "직무 미입력"} · {r.jobCount}인 응답
                      </span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.companies?.name} · {r.participants?.org_text ?? "소속 미지정"}
                    </p>
                  </button>
                  <QualityBadge score={r.quality_score} />
                </li>
              ))}
            </ul>
          </>
        )}

        {skipped.length > 0 && (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="text-sm font-semibold">승인하지 않은 {skipped.length}건</p>
            <ul className="space-y-1.5 text-xs">
              {skipped.map((s) => (
                <li key={s.responseId}>
                  <button
                    type="button"
                    className="text-left underline-offset-2 hover:underline"
                    onClick={() => onSelect(s.responseId)}
                  >
                    <span className="font-medium">
                      {s.name || "이름 미확인"} · {s.jobName}
                    </span>{" "}
                    — {s.reason}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
