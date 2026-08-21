import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * 단일 열 검토 화면의 세 층 (기획: 관리자 응답 검토 재설계).
 *
 * 관리자 화면이 목록·원문·판단을 세 열로 나란히 놓아서, 화면이 넓어져도 시선
 * 왕복·스크롤 분기·지면 흔들림이 남았다. 기본 배치에서 병렬 열을 없애고
 * 한 번에 한 상태(훑기 / 판단 / 도구 층)만 화면을 쓰게 한다. 폭 상한은
 * 셸이 아니라 내용이 갖는다 — `DocPane`은 읽기 폭, `ActionBar`는 하단 결정 바,
 * `ToolLayer`는 원문 위를 덮는 층이다.
 *
 * 사용 예:
 * ```tsx
 * <div className="flex min-h-svh flex-col">
 *   <DocPane className="flex-1">
 *     <h1>...</h1>
 *     <p>...</p>
 *   </DocPane>
 *   <ActionBar
 *     primary={<Button onClick={approve}>승인</Button>}
 *     secondary={<Button variant="outline" onClick={reject}>반려</Button>}
 *     gates={gates}
 *   />
 *   <ToolLayer open={toolOpen} onOpenChange={setToolOpen} title="AI 점검">
 *     ...
 *   </ToolLayer>
 * </div>
 * ```
 */

export function DocPane({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full min-w-0 max-w-[var(--measure-read)] space-y-4", className)}>
      {children}
    </div>
  );
}

/** 표·비교처럼 넓이가 실제로 필요한 블록만 이걸 쓴다 — DocPane 바깥에 놓는다. */
export function DocWide({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[var(--measure-wide)]", className)}>{children}</div>
  );
}

export type ActionGate = {
  /** 액션 바 칩에 보일 짧은 문구. 예: "인터뷰 기록 없음" */
  label: string;
  /** 칩을 눌렀을 때 사용자를 근거로 데려가는 동작. */
  onFocus: () => void;
};

/**
 * 결정 — 화면 하단 고정 바. 막는 이유는 회색 버튼이 아니라 문장으로 말한다.
 * 페이지 컨테이너의 마지막 자식으로 놓는다 (별도 음수 마진 트릭 불필요).
 */
export function ActionBar({
  primary,
  secondary,
  gates,
  hint,
  className,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  gates?: ActionGate[];
  hint?: ReactNode;
  className?: string;
}) {
  const gateList = gates ?? [];
  return (
    <div className={cn("sticky bottom-0 z-20 border-t bg-card px-4 py-3 sm:px-6", className)}>
      <div
        role="group"
        aria-label="판단"
        aria-live="polite"
        className="mb-2 flex flex-wrap items-center gap-1.5"
      >
        {gateList.length > 0 ? (
          <>
            <span className="text-xs font-bold text-destructive">승인 불가 {gateList.length}</span>
            {gateList.map((gate, i) => (
              <button
                key={i}
                type="button"
                onClick={gate.onFocus}
                title={`${gate.label} — 근거로 이동`}
                className="rounded-full border border-destructive/35 bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive"
              >
                {gate.label}
              </button>
            ))}
          </>
        ) : (
          <span className="text-xs font-bold text-success">게이트 통과</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-1 gap-2">
          {primary}
          {secondary}
        </div>
        {hint && <div className="shrink-0 text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * 도구 — 판단 화면을 덮는 층. 열이 아니라 층이므로 원문 폭을 재계산하지 않는다.
 * `modal={false}`로 원문이 뒤에서 계속 읽히고 페이지 스크롤 위치도 유지된다.
 * Esc 닫기는 Radix Dialog 기본 동작(`onOpenChange`)을 그대로 쓴다.
 */
export function ToolLayer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        // 판단 화면 단축키가 이 층을 외부 대화상자로 오인하지 않도록 표식을 남긴다.
        id="tool-layer"
        side="right"
        // 이 층 안 스크롤만 예외적으로 허용한다 — 원문은 스크롤이 분기되지 않는다.
        className="w-full overflow-y-auto sm:w-[var(--layer-w)] sm:max-w-[var(--layer-w)]"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {children}
        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
