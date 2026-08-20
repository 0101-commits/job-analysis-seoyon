import { cn } from "@/lib/utils";
import { qualityGrade, type QualityGrade } from "@/lib/review.functions";

/**
 * F16 점검 결과 배지 — 검토 목록·판단 패널·일괄 승인 후보가 같은 표기를 쓴다.
 * 점검하지 않은 응답은 등급을 만들어 내지 않고 "점검 전"이라고 밝힌다.
 */

const STYLE: Record<QualityGrade, string> = {
  주의: "bg-destructive/10 text-destructive",
  보통: "bg-warning/15 text-warning",
  양호: "bg-success/15 text-success",
};

export function QualityBadge({
  score,
  className,
}: {
  score: number | null | undefined;
  className?: string;
}) {
  const grade = qualityGrade(score);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        grade ? STYLE[grade] : "bg-secondary text-muted-foreground",
        className,
      )}
      title={grade ? `점검 점수 ${score}점` : "아직 점검하지 않았습니다"}
    >
      {grade ? `${grade} ${score}점` : "점검 전"}
    </span>
  );
}
