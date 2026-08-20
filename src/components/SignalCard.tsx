import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * 알림·경고의 단일 규격 (기획 B2).
 *
 * 한 장의 카드는 반드시 셋을 갖는다.
 *   ① 신호  — 무슨 일인지 한 문장
 *   ② 근거  — 왜 그렇게 판단했는지. 비교 기준·모수·기준 시점을 포함한다
 *   ③ 행동  — 지금 누를 수 있는 것 1~3개
 *
 * 셋 중 하나라도 채울 수 없으면 카드로 만들지 않는다. 볼 것만 있고 할 것이 없는
 * 카드는 화면을 채우지만 일을 진행시키지 않는다.
 * 또한 값이 지난번과 같아 알릴 것이 없으면 카드를 띄우지 않는다.
 */

export type SignalAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: "default" | "outline" | "ghost";
};

export type SignalTone = "neutral" | "attention" | "good";

const TONE_BAR: Record<SignalTone, string> = {
  neutral: "bg-primary",
  attention: "bg-warning",
  good: "bg-success",
};

export function SignalCard({
  signal,
  evidence,
  asOf,
  scope,
  actions = [],
  tone = "neutral",
  children,
  className,
}: {
  /** 한 문장. 조직·수치·상태가 들어간 사실 진술. */
  signal: string;
  /** 근거 2~4줄. 비교 기준과 모수를 포함한다. */
  evidence: string[];
  /** 이 판단의 기준 시점. "지금"이 아니라 언제 기준인지 밝힌다. */
  asOf?: string;
  /** 모수 — 몇 명 중 몇 명인지의 분모. */
  scope?: string;
  actions?: SignalAction[];
  tone?: SignalTone;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <article className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex">
        <div className={cn("w-1 shrink-0", TONE_BAR[tone])} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="px-4 py-3 text-sm font-semibold leading-snug sm:text-[15px]">{signal}</p>

          {evidence.length > 0 ? (
            <div className="space-y-1 border-t bg-secondary/50 px-4 py-3">
              {evidence.map((line) => (
                <p key={line} className="text-[13px] leading-relaxed text-muted-foreground">
                  · {line}
                </p>
              ))}
              {asOf || scope ? (
                <p className="pt-1 text-[11px] tabular-nums text-muted-foreground/80">
                  {[asOf ? `기준 ${asOf}` : null, scope].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t px-4 py-3">
              {actions.map((a) => (
                <Button
                  key={a.label}
                  size="sm"
                  variant={a.variant ?? "default"}
                  onClick={a.onClick}
                  asChild={Boolean(a.href)}
                >
                  {a.href ? <a href={a.href}>{a.label}</a> : <span>{a.label}</span>}
                </Button>
              ))}
            </div>
          ) : null}

          {children}
        </div>
      </div>
    </article>
  );
}
