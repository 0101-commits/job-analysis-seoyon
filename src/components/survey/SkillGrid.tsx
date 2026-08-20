// ⑤단계 스킬 작성 그리드. 순수 컴포넌트 — 저장/이동은 코어(위저드)가 담당한다.
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { LabelWithHint } from "@/components/FieldHint";

import { ExamplePopover } from "./ExamplePopover";
import { AutoTextarea, Hint, HowToBox, uid } from "./TaskGrid";
import type { HardSoft, Ksao, SkillGridProps, SkillItem } from "./types";

const KSAO_OPTIONS: { value: Ksao; label: string; hint: string }[] = [
  { value: "K", label: "K 지식", hint: "지식 — 이론·법규·제도처럼 알고 있어야 하는 것" },
  { value: "S", label: "S 기술", hint: "기술 — 도구·기법을 실제로 다룰 수 있는 것" },
  { value: "A", label: "A 태도·능력", hint: "태도·능력 — 판단력·책임감처럼 몸에 익은 자질" },
];

const HARD_SOFT: { value: HardSoft; hint: string }[] = [
  { value: "Hard", hint: "Hard — 이 직무여서 필요한 전문 지식·기술" },
  { value: "Soft", hint: "Soft — 어느 직무에서나 통하는 협업·소통 등 공통 역량" },
];

/** ⑤단계 안내 — 작성 순서 + 지식·기술·태도, Hard/Soft 정의 전체. */
export function SkillHowTo({ skillCount }: { skillCount?: number | undefined }) {
  return (
    <HowToBox
      sectionId="step5"
      note={
        skillCount === undefined
          ? undefined
          : `필요 역량 3개 이상 필수, 5개 이상 권장 — 현재 ${skillCount}개`
      }
      steps={[
        "이 직무를 제대로 하려면 필요한 지식·기술·태도를 3개 이상 적습니다(5개 이상 권장).",
        "각 항목이 지식·기술·태도 중 무엇인지, Hard 인지 Soft 인지 고릅니다.",
        "그 역량이 쓰이는 과업을 연결합니다. 특정 과업과 무관하면 「직무 공통 역량」을 고릅니다.",
        "자격요건 탭의 학력·자격은 '내 스펙'이 아니라 '이 직무에 필요한 기준'으로 적습니다.",
      ]}
      sections={[
        {
          title: "구분 (지식·기술·태도)",
          rows: KSAO_OPTIONS.map((o) => [o.label, o.hint] as [string, string]),
        },
        {
          title: "Hard / Soft",
          rows: HARD_SOFT.map((o) => [o.value, o.hint] as [string, string]),
        },
      ]}
    />
  );
}

export function SkillGrid({
  value,
  onChange,
  tasks,
  examples,
  jobGroup = "",
  disabled = false,
}: SkillGridProps) {
  const patch = (id: string, part: Partial<SkillItem>) => {
    onChange(value.map((s) => (s.id === id ? { ...s, ...part } : s)));
  };

  const addSkill = () => {
    onChange([
      ...value,
      {
        id: uid(),
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

  // 연결도 안 했고 '무관'도 안 고른 스킬 — 이동은 막지 않고 한 줄로만 알린다.
  const unlinked = value.filter((s) => !s.isGeneral && s.relatedTaskIds.length === 0).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          이 직무를 제대로 수행하는 데 필요한 지식·기술·능력을 3개 이상 적어 주세요.
        </p>
        <LabelWithHint term="필요 역량">필요 역량이란</LabelWithHint>
        <ExamplePopover examples={examples} jobGroup={jobGroup} fields={["skill"]} />
      </div>
      {unlinked > 0 ? (
        <p className="rounded-lg bg-secondary p-3 text-xs text-muted-foreground">
          관련 과업을 아직 고르지 않은 항목이 {unlinked}개 있습니다. 특정 과업과 무관한 역량이라면
          「특정 과업과 무관 (직무 공통 역량)」을 골라 주세요.
        </p>
      ) : null}

      <ul id="field-skills" className="scroll-mt-28 space-y-4">
        {value.map((skill, index) => {
          const generalId = `skill-${skill.id}-general`;
          return (
            <li
              key={skill.id}
              id={`skill-${skill.id}`}
              className="space-y-4 rounded-xl border bg-card p-4 shadow-sm scroll-mt-28 sm:p-5"
            >
              <div className="flex items-start gap-2">
                <span className="mt-2 text-sm font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <Input
                  value={skill.name}
                  disabled={disabled}
                  className="min-w-0 flex-1"
                  aria-label={`${index + 1}번째 필요 역량 이름`}
                  placeholder="예: 통계적 공정관리(SPC)"
                  onChange={(e) => patch(skill.id, { name: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((s) => s.id !== skill.id))}
                  title="필요 역량 삭제"
                  aria-label="필요 역량 삭제"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    구분
                    <Hint text={KSAO_OPTIONS.map((o) => `${o.label} = ${o.hint}`).join(" / ")} />
                  </Label>
                  <div className="inline-flex flex-wrap rounded-md border p-0.5">
                    {KSAO_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={disabled}
                        title={opt.hint}
                        aria-label={opt.hint}
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
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    Hard / Soft
                    <Hint text={HARD_SOFT.map((o) => o.hint).join(" / ")} />
                  </Label>
                  <div className="inline-flex rounded-md border p-0.5">
                    {HARD_SOFT.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={disabled}
                        title={opt.hint}
                        aria-label={opt.hint}
                        aria-pressed={skill.hardSoft === opt.value}
                        onClick={() => patch(skill.id, { hardSoft: opt.value })}
                        className={cn(
                          "rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                          skill.hardSoft === opt.value
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted",
                        )}
                      >
                        {opt.value}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`skill-desc-${skill.id}`} className="flex items-center gap-1">
                  한 줄 설명
                  <Hint text="명칭만 쓰지 말고 「어떤 상황에서 무엇을 할 수 있는 능력인지」를 덧붙입니다." />
                </Label>
                <AutoTextarea
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
                  <Hint text="이 역량이 필요한 과업을 모두 고르세요. 특정 과업에 묶이지 않으면 「특정 과업과 무관」을 고릅니다." />
                </Label>
                <div className="flex items-start gap-2 rounded-lg border bg-background p-2">
                  <Checkbox
                    id={generalId}
                    disabled={disabled}
                    checked={skill.isGeneral === true}
                    onCheckedChange={(c) =>
                      patch(
                        skill.id,
                        c === true ? { isGeneral: true, relatedTaskIds: [] } : { isGeneral: false },
                      )
                    }
                  />
                  <Label htmlFor={generalId} className="text-xs font-normal leading-snug">
                    특정 과업과 무관 (직무 공통 역량)
                  </Label>
                </div>
                {tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    4단계에서 과업을 먼저 작성해 주세요.
                  </p>
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {tasks.map((task) => {
                      const id = `skill-${skill.id}-task-${task.id}`;
                      return (
                        <li key={task.id} className="flex items-start gap-2">
                          <Checkbox
                            id={id}
                            disabled={disabled || skill.isGeneral === true}
                            checked={skill.relatedTaskIds.includes(task.id)}
                            onCheckedChange={(c) => toggleTask(skill, task.id, c === true)}
                          />
                          <Label
                            htmlFor={id}
                            className={cn(
                              "text-xs font-normal leading-snug",
                              skill.isGeneral === true && "text-muted-foreground",
                            )}
                          >
                            {task.name.trim() === "" ? "(이름 없는 과업)" : task.name}
                          </Label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Button type="button" variant="outline" disabled={disabled} onClick={addSkill}>
        <Plus className="mr-1 size-4" />
        필요 역량 추가
      </Button>
    </div>
  );
}

export default SkillGrid;
