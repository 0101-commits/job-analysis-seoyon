import type { ReactNode } from "react";
import { Inbox, Lock, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 비어 있는 화면의 3가지 규격 (기획 D3).
 *
 * - `nothing`  아직 만들어진 것이 없다 → 만드는 버튼을 준다
 * - `denied`   볼 권한이 없다 → 누구에게 요청해야 하는지 알려 준다
 * - `blocked`  먼저 해야 할 일이 남았다 → 그 일로 보낸다
 *
 * 어느 경우에도 다음에 할 행동이 화면에 있어야 한다. 빈 표를 그대로 두지 않는다.
 */

type Kind = "nothing" | "denied" | "blocked";

const ICONS: Record<Kind, typeof Inbox> = {
  nothing: Inbox,
  denied: Lock,
  blocked: ListChecks,
};

export function EmptyState({
  kind = "nothing",
  title,
  description,
  actionLabel,
  onAction,
  children,
  className,
}: {
  kind?: Kind;
  title: string;
  /** 왜 비었는지, 그리고 무엇을 하면 채워지는지. */
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  /** 링크 등 버튼 대신 넣을 요소. */
  children?: ReactNode;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center",
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <div className="space-y-1.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mx-auto max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actionLabel && onAction ? (
        <Button size="sm" onClick={onAction} className="mt-1">
          {actionLabel}
        </Button>
      ) : null}
      {children}
    </div>
  );
}
