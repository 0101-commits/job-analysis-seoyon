import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  HelpCircle,
  Loader2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TaskGrid } from "@/components/survey/TaskGrid";
import { SkillGrid } from "@/components/survey/SkillGrid";
import { RequirementsForm } from "@/components/survey/RequirementsForm";
import { validateSkills, validateTasks } from "@/components/survey/validation";
import type { RequirementsValue, SkillItem, TaskItem } from "@/components/survey/types";
import {
  COVERAGE_OPTIONS,
  EMPTY_REQUIREMENTS,
  getExamples,
  getJobSuggestions,
  getLatestReject,
  getMyParticipant,
  getOrCreateResponse,
  loadFull,
  saveRequirements,
  saveResponseFields,
  saveSkills,
  saveTasks,
  submit,
} from "@/lib/survey.data";

export const Route = createFileRoute("/_authenticated/survey")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "업무조사 작성 | 서연 그룹 업무조사" },
      { name: "description", content: "담당 직무의 과업과 필요 역량을 단계별로 작성합니다." },
      { property: "og:title", content: "업무조사 작성 | 서연 그룹 업무조사" },
      { property: "og:description", content: "담당 직무의 과업과 필요 역량을 단계별로 작성합니다." },
    ],
  }),
  component: SurveyPage,
});

const STEPS = [
  {
    label: "기본정보",
    intro: "관리자가 등록한 귀하의 인사정보를 확인합니다. 잘못된 내용이 있으면 알려 주세요.",
  },
  {
    label: "직무 확인",
    intro: "귀하가 맡고 있는 직무의 이름을 확인합니다. 이후 모든 답변의 기준이 됩니다.",
  },
  {
    label: "정의·목적",
    intro: "이 직무가 무엇을 하는 자리이고, 회사에 무엇으로 기여하는지를 한두 문장으로 적습니다.",
  },
  {
    label: "과업 작성",
    intro: "직무를 이루는 과업과 세부 활동을 적습니다. 조사에서 가장 중요한 단계입니다.",
  },
  {
    label: "스킬·요건",
    intro: "이 직무를 제대로 하려면 무엇을 알고 할 수 있어야 하는지를 적습니다.",
  },
  {
    label: "마무리",
    intro: "작성 내용을 되돌아보고 제출합니다. 제출 전 마지막 단계입니다.",
  },
];

function StepBar({ step, onSelect }: { step: number; onSelect: (n: number) => void }) {
  return (
    <ol className="flex items-center gap-1 sm:gap-2">
      {STEPS.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={s.label} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <button
              type="button"
              onClick={() => onSelect(n)}
              aria-label={`${n}단계 ${s.label}`}
              aria-current={current}
              className={`h-1.5 w-full rounded-full transition-colors ${
                current ? "bg-primary" : done ? "bg-primary/40" : "bg-border"
              }`}
            />
            <span
              className={`truncate text-[11px] ${
                current ? "font-semibold text-primary" : "text-muted-foreground"
              }`}
            >
              <span className="hidden sm:inline">{n}. </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function HelpPanel({
  step,
  tasks,
  skills,
}: {
  step: number;
  tasks: TaskItem[];
  skills: SkillItem[];
}) {
  const items: string[] = (() => {
    switch (step) {
      case 1:
        return ["성명·사번·소속·직급이 맞는지 확인", "다르면 인사담당자에게 정정 요청"];
      case 2:
        return [
          "직군 = 가장 큰 분류 (예: 사무관리)",
          "직렬 = 중간 분류 (예: 인사)",
          "직무 = 실제 담당 업무 단위 (예: 인사기획)",
        ];
      case 3:
        return [
          "정의는 「무엇을 대상으로 → 어떤 활동을 하여 → 어떤 상태를 만드는가」",
          "목적(미션)은 회사에 남기는 최종 성과로",
          "본인 이야기가 아니라 직무 이야기로",
        ];
      case 4:
        return [
          `과업 5~10개 권장 — 현재 ${tasks.length}개`,
          `주요 과업 최대 5개 — 현재 ${tasks.filter((t) => t.isKey).length}개`,
          "과업마다 세부 활동 2~8개",
          "과업은 「행위 + 목적」 한 문장",
          "일시적 프로젝트·TF 업무는 제외",
        ];
      case 5:
        return [
          `스킬 5개 이상 권장 — 현재 ${skills.length}개`,
          "스킬마다 어떤 과업에 쓰이는지 연결",
          "명칭만 쓰지 말고 설명 한 줄 추가",
          "학력·자격은 '내 스펙'이 아니라 '직무 요건'",
        ];
      default:
        return [
          "커버리지 자기평가 선택",
          "빠진 업무가 있다면 마지막에 보완",
          "제출 후에는 검토 전까지 수정 불가",
        ];
    }
  })();

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-muted-foreground">이 단계 체크리스트</p>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-muted-foreground">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SurveyPage() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["survey-bootstrap"],
    queryFn: async () => {
      const participant = await getMyParticipant();
      if (!participant) return null;
      const response = await getOrCreateResponse(participant);
      const [full, examples, reject, suggestions] = await Promise.all([
        loadFull(response.id),
        getExamples(),
        getLatestReject(response.id),
        getJobSuggestions(participant.company_id),
      ]);
      return { participant, response, full, examples, reject, suggestions };
    },
  });

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    jobGroup: "",
    jobSeries: "",
    jobName: "",
    definition: "",
    mission: "",
    coverage: null as string | null,
    missedNote: "",
    painNote: "",
  });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [req, setReq] = useState<RequirementsValue>(EMPTY_REQUIREMENTS);
  const [saveState, setSaveState] = useState<"unsaved" | "saving" | "saved">("saved");
  const [gateTried, setGateTried] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const hydratedRef = useRef(false);
  const stepRef = useRef(1);

  const responseId = data?.response.id ?? null;
  const status = data?.response.status ?? "draft";
  const readOnly = status === "submitted" || status === "approved";

  // 온보딩 미완료 → 튜토리얼로
  useEffect(() => {
    if (data && !data.response.onboarding_done) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [data, navigate]);

  // 서버 값 → 로컬 상태 1회 주입
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    const r = data.response;
    setForm({
      jobGroup: r.job_group ?? "",
      jobSeries: r.job_series ?? "",
      jobName: r.job_name ?? "",
      definition: r.definition ?? "",
      mission: r.mission ?? "",
      coverage: r.coverage_pct,
      missedNote: r.missed_note ?? "",
      painNote: r.pain_note ?? "",
    });
    setTasks(data.full.tasks);
    setSkills(data.full.skills);
    setReq(data.full.requirements);
    const resume = Math.min(Math.max(r.current_step, 1), STEPS.length);
    setStep(resume);
    stepRef.current = resume;
  }, [data]);

  async function persist(target: number) {
    if (!responseId) return;
    if (target === 2) {
      await saveResponseFields(responseId, {
        job_group: form.jobGroup || null,
        job_series: form.jobSeries || null,
        job_name: form.jobName || null,
      });
    } else if (target === 3) {
      await saveResponseFields(responseId, {
        definition: form.definition || null,
        mission: form.mission || null,
      });
    } else if (target === 4) {
      await saveTasks(responseId, tasks);
    } else if (target === 5) {
      await saveSkills(responseId, skills);
      await saveRequirements(responseId, req);
    } else if (target === 6) {
      await saveResponseFields(responseId, {
        coverage_pct: form.coverage,
        missed_note: form.missedNote || null,
        pain_note: form.painNote || null,
      });
    }
  }

  async function flush(target: number) {
    if (!responseId || readOnly) return;
    setSaveState("saving");
    try {
      await persist(target);
      setSaveState("saved");
    } catch (err) {
      setSaveState("unsaved");
      toast.error(err instanceof Error ? err.message : "임시저장에 실패했습니다.");
    }
  }

  // 입력 2초 유휴 시 자동 임시저장
  useEffect(() => {
    if (!hydratedRef.current || readOnly) return;
    setSaveState("unsaved");
    const timer = setTimeout(() => {
      void flush(stepRef.current);
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, tasks, skills, req, readOnly]);

  const taskCheck = useMemo(() => validateTasks(tasks), [tasks]);
  const skillCheck = useMemo(() => validateSkills(skills), [skills]);
  const activeCheck = step === 4 ? taskCheck : step === 5 ? skillCheck : null;

  async function goTo(next: number) {
    if (next < 1 || next > STEPS.length) return;
    if (next > step && !readOnly && activeCheck && !activeCheck.ok) {
      setGateTried(true);
      toast.error("작성이 완료되지 않은 항목이 있습니다.");
      return;
    }
    setGateTried(false);
    await flush(step);
    if (responseId && !readOnly) {
      await saveResponseFields(responseId, { current_step: next }).catch(() => undefined);
    }
    setStep(next);
    stepRef.current = next;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSubmit() {
    if (!responseId) return;
    setSending(true);
    try {
      await persist(4);
      await persist(5);
      await submit(responseId, {
        coverage: form.coverage,
        missedNote: form.missedNote,
        painNote: form.painNote,
      });
      setConfirmOpen(false);
      setJustSubmitted(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "제출에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-secondary">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          조사 내용을 불러오는 중입니다...
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-secondary px-4">
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            조사 대상자 정보를 찾을 수 없습니다. 관리자에게 문의해 주세요.
          </p>
          <Button className="mt-5" onClick={() => navigate({ to: "/home" })}>
            홈으로
          </Button>
        </div>
      </main>
    );
  }

  if (justSubmitted) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-secondary px-4 py-10">
        <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto size-12 text-success" />
          <h1 className="mt-4 text-xl font-bold">제출 완료</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            업무조사가 제출되었습니다. 검토 결과는 이메일과 홈 화면으로 안내드립니다.
            <br />
            소중한 시간을 내어 작성해 주셔서 감사합니다.
          </p>
          <Button className="mt-6 h-11 w-full" onClick={() => navigate({ to: "/home" })}>
            홈으로
          </Button>
        </div>
      </main>
    );
  }

  const { participant, examples, reject, suggestions } = data;
  const stepMeta = STEPS[step - 1] as (typeof STEPS)[number];
  const help = <HelpPanel step={step} tasks={tasks} skills={skills} />;
  const improveNotes = tasks.filter((t) => t.improveType || t.improveNote.trim());

  return (
    <div className="min-h-screen bg-secondary">
      <header className="sticky top-0 z-20 border-b bg-card">
        <div className="mx-auto max-w-5xl space-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-sm font-bold sm:text-base">업무조사 작성</h1>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {readOnly
                  ? "제출 완료 (읽기 전용)"
                  : saveState === "saving"
                    ? "저장 중…"
                    : saveState === "saved"
                      ? "저장됨 ✓"
                      : "저장 대기"}
              </span>
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="lg:hidden">
                    <HelpCircle className="size-4" />
                    도움말
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="max-h-[70vh] overflow-y-auto">
                  <SheetHeader>
                    <SheetTitle>{stepMeta.label} 도움말</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4">{help}</div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
          <StepBar step={step} onSelect={(n) => void goTo(n)} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[1fr_260px]">
        <div className="space-y-5">
          {status === "rejected" && reject ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <AlertTriangle className="size-4" />
                반려된 응답입니다. 아래 의견을 반영해 수정 후 다시 제출해 주세요.
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{reject.body}</p>
            </div>
          ) : null}

          <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
            <p className="text-xs font-semibold text-primary">
              {step}단계 · {stepMeta.label}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{stepMeta.intro}</p>

            <div className="mt-6">
              {step === 1 ? (
                <div className="space-y-4">
                  <dl className="grid gap-3 sm:grid-cols-2">
                    {[
                      ["성명", participant.name],
                      ["사번", participant.emp_no],
                      ["이메일", participant.email],
                      ["회사", participant.company_name],
                      ["소속", participant.org_text],
                      ["직급", participant.grade],
                      ["역할단계", participant.role_level],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border bg-background p-3">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-1 text-sm font-medium">{value || "미등록"}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                    정보가 다르면 관리자에게 문의해 주세요. 이 화면에서는 수정할 수 없습니다.
                  </p>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-background p-3">
                    <p className="text-xs text-muted-foreground">회사</p>
                    <p className="mt-1 text-sm font-medium">
                      {participant.company_name ?? "미지정"}
                    </p>
                  </div>
                  <datalist id="job-group-options">
                    {suggestions.groups.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  <datalist id="job-series-options">
                    {suggestions.series.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  <datalist id="job-name-options">
                    {suggestions.names.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  {(
                    [
                      ["jobGroup", "직군", "예: 사무관리", "job-group-options"],
                      ["jobSeries", "직렬", "예: 인사", "job-series-options"],
                      ["jobName", "직무", "예: 인사기획", "job-name-options"],
                    ] as const
                  ).map(([key, label, placeholder, listId]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={key}>{label}</Label>
                      <Input
                        id={key}
                        list={listId}
                        value={form[key]}
                        disabled={readOnly}
                        placeholder={placeholder}
                        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      />
                    </div>
                  ))}
                  <p className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                    아직 표준 분류가 없다면 평소 쓰는 이름으로 적어 주세요. 나중에 표준 분류와
                    연결됩니다.
                  </p>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="definition">직무 정의</Label>
                    <p className="text-xs text-muted-foreground">
                      「무엇을 대상으로 → 어떤 활동을 하여 → 어떤 상태를 만드는가」가 드러나도록 2~3줄로
                      적어 주세요.
                    </p>
                    <Textarea
                      id="definition"
                      rows={4}
                      disabled={readOnly}
                      value={form.definition}
                      onChange={(e) => setForm({ ...form, definition: e.target.value })}
                      placeholder="예: 회사의 인적자원을 확보·육성·평가·보상하는 제도를 설계하고 운영하여 조직의 인력 경쟁력을 유지하는 직무"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mission">직무 목적 (미션)</Label>
                    <p className="text-xs text-muted-foreground">
                      이 직무가 회사에 남기는 최종 성과를 1~2줄로 적어 주세요.
                    </p>
                    <Textarea
                      id="mission"
                      rows={3}
                      disabled={readOnly}
                      value={form.mission}
                      onChange={(e) => setForm({ ...form, mission: e.target.value })}
                      placeholder="예: 적기·적소에 필요한 인력을 배치하고 공정한 평가·보상 체계를 운영하여 임직원의 몰입도와 조직 생산성을 높인다"
                    />
                  </div>

                  <div className="space-y-3">
                    <p className="text-sm font-semibold">직군별 작성 예시</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {examples
                        .filter((e) => e.field === "definition" || e.field === "mission")
                        .map((e) => (
                          <div
                            key={`${e.category}-${e.field}-${e.good_example}`}
                            className="rounded-lg border bg-background p-3 text-sm"
                          >
                            <p className="text-xs font-semibold text-primary">
                              {e.category} · {e.field === "definition" ? "정의" : "목적"}
                            </p>
                            <p className="mt-2 text-foreground">{e.good_example}</p>
                            {e.bad_example ? (
                              <p className="mt-2 text-xs text-destructive line-through">
                                {e.bad_example}
                              </p>
                            ) : null}
                            {e.note ? (
                              <p className="mt-2 text-xs text-muted-foreground">{e.note}</p>
                            ) : null}
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <TaskGrid
                  value={tasks}
                  onChange={setTasks}
                  examples={examples.filter((e) => e.field === "task" || e.field === "activity")}
                  disabled={readOnly}
                />
              ) : null}

              {step === 5 ? (
                <Tabs defaultValue="skills">
                  <TabsList className="w-full">
                    <TabsTrigger value="skills" className="flex-1">
                      스킬
                    </TabsTrigger>
                    <TabsTrigger value="requirements" className="flex-1">
                      자격요건
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="skills" className="mt-4">
                    <SkillGrid
                      value={skills}
                      onChange={setSkills}
                      tasks={tasks.map((t) => ({ id: t.id, name: t.name }))}
                      examples={examples.filter((e) => e.field === "skill")}
                      disabled={readOnly}
                    />
                  </TabsContent>
                  <TabsContent value="requirements" className="mt-4">
                    <RequirementsForm value={req} onChange={setReq} disabled={readOnly} />
                  </TabsContent>
                </Tabs>
              ) : null}

              {step === 6 ? (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <p className="text-sm font-semibold">작성하신 업무 개선의견</p>
                    {improveNotes.length ? (
                      <ul className="space-y-2">
                        {improveNotes.map((t) => (
                          <li key={t.id} className="rounded-lg border bg-background p-3 text-sm">
                            <p className="font-medium">{t.name || "(과업명 미입력)"}</p>
                            <p className="mt-1 text-muted-foreground">
                              {t.improveType ? `[${t.improveType}] ` : ""}
                              {t.improveNote || "의견 없음"}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                        4단계에서 작성한 개선의견이 없습니다. 필요하면 이전 단계로 돌아가 추가할 수
                        있습니다.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="pain">업무 수행 중 애로사항 (선택)</Label>
                    <p className="text-xs text-muted-foreground">
                      제도·시스템·협업 등 업무를 어렵게 만드는 요인이 있다면 자유롭게 적어 주세요.
                    </p>
                    <Textarea
                      id="pain"
                      rows={4}
                      disabled={readOnly}
                      value={form.painNote}
                      onChange={(e) => setForm({ ...form, painNote: e.target.value })}
                    />
                  </div>

                  <div className="space-y-3">
                    <Label>이 조사가 귀하의 실제 직무를 어느 정도 반영합니까?</Label>
                    <RadioGroup
                      value={form.coverage ?? ""}
                      disabled={readOnly}
                      onValueChange={(v) => setForm({ ...form, coverage: v })}
                      className="gap-2"
                    >
                      {COVERAGE_OPTIONS.map((o) => (
                        <label
                          key={o.value}
                          htmlFor={`cov-${o.value}`}
                          className="flex cursor-pointer items-center gap-3 rounded-lg border bg-background p-3 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/30"
                        >
                          <RadioGroupItem id={`cov-${o.value}`} value={o.value} />
                          {o.label}
                        </label>
                      ))}
                    </RadioGroup>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="missed">이 조사에서 담지 못한 직무의 측면이 있다면 (선택)</Label>
                    <Textarea
                      id="missed"
                      rows={3}
                      disabled={readOnly}
                      value={form.missedNote}
                      onChange={(e) => setForm({ ...form, missedNote: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {activeCheck && gateTried && activeCheck.errors.length ? (
              <div className="mt-5 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                <p className="text-sm font-semibold text-destructive">
                  다음 항목을 보완해야 다음 단계로 넘어갈 수 있습니다.
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-destructive">
                  {activeCheck.errors.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {activeCheck && activeCheck.warnings.length ? (
              <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
                <p className="text-sm font-semibold text-warning">확인해 보세요 (이동은 가능합니다)</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {activeCheck.warnings.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              className="h-11 flex-1"
              disabled={step === 1}
              onClick={() => void goTo(step - 1)}
            >
              <ArrowLeft className="size-4" />
              이전
            </Button>
            {step < STEPS.length ? (
              <Button className="h-11 flex-1" onClick={() => void goTo(step + 1)}>
                다음
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button
                className="h-11 flex-1"
                disabled={readOnly || !form.coverage}
                onClick={() => setConfirmOpen(true)}
              >
                <Send className="size-4" />
                제출하기
              </Button>
            )}
          </div>
          {step === STEPS.length && !readOnly && !form.coverage ? (
            <p className="text-center text-xs text-muted-foreground">
              커버리지 자기평가를 선택하면 제출할 수 있습니다.
            </p>
          ) : null}
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-28 rounded-xl border bg-card p-4 shadow-sm">{help}</div>
        </aside>
      </main>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>업무조사를 제출할까요?</DialogTitle>
            <DialogDescription>
              제출 후에는 관리자 검토 전까지 수정할 수 없습니다. 작성 내용을 다시 확인하셨다면 제출해
              주세요.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>
              더 검토할게요
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={sending}>
              {sending ? "제출 중..." : "제출하기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
