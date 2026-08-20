// 작성 예시를 입력칸 옆에서 펼쳐 본다 (기획 C1).
//
// 예시 패널이 입력과 좌우로 나뉘어 있어 실제 작성칸이 절반뿐이었다 — 두 번 지적된 지점이다.
// 그래서 예시는 버튼 뒤로 넣고 입력이 화면 전폭을 쓴다. 대신 예시를 두 세트로만 줄이고
// (공통 기준 1건 + 같은 직군 1건) 그 안에서는 과업·활동·스킬까지 전부 펼쳐 보여 준다.
import { useMemo } from "react";
import { BookOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COPY } from "@/lib/glossary";
import { cn } from "@/lib/utils";

import type { ExampleRow } from "./types";

/** example_library 행. 어떤 예시를 고를지에 쓰는 두 열이 types.ts 계약에는 없어 여기서 확장한다. */
export interface ExampleLibRow extends ExampleRow {
  is_common?: boolean | null;
  job_group_key?: string | null;
}

const FIELD_LABEL: Record<ExampleRow["field"], string> = {
  definition: "직무 정의",
  mission: "직무 목적",
  task: "과업",
  activity: "세부 활동",
  skill: "필요 역량",
};

const FIELD_ORDER: ExampleRow["field"][] = ["definition", "mission", "task", "activity", "skill"];

/**
 * 예시는 딱 두 세트 — ① 인사팀이 만든 공통 기준, ② 참여자와 같은 직군의 작성 예시.
 * 세트 안에서는 요청한 항목의 행을 모두 담는다(과업 2건·활동 2건처럼 여러 행이 있으면 전부).
 */
export function pickExamples(
  examples: ExampleRow[],
  jobGroup: string,
  fields?: ExampleRow["field"][],
): { heading: string; rows: ExampleRow[] }[] {
  const key = jobGroup.trim();
  const rows = examples as ExampleLibRow[];
  const wanted = FIELD_ORDER.filter((f) => !fields || fields.includes(f));
  const pick = (match: (e: ExampleLibRow) => boolean) =>
    wanted.flatMap((f) => rows.filter((e) => e.field === f && match(e)));

  const common = pick((e) => e.is_common === true);
  const mine = key ? pick((e) => e.is_common !== true && e.job_group_key === key) : [];

  const columns: { heading: string; rows: ExampleRow[] }[] = [];
  if (common.length) columns.push({ heading: COPY.exampleStandard, rows: common });
  if (mine.length) columns.push({ heading: `${key} 직군 예시`, rows: mine });
  return columns;
}

function ExampleBody({ row }: { row: ExampleRow }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-[11px] font-semibold text-muted-foreground">{FIELD_LABEL[row.field]}</p>
      <p className="mt-2 text-sm leading-relaxed">{row.good_example}</p>
      {row.note ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">왜 좋은가 </span>
          {row.note}
        </p>
      ) : null}
      {row.bad_example ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
          <Badge variant="outline" className="shrink-0 text-[10px] font-semibold">
            아쉬운 예
          </Badge>
          <span className="text-xs text-muted-foreground">{row.bad_example}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 입력 항목 옆에 붙는 [예시 보기] 버튼. 보여 줄 예시가 없으면 버튼 자체를 렌더하지 않는다
 * (누르면 빈 화면이 나오는 버튼은 두지 않는다).
 */
export function ExamplePopover({
  examples,
  jobGroup,
  fields,
  label = COPY.showExample,
  className,
}: {
  examples: ExampleRow[];
  /** 참여자가 2단계에서 적은 직군. 비어 있으면 공통 기준 예시만 나온다. */
  jobGroup: string;
  /** 이 자리에서 보여 줄 항목. 생략하면 세트 전체를 보여 준다. */
  fields?: ExampleRow["field"][];
  label?: string;
  className?: string;
}) {
  const columns = useMemo(
    () => pickExamples(examples, jobGroup, fields),
    [examples, jobGroup, fields],
  );
  if (columns.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-7 shrink-0 gap-1 px-2 text-xs font-medium text-primary", className)}
        >
          <BookOpen className="size-3.5" aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[70vh] w-[min(92vw,34rem)] overflow-y-auto p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="divide-y">
          {columns.map((col) => (
            <div key={col.heading} className="space-y-2 p-3">
              <p className="text-xs font-semibold text-primary">{col.heading}</p>
              {col.rows.map((row) => (
                <ExampleBody key={`${row.field}-${row.good_example}`} row={row} />
              ))}
            </div>
          ))}
        </div>
        <p className="border-t bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          예시는 두 건만 둡니다. 그대로 옮겨 적지 말고 본인 업무의 말로 바꿔 적어 주세요.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export default ExamplePopover;
