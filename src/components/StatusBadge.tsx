import { cn } from "@/lib/utils";
import { STATUS_FOR_RESPONDENT, STATUS_HELP } from "@/lib/glossary";

/**
 * 진행 상태 배지 (기획 D2).
 *
 * 상태 7종의 색·문구를 여기 한 곳에서만 정한다. 관리자와 참여자가 같은 상태를 보되
 * 참여자에게는 자기 일의 언어로 보여 준다(`perspective="respondent"`).
 */

type Status = "미발송" | "초대발송" | "미접속" | "작성중" | "제출" | "반려" | "승인";

const STYLES: Record<string, string> = {
  미발송: "bg-muted text-muted-foreground border-border",
  초대발송: "bg-primary-soft text-accent-foreground border-primary/20",
  미접속: "bg-muted text-muted-foreground border-border",
  작성중: "bg-warning/15 text-warning border-warning/30",
  제출: "bg-primary-soft text-accent-foreground border-primary/25",
  반려: "bg-destructive/10 text-destructive border-destructive/25",
  승인: "bg-success/15 text-success border-success/30",
};

/** 진행 순서 — 대시보드 진행 단계 보드(B1)와 정렬을 맞추기 위한 단일 원천. */
export const STATUS_ORDER: Status[] = [
  "미발송",
  "초대발송",
  "미접속",
  "작성중",
  "제출",
  "반려",
  "승인",
];

export function statusLabel(status: string, perspective: "admin" | "respondent" = "admin") {
  if (perspective === "respondent") return STATUS_FOR_RESPONDENT[status] ?? status;
  return status;
}

export function statusHelp(status: string) {
  return STATUS_HELP[status] ?? "";
}

export function StatusBadge({
  status,
  className,
  perspective = "admin",
  withHelp = false,
}: {
  status: string;
  className?: string;
  /** 참여자 화면에서는 상태 문구를 1인칭 관점으로 바꾼다. */
  perspective?: "admin" | "respondent";
  /** 마우스를 올리면 상태 설명을 띄운다. */
  withHelp?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold",
        STYLES[status] ?? "bg-muted text-muted-foreground border-border",
        className,
      )}
      title={withHelp ? statusHelp(status) : undefined}
    >
      {statusLabel(status, perspective)}
    </span>
  );
}
