import { Check, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 자동 저장이 지금 어떤 상태인지 항상 보여 준다 (기획 C6).
 *
 * 자동 저장은 이미 동작하지만 화면에 흔적이 없었다. 저장이 되고 있는지 모르는 화면에서
 * 사용자는 작성을 멈춘다. 실패했을 때는 같은 자리에서 직접 저장할 수 있어야 한다.
 */

export type SaveState = "idle" | "saving" | "saved" | "failed";

export function SaveStatusChip({
  state,
  savedAt,
  retryCount,
  onSaveNow,
  className,
}: {
  state: SaveState;
  /** 마지막으로 저장된 시각. */
  savedAt?: Date | null;
  /** 실패 후 재시도한 횟수 — 왜 아직 저장이 안 됐는지 설명해 준다. */
  retryCount?: number;
  onSaveNow?: () => void;
  className?: string;
}) {
  const time = savedAt
    ? savedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

  if (state === "failed") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive",
          className,
        )}
        role="status"
      >
        <AlertTriangle className="size-3.5" aria-hidden />
        <span>
          저장하지 못했습니다
          {retryCount ? ` · ${retryCount}회 재시도` : ""}
        </span>
        {onSaveNow ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-xs text-destructive hover:bg-destructive/15"
            onClick={onSaveNow}
          >
            지금 저장
          </Button>
        ) : null}
      </span>
    );
  }

  if (state === "saving") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground",
          className,
        )}
        role="status"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        저장 중
      </span>
    );
  }

  if (state === "saved" && time) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs font-medium text-success",
          className,
        )}
        role="status"
      >
        <Check className="size-3.5" aria-hidden />
        <span className="tabular-nums">{time} 저장됨</span>
      </span>
    );
  }

  // 아직 아무것도 입력하지 않은 상태 — 자동 저장이 켜져 있다는 사실만 알린다.
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground",
        className,
      )}
    >
      작성하는 동안 자동으로 저장됩니다
    </span>
  );
}
