// ④단계 Task·Activity 작성 그리드. 순수 컴포넌트 — 저장/이동은 코어(위저드)가 담당한다.
// 예시 패널·안내 박스는 여기서 export 만 하고, 어떤 예시를 보여줄지는 위저드가 정한다(참여자 직군을 알기 때문).
import { useMemo, useState } from "react";
import type { ComponentProps } from "react";
import { ChevronDown, ChevronUp, Info, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type {
  ActivityItem,
  Authority,
  ExampleRow,
  ImproveType,
  TaskGridProps,
  TaskItem,
} from "./types";
import { duplicateTaskIds } from "./validation";

const MAX_KEY_TASKS = 5;

/**
 * 신규 행 id. crypto.randomUUID 는 보안 컨텍스트(https/localhost)에서만 존재하므로
 * 사내 http 배포를 대비해 uuid v4 모양의 폴백을 둔다(DB 컬럼이 uuid 라 모양을 지켜야 한다).
 * SkillGrid 도 같은 헬퍼를 쓴다.
 */
export const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

const IMPORTANCE_HINTS: Record<number, string> = {
  1: "보조적 — 없어도 직무 성과에 큰 영향이 없음",
  2: "낮음 — 가끔 필요한 보완적 과업",
  3: "보통 — 일상적으로 수행하는 표준 과업",
  4: "높음 — 빠지면 성과에 눈에 띄는 손실",
  5: "직무 성과를 좌우 — 이 과업의 품질이 곧 직무의 성패",
};

const AUTHORITY_OPTIONS: { value: Authority; label: string; hint: string }[] = [
  { value: "D", label: "D 결정", hint: "결정 — 내가 최종 판단을 내린다" },
  { value: "R", label: "R 검토", hint: "검토 — 결정 전 내용을 확인하고 의견을 낸다" },
  { value: "O", label: "O 실행", hint: "실행 — 정해진 방침대로 직접 수행한다" },
  { value: "S", label: "S 지원", hint: "지원 — 다른 사람의 수행을 돕는다" },
];

const IMPROVE_TYPES: { value: ImproveType; desc: string }[] = [
  { value: "삭제", desc: "더 이상 필요하지 않아 없애도 되는 과업" },
  { value: "통폐합", desc: "비슷한 다른 과업과 하나로 합칠 수 있는 과업" },
  { value: "빈도감소", desc: "수행 주기를 늘려도 되는 과업 (예: 주간 → 월간)" },
  { value: "하위자위양", desc: "더 낮은 직급·경력자가 맡아도 되는 과업" },
  { value: "타부서이관", desc: "다른 부서가 맡는 편이 자연스러운 과업" },
  { value: "강화", desc: "지금보다 더 많은 시간·자원을 들여야 하는 과업" },
];

const KEY_TASK_HINT = `주요 과업 — 이 직무를 대표하는 과업. 빠지면 직무가 성립하지 않는 것으로 최대 ${MAX_KEY_TASKS}개만 고릅니다.`;

/**
 * ⓘ 아이콘 + 설명. 터치 기기에서 뜨지 않는 hover 툴팁 대신 탭/클릭으로 여는 Popover 를 쓴다.
 * SkillGrid 도 재사용한다.
 */
export function Hint({ text }: { text: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={text}
          aria-label={`설명 보기: ${text}`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-xs leading-relaxed text-pretty">
        {text}
      </PopoverContent>
    </Popover>
  );
}

/** 입력한 만큼 늘어나는 한 줄 시작 입력칸. 과업명·스킬 설명처럼 길이가 들쭉날쭉한 칸에 쓴다. */
export function AutoTextarea({ className, onChange, ...props }: ComponentProps<"textarea">) {
  // 인라인 ref 는 렌더마다 다시 붙으므로 값이 밖에서 바뀌어도 높이가 따라온다.
  const fit = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <Textarea
      ref={fit}
      rows={1}
      className={cn("min-h-0 resize-none overflow-hidden py-2", className)}
      onChange={(e) => {
        fit(e.currentTarget);
        onChange?.(e);
      }}
      {...props}
    />
  );
}

/** example_library 행. 어떤 예시를 고를지에 쓰는 두 컬럼이 types.ts 계약에는 없어 여기서 확장한다. */
export interface ExampleLibRow extends ExampleRow {
  is_common?: boolean | null;
  job_group_key?: string | null;
}

const FIELD_LABEL: Record<ExampleRow["field"], string> = {
  definition: "직무 정의",
  mission: "직무 목적",
  task: "과업",
  activity: "세부 활동",
  skill: "스킬",
};

const FIELD_ORDER: ExampleRow["field"][] = ["definition", "mission", "task", "activity", "skill"];

/**
 * 예시는 딱 2세트 — ① 공통 기준 예시, ② 참여자 직군 예시.
 * 항목(field)별로 한 행씩만 뽑아 한 화면에 담기게 한다.
 */
export function pickExamples(
  examples: ExampleRow[],
  jobGroup: string,
): { heading: string; rows: ExampleRow[] }[] {
  const key = jobGroup.trim();
  const rows = examples as ExampleLibRow[];
  const pick = (match: (e: ExampleLibRow) => boolean) =>
    FIELD_ORDER.flatMap((f) => {
      const row = rows.find((e) => e.field === f && match(e));
      return row ? [row] : [];
    });

  const common = pick((e) => e.is_common === true);
  const mine = key ? pick((e) => e.is_common !== true && e.job_group_key === key) : [];

  const columns: { heading: string; rows: ExampleRow[] }[] = [];
  if (common.length) columns.push({ heading: "공통 기준 예시", rows: common });
  if (mine.length) columns.push({ heading: `${key} 직군 예시`, rows: mine });
  return columns;
}

const EXAMPLES_COLLAPSED_KEY = "survey-examples-collapsed";

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
 * 단계 콘텐츠 상단의 접이식 예시 카드. 좌=공통 기준, 우=내 직군.
 * 접힘 상태는 localStorage 로 기억해 단계를 옮겨도 유지된다.
 */
export function ExamplesPanel({
  examples,
  jobGroup,
  title = "작성 예시",
}: {
  examples: ExampleRow[];
  jobGroup: string;
  title?: string;
}) {
  const [open, setOpen] = useState(
    () => globalThis.localStorage?.getItem(EXAMPLES_COLLAPSED_KEY) !== "1",
  );
  const columns = useMemo(() => pickExamples(examples, jobGroup), [examples, jobGroup]);
  if (columns.length === 0) return null;

  const toggle = (next: boolean) => {
    setOpen(next);
    globalThis.localStorage?.setItem(EXAMPLES_COLLAPSED_KEY, next ? "0" : "1");
  };

  return (
    <Collapsible open={open} onOpenChange={toggle} className="rounded-xl border bg-card shadow-sm">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span className="text-sm font-semibold">{title}</span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("grid gap-4 border-t p-4", columns.length > 1 && "sm:grid-cols-2")}>
          {columns.map((col) => (
            <div key={col.heading} className="space-y-2">
              <p className="text-xs font-semibold text-primary">{col.heading}</p>
              {col.rows.map((row) => (
                <ExampleBody key={`${row.field}-${row.good_example}`} row={row} />
              ))}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 「이렇게 작성하세요」 접이식 안내. 작성 순서 + 평가 항목 정의를 한곳에 모은다. */
export function HowToBox({
  steps,
  sections,
}: {
  steps: string[];
  sections: { title: string; rows: [string, string][] }[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border bg-primary-soft/20 shadow-sm"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span className="text-sm font-semibold">이렇게 작성하세요</span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 border-t p-4">
          <ol className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={s} className="flex gap-2 text-sm">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{s}</span>
              </li>
            ))}
          </ol>
          {sections.map((sec) => (
            <div key={sec.title} className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground">{sec.title}</p>
              <dl className="divide-y rounded-lg border bg-background text-xs">
                {sec.rows.map(([term, desc]) => (
                  <div key={term} className="grid gap-1 p-2 sm:grid-cols-[120px_minmax(0,1fr)]">
                    <dt className="font-semibold">{term}</dt>
                    <dd className="leading-relaxed text-muted-foreground">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** ④단계 안내 — 작성 순서 + 중요도·책임수준·이관가능·개선유형 정의 전체. */
export function TaskHowTo() {
  return (
    <HowToBox
      steps={[
        "담당 과업을 5~10개로 나누어 「행위 + 목적」 한 문장으로 적습니다.",
        "과업마다 실제 수행 단계인 세부 활동을 2~8개 적습니다.",
        `중요도·책임수준·이관 가능을 고르고, 직무를 대표하는 과업 최대 ${MAX_KEY_TASKS}개에 ★를 답니다.`,
      ]}
      sections={[
        {
          title: "중요도 (1~5)",
          rows: [1, 2, 3, 4, 5].map(
            (n) => [`${n}점`, IMPORTANCE_HINTS[n] ?? ""] as [string, string],
          ),
        },
        {
          title: "책임수준 (복수 해당 시 최상위 하나만)",
          rows: AUTHORITY_OPTIONS.map((o) => [o.label, o.hint] as [string, string]),
        },
        {
          title: "이관 가능",
          rows: [
            ["예", "다른 사람이 맡아도 이 직무가 그대로 성립하는 과업"],
            ["아니오", "이 직무에서 떼어내면 직무 자체가 성립하지 않는 과업"],
            ["주요 과업 ★", KEY_TASK_HINT],
          ],
        },
        {
          title: "개선 유형 (선택)",
          rows: IMPROVE_TYPES.map((t) => [t.value, t.desc] as [string, string]),
        },
      ]}
    />
  );
}

export function TaskGrid({ value, onChange, disabled = false, confirmRemove }: TaskGridProps) {
  const dupIds = useMemo(() => duplicateTaskIds(value), [value]);
  const keyCount = value.filter((t) => t.isKey).length;

  const patch = (id: string, part: Partial<TaskItem>) => {
    onChange(value.map((t) => (t.id === id ? { ...t, ...part } : t)));
  };

  const addTask = () => {
    onChange([
      ...value,
      {
        id: uid(),
        name: "",
        importance: null,
        authority: null,
        transferable: null,
        isKey: false,
        improveType: null,
        improveNote: "",
        activities: [],
      },
    ]);
  };

  const removeTask = (task: TaskItem) => {
    if (confirmRemove && !confirmRemove(task)) return;
    onChange(value.filter((t) => t.id !== task.id));
  };

  const moveTask = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(next);
  };

  const toggleKey = (task: TaskItem) => {
    if (!task.isKey && keyCount >= MAX_KEY_TASKS) {
      toast.error(`주요 과업은 최대 ${MAX_KEY_TASKS}개까지 선택할 수 있습니다.`);
      return;
    }
    patch(task.id, { isKey: !task.isKey });
  };

  const setActivities = (task: TaskItem, activities: ActivityItem[]) =>
    patch(task.id, { activities });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        담당하는 과업을 5~10개로 나누어 적어 주세요. 각 과업은 &lsquo;무엇을 해서 무엇을
        만든다&rsquo; 형태의 한 문장으로 씁니다.
      </p>

      <ul className="space-y-4">
        {value.map((task, index) => (
          <li key={task.id} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <div className="flex items-start gap-2">
              <span className="mt-2 text-sm font-semibold text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1 space-y-2">
                <AutoTextarea
                  value={task.name}
                  disabled={disabled}
                  onChange={(e) => patch(task.id, { name: e.target.value })}
                  placeholder="예: 월간 생산실적을 집계하여 경영회의 보고자료를 작성한다"
                  aria-label={`${index + 1}번째 과업명`}
                />
                {dupIds.has(task.id) ? (
                  <Badge variant="outline" className="gap-1 border-amber-400 text-amber-700">
                    <TriangleAlert className="size-3" />
                    비슷한 과업이 있습니다 — 묶어보세요
                  </Badge>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Hint text={KEY_TASK_HINT} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => toggleKey(task)}
                  title={KEY_TASK_HINT}
                  aria-label="주요 과업 표시"
                  aria-pressed={task.isKey}
                >
                  <Star className={cn("size-4", task.isKey && "fill-amber-400 text-amber-500")} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled || index === 0}
                  onClick={() => moveTask(index, -1)}
                  title="위로 이동"
                  aria-label="위로 이동"
                >
                  <ChevronUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled || index === value.length - 1}
                  onClick={() => moveTask(index, 1)}
                  title="아래로 이동"
                  aria-label="아래로 이동"
                >
                  <ChevronDown className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => removeTask(task)}
                  title="과업 삭제"
                  aria-label="과업 삭제"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  중요도
                  <Hint
                    text={[1, 2, 3, 4, 5].map((n) => `${n} = ${IMPORTANCE_HINTS[n]}`).join(" / ")}
                  />
                </Label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Button
                      key={n}
                      type="button"
                      variant={task.importance === n ? "default" : "outline"}
                      size="icon"
                      disabled={disabled}
                      title={IMPORTANCE_HINTS[n]}
                      aria-label={`중요도 ${n} — ${IMPORTANCE_HINTS[n]}`}
                      aria-pressed={task.importance === n}
                      onClick={() => patch(task.id, { importance: n })}
                    >
                      {n}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  책임수준
                  <Hint text={AUTHORITY_OPTIONS.map((o) => `${o.label} = ${o.hint}`).join(" / ")} />
                </Label>
                <div className="inline-flex flex-wrap rounded-md border p-0.5">
                  {AUTHORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={disabled}
                      title={opt.hint}
                      aria-label={opt.hint}
                      aria-pressed={task.authority === opt.value}
                      onClick={() => patch(task.id, { authority: opt.value })}
                      className={cn(
                        "rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                        task.authority === opt.value
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">복수 해당 시 최상위</p>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  이관 가능
                  <Hint text="예 = 다른 사람이 맡아도 이 직무가 그대로 성립하는 과업 / 아니오 = 이 직무에서 떼어내면 직무 자체가 성립하지 않는 과업" />
                </Label>
                <div className="inline-flex rounded-md border p-0.5">
                  {[
                    { v: true, l: "예" },
                    { v: false, l: "아니오" },
                  ].map((opt) => (
                    <button
                      key={opt.l}
                      type="button"
                      disabled={disabled}
                      aria-pressed={task.transferable === opt.v}
                      onClick={() => patch(task.id, { transferable: opt.v })}
                      className={cn(
                        "rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                        task.transferable === opt.v
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted",
                      )}
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <ActivityList
              task={task}
              disabled={disabled}
              onChange={(next) => setActivities(task, next)}
            />

            <ImproveSection task={task} disabled={disabled} onPatch={patch} />
          </li>
        ))}
      </ul>

      <Button type="button" variant="outline" disabled={disabled} onClick={addTask}>
        <Plus className="mr-1 size-4" />
        과업 추가
      </Button>
    </div>
  );
}

function ActivityList({
  task,
  disabled,
  onChange,
}: {
  task: TaskItem;
  disabled: boolean;
  onChange: (next: ActivityItem[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= task.activities.length) return;
    const next = [...task.activities];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(next);
  };

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <Label className="flex items-center gap-1 text-xs">
        세부 활동(Activity)
        <Hint text="이 과업을 실제로 수행하는 단계를 2~8개로 적습니다. 과업보다 짧은 주기로 반복되는 실행 단위입니다." />
      </Label>
      <ul className="space-y-2">
        {task.activities.map((act, i) => (
          <li key={act.id} className="flex items-center gap-1">
            <Input
              value={act.name}
              disabled={disabled}
              placeholder="예: 라인별 생산량·불량률 데이터 추출"
              aria-label={`세부 활동 ${i + 1}`}
              onChange={(e) =>
                onChange(
                  task.activities.map((a) =>
                    a.id === act.id ? { ...a, name: e.target.value } : a,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || i === 0}
              onClick={() => move(i, -1)}
              title="위로 이동"
              aria-label="활동 위로 이동"
            >
              <ChevronUp className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || i === task.activities.length - 1}
              onClick={() => move(i, 1)}
              title="아래로 이동"
              aria-label="활동 아래로 이동"
            >
              <ChevronDown className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => onChange(task.activities.filter((a) => a.id !== act.id))}
              title="활동 삭제"
              aria-label="활동 삭제"
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...task.activities, { id: uid(), name: "" }])}
      >
        <Plus className="mr-1 size-4" />
        활동 추가
      </Button>
    </div>
  );
}

function ImproveSection({
  task,
  disabled,
  onPatch,
}: {
  task: TaskItem;
  disabled: boolean;
  onPatch: (id: string, part: Partial<TaskItem>) => void;
}) {
  const [open, setOpen] = useState(task.improveType !== null || task.improveNote !== "");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
          <ChevronDown className={cn("mr-1 size-4 transition-transform", open && "rotate-180")} />
          개선 의견 (선택)
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        <Label className="flex items-center gap-1 text-xs">
          개선 유형
          <Hint text={IMPROVE_TYPES.map((t) => `${t.value} = ${t.desc}`).join(" / ")} />
        </Label>
        <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
          <Select
            disabled={disabled}
            value={task.improveType ?? ""}
            onValueChange={(v) => onPatch(task.id, { improveType: v as ImproveType })}
          >
            <SelectTrigger aria-label="개선 유형">
              <SelectValue placeholder="개선 유형 선택" />
            </SelectTrigger>
            <SelectContent>
              {IMPROVE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <span className="font-medium">{t.value}</span>
                  <span className="block text-xs text-muted-foreground">{t.desc}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={task.improveNote}
            disabled={disabled}
            rows={2}
            aria-label="개선 의견 내용"
            placeholder="예: 월말 집계를 시스템 자동 추출로 바꾸면 이틀을 줄일 수 있습니다."
            onChange={(e) => onPatch(task.id, { improveNote: e.target.value })}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default TaskGrid;
