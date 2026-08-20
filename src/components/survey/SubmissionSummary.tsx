// 제출 전 「내가 쓴 내용 한 장 요약」 (기획 C7).
//
// 순수 컴포넌트 — 데이터는 props 로만 받는다. 제출 후 참여자 홈에서 같은 요약을 다시 보여 주기
// 때문에 조사 화면의 상태나 저장 로직에 손을 대지 않는다.
import { AlertCircle, CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SubmissionSummaryProps {
  job: { group: string; series: string; name: string };
  definition: string;
  mission: string;
  taskCount: number;
  activityCount: number;
  skillCount: number;
  /** 비어 있는 항목. 누르면 해당 단계로 보낸다. */
  missing: { id: string; label: string; step: number }[];
  /** 없으면 항목이 링크가 아니라 글로만 보인다(홈 화면 재사용). */
  onGoToStep?: (step: number) => void;
  title?: string;
  className?: string;
}

function Tile({
  label,
  value,
  step,
  onGoToStep,
}: {
  label: string;
  value: string;
  step: number;
  onGoToStep?: ((step: number) => void) | undefined;
}) {
  const body = (
    <>
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 block text-sm font-semibold">{value}</span>
    </>
  );
  // 보이는 수치는 대상으로 가는 링크다 (기획 P6).
  if (!onGoToStep) {
    return <div className="rounded-lg border bg-background p-3">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onGoToStep(step)}
      className="rounded-lg border bg-background p-3 text-left transition-colors hover:border-primary hover:bg-secondary"
    >
      {body}
    </button>
  );
}

export function SubmissionSummary({
  job,
  definition,
  mission,
  taskCount,
  activityCount,
  skillCount,
  missing,
  onGoToStep,
  title = "내가 쓴 내용 한 장 요약",
  className,
}: SubmissionSummaryProps) {
  const jobLine = [job.group, job.series, job.name]
    .map((v) => v.trim())
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={cn("space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5", className)}>
      <div className="flex items-center gap-2">
        {missing.length === 0 ? (
          <CheckCircle2 className="size-4 text-success" aria-hidden />
        ) : (
          <AlertCircle className="size-4 text-warning" aria-hidden />
        )}
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>

      <Tile
        label="직군 · 직렬 · 직무"
        value={jobLine || "아직 적지 않았습니다"}
        step={2}
        onGoToStep={onGoToStep}
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <Tile label="과업" value={`${taskCount}건`} step={4} onGoToStep={onGoToStep} />
        <Tile label="세부 활동" value={`${activityCount}건`} step={4} onGoToStep={onGoToStep} />
        <Tile label="필요 역량" value={`${skillCount}건`} step={5} onGoToStep={onGoToStep} />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">직무 정의</p>
        <p className="whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-relaxed">
          {definition.trim() || "아직 적지 않았습니다."}
        </p>
        <p className="text-xs font-semibold text-muted-foreground">직무 목적</p>
        <p className="whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-relaxed">
          {mission.trim() || "아직 적지 않았습니다."}
        </p>
      </div>

      {missing.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="text-xs font-semibold text-warning">
            비어 있는 항목 {missing.length}개 — 누르면 그 단계로 이동합니다
          </p>
          <ul className="mt-2 space-y-1">
            {missing.map((m) =>
              onGoToStep ? (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onGoToStep(m.step)}
                    className="text-left text-xs text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
                  >
                    {m.step}단계 · {m.label}
                  </button>
                </li>
              ) : (
                <li key={m.id} className="text-xs">
                  {m.step}단계 · {m.label}
                </li>
              ),
            )}
          </ul>
        </div>
      ) : (
        <p className="rounded-lg border border-success/40 bg-success/5 p-3 text-xs text-success">
          비어 있는 항목이 없습니다.
        </p>
      )}
    </section>
  );
}

export default SubmissionSummary;
