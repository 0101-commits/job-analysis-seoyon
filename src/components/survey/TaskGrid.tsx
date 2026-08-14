// ④단계 Task·Activity 작성 그리드. 순수 컴포넌트 — 저장/이동은 코어(위저드)가 담당한다.
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Info,
  Plus,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
  { value: "D", label: "D 결정", hint: "의사결정을 내림" },
  { value: "R", label: "R 검토", hint: "결정 전 중간 검토" },
  { value: "O", label: "O 실행", hint: "실제 실행" },
  { value: "S", label: "S 지원", hint: "단순 지원" },
];

const IMPROVE_TYPES: ImproveType[] = [
  "삭제",
  "통폐합",
  "빈도감소",
  "하위자위양",
  "타부서이관",
  "강화",
];

/** ⓘ 아이콘 + 툴팁. SkillGrid/RequirementsForm 도 재사용한다. */
export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          title={text}
          aria-label={text}
          className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-pretty">{text}</TooltipContent>
    </Tooltip>
  );
}

/** 직군 카테고리별 좋은 예 / 아쉬운 예 카드. */
export function ExamplesPanel({
  examples,
  title = "작성 예시",
}: {
  examples: ExampleRow[];
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  if (examples.length === 0) return null;

  const body = (
    <div className="space-y-3">
      {examples.map((ex, i) => (
        <div key={`${ex.category}-${i}`} className="rounded-lg border bg-card p-3 shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground">{ex.category}</p>
          <div className="mt-2 space-y-2">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 dark:border-emerald-900 dark:bg-emerald-950/40">
              <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                좋은 예
              </p>
              <p className="mt-1 text-xs leading-relaxed">{ex.good_example}</p>
            </div>
            {ex.bad_example ? (
              <div className="rounded-md border border-orange-200 bg-orange-50 p-2 dark:border-orange-900 dark:bg-orange-950/40">
                <p className="text-[11px] font-semibold text-orange-700 dark:text-orange-400">
                  아쉬운 예
                </p>
                <p className="mt-1 text-xs leading-relaxed">{ex.bad_example}</p>
              </div>
            ) : null}
            {ex.note ? <p className="text-[11px] text-muted-foreground">{ex.note}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {/* 모바일: 접이식 */}
      <div className="lg:hidden">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full justify-between">
              {title} 보기
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">{body}</CollapsibleContent>
        </Collapsible>
      </div>
      {/* 데스크톱: 우측 고정 */}
      <aside className="hidden lg:block">
        <div className="sticky top-4">
          <p className="mb-2 text-sm font-semibold">{title}</p>
          {body}
        </div>
      </aside>
    </>
  );
}

export function TaskGrid({ value, onChange, examples, disabled = false }: TaskGridProps) {
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

  const removeTask = (id: string) => onChange(value.filter((t) => t.id !== id));

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
    <TooltipProvider delayDuration={200}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            담당하는 과업을 5~10개로 나누어 적어 주세요. 각 과업은 &lsquo;무엇을 해서 무엇을
            만든다&rsquo; 형태의 한 문장으로 씁니다.
          </p>

          <ul className="space-y-4">
            {value.map((task, index) => (
              <li
                key={task.id}
                className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-2 text-sm font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      onClick={() => toggleKey(task)}
                      title={`주요 과업으로 표시 (최대 ${MAX_KEY_TASKS}개)`}
                      aria-label="주요 과업 표시"
                      aria-pressed={task.isKey}
                    >
                      <Star
                        className={cn(
                          "size-4",
                          task.isKey && "fill-amber-400 text-amber-500",
                        )}
                      />
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
                      onClick={() => removeTask(task.id)}
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
                      <Hint text="1=보조적 … 5=직무 성과를 좌우" />
                    </Label>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Tooltip key={n}>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant={task.importance === n ? "default" : "outline"}
                              size="icon"
                              disabled={disabled}
                              title={IMPORTANCE_HINTS[n]}
                              aria-label={`중요도 ${n}`}
                              aria-pressed={task.importance === n}
                              onClick={() => patch(task.id, { importance: n })}
                            >
                              {n}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-56">
                            {IMPORTANCE_HINTS[n]}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-1">
                      책임수준
                      <Hint text="D=의사결정을 내림 / R=결정 전 중간 검토 / O=실제 실행 / S=단순 지원. 복수 해당 시 최상위를 고르세요." />
                    </Label>
                    <div className="inline-flex flex-wrap rounded-md border p-0.5">
                      {AUTHORITY_OPTIONS.map((opt) => (
                        <Tooltip key={opt.value}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={disabled}
                              title={opt.hint}
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
                          </TooltipTrigger>
                          <TooltipContent>{opt.hint}</TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">복수 해당 시 최상위</p>
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-1">
                      이관 가능
                      <Hint text="이 과업을 다른 사람에게 넘겨도 직무가 성립하면 예" />
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

        <ExamplesPanel examples={examples} title="과업 작성 예시" />
      </div>
    </TooltipProvider>
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
        <Hint text="이 과업을 실제로 수행하는 단계를 2~8개로 적습니다." />
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
      <CollapsibleContent className="mt-2 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
        <Select
          disabled={disabled}
          value={task.improveType ?? ""}
          onValueChange={(v) => onPatch(task.id, { improveType: v as ImproveType })}
        >
          <SelectTrigger aria-label="개선 유형">
            <SelectValue placeholder="개선 유형" />
          </SelectTrigger>
          <SelectContent>
            {IMPROVE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
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
      </CollapsibleContent>
    </Collapsible>
  );
}

export default TaskGrid;
