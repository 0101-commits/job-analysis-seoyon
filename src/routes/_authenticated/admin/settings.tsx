import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  Plus,
  Save,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SectionNav, CollapsibleSection, type SectionDef } from "@/components/SectionNav";
import { BackupPanel, ReminderRulesPanel } from "@/components/admin/AutomationPanels";
import { FieldHint } from "@/components/FieldHint";
import { EmptyState } from "@/components/EmptyState";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { PASSWORD_TOKENS, validatePasswordRule } from "@/lib/password-rule";
import { listAllCompanies } from "@/lib/companies";
import { downloadText } from "@/lib/xlsx";
import { exportAuditLog } from "@/lib/export.functions";
import {
  DEFAULT_OPS,
  EMAIL_DOMAIN_RE,
  OPS_LIMITS,
  REMINDER_TARGETS,
  companyOffImpact,
  getOpsImpact,
  getOpsValues,
  getSettings,
  listAuditLogs,
  normalizeEmailDomain,
  previewPasswordRule,
  setCompanyStatus,
  systemStatus,
  updateOpsValues,
  updateSystemSettings,
  upsertSurveySetting,
  validateOps,
  type OpsKey,
  type OpsValues,
} from "@/lib/settings.functions";
import { inspectImpact } from "@/lib/master.functions";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
  head: () => ({
    meta: [
      { title: "조사 설정 | 서연 그룹 업무조사" },
      { name: "description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
      { property: "og:title", content: "설정 | 서연 그룹 업무조사" },
      { property: "og:description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
    ],
  }),
  component: SettingsPage,
});

type ReminderTarget = (typeof REMINDER_TARGETS)[number];

/** 역할단계 등록 상한 — 서버(settings.functions.ts roleLevelsSchema)의 max(12)와 같은 값. */
const MAX_ROLE_LEVELS = 12;

/** 고객 질의 대응용 보안 현황. 정적 콘텐츠(DB 조회 없음). */
const SECURITY_ROWS: { title: string; state: "적용" | "옵션" | "실명 구조"; desc: string }[] = [
  {
    title: "행 단위 접근 통제(RLS)",
    state: "적용",
    desc: "전 18개 테이블 활성. 응답자는 본인 데이터만, 관리자는 역할 검증 후 전체를 볼 수 있습니다.",
  },
  {
    title: "권한 상승 차단",
    state: "적용",
    desc: "응답자는 자기 인사정보를 수정할 수 없습니다(접속 시각만 기록 가능). 자가 승인·계열사 위조·AI 제안 위조는 전부 DB 레벨에서 차단됩니다.",
  },
  {
    title: "로그인 보호",
    state: "적용",
    desc: "5회 실패 시 30분 잠금. 계정 존재 여부와 남은 횟수는 노출하지 않습니다.",
  },
  {
    title: "초기 비밀번호",
    state: "적용",
    desc: "최초 로그인 시 변경을 강제하고, 변경 완료 즉시 서버에서 삭제합니다.",
  },
  {
    title: "검토 이력 통제",
    state: "적용",
    desc: "관리자 정정 이력은 응답자에게 노출되지 않고, 반려 사유만 전달됩니다.",
  },
  {
    title: "AI 개인정보 배제",
    state: "적용",
    desc: "AI 프롬프트에 이름·사번·이메일을 포함하지 않습니다(집계값만 사용).",
  },
  {
    title: "변경 기록",
    state: "적용",
    desc: "승인·반려·정정·마스터 변경 등 주요 행위를 행위자·시각과 함께 기록합니다.",
  },
  {
    title: "내보내기 익명화",
    state: "옵션",
    desc: "파일 내보내기 시 성명·사번·이메일을 제거하는 옵션을 제공합니다. 생년월일은 항상 포함되지 않습니다.",
  },
  {
    title: "응답-작성자 연결",
    state: "실명 구조",
    desc: "본 조사는 검토·반려 워크플로가 필요한 실명 조사로, 응답이 참여자와 직접 연결됩니다. 익명 조사 전환이 필요하면 별도 설계가 필요합니다.",
  },
];

/**
 * 설정 화면으로 올린 운영값의 설명표 (기획 D5).
 * `source` 는 이 값이 원래 코드 어디에 박혀 있었는지 — 유지보수 시 대조용이다.
 */
const OPS_FIELDS: Record<OpsKey, { label: string; unit: string; hint: string; source: string }> = {
  reviewBacklogDays: {
    label: "검토 적체 기준",
    unit: "일",
    hint: "참여자가 제출한 뒤 이 일수를 넘겨도 검토가 끝나지 않으면 '적체'로 봅니다. 짧게 잡을수록 더 많은 건이 적체로 표시됩니다.",
    source: "admin/review.tsx — 평균 대기일만 보여 주고 기준값은 없었음",
  },
  rejectStaleDays: {
    label: "반려 후 무응답 기준",
    unit: "일",
    hint: "반려한 뒤 이 일수 동안 참여자가 응답을 고치지 않으면 정합성 점검 목록에 올립니다.",
    source: "dashboard.functions.ts REJECT_STALE_MS = 7일",
  },
  exampleCount: {
    label: "참여자 화면 예시 개수",
    unit: "건",
    hint: "작성 화면에서 [예시 보기]를 눌렀을 때 한 번에 보여 줄 예시 수입니다. 많이 보여 주면 그대로 옮겨 적는 경향이 커집니다.",
    source: "survey/ExamplePopover.tsx — 공통 1건 + 직군 1건 고정",
  },
  mailBatchMax: {
    label: "한 번에 보낼 최대 통수",
    unit: "통",
    hint: "안내·독려 메일을 한 번에 보낼 수 있는 최대 통수입니다. 실수로 전원에게 보내는 것을 막는 안전장치입니다.",
    source: "mail.functions.ts — 상한 없음",
  },
  jobCountOk: {
    label: "'정상' 기준 응답 수",
    unit: "인 이상",
    hint: "같은 직무를 이만큼 이상이 작성했으면 직무기술서를 그대로 쓸 수 있다고 봅니다.",
    source: "admin/review.tsx JobCountBadge — 5",
  },
  jobCountCaution: {
    label: "'심층검토' 기준 응답 수",
    unit: "인 이상",
    hint: "이 값 이상 '정상' 기준 미만이면 심층검토, 이 값 미만이면 인터뷰가 반드시 필요한 직무로 표시합니다.",
    source: "admin/review.tsx JobCountBadge — 2",
  },
  taskMin: {
    label: "제출 최소",
    unit: "개",
    hint: "이 개수를 채우지 못하면 참여자가 제출할 수 없습니다.",
    source: "survey/validation.ts validateTasks — 3",
  },
  taskRecommendMin: {
    label: "권장 최소",
    unit: "개",
    hint: "제출은 막지 않고 '이 정도는 적어 달라'고 안내하는 값입니다.",
    source: "survey/validation.ts·TaskGrid.tsx 안내 문구 — 5",
  },
  taskRecommendMax: {
    label: "권장 최대",
    unit: "개",
    hint: "이 개수를 넘으면 비슷한 것끼리 합치라고 안내합니다.",
    source: "survey/validation.ts validateTasks — 10",
  },
  activityMin: {
    label: "제출 최소",
    unit: "개",
    hint: "과업 하나당 이 개수를 채우지 못하면 제출할 수 없습니다.",
    source: "survey/validation.ts — 1",
  },
  activityRecommendMin: {
    label: "권장 최소",
    unit: "개",
    hint: "과업 하나당 이보다 적으면 나눠 적으라고 안내합니다.",
    source: "survey/validation.ts·TaskGrid.tsx — 2",
  },
  activityRecommendMax: {
    label: "권장 최대",
    unit: "개",
    hint: "과업 하나당 이보다 많으면 과업을 나누라고 안내합니다.",
    source: "survey/validation.ts·TaskGrid.tsx — 8",
  },
  skillMin: {
    label: "제출 최소",
    unit: "개",
    hint: "이 개수를 채우지 못하면 제출할 수 없습니다.",
    source: "survey/validation.ts validateSkills — 3",
  },
  skillRecommendMin: {
    label: "권장 최소",
    unit: "개",
    hint: "제출은 막지 않고 안내만 하는 값입니다.",
    source: "survey/validation.ts 안내 문구 — 5",
  },
  skillRecommendMax: {
    label: "권장 최대",
    unit: "개",
    hint: "이보다 많으면 비슷한 역량을 합치라고 안내합니다.",
    source: "상한 없음 — 이번에 신설",
  },
};

/** 저장 버튼을 누른 자리에서 결과를 알리기 위한 항목별 상태 (기획 P8). */
type ItemSave = { state: "saving" | "ok" | "error"; message?: string };

type SurveyDraft = {
  deadline: string;
  reminderDays: string;
  reminderTarget: ReminderTarget;
  reminderAuto: boolean;
  staleDays: string;
};

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function parseReminderDays(text: string) {
  const days = text
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v.replace(/^D-/i, "")));
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 60)) return null;
  return days;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.";
}

/** 저장 버튼 + 그 자리의 성공·실패 표시. 전역 토스트만으로는 무엇이 저장됐는지 알 수 없다. */
function SaveRow({
  status,
  disabled,
  onSave,
  label = "저장",
}: {
  status?: ItemSave | undefined;
  disabled?: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" disabled={disabled || status?.state === "saving"} onClick={onSave}>
        <Save className="size-4" />
        {status?.state === "saving" ? "저장 중..." : label}
      </Button>
      {status?.state === "ok" && (
        <span
          className="inline-flex items-center gap-1.5 text-xs font-medium text-success"
          role="status"
        >
          <Check className="size-3.5" aria-hidden />
          {status.message ?? "저장했습니다"}
        </span>
      )}
      {status?.state === "error" && (
        <span
          className="inline-flex items-start gap-1.5 text-xs font-medium text-destructive"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>저장하지 못했습니다 — {status.message}</span>
        </span>
      )}
    </div>
  );
}

/** 숫자 하나 + 뜻 설명 + 지금 이 값이면 몇 건이 그렇게 분류되는지 (기획 P9·P11). */
function OpsNumber({
  fieldKey,
  value,
  onChange,
  impact,
}: {
  fieldKey: OpsKey;
  value: string;
  onChange: (next: string) => void;
  impact?: string;
}) {
  const field = OPS_FIELDS[fieldKey];
  const limit = OPS_LIMITS[fieldKey];
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {field.label}
        <FieldHint term={field.label} text={field.hint} />
      </span>
      <div className="flex items-center gap-2">
        <Input
          aria-label={field.label}
          type="number"
          min={limit.min}
          max={limit.max}
          inputMode="numeric"
          className="w-24 tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">{field.unit}</span>
      </div>
      {impact ? <p className="text-xs text-primary">{impact}</p> : null}
    </div>
  );
}

/** 배포 판 한 줄 표기 — 값이 없으면 없다고 말한다 (구 상단 표시줄의 로직 이식, 기획 2). */
function buildLine() {
  const version = import.meta.env["VITE_APP_VERSION"] as string | undefined;
  const builtAt = import.meta.env["VITE_BUILD_TIME"] as string | undefined;
  if (!version && !builtAt) return "빌드 정보 확인 불가";
  const when = builtAt ? new Date(builtAt) : null;
  const stamp =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })
      : null;
  return [version ? `버전 v${version.slice(0, 7)}` : null, stamp ? `빌드 ${stamp}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** 탭 맨 위의 한 줄 설명 — 이 탭에서 무엇을 정하는지 (기획 P12). */
function TabIntro({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-secondary/40 p-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function SettingsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => getSettings({ headers: await authHeaders() }),
  });

  const { data: status } = useQuery({
    queryKey: ["admin-system-status"],
    queryFn: async () => systemStatus({ headers: await authHeaders() }),
  });

  const { data: ops } = useQuery({
    queryKey: ["admin-ops-values"],
    queryFn: async () => getOpsValues({ headers: await authHeaders() }),
  });

  const { data: impact } = useQuery({
    queryKey: ["admin-ops-impact"],
    queryFn: async () => getOpsImpact({ headers: await authHeaders() }),
  });

  const [rule, setRule] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [levelInput, setLevelInput] = useState("");
  /** X 클릭 후 영향 인원을 세는 동안의 대상 — 그 칩의 삭제 버튼만 잠근다. */
  const [levelChecking, setLevelChecking] = useState<string | null>(null);
  /** 영향 인원이 있어 확인이 필요한 삭제 요청. null 이면 다이얼로그 닫힘. */
  const [levelDeleteAsk, setLevelDeleteAsk] = useState<{ name: string; count: number } | null>(
    null,
  );
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SurveyDraft>>({});
  const [opsDraft, setOpsDraft] = useState<Record<OpsKey, string>>(
    () =>
      Object.fromEntries(
        (Object.keys(DEFAULT_OPS) as OpsKey[]).map((k) => [k, String(DEFAULT_OPS[k])]),
      ) as Record<OpsKey, string>,
  );
  const [saves, setSaves] = useState<Record<string, ItemSave>>({});
  const [samples, setSamples] = useState<
    { id: string; name: string; empNo: string; password: string }[]
  >([]);
  const [auditAction, setAuditAction] = useState("all");

  useEffect(() => {
    if (!data) return;
    setRule(data.passwordRule);
    setLevels(data.roleLevels);
    setDomains(data.allowedEmailDomains);
    setDrafts(
      Object.fromEntries(
        data.companies.map((c) => {
          const s = data.surveys.find((x) => x.company_id === c.id);
          return [
            c.id,
            {
              deadline: s?.deadline ?? "",
              reminderDays: (s?.reminder_days ?? [7, 3, 1]).join(", "),
              reminderTarget: (s?.reminder_target === "미접속"
                ? "미접속"
                : "미제출") as ReminderTarget,
              reminderAuto: s?.reminder_auto ?? false,
              staleDays: String(s?.stale_days ?? 7),
            },
          ];
        }),
      ),
    );
  }, [data]);

  useEffect(() => {
    if (!ops) return;
    setOpsDraft(
      Object.fromEntries(
        (Object.keys(DEFAULT_OPS) as OpsKey[]).map((k) => [k, String(ops.values[k])]),
      ) as Record<OpsKey, string>,
    );
  }, [ops]);

  const ruleError = rule ? validatePasswordRule(rule) : null;

  /** 항목별 저장 실행 — 성공·실패를 그 항목 자리에 남긴다. */
  async function runSave(id: string, run: () => Promise<unknown>, okMessage: string) {
    setSaves((prev) => ({ ...prev, [id]: { state: "saving" } }));
    try {
      await run();
      setSaves((prev) => ({ ...prev, [id]: { state: "ok", message: okMessage } }));
      void queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-ops-values"] });
    } catch (err) {
      setSaves((prev) => ({ ...prev, [id]: { state: "error", message: errorMessage(err) } }));
    }
  }

  const preview = useMutation({
    mutationFn: async (value: string) =>
      previewPasswordRule({ data: { rule: value }, headers: await authHeaders() }),
    onSuccess: (res) => {
      setSamples(res.samples);
      if (res.samples.length === 0) toast.info("미리보기에 사용할 참여자가 없습니다.");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const { data: audit } = useQuery({
    queryKey: ["admin-audit-logs", auditAction],
    queryFn: async () =>
      listAuditLogs({
        data: { limit: 50, ...(auditAction === "all" ? {} : { action: auditAction }) },
        headers: await authHeaders(),
      }),
  });

  /** 감사 기록 전체를 CSV 파일로 (기획 9 후속). */
  const downloadAudit = useMutation({
    mutationFn: async () => exportAuditLog({ data: {}, headers: await authHeaders() }),
    onSuccess: (csv) => {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadText(`서연_감사기록_${stamp}.csv`, csv, "text/csv;charset=utf-8");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /* ── 계열사 켜고 끄기 (기획 11) — 이 탭만 중지 포함 전체 목록을 본다 ── */
  const { data: allCompanies } = useQuery({
    queryKey: ["companies-all"],
    queryFn: listAllCompanies,
  });

  /** 끄기 전 확인 다이얼로그에 띄울 영향 수치. null 이면 다이얼로그 닫힘. */
  const [pausing, setPausing] = useState<{
    id: string;
    name: string;
    participants: number;
    activeWaves: number;
  } | null>(null);

  const askPause = useMutation({
    mutationFn: async (company: { id: string; name: string }) => ({
      company,
      impact: await companyOffImpact({
        data: { companyId: company.id },
        headers: await authHeaders(),
      }),
    }),
    onSuccess: ({ company, impact }) =>
      setPausing({ id: company.id, name: company.name, ...impact }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const switchCompany = useMutation({
    mutationFn: async (input: { companyId: string; status: "active" | "inactive" }) =>
      setCompanyStatus({ data: input, headers: await authHeaders() }),
    onSuccess: () => {
      setPausing(null);
      // 헤더 스위처(운영 중만)와 이 탭(전체)이 함께 갱신되어야 한다.
      void queryClient.invalidateQueries({ queryKey: ["companies"] });
      void queryClient.invalidateQueries({ queryKey: ["companies-all"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function updateDraft(companyId: string, patch: Partial<SurveyDraft>) {
    setDrafts((prev) => {
      const current = prev[companyId];
      if (!current) return prev;
      return { ...prev, [companyId]: { ...current, ...patch } };
    });
  }

  function submitSurvey(companyId: string) {
    const draft = drafts[companyId];
    if (!draft) return;
    const days = parseReminderDays(draft.reminderDays);
    if (!days) {
      setSaves((prev) => ({
        ...prev,
        [`survey:${companyId}`]: {
          state: "error",
          message: "독려 안내 일자는 0~60 사이 숫자를 쉼표로 구분해 입력해 주세요.",
        },
      }));
      return;
    }
    const staleDays = Number(draft.staleDays);
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 60) {
      setSaves((prev) => ({
        ...prev,
        [`survey:${companyId}`]: {
          state: "error",
          message: "미진행 기준일은 1~60 사이 숫자로 입력해 주세요.",
        },
      }));
      return;
    }
    void runSave(
      `survey:${companyId}`,
      async () =>
        upsertSurveySetting({
          data: {
            companyId,
            deadline: draft.deadline || null,
            reminderDays: days,
            reminderTarget: draft.reminderTarget,
            reminderAuto: draft.reminderAuto,
            staleDays,
          },
          headers: await authHeaders(),
        }),
      "이 계열사 설정을 저장했습니다",
    );
  }

  /**
   * 운영값 저장 — 화면은 구획별로 나뉘어 있지만 저장 위치는 한 행이다.
   * 다른 구획에서 고치던 값이 같이 넘어가지 않도록 저장한 값 위에 이 구획의 값만 얹는다.
   */
  function submitOps(id: string, keys: OpsKey[], okMessage: string) {
    if (!ops) return;
    const next = { ...ops.values } as OpsValues;
    for (const key of keys) {
      const raw = Number(opsDraft[key]);
      const limit = OPS_LIMITS[key];
      if (!Number.isInteger(raw) || raw < limit.min || raw > limit.max) {
        setSaves((prev) => ({
          ...prev,
          [id]: {
            state: "error",
            message: `${OPS_FIELDS[key].label}은(는) ${limit.min}~${limit.max} 사이 숫자여야 합니다.`,
          },
        }));
        return;
      }
      next[key] = raw;
    }
    const invalid = validateOps(next);
    if (invalid) {
      setSaves((prev) => ({ ...prev, [id]: { state: "error", message: invalid } }));
      return;
    }
    void runSave(
      id,
      async () => updateOpsValues({ data: next, headers: await authHeaders() }),
      okMessage,
    );
  }

  function addLevel() {
    const value = levelInput.trim();
    if (!value) return;
    if (levels.length >= MAX_ROLE_LEVELS) {
      toast.error(`역할단계는 최대 ${MAX_ROLE_LEVELS}개까지 등록할 수 있습니다.`);
      return;
    }
    if (levels.includes(value)) {
      toast.error("이미 있는 역할단계입니다.");
      return;
    }
    setLevels((prev) => [...prev, value]);
    setLevelInput("");
  }

  /** 배열 순서가 곧 참여자 선택지·비교 화면의 표시 순서다. 로컬 swap, 반영은 저장 버튼. */
  function moveLevel(index: number, delta: -1 | 1) {
    setLevels((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }

  /**
   * X 클릭 → 이 역할단계를 쓰는 참여자가 있는지 서버에서 먼저 센다 (기획 W3 삭제 가드).
   * 0명이면 바로 목록에서 빼고, 있으면 확인 다이얼로그를 띄운다. 실제 반영은 저장 버튼.
   */
  async function requestLevelDelete(name: string) {
    setLevelChecking(name);
    try {
      const audience = await inspectImpact({
        data: { kind: "role_level_delete", id: name },
        headers: await authHeaders(),
      });
      if (audience.total === 0) {
        setLevels((prev) => prev.filter((v) => v !== name));
      } else {
        setLevelDeleteAsk({ name, count: audience.total });
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `삭제 영향을 확인하지 못했습니다: ${err.message}`
          : "삭제 영향을 확인하지 못했습니다.",
      );
    } finally {
      setLevelChecking(null);
    }
  }

  function addDomain() {
    const value = normalizeEmailDomain(domainInput);
    if (!value) return;
    if (!EMAIL_DOMAIN_RE.test(value)) {
      toast.error("도메인 형식이 올바르지 않습니다. 예: seoyon.com");
      return;
    }
    if (domains.includes(value)) {
      toast.error("이미 있는 도메인입니다.");
      return;
    }
    setDomains((prev) => [...prev, value]);
    setDomainInput("");
  }

  /* ── 지금 이 값이면 몇 건이 그렇게 분류되는지 (P11) ── */
  const num = (key: OpsKey) => {
    const raw = Number(opsDraft[key]);
    return Number.isFinite(raw) ? raw : DEFAULT_OPS[key];
  };

  const opsImpact = useMemo(() => {
    if (!impact) return null;
    const countAtLeast = (list: number[], threshold: number) =>
      list.filter((v) => v >= threshold).length;
    const jobs = impact.jobResponseCounts;
    const ok = num("jobCountOk");
    const caution = num("jobCountCaution");
    const range = (list: number[], min: number, recMin: number, recMax: number) => ({
      total: list.length,
      blocked: list.filter((v) => v < min).length,
      warned: list.filter((v) => v >= min && (v < recMin || v > recMax)).length,
    });
    return {
      review: {
        total: impact.reviewWaits.length,
        hit: countAtLeast(impact.reviewWaits, num("reviewBacklogDays")),
      },
      reject: {
        total: impact.rejectIdleDays.length,
        hit: countAtLeast(impact.rejectIdleDays, num("rejectStaleDays")),
      },
      job: {
        total: jobs.length,
        ok: jobs.filter((v) => v >= ok).length,
        caution: jobs.filter((v) => v >= caution && v < ok).length,
        interview: jobs.filter((v) => v < caution).length,
      },
      task: range(
        impact.taskCounts,
        num("taskMin"),
        num("taskRecommendMin"),
        num("taskRecommendMax"),
      ),
      activity: range(
        impact.activityCounts,
        num("activityMin"),
        num("activityRecommendMin"),
        num("activityRecommendMax"),
      ),
      skill: range(
        impact.skillCounts,
        num("skillMin"),
        num("skillRecommendMin"),
        num("skillRecommendMax"),
      ),
      mail: {
        recipients: impact.mailRecipients,
        rounds: Math.max(1, Math.ceil(impact.mailRecipients / Math.max(1, num("mailBatchMax")))),
      },
    };
    // opsDraft 가 바뀔 때마다 다시 센다 — 숫자를 바꾸면 결과가 즉시 보여야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impact, opsDraft]);

  /** 계열사별: 지금 미진행 기준일이면 몇 명이 미진행으로 표시되는지. */
  function staleImpact(companyId: string, draftDays: string) {
    if (!impact) return null;
    const days = Number(draftDays);
    if (!Number.isInteger(days)) return null;
    const rows = impact.idleDays.filter((r) => r.companyId === companyId);
    if (rows.length === 0) return "이 계열사에는 아직 미완료 참여자가 없습니다.";
    const hit = rows.filter((r) => r.days === null || r.days >= days).length;
    return `지금 값(${days}일)이면 미완료 ${rows.length}명 중 ${hit}명이 미진행으로 표시됩니다.`;
  }

  /** 허용 도메인을 이 목록으로 두면 몇 명의 이메일이 목록 밖인지. */
  const domainOutside = useMemo(() => {
    if (!impact || domains.length === 0) return null;
    const allowed = new Set(domains);
    const total = impact.emailDomainCounts.reduce((sum, d) => sum + d.count, 0);
    const outside = impact.emailDomainCounts.filter((d) => !allowed.has(d.domain));
    return { total, count: outside.reduce((sum, d) => sum + d.count, 0), domains: outside };
  }, [impact, domains]);

  const opsSections: SectionDef[] = [
    { id: "ops-judge", label: "판정 기준" },
    { id: "ops-writing", label: "작성 분량 기준" },
    { id: "ops-usage", label: "화면·발송" },
    { id: "ops-status", label: "연결 상태" },
  ];
  const surveySections: SectionDef[] = (allCompanies ?? []).map((c) => ({
    id: `survey-${c.id}`,
    label: c.name,
  }));
  const securitySections: SectionDef[] = [
    { id: "sec-basis", label: "조사 구조" },
    { id: "sec-domain", label: "허용 도메인", count: domains.length },
    { id: "sec-list", label: "보안 장치" },
    { id: "sec-audit", label: "감사 기록" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">조사 설정</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          화면이 무엇을 '늦었다'·'모자라다'로 볼지, 초기 비밀번호와 계열사별 마감을 어떻게 둘지
          여기에서 정합니다. 여기 있는 값은 모두 운영 중에 바꿀 수 있습니다.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : (
        <Tabs defaultValue="ops">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="ops">운영 기본</TabsTrigger>
            <TabsTrigger value="password">초기 비밀번호</TabsTrigger>
            <TabsTrigger value="survey">계열사 운영</TabsTrigger>
            <TabsTrigger value="levels">역할단계</TabsTrigger>
            <TabsTrigger value="reminders">독려 규칙</TabsTrigger>
            <TabsTrigger value="backup">백업</TabsTrigger>
            <TabsTrigger value="security">보안</TabsTrigger>
          </TabsList>

          {/* 0. 운영 기본 — 화면 동작을 좌우하는 값 (기획 D5) */}
          <TabsContent value="ops" className="mt-4 space-y-5">
            <TabIntro>
              이 탭에서는 <strong>화면이 무엇을 문제로 볼지</strong>를 정합니다. 며칠이 지나야
              '늦었다'로 볼지, 몇 개를 적어야 '충분하다'로 볼지의 기준입니다. 값 아래에는 지금 이
              값이면 몇 건이 그렇게 분류되는지 함께 보여 줍니다.
            </TabIntro>

            {ops && !ops.stored && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  아직 저장된 값이 없어 아래 숫자는 <strong>기본값</strong>으로 동작 중입니다. 값을
                  바꿔 저장하면 그때부터 저장된 값이 쓰입니다.
                </span>
              </p>
            )}

            <SectionNav sections={opsSections} />

            <CollapsibleSection
              storageKey="settings"
              id="ops-judge"
              title="판정 기준"
              subtitle="며칠이 지나면 늦은 것으로 볼지, 응답 몇 건이면 믿을 만한 직무로 볼지"
            >
              <div className="space-y-5 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <OpsNumber
                    fieldKey="reviewBacklogDays"
                    value={opsDraft.reviewBacklogDays}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, reviewBacklogDays: v }))}
                    {...(opsImpact
                      ? {
                          impact: `검토 대기 ${opsImpact.review.total}건 중 ${opsImpact.review.hit}건이 적체로 표시됩니다.`,
                        }
                      : {})}
                  />
                  <OpsNumber
                    fieldKey="rejectStaleDays"
                    value={opsDraft.rejectStaleDays}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, rejectStaleDays: v }))}
                    {...(opsImpact
                      ? {
                          impact: `반려 후 손대지 않은 ${opsImpact.reject.total}건 중 ${opsImpact.reject.hit}건이 점검 목록에 오릅니다.`,
                        }
                      : {})}
                  />
                  <OpsNumber
                    fieldKey="jobCountOk"
                    value={opsDraft.jobCountOk}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, jobCountOk: v }))}
                  />
                  <OpsNumber
                    fieldKey="jobCountCaution"
                    value={opsDraft.jobCountCaution}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, jobCountCaution: v }))}
                  />
                </div>
                {opsImpact && (
                  <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
                    지금 값이면 직무 {opsImpact.job.total}개 중 —{" "}
                    <span className="font-semibold text-success">정상 {opsImpact.job.ok}</span> ·{" "}
                    <span className="font-semibold text-warning">
                      심층검토 {opsImpact.job.caution}
                    </span>{" "}
                    ·{" "}
                    <span className="font-semibold text-destructive">
                      인터뷰 필수 {opsImpact.job.interview}
                    </span>
                  </p>
                )}
                <SaveRow
                  status={saves["ops-judge"]}
                  onSave={() =>
                    submitOps(
                      "ops-judge",
                      ["reviewBacklogDays", "rejectStaleDays", "jobCountOk", "jobCountCaution"],
                      "판정 기준을 저장했습니다",
                    )
                  }
                />
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="ops-writing"
              title="작성 분량 기준"
              subtitle="참여자가 최소 몇 개를 적어야 제출할 수 있는지, 몇 개를 권장할지"
            >
              <div className="space-y-5 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                {(
                  [
                    {
                      title: "과업",
                      keys: ["taskMin", "taskRecommendMin", "taskRecommendMax"] as OpsKey[],
                      unitLabel: "응답",
                      stat: opsImpact?.task,
                    },
                    {
                      title: "세부 활동 (과업 1건당)",
                      keys: [
                        "activityMin",
                        "activityRecommendMin",
                        "activityRecommendMax",
                      ] as OpsKey[],
                      unitLabel: "과업",
                      stat: opsImpact?.activity,
                    },
                    {
                      title: "필요 역량",
                      keys: ["skillMin", "skillRecommendMin", "skillRecommendMax"] as OpsKey[],
                      unitLabel: "응답",
                      stat: opsImpact?.skill,
                    },
                  ] as const
                ).map((group) => (
                  <div key={group.title} className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-semibold">{group.title}</p>
                    <div className="grid gap-4 sm:grid-cols-3">
                      {group.keys.map((key) => (
                        <OpsNumber
                          key={key}
                          fieldKey={key}
                          value={opsDraft[key]}
                          onChange={(v) => setOpsDraft((prev) => ({ ...prev, [key]: v }))}
                        />
                      ))}
                    </div>
                    {group.stat && (
                      <p className="text-xs text-muted-foreground">
                        지금 값이면 제출 이후 {group.unitLabel} {group.stat.total}건 중{" "}
                        <span className="font-semibold text-destructive">
                          {group.stat.blocked}건이 제출 최소 미달
                        </span>
                        ,{" "}
                        <span className="font-semibold text-warning">
                          {group.stat.warned}건이 권장 범위 밖
                        </span>
                        입니다.
                      </p>
                    )}
                  </div>
                ))}
                <SaveRow
                  status={saves["ops-writing"]}
                  onSave={() =>
                    submitOps(
                      "ops-writing",
                      [
                        "taskMin",
                        "taskRecommendMin",
                        "taskRecommendMax",
                        "activityMin",
                        "activityRecommendMin",
                        "activityRecommendMax",
                        "skillMin",
                        "skillRecommendMin",
                        "skillRecommendMax",
                      ],
                      "작성 분량 기준을 저장했습니다",
                    )
                  }
                />
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="ops-usage"
              title="화면·발송"
              subtitle="참여자에게 예시를 몇 건 보여 줄지, 메일을 한 번에 몇 통까지 보낼지"
            >
              <div className="space-y-5 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <OpsNumber
                    fieldKey="exampleCount"
                    value={opsDraft.exampleCount}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, exampleCount: v }))}
                    impact={`참여자가 [예시 보기]를 누르면 ${num("exampleCount")}건이 보입니다.`}
                  />
                  <OpsNumber
                    fieldKey="mailBatchMax"
                    value={opsDraft.mailBatchMax}
                    onChange={(v) => setOpsDraft((prev) => ({ ...prev, mailBatchMax: v }))}
                    {...(opsImpact
                      ? {
                          impact: `메일을 받을 수 있는 참여자 ${opsImpact.mail.recipients}명 — 전원 발송 시 최대 ${opsImpact.mail.rounds}회로 나뉩니다.`,
                        }
                      : {})}
                  />
                </div>
                <SaveRow
                  status={saves["ops-usage"]}
                  onSave={() =>
                    submitOps(
                      "ops-usage",
                      ["exampleCount", "mailBatchMax"],
                      "화면·발송 값을 저장했습니다",
                    )
                  }
                />
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="ops-status"
              title="연결 상태"
              subtitle="메일과 AI 연결이 실제 운영용으로 준비되었는지 — 이 화면에서는 바꿀 수 없습니다"
            >
              <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                {status ? (
                  <ul className="space-y-2">
                    {status.items.map((item) => (
                      <li
                        key={item.key}
                        className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <span className="text-sm font-medium">{item.label}</span>
                        <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
                          <span
                            className={
                              item.warn
                                ? "inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-800 dark:bg-orange-950 dark:text-orange-200"
                                : "inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold"
                            }
                          >
                            {item.warn && <AlertTriangle className="size-3.5" />}
                            {item.value}
                          </span>
                          {item.note && (
                            <span className="text-xs text-muted-foreground sm:text-right">
                              {item.note}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">상태를 확인하는 중...</p>
                )}
              </div>
            </CollapsibleSection>
          </TabsContent>

          {/* 1. 초기 비밀번호 규칙 */}
          <TabsContent value="password" className="mt-4 space-y-4">
            <TabIntro>
              이 탭에서는 <strong>참여자에게 처음 나눠 줄 비밀번호를 어떤 규칙으로 만들지</strong>{" "}
              정합니다. 참여자는 첫 로그인 때 반드시 새 비밀번호로 바꿔야 합니다.
            </TabIntro>

            <CollapsibleSection
              storageKey="settings"
              id="password-rule"
              title="비밀번호 규칙"
              subtitle="자동 입력 항목을 눌러 조립하거나 직접 입력합니다 (8자 이상)"
            >
              <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <div className="flex flex-wrap gap-2">
                  {PASSWORD_TOKENS.map((t) => (
                    <Button
                      key={t.token}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRule((prev) => prev + t.token)}
                    >
                      <Plus className="size-3.5" />
                      {t.label}
                    </Button>
                  ))}
                </div>

                <Input
                  id="password-rule"
                  aria-label="비밀번호 규칙"
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  placeholder="{birth6}{empno_last4}"
                  className="font-mono"
                />
                {ruleError ? (
                  <p className="text-xs text-destructive">{ruleError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    사용 가능한 자동 입력 항목: {PASSWORD_TOKENS.map((t) => t.token).join(" ")} · 그
                    외 문자는 그대로 사용됩니다.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!!ruleError || preview.isPending}
                    onClick={() => preview.mutate(rule)}
                  >
                    <Eye className="size-4" />
                    샘플 미리보기
                  </Button>
                  <SaveRow
                    status={saves["password"]}
                    disabled={!!ruleError}
                    onSave={() =>
                      void runSave(
                        "password",
                        async () =>
                          updateSystemSettings({
                            data: { passwordRule: rule },
                            headers: await authHeaders(),
                          }),
                        "비밀번호 규칙을 저장했습니다",
                      )
                    }
                  />
                </div>

                {samples.length > 0 && (
                  <ul className="space-y-2">
                    {samples.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-3 rounded-lg border bg-secondary/50 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate">
                          {s.name}
                          <span className="ml-2 text-xs text-muted-foreground">{s.empNo}</span>
                        </span>
                        <span className="font-mono text-sm font-semibold">{s.password}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </CollapsibleSection>
          </TabsContent>

          {/* 2. 계열사별 마감일 + 독려 안내 */}
          <TabsContent value="survey" className="mt-4 space-y-5">
            <TabIntro>
              이 탭에서는 <strong>계열사마다 언제까지 받을지와 독려 안내를 언제 보낼지</strong>{" "}
              정합니다. 미진행 기준일은 진행 현황 화면에서 '움직이지 않는 사람'을 세는 기준입니다.
            </TabIntro>

            <SectionNav sections={surveySections} />

            {(allCompanies ?? []).map((c) => {
              const draft = drafts[c.id];
              if (!draft) return null;
              const inactive = c.status === "inactive";
              const impactLine = staleImpact(c.id, draft.staleDays);
              return (
                <div key={c.id} className={inactive ? "opacity-60" : undefined}>
                  <CollapsibleSection
                    storageKey="settings"
                    id={`survey-${c.id}`}
                    title={c.name}
                    subtitle={`계열사 코드 ${c.code}`}
                    aside={
                      <div className="flex shrink-0 items-center gap-2">
                        {inactive && (
                          <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                            중지됨
                          </span>
                        )}
                        <Label
                          htmlFor={`company-on-${c.id}`}
                          className="cursor-pointer text-xs text-muted-foreground"
                        >
                          {inactive ? "중지" : "운영 중"}
                        </Label>
                        <Switch
                          id={`company-on-${c.id}`}
                          aria-label={`${c.name} 운영 상태`}
                          checked={!inactive}
                          disabled={askPause.isPending || switchCompany.isPending}
                          onCheckedChange={(on) =>
                            on
                              ? switchCompany.mutate({ companyId: c.id, status: "active" })
                              : askPause.mutate({ id: c.id, name: c.name })
                          }
                        />
                      </div>
                    }
                  >
                    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                      <p className="text-xs text-muted-foreground">
                        차수를 만들면 차수의 마감·독려 일정이 우선하고, 이 값은 기본값으로만
                        쓰입니다.
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor={`deadline-${c.id}`}>제출 마감</Label>
                          <Input
                            id={`deadline-${c.id}`}
                            type="date"
                            value={draft.deadline}
                            onChange={(e) => updateDraft(c.id, { deadline: e.target.value })}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor={`days-${c.id}`}>독려 안내 일자 (D-N)</Label>
                          <Input
                            id={`days-${c.id}`}
                            value={draft.reminderDays}
                            onChange={(e) => updateDraft(c.id, { reminderDays: e.target.value })}
                            placeholder="7, 3, 1"
                            inputMode="numeric"
                          />
                          <p className="text-xs text-muted-foreground">
                            마감 며칠 전에 보낼지 쉼표로 구분해 입력합니다.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor={`target-${c.id}`}>발송 대상</Label>
                          <Select
                            value={draft.reminderTarget}
                            onValueChange={(v) =>
                              updateDraft(c.id, { reminderTarget: v as ReminderTarget })
                            }
                          >
                            <SelectTrigger id={`target-${c.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {REMINDER_TARGETS.map((t) => (
                                <SelectItem key={t} value={t}>
                                  {t} 대상
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            미진행 기준일 (일)
                            <FieldHint
                              term="미진행 기준일"
                              text="마지막 접속·안내 이후 이 일수가 지나도록 제출하지 않으면 진행 현황 화면에서 '미진행'으로 셉니다. 짧게 잡을수록 미진행 인원이 늘어납니다."
                            />
                          </span>
                          <Input
                            id={`stale-${c.id}`}
                            aria-label="미진행 기준일"
                            type="number"
                            min={1}
                            max={60}
                            value={draft.staleDays}
                            onChange={(e) => updateDraft(c.id, { staleDays: e.target.value })}
                            inputMode="numeric"
                          />
                          {impactLine && <p className="text-xs text-primary">{impactLine}</p>}
                        </div>

                        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                          <Label htmlFor={`auto-${c.id}`} className="cursor-pointer">
                            자동 발송
                          </Label>
                          <Switch
                            id={`auto-${c.id}`}
                            checked={draft.reminderAuto}
                            onCheckedChange={(v) => updateDraft(c.id, { reminderAuto: v })}
                          />
                        </div>
                      </div>

                      <SaveRow status={saves[`survey:${c.id}`]} onSave={() => submitSurvey(c.id)} />
                    </section>
                  </CollapsibleSection>
                </div>
              );
            })}

            {/* 끄기 전 확인 — 무엇이 숨겨지는지 수치로 먼저 보여 준다 (기획 11) */}
            <AlertDialog
              open={pausing !== null}
              onOpenChange={(open) => {
                if (!open) setPausing(null);
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>「{pausing?.name}」 운영을 중지할까요?</AlertDialogTitle>
                  <AlertDialogDescription>
                    참여자 {pausing?.participants ?? 0}명 · 진행 중 차수 {pausing?.activeWaves ?? 0}
                    건이 화면에서 숨겨지고, 소속 참여자는 로그인할 수 없게 됩니다. 데이터는 지워지지
                    않습니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={switchCompany.isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      if (pausing) {
                        switchCompany.mutate({ companyId: pausing.id, status: "inactive" });
                      }
                    }}
                  >
                    {switchCompany.isPending ? "중지하는 중..." : "운영 중지"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </TabsContent>

          {/* 3. 역할단계 명칭 세트 */}
          <TabsContent value="levels" className="mt-4 space-y-4">
            <TabIntro>
              이 탭에서는 <strong>참여자가 자기 역할단계를 고를 때 나오는 선택지</strong>를
              정합니다. 직급 체계와 별개로 실제 수행 범위를 나타내는 이름을 씁니다. 위에서 아래
              순서가 참여자 선택지와 비교 화면의 정렬 순서입니다.
            </TabIntro>

            <CollapsibleSection
              storageKey="settings"
              id="levels"
              title="역할단계 명칭"
              subtitle="참여자 직무 카드에서 사용합니다. 등록한 순서대로 표시됩니다"
              aside={
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold">
                  {levels.length}개
                </span>
              }
            >
              <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <div className="flex flex-col items-start gap-2">
                  {levels.map((lv, i) => (
                    <span
                      key={lv}
                      className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm"
                    >
                      <span className="tabular-nums text-xs text-muted-foreground">{i + 1}.</span>
                      {lv}
                      <button
                        type="button"
                        aria-label={`${lv} 위로`}
                        disabled={i === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        onClick={() => moveLevel(i, -1)}
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${lv} 아래로`}
                        disabled={i === levels.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        onClick={() => moveLevel(i, 1)}
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${lv} 삭제`}
                        disabled={levelChecking !== null}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                        onClick={() => void requestLevelDelete(lv)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                  {levels.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      역할단계를 1개 이상 추가해 주세요.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    id="level-input"
                    aria-label="역할단계 추가"
                    value={levelInput}
                    onChange={(e) => setLevelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLevel();
                      }
                    }}
                    placeholder="예: 책임"
                  />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {levels.length}/{MAX_ROLE_LEVELS}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={levels.length >= MAX_ROLE_LEVELS}
                    onClick={addLevel}
                  >
                    <Plus className="size-4" />
                    추가
                  </Button>
                </div>

                <SaveRow
                  status={saves["levels"]}
                  disabled={levels.length === 0}
                  onSave={() =>
                    void runSave(
                      "levels",
                      async () =>
                        updateSystemSettings({
                          data: { roleLevels: levels },
                          headers: await authHeaders(),
                        }),
                      "역할단계를 저장했습니다",
                    )
                  }
                />
              </section>
            </CollapsibleSection>

            {/* 삭제 가드 — 영향 인원이 있을 때만 뜨는 확인 다이얼로그 (W3) */}
            <AlertDialog
              open={levelDeleteAsk !== null}
              onOpenChange={(open) => {
                if (!open) setLevelDeleteAsk(null);
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    「{levelDeleteAsk?.name}」 역할단계를 삭제할까요?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    이 역할단계를 쓰는 참여자 {levelDeleteAsk?.count}명이 &lsquo;현행에 없는
                    값&rsquo; 신호로 잡히게 됩니다. 목록에서 뺀 뒤 저장 버튼을 눌러야 실제로
                    반영됩니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      const name = levelDeleteAsk?.name;
                      if (name) setLevels((prev) => prev.filter((v) => v !== name));
                      setLevelDeleteAsk(null);
                    }}
                  >
                    삭제
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </TabsContent>

          {/* 5. 독려 규칙 (기획 F4) */}
          <TabsContent value="reminders" className="mt-4">
            <ReminderRulesPanel />
          </TabsContent>

          {/* 6. 백업·되돌리기 (기획 F3) */}
          <TabsContent value="backup" className="mt-4">
            <BackupPanel />
          </TabsContent>

          {/* 7. 보안 — 조사 구조 고지 + 허용 도메인 + 장치 현황 + 감사 기록 */}
          <TabsContent value="security" className="mt-4 space-y-5">
            <TabIntro>
              이 탭에서는 <strong>누가 어떤 이메일로 참여할 수 있는지</strong>를 정하고,{" "}
              <strong>시스템에 적용된 보호 장치와 지금까지 누가 무엇을 바꿨는지</strong>를
              확인합니다.
            </TabIntro>

            <SectionNav sections={securitySections} />

            <CollapsibleSection
              storageKey="settings"
              id="sec-basis"
              title="이 조사는 실명 조사입니다"
              subtitle="응답이 작성자와 연결됩니다 — 익명 조사가 아닙니다"
            >
              <div className="space-y-2 rounded-xl border border-primary/30 bg-primary-soft/40 p-4 text-sm sm:p-6">
                <p>
                  제출한 응답은 <strong>작성한 참여자와 직접 연결</strong>됩니다. 검토자가 누구의
                  응답인지 보고 승인·반려하며, 반려 사유가 그 사람에게 전달되기 때문입니다.
                </p>
                <p className="text-muted-foreground">
                  대신 관리자의 정정 이력은 참여자에게 보이지 않고, AI 에 보내는 내용에는 이름·사번·
                  이메일이 들어가지 않으며, 내보내기 파일은 익명화 옵션으로 개인정보를 뺄 수
                  있습니다. 익명 조사로 바꾸려면 검토·반려 흐름부터 다시 설계해야 합니다.
                </p>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="sec-domain"
              title="허용 이메일 도메인"
              subtitle="명부를 올릴 때 이 목록에 없는 도메인의 이메일은 오류로 표시됩니다"
            >
              <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <div className="flex flex-wrap gap-2">
                  {domains.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm"
                    >
                      @{d}
                      <button
                        type="button"
                        aria-label={`${d} 삭제`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDomains((prev) => prev.filter((v) => v !== d))}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                  {domains.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      등록된 도메인이 없습니다 — 현재 모든 도메인을 허용합니다.
                    </p>
                  )}
                </div>

                <div className="flex gap-2">
                  <Input
                    id="domain-input"
                    aria-label="허용 도메인 추가"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDomain();
                      }
                    }}
                    placeholder="예: seoyon.com"
                    inputMode="email"
                  />
                  <Button type="button" variant="outline" onClick={addDomain}>
                    <Plus className="size-4" />
                    추가
                  </Button>
                </div>

                {/* 저장 전에 영향부터 알린다 — 좁히면 다음 명부 업로드에서 오류가 난다. */}
                {domainOutside && (
                  <div
                    className={
                      domainOutside.count > 0
                        ? "space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs"
                        : "rounded-lg border bg-secondary/50 p-3 text-xs text-muted-foreground"
                    }
                  >
                    {domainOutside.count > 0 ? (
                      <>
                        <p className="flex items-start gap-1.5 font-medium text-warning">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          지금 목록으로 저장하면 이메일이 등록된 참여자 {domainOutside.total}명 중{" "}
                          {domainOutside.count}명의 도메인이 목록 밖입니다. 이미 만들어진 계정은
                          그대로 쓸 수 있지만, 다음에 명부를 올릴 때 이 사람들이 오류로 표시됩니다.
                        </p>
                        <p className="text-muted-foreground">
                          목록 밖 도메인:{" "}
                          {domainOutside.domains
                            .slice(0, 8)
                            .map((d) => `@${d.domain}(${d.count}명)`)
                            .join(", ")}
                          {domainOutside.domains.length > 8
                            ? ` 외 ${domainOutside.domains.length - 8}종`
                            : ""}
                        </p>
                      </>
                    ) : (
                      <p>
                        지금 목록이면 이메일이 등록된 참여자 {domainOutside.total}명 전원이 허용
                        범위 안에 있습니다.
                      </p>
                    )}
                  </div>
                )}

                <SaveRow
                  status={saves["domains"]}
                  onSave={() =>
                    void runSave(
                      "domains",
                      async () =>
                        updateSystemSettings({
                          data: { allowedEmailDomains: domains },
                          headers: await authHeaders(),
                        }),
                      "허용 도메인을 저장했습니다",
                    )
                  }
                />
              </section>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="sec-list"
              title="보안 장치 현황"
              subtitle="서버와 데이터베이스 수준에서 동작합니다 — 여기에서 켜고 끌 수 없습니다"
              defaultCollapsed
            >
              <ul className="space-y-2 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                {SECURITY_ROWS.map((row) => (
                  <li key={row.title} className="rounded-lg border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{row.title}</span>
                      <span
                        className={
                          row.state === "적용"
                            ? "inline-flex shrink-0 items-center rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-success"
                            : "inline-flex shrink-0 items-center rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground"
                        }
                      >
                        {row.state}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{row.desc}</p>
                  </li>
                ))}
              </ul>
            </CollapsibleSection>

            <CollapsibleSection
              storageKey="settings"
              id="sec-audit"
              title="감사 기록"
              subtitle="누가 언제 무엇을 바꿨는지 — 최근 50건"
              aside={
                <Select value={auditAction} onValueChange={setAuditAction}>
                  <SelectTrigger className="w-[200px]" aria-label="행위 종류 고르기">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">전체 행위</SelectItem>
                    {(audit?.actions ?? []).map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            >
              <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                {audit && audit.rows.length === 0 ? (
                  <EmptyState
                    kind="nothing"
                    title="해당하는 기록이 없습니다"
                    description="다른 행위 종류를 고르거나 전체 행위로 돌려 보세요."
                    actionLabel="전체 행위 보기"
                    onAction={() => setAuditAction("all")}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">시각</th>
                          <th className="py-2 pr-3 font-medium">행위자</th>
                          <th className="py-2 pr-3 font-medium">한 일</th>
                          <th className="py-2 font-medium">대상</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(audit?.rows ?? []).map((row) => (
                          <tr key={row.id} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-3 tabular-nums text-xs text-muted-foreground">
                              {new Date(row.at).toLocaleString("ko-KR", {
                                dateStyle: "short",
                                timeStyle: "short",
                              })}
                            </td>
                            <td className="py-2 pr-3 text-xs">{row.actor}</td>
                            <td className="py-2 pr-3">{row.action}</td>
                            <td className="py-2 text-xs text-muted-foreground">
                              <span className="block">{row.target || "—"}</span>
                              <span className="block max-w-[280px] truncate" title={row.detail}>
                                {row.detail === "{}" ? "" : row.detail}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 화면은 최근 50건만 — 전체가 필요하면 파일로 (기획 9 후속) */}
                <div className="mt-4 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={downloadAudit.isPending}
                    onClick={() => downloadAudit.mutate()}
                  >
                    <Download className="size-4" />
                    {downloadAudit.isPending ? "만드는 중..." : "감사기록 내려받기 (CSV)"}
                  </Button>
                </div>
              </div>
            </CollapsibleSection>

            {/* 지금 보고 있는 화면이 어느 판인지 (기획 2 — 구 상단 표시줄에서 이동) */}
            <p className="text-right text-xs text-muted-foreground">{buildLine()}</p>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
