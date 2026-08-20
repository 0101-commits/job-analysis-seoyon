// 작성 중 항상 보이는 진행 체크리스트 (기획 C3).
//
// 지금까지는 상단 단계 바만 있어서, 무엇이 비었는지는 제출 버튼을 누른 뒤에야 알 수 있었다.
// 이제 남은 항목을 옆에 세워 두고 누르면 그 자리로 데려간다 — 데스크톱은 우측 고정 패널,
// 좁은 화면은 하단 바 + 시트. 제출 버튼은 어느 단계에서도 보이고 남은 개수를 함께 달고 있다.
import { useState } from "react";
import { Check, CircleDashed, ListChecks, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import type { ChecklistEntry } from "./validation";

export interface StepChecklistProps {
  steps: { n: number; label: string }[];
  items: ChecklistEntry[];
  currentStep: number;
  /** 항목을 눌렀을 때. 단계 이동 + anchor 요소로 스크롤을 호출부가 처리한다. */
  onJump: (step: number, anchor: string) => void;
  /** 제출 버튼. 읽기 전용(제출 완료)이면 null 을 넘겨 버튼을 숨긴다. */
  submit: { onClick: () => void; disabled: boolean } | null;
}

function ItemRow({
  item,
  onJump,
}: {
  item: ChecklistEntry;
  onJump: (step: number, anchor: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(item.step, item.anchor)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary",
          item.done ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {item.done ? (
          <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        ) : (
          <CircleDashed
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              item.required ? "text-warning" : "text-muted-foreground",
            )}
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block leading-snug">{item.label}</span>
          {item.hint ? (
            <span className="mt-0.5 block leading-snug text-[11px] text-muted-foreground">
              {item.hint}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Body({ steps, items, currentStep, onJump }: Omit<StepChecklistProps, "submit">) {
  return (
    <div className="space-y-3">
      {steps.map((s) => {
        const rows = items.filter((i) => i.step === s.n);
        if (rows.length === 0) return null;
        const left = rows.filter((i) => i.required && !i.done).length;
        return (
          <div key={s.n}>
            <div className="flex items-center gap-2 px-2">
              <span
                className={cn(
                  "text-[11px] font-semibold",
                  s.n === currentStep ? "text-primary" : "text-muted-foreground",
                )}
              >
                {s.n}. {s.label}
              </span>
              {left > 0 ? (
                <span className="rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning tabular-nums">
                  {left}
                </span>
              ) : (
                <Check className="size-3 text-success" aria-hidden />
              )}
            </div>
            <ul className="mt-0.5">
              {rows.map((item) => (
                <ItemRow key={item.id} item={item} onJump={onJump} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function StepChecklist({ steps, items, currentStep, onJump, submit }: StepChecklistProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const left = items.filter((i) => i.required && !i.done).length;
  const submitLabel = left > 0 ? `제출하기 (남은 ${left}개)` : "제출하기";

  // 시트에서 항목을 누르면 시트를 닫아야 대상 필드가 보인다.
  const jumpAndClose = (step: number, anchor: string) => {
    setSheetOpen(false);
    onJump(step, anchor);
  };

  const submitButton = submit ? (
    <Button className="w-full" onClick={submit.onClick} disabled={submit.disabled}>
      <Send className="size-4" />
      {submitLabel}
    </Button>
  ) : null;

  return (
    <>
      <aside className="hidden lg:block">
        <div className="sticky top-28 space-y-3 rounded-xl border bg-card p-3 shadow-sm">
          <div className="flex items-center gap-2 px-1">
            <ListChecks className="size-4 text-primary" aria-hidden />
            <p className="text-sm font-semibold">작성 점검</p>
          </div>
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            {left > 0
              ? `제출까지 채워야 할 항목이 ${left}개 남았습니다. 항목을 누르면 그 자리로 이동합니다.`
              : "필요한 항목을 모두 채웠습니다. 언제든 제출할 수 있습니다."}
          </p>
          <div className="max-h-[calc(100vh-20rem)] overflow-y-auto">
            <Body steps={steps} items={items} currentStep={currentStep} onJump={onJump} />
          </div>
          {submitButton}
        </div>
      </aside>

      {/* 좁은 화면 — 하단 고정 바에서 시트로 펼친다. 본문 하단 여백은 호출부가 준다. */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t bg-card/95 p-2 backdrop-blur lg:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="flex-1">
              <ListChecks className="size-4" />
              작성 점검
              {left > 0 ? (
                <span className="ml-1 rounded-full bg-warning/15 px-1.5 text-xs font-semibold text-warning tabular-nums">
                  {left}
                </span>
              ) : (
                <Check className="ml-1 size-4 text-success" aria-hidden />
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[75vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>작성 점검</SheetTitle>
            </SheetHeader>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              {left > 0
                ? `제출까지 ${left}개 남았습니다. 항목을 누르면 그 자리로 이동합니다.`
                : "필요한 항목을 모두 채웠습니다."}
            </p>
            <Body steps={steps} items={items} currentStep={currentStep} onJump={jumpAndClose} />
          </SheetContent>
        </Sheet>
        {submit ? (
          <Button className="flex-1" onClick={submit.onClick} disabled={submit.disabled}>
            <Send className="size-4" />
            {left > 0 ? `제출 (${left})` : "제출하기"}
          </Button>
        ) : null}
      </div>
    </>
  );
}

export default StepChecklist;
