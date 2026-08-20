import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FIELD_DEFINITIONS, COPY } from "@/lib/glossary";
import { cn } from "@/lib/utils";

/**
 * 판단 항목의 정의를 라벨 옆에서 알려 준다 (기획 C2).
 *
 * 정의는 `glossary.ts` 의 FIELD_DEFINITIONS 한 곳에만 둔다. 화면마다 다르게 설명하면
 * 같은 항목을 두 가지로 이해하게 된다.
 *
 * 마우스를 올리면 뜨고, 키보드·터치에서는 눌러서 열 수 있다.
 */
export function FieldHint({
  term,
  text,
  className,
}: {
  /** FIELD_DEFINITIONS 의 항목명. 예: "중요도" */
  term: string;
  /** 사전에 없는 일회성 설명이 필요할 때만 직접 넘긴다. */
  text?: string;
  className?: string;
}) {
  const body = text ?? FIELD_DEFINITIONS[term];
  if (!body) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${term} 설명`}
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary",
            className,
          )}
        >
          <HelpCircle className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[280px] text-[13px] leading-relaxed"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="mb-1 text-xs font-semibold text-primary">{term}</p>
        <p className="text-muted-foreground">{body}</p>
      </PopoverContent>
    </Popover>
  );
}

/** 라벨 + 설명 아이콘을 한 덩어리로 쓰는 흔한 조합. */
export function LabelWithHint({
  children,
  term,
  required,
  className,
}: {
  children: React.ReactNode;
  term: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="text-sm font-medium">
        {children}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </span>
      <FieldHint term={term} />
    </span>
  );
}

export { COPY };
