// ⑤단계 스킬 작성 그리드. 순수 컴포넌트 — 저장/이동은 코어(위저드)가 담당한다.
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { ExamplesPanel, Hint } from "./TaskGrid";
import type { HardSoft, Ksao, SkillGridProps, SkillItem } from "./types";

const KSAO_OPTIONS: { value: Ksao; label: string; hint: string }[] = [
  { value: "K", label: "K 지식", hint: "지식 — 이론·법규 등 아는 것" },
  { value: "S", label: "S 기술", hint: "기술 — 도구·방법을 다루는 것" },
  { value: "A", label: "A 능력", hint: "능력 — 자질·판단력" },
];

const HARD_SOFT: HardSoft[] = ["Hard", "Soft"];

export function SkillGrid({ value, onChange, tasks, examples, disabled = false }: SkillGridProps) {
  const patch = (id: string, part: Partial<SkillItem>) => {
    onChange(value.map((s) => (s.id === id ? { ...s, ...part } : s)));
  };

  const addSkill = () => {
    onChange([
      ...value,
      {
        id: crypto.randomUUID(),
        name: "",
        ksao: null,
        hardSoft: null,
        description: "",
        relatedTaskIds: [],
      },
    ]);
  };

  const toggleTask = (skill: SkillItem, taskId: string, checked: boolean) => {
    patch(skill.id, {
      relatedTaskIds: checked
        ? [...skill.relatedTaskIds, taskId]
        : skill.relatedTaskIds.filter((id) => id !== taskId),
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            이 직무를 제대로 수행하는 데 필요한 지식·기술·능력을 3개 이상 적어 주세요.
          </p>

          <ul className="space-y-4">
            {value.map((skill, index) => (
              <li
                key={skill.id}
                className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-2 text-sm font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                  <Input
                    value={skill.name}
                    disabled={disabled}
                    className="min-w-0 flex-1"
                    aria-label={`${index + 1}번째 스킬명`}
                    placeholder="예: 통계적 공정관리(SPC)"
                    onChange={(e) => patch(skill.id, { name: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={() => onChange(value.filter((s) => s.id !== skill.id))}
                    title="스킬 삭제"
                    aria-label="스킬 삭제"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1">
                      구분
                      <Hint text="지식=이론·법규 등 아는 것 / 기술=도구·방법을 다루는 것 / 능력=자질·판단력" />
                    </Label>
                    <div className="inline-flex flex-wrap rounded-md border p-0.5">
                      {KSAO_OPTIONS.map((opt) => (
                        <Tooltip key={opt.value}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={disabled}
                              title={opt.hint}
                              aria-pressed={skill.ksao === opt.value}
                              onClick={() => patch(skill.id, { ksao: opt.value })}
                              className={cn(
                                "rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                                skill.ksao === opt.value
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
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-1">
                      Hard / Soft
                      <Hint text="Hard=직무 전문성·기술 역량 / Soft=협업·소통 등 공통 역량" />
                    </Label>
                    <div className="inline-flex rounded-md border p-0.5">
                      {HARD_SOFT.map((hs) => (
                        <button
                          key={hs}
                          type="button"
                          disabled={disabled}
                          aria-pressed={skill.hardSoft === hs}
                          onClick={() => patch(skill.id, { hardSoft: hs })}
                          className={cn(
                            "rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                            skill.hardSoft === hs
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-muted",
                          )}
                        >
                          {hs}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`skill-desc-${skill.id}`}>한 줄 설명</Label>
                  <Input
                    id={`skill-desc-${skill.id}`}
                    value={skill.description}
                    disabled={disabled}
                    placeholder="예: 관리도와 Cp/Cpk 지표를 해석하여 공정 이상을 판정"
                    onChange={(e) => patch(skill.id, { description: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    관련 과업
                    <Hint text="이 스킬이 필요한 과업을 모두 고르세요." />
                  </Label>
                  {tasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      이전 단계에서 과업을 먼저 작성해 주세요.
                    </p>
                  ) : (
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {tasks.map((task) => {
                        const id = `skill-${skill.id}-task-${task.id}`;
                        return (
                          <li key={task.id} className="flex items-start gap-2">
                            <Checkbox
                              id={id}
                              disabled={disabled}
                              checked={skill.relatedTaskIds.includes(task.id)}
                              onCheckedChange={(c) => toggleTask(skill, task.id, c === true)}
                            />
                            <Label htmlFor={id} className="text-xs font-normal leading-snug">
                              {task.name.trim() === "" ? "(이름 없는 과업)" : task.name}
                            </Label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <Button type="button" variant="outline" disabled={disabled} onClick={addSkill}>
            <Plus className="mr-1 size-4" />
            스킬 추가
          </Button>
        </div>

        <ExamplesPanel examples={examples} title="스킬 작성 예시" />
      </div>
    </TooltipProvider>
  );
}

export default SkillGrid;
