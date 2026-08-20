import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HowToBox, TaskGrid, TaskHowTo, uid } from "@/components/survey/TaskGrid";
import { selfCheckMyResponse, type SelfCheckFinding } from "@/lib/ai.functions";
import { NoticeStack } from "@/components/survey/NoticeStack";
import { InquiryComposer } from "@/components/survey/InquiryComposer";
import type { InquiryCategory } from "@/lib/inquiry.functions";
import { SkillGrid, SkillHowTo } from "@/components/survey/SkillGrid";
import { RequirementsForm } from "@/components/survey/RequirementsForm";
import { ExamplePopover } from "@/components/survey/ExamplePopover";
import { StepChecklist } from "@/components/survey/StepChecklist";
import { SubmissionSummary } from "@/components/survey/SubmissionSummary";
import { buildChecklist, validateSkills, validateTasks } from "@/components/survey/validation";
import type { RequirementsValue, SkillItem, TaskItem } from "@/components/survey/types";
import { FieldHint } from "@/components/FieldHint";
import { SaveStatusChip, type SaveState } from "@/components/SaveStatusChip";
import { SURVEY_STEP_LABELS, isFocusField } from "@/lib/survey.focus";
import {
  COVERAGE_OPTIONS,
  EMPTY_REQUIREMENTS,
  INFO_FIELDS,
  createInfoChangeRequest,
  getExamples,
  getJobSuggestions,
  getLatestReject,
  getMyDutyCandidates,
  getMyInfoRequests,
  getMyParticipant,
  getOrCreateResponse,
  getRejectHistory,
  infoFieldLabel,
  isConflict,
  loadFull,
  saveRequirements,
  saveResponseFields,
  saveSkills,
  saveTasks,
  submit,
  type DutyTaskCandidate,
  type InfoChangeField,
  type MyParticipant,
} from "@/lib/survey.data";

/** 단계 이름은 홈 화면과 공유한다(survey.focus.ts). 여기서는 한 줄 설명만 갖는다. */
const STEP_INTROS = [
  "관리자가 등록한 귀하의 인사정보를 확인합니다. 잘못된 내용이 있으면 알려 주세요.",
  "귀하가 맡고 있는 직무의 이름을 확인합니다. 이후 모든 답변의 기준이 됩니다.",
  "이 직무가 무엇을 하는 자리이고, 회사에 무엇으로 기여하는지를 한두 문장으로 적습니다.",
  "직무를 이루는 과업과 세부 활동을 적습니다. 조사에서 가장 중요한 단계입니다.",
  "이 직무를 제대로 하려면 무엇을 알고 할 수 있어야 하는지를 적습니다.",
  "작성 내용을 되돌아보고 제출합니다. 제출 전 마지막 단계입니다.",
];

const STEPS = SURVEY_STEP_LABELS.map((label, i) => ({ label, intro: STEP_INTROS[i] ?? "" }));

/**
 * 반려·정정 딥링크(`focus=`)가 가리키는 입력칸으로 데려간다 (기획 C8).
 * 진행 체크리스트의 「미완 항목 클릭」도 같은 길을 쓴다 — 한 곳에서만 관리한다.
 */
function focusAnchor(anchor: string) {
  if (!anchor) return;
  const el = document.getElementById(anchor);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // 어디로 왔는지 보이지 않으면 이동한 의미가 없다 — 잠깐 테두리를 준다.
  el.classList.add("ring-2", "ring-primary", "ring-offset-2", "rounded-lg");
  window.setTimeout(
    () => el.classList.remove("ring-2", "ring-primary", "ring-offset-2", "rounded-lg"),
    2400,
  );
}

/** 저장 실패 재시도 간격 — 3회 모두 실패하면 수동 [지금 저장] 버튼을 띄운다. */
const RETRY_DELAYS = [1000, 3000, 9000];

/** 현재 단계는 URL 이 원천 — 새로고침·뒤로가기가 단계 이동으로 동작한다. */
export const Route = createFileRoute("/_authenticated/survey")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { step?: number; focus?: string } => {
    const n = Number(search["step"]);
    const f = search["focus"];
    return {
      ...(Number.isInteger(n) && n >= 1 && n <= STEPS.length ? { step: n } : {}),
      ...(typeof f === "string" && isFocusField(f) ? { focus: f } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "업무조사 작성 | 서연 그룹 업무조사" },
      { name: "description", content: "담당 직무의 과업과 필요 역량을 단계별로 작성합니다." },
      { property: "og:title", content: "업무조사 작성 | 서연 그룹 업무조사" },
      {
        property: "og:description",
        content: "담당 직무의 과업과 필요 역량을 단계별로 작성합니다.",
      },
    ],
  }),
  component: SurveyPage,
});

/**
 * 진행 바 자체는 표시 전용(높이 6px 은 손가락으로 누르기엔 너무 얇다).
 * 클릭은 아래 번호·라벨 버튼이 받고, 완료한 단계(현재 이하)로만 이동할 수 있다.
 */
function StepBar({ step, onSelect }: { step: number; onSelect: (n: number) => void }) {
  return (
    <ol className="flex items-stretch gap-1 sm:gap-2">
      {STEPS.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={s.label} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              aria-hidden
              className={`h-1.5 w-full rounded-full transition-colors ${
                current ? "bg-primary" : done ? "bg-primary/40" : "bg-border"
              }`}
            />
            <button
              type="button"
              disabled={n > step}
              onClick={() => onSelect(n)}
              aria-label={`${n}단계 ${s.label}`}
              aria-current={current ? "step" : undefined}
              className={`flex h-9 w-full items-center justify-center rounded-md px-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                current ? "font-semibold text-primary" : "text-muted-foreground"
              } ${n > step ? "cursor-not-allowed opacity-60" : "hover:bg-secondary"}`}
            >
              <span className="hidden sm:inline">{n}.&nbsp;</span>
              <span className="truncate">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** 반려 배너 — 최신 사유는 항상 펼쳐 두고, 과거 이력은 접어 둔다. */
function RejectBanner({
  responseId,
  reject,
  onGoToStep,
}: {
  responseId: string;
  reject: { body: string; step: number | null; created_at: string };
  onGoToStep: (n: number) => void;
}) {
  const { data: history } = useQuery({
    queryKey: ["reject-history", responseId],
    queryFn: () => getRejectHistory(responseId),
  });
  const past = (history ?? []).slice(1);

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <AlertTriangle className="size-4" />
          반려된 응답입니다. 아래 의견을 반영해 수정 후 다시 제출해 주세요.
        </p>
        <span className="text-xs text-muted-foreground">
          {new Date(reject.created_at).toLocaleString("ko-KR")}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{reject.body}</p>
      {reject.step ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => onGoToStep(reject.step as number)}
        >
          {reject.step}단계 「{STEPS[reject.step - 1]?.label}」로 이동
        </Button>
      ) : null}
      {past.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            이전 반려 이력 {past.length}건 보기
          </summary>
          <ul className="mt-2 space-y-2">
            {past.map((c) => (
              <li key={c.id} className="rounded-lg border bg-background p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {c.step ? `${c.step}단계 「${STEPS[c.step - 1]?.label}」` : "단계 미지정"}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(c.created_at).toLocaleDateString("ko-KR")}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 인사정보 정정 요청 — 응답자는 1단계 정보를 직접 고칠 수 없으므로 관리자에게 요청을 보낸다.
 * showPending 이 켜진 곳(1단계)에서만 요청 현황을 함께 보여 준다.
 */
function InfoRequestPanel({
  participant,
  showPending,
}: {
  participant: MyParticipant;
  showPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const { data: requests, refetch } = useQuery({
    queryKey: ["my-info-requests", participant.id],
    queryFn: () => getMyInfoRequests(participant.id),
  });

  const current: Record<string, string> = {
    name: participant.name,
    emp_no: participant.emp_no,
    email: participant.email ?? "",
    company: participant.company_name ?? "",
    org_text: participant.org_text ?? "",
    grade: participant.grade ?? "",
    role_level: participant.role_level ?? "",
  };

  const rows = requests ?? [];
  const pending = rows.filter((r) => r.status === "요청");
  const handled = rows.filter((r) => r.status !== "요청");

  function toggle(key: string, on: boolean) {
    setPicked((prev) => {
      const next = { ...prev };
      if (on) next[key] = next[key] ?? "";
      else delete next[key];
      return next;
    });
  }

  async function send() {
    const fields: InfoChangeField[] = Object.entries(picked).map(([field, requested]) => ({
      field,
      current: current[field] ?? "",
      requested: requested.trim(),
    }));
    if (fields.length === 0) {
      toast.error("정정할 항목을 하나 이상 골라 주세요.");
      return;
    }
    if (fields.some((f) => f.requested === "")) {
      toast.error("선택한 항목의 올바른 값을 모두 적어 주세요.");
      return;
    }
    setSending(true);
    try {
      await createInfoChangeRequest(participant.id, fields, note);
      setOpen(false);
      setPicked({});
      setNote("");
      await refetch();
      toast.success("정정 요청을 보냈습니다. 처리 전에도 계속 작성할 수 있습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "정정 요청에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }

  const summary = (fields: unknown) =>
    (Array.isArray(fields) ? (fields as InfoChangeField[]) : [])
      .map((f) => `${infoFieldLabel(f.field)}: ${f.current || "(비어 있음)"} → ${f.requested}`)
      .join(" / ");

  return (
    <div className="space-y-3">
      {showPending && pending.length > 0 ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          정정 요청 처리 대기 중 {pending.length}건 — {summary(pending[0]?.fields)}
        </p>
      ) : null}

      {showPending && handled.length > 0 ? (
        <ul className="space-y-2">
          {handled.slice(0, 3).map((r) => (
            <li key={r.id} className="rounded-lg border bg-background p-3 text-sm">
              <p className="font-medium">
                {r.status === "처리완료" ? "정정 처리 완료" : "정정 요청 반려"}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString("ko-KR")}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{summary(r.fields)}</p>
              {r.admin_note ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                  관리자 의견: {r.admin_note}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">
          정보가 다르면 아래 버튼으로 정정을 요청해 주세요. 이 화면에서는 직접 수정할 수 없습니다.
        </span>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          정보 정정 요청
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>인사정보 정정 요청</DialogTitle>
            <DialogDescription>
              틀린 항목을 고르고 올바른 값을 적어 주세요. 관리자가 확인 후 반영합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {INFO_FIELDS.map((f) => {
              const checked = f.key in picked;
              return (
                <div key={f.key} className="rounded-lg border p-3">
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggle(f.key, v === true)}
                      aria-label={`${f.label} 정정`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{f.label}</span>
                      <span className="ml-2 text-muted-foreground">
                        현재: {current[f.key] || "미등록"}
                      </span>
                    </span>
                  </label>
                  {checked ? (
                    <Input
                      className="mt-2"
                      value={picked[f.key] ?? ""}
                      aria-label={`${f.label} 올바른 값`}
                      placeholder="올바른 값"
                      onChange={(e) => setPicked((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  ) : null}
                </div>
              );
            })}
            <div className="space-y-2">
              <Label htmlFor="info-note">사유 (선택)</Label>
              <Textarea
                id="info-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 3월 인사이동으로 소속이 변경되었습니다."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
              취소
            </Button>
            <Button onClick={() => void send()} disabled={sending}>
              {sending ? "보내는 중..." : "요청 보내기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * V8: 업무분장표에서 과업 후보를 골라 4단계 그리드에 프리필한다.
 * 후보가 0건이면 호출부에서 버튼 자체를 렌더하지 않는다(빈 상태 소음 금지).
 */
function DutyImportPanel({
  candidates,
  tasks,
  onAppend,
}: {
  candidates: DutyTaskCandidate[];
  tasks: TaskItem[];
  onAppend: (items: DutyTaskCandidate[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const existing = new Set(tasks.map((t) => t.name.trim()).filter(Boolean));

  const toggle = (i: number, on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(i);
      else next.delete(i);
      return next;
    });
  };

  const apply = () => {
    onAppend(candidates.filter((_, i) => picked.has(i)));
    setOpen(false);
    toast.success(
      `업무분장 ${picked.size}건을 과업으로 추가했습니다. 내용은 자유롭게 고쳐 주세요.`,
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">
          소속 조직의 업무분장표가 등록되어 있습니다. 과업 후보로 불러와 시작할 수 있습니다.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPicked(new Set());
            setOpen(true);
          }}
        >
          <ClipboardList className="mr-1 size-4" />
          업무분장에서 불러오기
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>업무분장에서 과업 불러오기</DialogTitle>
            <DialogDescription>
              가져올 항목을 고르세요. 주요업무는 과업명으로, 세부업무는 세부 활동으로 들어가며
              불러온 뒤 자유롭게 수정할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {candidates.map((c, i) => {
              const dup = existing.has(c.task.trim());
              return (
                <li key={c.task} className={cnDuty(dup)}>
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox
                      checked={picked.has(i)}
                      disabled={dup}
                      onCheckedChange={(v) => toggle(i, v === true)}
                      aria-label={`${c.task} 불러오기`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{c.task}</span>
                      {dup ? (
                        <span className="ml-2 text-xs text-muted-foreground">이미 있는 과업</span>
                      ) : null}
                      {c.activities.length ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          세부: {c.activities.join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button disabled={picked.size === 0} onClick={apply}>
              {picked.size > 0 ? `${picked.size}건 불러오기` : "불러오기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 중복(이미 있는 과업) 행은 흐리게 — 목록이 길어 클래스 분기를 함수로 뺐다. */
function cnDuty(dup: boolean) {
  return `rounded-lg border p-3 ${dup ? "opacity-50" : ""}`;
}

function SurveyPage() {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();

  const { data, isLoading, refetch } = useQuery({
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
  const [saveFails, setSaveFails] = useState(0);
  /** 마지막으로 저장이 끝난 시각 — 저장됐다는 말만으로는 언제 저장됐는지 알 수 없다 (기획 P8). */
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [gateTried, setGateTried] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  /** 맥락별 [문의하기] 진입점(기본정보 없음, 항목 이해 안 됨 등)이 공유하는 다이얼로그 상태. */
  const [inquiry, setInquiry] = useState<{ open: boolean; category: InquiryCategory }>({
    open: false,
    category: "기타",
  });
  const openInquiry = (category: InquiryCategory) => setInquiry({ open: true, category });
  const [sending, setSending] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);
  /** V15-2: 제출 전 셀프 AI 점검 다이얼로그 상태. 게이트가 아니므로 제출 흐름과 무관하다. */
  const [aiCheck, setAiCheck] = useState<{
    open: boolean;
    loading: boolean;
    findings: SelfCheckFinding[] | null;
    error: string | null;
  }>({ open: false, loading: false, findings: null, error: null });

  const hydratedRef = useRef(false);
  /** 서버 값 주입으로 state 가 바뀐 직후 1회는 자동저장을 건너뛴다(방금 읽은 값을 되쓰지 않는다). */
  const skipAutosaveRef = useRef(false);
  const pendingRef = useRef(false);
  const flushPendingRef = useRef<() => void>(() => undefined);
  /** 마지막으로 확인한 responses.updated_at — 저장할 때 낙관적 락 기준값으로 보낸다. */
  const updatedAtRef = useRef<string | null>(null);
  /** 진행 중인 저장(항상 최대 1개)과 그 뒤에 대기 중인 저장이 있는지 */
  const savingRef = useRef<Promise<void> | null>(null);
  const waitingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failsRef = useRef(0);
  /** URL 로 앞 단계를 건너뛰지 못하게 하는 상한. 서버 current_step 에서 시작해 진행할 때마다 오른다. */
  const unlockedRef = useRef(1);

  const responseId = data?.response.id ?? null;
  const status = data?.response.status ?? "draft";
  const readOnly = status === "submitted" || status === "approved";

  // V8: 소속 조직 업무분장 후보. 0건이면 4단계 버튼 자체가 안 뜬다.
  const { data: dutyCandidates } = useQuery({
    queryKey: ["duty-candidates"],
    queryFn: () => getMyDutyCandidates(),
    enabled: !!data && !readOnly,
    staleTime: Infinity,
  });

  // 단계는 URL 에서 파생한다. 상한을 넘는 값(앞 단계 건너뛰기)은 상한으로 눌러 쓴다.
  // 상한은 렌더 중에 올린다 — effect 로 미루면 첫 렌더의 step 이 1로 굳는다.
  if (data) {
    const resume = Math.min(Math.max(data.response.current_step, 1), STEPS.length);
    if (resume > unlockedRef.current) unlockedRef.current = resume;
  }
  const step = Math.min(Math.max(search.step ?? unlockedRef.current, 1), unlockedRef.current);
  const stepRef = useRef(step);
  stepRef.current = step;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  // 온보딩 미완료 → 튜토리얼로
  useEffect(() => {
    if (data && !data.response.onboarding_done) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [data, navigate]);

  // 서버 값 → 로컬 상태 주입. 폼 입력을 덮어쓰지 않도록 1회만 돌고,
  // 충돌 후 다시 불러올 때는 hydratedRef 를 되돌려 이 경로를 한 번 더 태운다.
  // participant·examples·reject 는 data 를 직접 읽으므로 이 가드와 무관하게 항상 최신이다.
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    skipAutosaveRef.current = true;
    const r = data.response;
    updatedAtRef.current = r.updated_at;
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
  }, [data]);

  // URL 정규화 — step 이 없으면 이어서 할 단계로, 상한을 넘으면 상한으로 되돌린다.
  // search 를 통째로 갈아끼우면 딥링크로 실려 온 focus 가 도착 직후 사라진다.
  useEffect(() => {
    if (!data) return;
    if (search.step !== step) {
      void navigate({ to: "/survey", search: (prev) => ({ ...prev, step }), replace: true });
    }
  }, [data, search.step, step, navigate]);

  // 딥링크로 들어온 항목으로 데려간다. 목록이 그려진 뒤여야 하므로 데이터 주입 후에 돈다.
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    const target = search.focus;
    if (!data || !target || focusedRef.current === target) return;
    focusedRef.current = target;
    const timer = setTimeout(() => focusAnchor(`field-${target}`), 150);
    return () => clearTimeout(timer);
  }, [data, search.focus]);

  async function persist(target: number) {
    if (!responseId) return;
    const expected = updatedAtRef.current;
    if (target === 2) {
      updatedAtRef.current = await saveResponseFields(
        responseId,
        {
          job_group: form.jobGroup || null,
          job_series: form.jobSeries || null,
          job_name: form.jobName || null,
        },
        expected,
      );
    } else if (target === 3) {
      updatedAtRef.current = await saveResponseFields(
        responseId,
        { definition: form.definition || null, mission: form.mission || null },
        expected,
      );
    } else if (target === 4) {
      updatedAtRef.current = await saveTasks(responseId, tasks, expected);
    } else if (target === 5) {
      updatedAtRef.current = await saveSkills(responseId, skills, expected);
      await saveRequirements(responseId, req);
    } else if (target === 6) {
      updatedAtRef.current = await saveResponseFields(
        responseId,
        {
          coverage_pct: form.coverage,
          missed_note: form.missedNote || null,
          pain_note: form.painNote || null,
        },
        expected,
      );
    }
  }

  /** 저장 1회. 실패하면 지수 백오프로 재시도를 예약한다(예외를 다시 던지지 않는다). */
  async function runSave(target: number) {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    pendingRef.current = false;
    setSaveState("saving");
    try {
      await persist(target);
      failsRef.current = 0;
      setSaveFails(0);
      setSaveState("saved");
      setSavedAt(new Date());
    } catch (err) {
      setSaveState("unsaved");
      // 충돌은 재시도해도 계속 실패한다 — 사용자에게 최신 내용을 불러올지 묻는다.
      if (isConflict(err)) {
        failsRef.current = 0;
        setSaveFails(0);
        setConflictOpen(true);
        return;
      }
      failsRef.current += 1;
      setSaveFails(failsRef.current);
      const delay = RETRY_DELAYS[failsRef.current - 1];
      if (delay === undefined) {
        toast.error(err instanceof Error ? err.message : "임시저장에 실패했습니다.");
        return;
      }
      retryTimerRef.current = setTimeout(() => void flush(target), delay);
    }
  }

  /** 저장 직렬화 — 진행 중인 저장이 있으면 끝난 뒤 한 번만 이어서 저장한다(대기자는 1명). */
  function flush(target: number): Promise<void> {
    if (!responseId || readOnly) return Promise.resolve();
    const inflight = savingRef.current;
    if (inflight && waitingRef.current) return inflight;

    let next: Promise<void>;
    if (inflight) {
      waitingRef.current = true;
      next = inflight.then(() => {
        waitingRef.current = false;
        return runSave(target);
      });
    } else {
      next = runSave(target);
    }
    savingRef.current = next;
    void next.then(() => {
      if (savingRef.current === next) savingRef.current = null;
    });
    return next;
  }

  /** 재시도 3회가 모두 실패한 뒤 노출되는 수동 저장. */
  function manualSave() {
    failsRef.current = 0;
    setSaveFails(0);
    return flush(stepRef.current);
  }

  /** 충돌 확인 후 서버 내용을 다시 읽어 로컬 입력을 갈아끼운다. */
  async function reloadFromServer() {
    setConflictOpen(false);
    hydratedRef.current = false;
    updatedAtRef.current = null;
    pendingRef.current = false;
    failsRef.current = 0;
    setSaveFails(0);
    setSaveState("saved");
    await refetch();
  }

  // 입력 2초 유휴 시 자동 임시저장
  useEffect(() => {
    if (!hydratedRef.current || readOnly) return;
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false;
      return;
    }
    setSaveState("unsaved");
    pendingRef.current = true;
    const timer = setTimeout(() => {
      void flush(stepRef.current);
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, tasks, skills, req, readOnly]);

  // debounce 가 아직 안 터진 마지막 입력을 이탈 시점에 저장한다.
  // ponytail: beforeunload 는 요청 완료를 보장하지 않는다 — 확실히 하려면 sendBeacon 전용 엔드포인트 필요.
  flushPendingRef.current = () => {
    if (pendingRef.current) void flush(stepRef.current);
  };
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      // 저장이 끝난 상태면 경고하지 않는다 — 늘 뜨는 경고는 아무도 읽지 않는다.
      if (readOnly || (!pendingRef.current && saveStateRef.current === "saved")) return;
      flushPendingRef.current();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [readOnly]);

  // 화면을 벗어날 때(라우팅 이동)는 경고 없이 마지막 입력만 저장한다.
  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      flushPendingRef.current();
    },
    [],
  );

  // goTo 를 거치지 않은 단계 이동(브라우저 뒤로가기) — 떠나는 단계의 미저장 입력을 저장한다.
  const prevStepRef = useRef(step);
  useEffect(() => {
    const from = prevStepRef.current;
    prevStepRef.current = step;
    if (from !== step && pendingRef.current) void flush(from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const taskCheck = useMemo(() => validateTasks(tasks), [tasks]);
  const skillCheck = useMemo(() => validateSkills(skills), [skills]);
  const defCheck = useMemo(() => {
    const errors: string[] = [];
    if (form.definition.trim() === "") errors.push("직무 정의를 적어 주세요");
    if (form.mission.trim() === "") errors.push("직무 목적(미션)을 적어 주세요");
    return { ok: errors.length === 0, errors, warnings: [] };
  }, [form.definition, form.mission]);

  /** 해당 단계의 필수 조건. 없으면 null(자유 이동 가능 단계) */
  const checkStep = (n: number) =>
    n === 3 ? defCheck : n === 4 ? taskCheck : n === 5 ? skillCheck : null;

  const activeCheck = checkStep(step);

  // 진행 체크리스트 (기획 C3). 게이트와 같은 조건을 쓰되 항목마다 갈 자리를 달고 있다.
  const checklist = useMemo(
    () =>
      buildChecklist({
        jobGroup: form.jobGroup,
        jobSeries: form.jobSeries,
        jobName: form.jobName,
        definition: form.definition,
        mission: form.mission,
        tasks,
        skills,
        coverage: form.coverage,
        requirements: req,
      }),
    [form, tasks, skills, req],
  );
  const missingItems = checklist
    .filter((i) => i.required && !i.done)
    .map((i) => ({ id: i.id, label: i.hint ? `${i.label} — ${i.hint}` : i.label, step: i.step }));

  /** target 단계로 가기 전에 통과해야 할 선행 단계 중 처음 실패하는 단계 번호 */
  function firstBlockingStep(target: number): number | null {
    for (let n = 1; n < target; n += 1) {
      const check = checkStep(n);
      if (check && !check.ok) return n;
    }
    return null;
  }

  /** 실패 단계로 되돌리고 에러를 펼친다. */
  async function blockAt(n: number) {
    setGateTried(true);
    toast.error(`${n}단계 「${STEPS[n - 1]?.label}」 작성이 완료되지 않았습니다.`);
    if (n !== step) {
      await flush(step);
      await navigate({ to: "/survey", search: { step: n } });
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function goTo(next: number) {
    if (next < 1 || next > STEPS.length) return;
    if (next > step && !readOnly) {
      const blocked = firstBlockingStep(next);
      if (blocked !== null) {
        await blockAt(blocked);
        return;
      }
    }
    setGateTried(false);
    await flush(step);
    if (responseId && !readOnly) {
      try {
        updatedAtRef.current = await saveResponseFields(
          responseId,
          { current_step: next },
          updatedAtRef.current,
        );
      } catch (err) {
        // 단계 기록 실패는 내용 저장과 달리 치명적이지 않다 — 충돌만 사용자에게 알린다.
        if (isConflict(err)) {
          setConflictOpen(true);
          return;
        }
      }
    }
    unlockedRef.current = Math.max(unlockedRef.current, next);
    await navigate({ to: "/survey", search: { step: next } });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /**
   * 체크리스트 항목 → 그 입력칸. 다른 단계면 먼저 옮기고, 화면이 그려진 뒤 스크롤한다.
   * 앞 단계를 건너뛰려 하면 goTo 가 막고 어디를 채워야 하는지 알려 준다(막다른 골목 없음).
   */
  async function jumpTo(target: number, anchor: string) {
    if (target !== step) await goTo(target);
    // 단계가 바뀌면 그 화면이 그려진 뒤에야 대상 요소가 생긴다. 없으면 focusAnchor 가 그냥 넘어간다.
    setTimeout(() => focusAnchor(anchor), 120);
  }

  /** V15-2: 화면의 마지막 입력까지 저장한 뒤 본인 응답을 AI 로 점검한다(선택 사항). */
  async function runAiCheck() {
    if (!responseId) return;
    setAiCheck({ open: true, loading: true, findings: null, error: null });
    try {
      await flush(stepRef.current);
      const res = await selfCheckMyResponse({ data: { responseId } });
      setAiCheck({ open: true, loading: false, findings: res.findings, error: null });
    } catch {
      setAiCheck({
        open: true,
        loading: false,
        findings: null,
        error: "AI 점검을 잠시 사용할 수 없습니다 — 그대로 제출해도 됩니다.",
      });
    }
  }

  async function handleSubmit() {
    if (!responseId || readOnly) return;

    // 단계 게이트를 우회해 들어왔을 수 있으니 제출 직전에 전부 재검증한다.
    const blocked = firstBlockingStep(STEPS.length);
    if (blocked !== null) {
      setConfirmOpen(false);
      await blockAt(blocked);
      return;
    }
    if (!form.coverage) {
      setConfirmOpen(false);
      toast.error("'내 일을 어느 정도 담았는지'를 선택해야 제출할 수 있습니다.");
      return;
    }

    setSending(true);
    try {
      if (savingRef.current) await savingRef.current; // 자동저장과 겹치지 않게
      await persist(3);
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
      setConfirmOpen(false);
      if (isConflict(err)) {
        setConflictOpen(true);
        return;
      }
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
  const improveNotes = tasks.filter((t) => t.improveType || t.improveNote.trim());
  const activityCount = tasks.reduce((sum, t) => sum + t.activities.length, 0);

  const chipState: SaveState =
    saveFails > 0
      ? "failed"
      : saveState === "saving"
        ? "saving"
        : saveState === "saved" && savedAt
          ? "saved"
          : "idle";

  return (
    <div className="min-h-screen bg-secondary">
      <header className="sticky top-0 z-20 border-b bg-card">
        <div className="mx-auto max-w-5xl space-y-3 px-4 py-3 sm:px-6 lg:max-w-7xl">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-sm font-bold sm:text-base">업무조사 작성</h1>
            {readOnly ? (
              <span className="text-xs text-muted-foreground">제출 완료 (읽기 전용)</span>
            ) : (
              // 저장 상태·재시도 횟수·수동 저장이 늘 같은 자리에 있다 (기획 C6).
              <SaveStatusChip
                state={chipState}
                savedAt={savedAt}
                retryCount={saveFails}
                onSaveNow={() => void manualSave()}
              />
            )}
          </div>
          <StepBar step={step} onSelect={(n) => void goTo(n)} />
        </div>
      </header>

      {/* 넓은 화면에서는 입력이 좁아지지 않도록 폭을 늘려 오른쪽에 점검 패널을 세운다 (기획 C1·C3). */}
      <main className="mx-auto max-w-5xl px-4 py-6 pb-24 sm:px-6 lg:grid lg:max-w-7xl lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-6 lg:pb-6">
        <div className="space-y-5">
          <NoticeStack />

          {status === "rejected" && reject ? (
            <RejectBanner
              responseId={data.response.id}
              reject={reject}
              onGoToStep={(n) => void goTo(n)}
            />
          ) : null}

          <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
            <p className="text-xs font-semibold text-primary">
              {step}단계 · {stepMeta.label}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{stepMeta.intro}</p>

            <div className="mt-6">
              {step === 1 ? (
                <div className="space-y-4">
                  <HowToBox
                    sectionId="step1"
                    title="이 단계에서 할 일"
                    steps={[
                      "관리자가 등록한 인사정보가 맞는지 훑어봅니다.",
                      "틀린 내용이 있으면 [정정 요청]으로 알려 주세요. 이 화면에서는 직접 고칠 수 없습니다.",
                      "요청을 보낸 뒤에도 작성은 계속할 수 있습니다.",
                    ]}
                  />
                  <InfoRequestPanel participant={participant} showPending />
                  <dl className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ["name", "성명", participant.name],
                        ["emp_no", "사번", participant.emp_no],
                        ["email", "이메일", participant.email],
                        ["company", "회사", participant.company_name],
                        ["org_text", "소속", participant.org_text],
                        ["grade", "직급", participant.grade],
                        ["role_level", "역할단계", participant.role_level],
                      ] as const
                    ).map(([key, label, value]) => (
                      <div
                        key={key}
                        id={`field-${key}`}
                        className="rounded-lg border bg-background p-3 scroll-mt-28"
                      >
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-1 text-sm font-medium">{value || "미등록"}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4">
                  <HowToBox
                    sectionId="step2"
                    title="이 단계에서 할 일"
                    steps={[
                      "직군 → 직렬 → 직무 순으로 본인이 맡은 자리의 이름을 적습니다.",
                      "입력칸을 누르면 같은 계열사에서 이미 쓰는 이름이 후보로 뜹니다. 맞는 것이 있으면 고르세요.",
                      "여기 적은 직군에 맞춰 이후 단계의 작성 예시가 바뀝니다.",
                    ]}
                    sections={[
                      {
                        title: "세 가지 분류",
                        rows: [
                          ["직군", "가장 큰 분류입니다. 예: 사무관리, 생산, 연구개발"],
                          ["직렬", "직군 안의 중간 분류입니다. 예: 사무관리 안의 인사, 총무"],
                          ["직무", "실제로 담당하는 업무 단위입니다. 예: 인사기획, 급여운영"],
                        ],
                      },
                    ]}
                  />
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
                      ["jobGroup", "job_group", "직군", "예: 사무관리", "job-group-options"],
                      ["jobSeries", "job_series", "직렬", "예: 인사", "job-series-options"],
                      ["jobName", "job_name", "직무", "예: 인사기획", "job-name-options"],
                    ] as const
                  ).map(([key, anchor, label, placeholder, listId]) => (
                    <div key={key} id={`field-${anchor}`} className="space-y-2 scroll-mt-28">
                      {/* 정의 아이콘은 label 밖에 둔다 — label 안의 버튼은 눌러도 입력칸이 잡힌다. */}
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor={key}>{label}</Label>
                        <FieldHint term={label} />
                      </div>
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
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => openInquiry("직무없음")}
                  >
                    내 직무가 목록에 없나요? 문의하기
                  </Button>
                  <InfoRequestPanel participant={participant} />
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-6">
                  <HowToBox
                    sectionId="step3"
                    title="이 단계에서 할 일"
                    steps={[
                      "직무 정의 — 「무엇을 대상으로 → 어떤 활동을 하여 → 어떤 상태를 만드는가」를 두세 문장으로 적습니다.",
                      "직무 목적 — 이 직무가 회사에 남기는 최종 성과를 한두 문장으로 적습니다.",
                      "막히면 각 칸 옆 [예시 보기]에서 잘 쓴 문장과 아쉬운 문장을 비교해 보세요.",
                    ]}
                    sections={[
                      {
                        title: "자주 하는 실수",
                        rows: [
                          [
                            "내 이야기로 쓰기",
                            "「저는 ~을 합니다」가 아니라 직무를 주어로 씁니다.",
                          ],
                          [
                            "부서명으로 쓰기",
                            "「인사 업무 담당」처럼 쓰면 무엇을 하는 자리인지 남지 않습니다.",
                          ],
                        ],
                      },
                    ]}
                  />
                  <div id="field-definition" className="space-y-2 scroll-mt-28">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <Label htmlFor="definition">직무 정의</Label>
                      <ExamplePopover
                        examples={examples}
                        jobGroup={form.jobGroup}
                        fields={["definition"]}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      「무엇을 대상으로 → 어떤 활동을 하여 → 어떤 상태를 만드는가」가 드러나도록
                      2~3줄로 적어 주세요. 본인 이야기가 아니라 직무 이야기로 적습니다.
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
                  <div id="field-mission" className="space-y-2 scroll-mt-28">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <Label htmlFor="mission">직무 목적</Label>
                      <ExamplePopover
                        examples={examples}
                        jobGroup={form.jobGroup}
                        fields={["mission"]}
                      />
                    </div>
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
                </div>
              ) : null}

              {step === 4 ? (
                <div className="space-y-5">
                  <TaskHowTo taskCount={tasks.length} />
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => openInquiry("항목이해")}
                  >
                    이 항목이 무슨 뜻인지 모르겠나요? 문의하기
                  </Button>
                  {!readOnly && (dutyCandidates?.length ?? 0) > 0 ? (
                    <DutyImportPanel
                      candidates={dutyCandidates ?? []}
                      tasks={tasks}
                      onAppend={(items) =>
                        setTasks((prev) => [
                          ...prev,
                          ...items.map((c) => ({
                            id: uid(),
                            name: c.task,
                            importance: null,
                            authority: null,
                            transferable: null,
                            isKey: false,
                            improveType: null,
                            improveNote: "",
                            activities: c.activities.map((a) => ({ id: uid(), name: a })),
                          })),
                        ])
                      }
                    />
                  ) : null}
                  <TaskGrid
                    value={tasks}
                    onChange={setTasks}
                    examples={examples.filter((e) => e.field === "task" || e.field === "activity")}
                    jobGroup={form.jobGroup}
                    disabled={readOnly}
                    confirmRemove={(task) => {
                      const linked = skills.filter((s) => s.relatedTaskIds.includes(task.id));
                      if (linked.length === 0) return true;
                      const names = linked.map((s) => s.name.trim() || "이름 미입력").join(", ");
                      if (
                        !window.confirm(
                          `이 과업에 연결된 필요 역량이 ${linked.length}개 있습니다 (${names}).\n삭제하면 연결도 함께 사라집니다. 계속할까요?`,
                        )
                      ) {
                        return false;
                      }
                      setSkills((prev) =>
                        prev.map((s) =>
                          s.relatedTaskIds.includes(task.id)
                            ? {
                                ...s,
                                relatedTaskIds: s.relatedTaskIds.filter((id) => id !== task.id),
                              }
                            : s,
                        ),
                      );
                      return true;
                    }}
                  />
                </div>
              ) : null}

              {step === 5 ? (
                <Tabs defaultValue="skills">
                  <TabsList className="w-full">
                    <TabsTrigger value="skills" className="flex-1">
                      필요 역량
                    </TabsTrigger>
                    <TabsTrigger value="requirements" className="flex-1">
                      자격요건
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="skills" className="mt-4 space-y-5">
                    <SkillHowTo skillCount={skills.length} />
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-sm"
                      onClick={() => openInquiry("항목이해")}
                    >
                      이 항목이 무슨 뜻인지 모르겠나요? 문의하기
                    </Button>
                    <SkillGrid
                      value={skills}
                      onChange={setSkills}
                      tasks={tasks.map((t) => ({ id: t.id, name: t.name }))}
                      examples={examples.filter((e) => e.field === "skill")}
                      jobGroup={form.jobGroup}
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
                  {/* 제출 전 영수증 — 무엇을 냈는지 한 장으로 보고 누르면 그 단계로 돌아간다 (기획 C7). */}
                  <SubmissionSummary
                    job={{ group: form.jobGroup, series: form.jobSeries, name: form.jobName }}
                    definition={form.definition}
                    mission={form.mission}
                    taskCount={tasks.length}
                    activityCount={activityCount}
                    skillCount={skills.length}
                    missing={missingItems}
                    onGoToStep={(n) => void goTo(n)}
                  />

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

                  <div id="field-pain_note" className="space-y-2 scroll-mt-28">
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

                  <div id="field-coverage" className="space-y-3 scroll-mt-28">
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

                  <div id="field-missed_note" className="space-y-2 scroll-mt-28">
                    <Label htmlFor="missed">
                      이 조사에서 담지 못한 직무의 측면이 있다면 (선택)
                    </Label>
                    <Textarea
                      id="missed"
                      rows={3}
                      disabled={readOnly}
                      value={form.missedNote}
                      onChange={(e) => setForm({ ...form, missedNote: e.target.value })}
                    />
                  </div>

                  {!readOnly ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                      <span className="min-w-0 flex-1">
                        제출 전에 AI 가 작성 내용을 한 번 훑어볼 수 있습니다. 선택 사항이며 점검
                        없이 그대로 제출해도 됩니다.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={aiCheck.loading}
                        onClick={() => void runAiCheck()}
                      >
                        <Sparkles className="mr-1 size-4" />
                        제출 전 AI 점검 (선택)
                      </Button>
                    </div>
                  ) : null}
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
                <p className="text-sm font-semibold text-warning">
                  권장 사항 — 반영하지 않아도 다음 단계로 넘어갈 수 있습니다
                </p>
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
              &lsquo;내 일을 어느 정도 담았는지&rsquo;를 선택하면 제출할 수 있습니다.
            </p>
          ) : null}
        </div>

        <StepChecklist
          steps={STEPS.map((s, i) => ({ n: i + 1, label: s.label }))}
          items={checklist}
          currentStep={step}
          onJump={(target, anchor) => void jumpTo(target, anchor)}
          submit={
            readOnly
              ? null
              : {
                  disabled: sending,
                  onClick: () => {
                    // 마지막 단계가 아니면 먼저 그리로 데려간다 — 제출 조건을 눈으로 보고 누르게.
                    if (step !== STEPS.length) void goTo(STEPS.length);
                    else if (!form.coverage) void jumpTo(STEPS.length, "field-coverage");
                    else setConfirmOpen(true);
                  },
                }
          }
        />
      </main>

      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>관리자가 이 응답을 수정했습니다</DialogTitle>
            <DialogDescription>
              방금 입력분은 사라지고 최신 내용으로 바뀝니다. 확인을 누르면 최신 내용을 불러옵니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => void reloadFromServer()}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={aiCheck.open}
        onOpenChange={(v) => setAiCheck((prev) => ({ ...prev, open: v }))}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>제출 전 AI 점검</DialogTitle>
            <DialogDescription>
              참고용 제안입니다. 반영 여부는 자유이며 이대로 제출해도 됩니다.
            </DialogDescription>
          </DialogHeader>
          {aiCheck.loading ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              작성 내용을 점검하는 중입니다...
            </p>
          ) : aiCheck.error ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {aiCheck.error}
            </p>
          ) : aiCheck.findings && aiCheck.findings.length > 0 ? (
            <ul className="space-y-2">
              {aiCheck.findings.map((f) => (
                <li key={`${f.item}-${f.reason}`} className="rounded-lg border bg-background p-3">
                  <p className="text-sm font-semibold">{f.item}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{f.reason}</p>
                  {f.suggestion ? (
                    <p className="mt-1 text-sm">
                      <span className="font-medium text-primary">제안 </span>
                      {f.suggestion}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-lg border bg-background p-3 text-sm">
              <CheckCircle2 className="size-4 shrink-0 text-success" />
              특별한 보완점을 찾지 못했습니다. 그대로 제출하셔도 좋습니다.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAiCheck((prev) => ({ ...prev, open: false }))}
            >
              닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>업무조사를 제출할까요?</DialogTitle>
            <DialogDescription>
              제출하면 수정할 수 없습니다. 관리자가 보완을 요청하면 다시 열립니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>
              계속 작성하기
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={sending}>
              {sending ? "제출 중..." : "제출하기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InquiryComposer
        open={inquiry.open}
        onOpenChange={(v) => setInquiry((prev) => ({ ...prev, open: v }))}
        defaultCategory={inquiry.category}
      />
    </div>
  );
}
