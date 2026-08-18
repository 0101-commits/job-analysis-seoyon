import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Eye, Plus, Save, X } from "lucide-react";
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
import { PASSWORD_TOKENS, validatePasswordRule } from "@/lib/password-rule";
import {
  EMAIL_DOMAIN_RE,
  REMINDER_TARGETS,
  getSettings,
  normalizeEmailDomain,
  previewPasswordRule,
  systemStatus,
  updateSystemSettings,
  upsertSurveySetting,
} from "@/lib/settings.functions";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  head: () => ({
    meta: [
      { title: "설정 | 서연 그룹 업무조사" },
      { name: "description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
      { property: "og:title", content: "설정 | 서연 그룹 업무조사" },
      { property: "og:description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
    ],
  }),
  component: SettingsPage,
});

type ReminderTarget = (typeof REMINDER_TARGETS)[number];

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

  const [rule, setRule] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [levelInput, setLevelInput] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SurveyDraft>>({});
  const [samples, setSamples] = useState<
    { id: string; name: string; empNo: string; password: string }[]
  >([]);

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
              reminderTarget: (s?.reminder_target === "미접속" ? "미접속" : "미제출") as ReminderTarget,
              reminderAuto: s?.reminder_auto ?? false,
              staleDays: String(s?.stale_days ?? 7),
            },
          ];
        }),
      ),
    );
  }, [data]);

  const ruleError = rule ? validatePasswordRule(rule) : null;

  const saveSystem = useMutation({
    mutationFn: async (payload: {
      passwordRule?: string;
      roleLevels?: string[];
      allowedEmailDomains?: string[];
    }) => updateSystemSettings({ data: payload, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("저장되었습니다.");
      void queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const saveSurvey = useMutation({
    mutationFn: async (payload: {
      companyId: string;
      deadline: string | null;
      reminderDays: number[];
      reminderTarget: ReminderTarget;
      reminderAuto: boolean;
      staleDays: number;
    }) => upsertSurveySetting({ data: payload, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("계열사 설정이 저장되었습니다.");
      void queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const preview = useMutation({
    mutationFn: async (value: string) =>
      previewPasswordRule({ data: { rule: value }, headers: await authHeaders() }),
    onSuccess: (res) => {
      setSamples(res.samples);
      if (res.samples.length === 0) toast.info("미리보기에 사용할 참여자가 없습니다.");
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
      toast.error("리마인더 일자는 0~60 사이 숫자를 쉼표로 구분해 입력해 주세요.");
      return;
    }
    const staleDays = Number(draft.staleDays);
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 60) {
      toast.error("미진행 기준일은 1~60 사이 숫자로 입력해 주세요.");
      return;
    }
    saveSurvey.mutate({
      companyId,
      deadline: draft.deadline || null,
      reminderDays: days,
      reminderTarget: draft.reminderTarget,
      reminderAuto: draft.reminderAuto,
      staleDays,
    });
  }

  function addLevel() {
    const value = levelInput.trim();
    if (!value) return;
    if (levels.includes(value)) {
      toast.error("이미 있는 역할단계입니다.");
      return;
    }
    setLevels((prev) => [...prev, value]);
    setLevelInput("");
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">설정</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          초기 비밀번호 규칙, 계열사별 마감일과 리마인더, 역할단계를 관리합니다.
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
            <TabsTrigger value="security">보안</TabsTrigger>
          </TabsList>

          {/* 0. 운영 기본 — 허용 도메인 + 연결 상태 */}
          <TabsContent value="ops" className="mt-4 space-y-4">
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <Label htmlFor="domain-input">허용 이메일 도메인</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  명부를 올릴 때 이 목록에 없는 도메인의 이메일은 오류로 표시됩니다. 비워 두면 모든
                  도메인을 허용합니다.
                </p>
              </div>

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

              <Button
                type="button"
                disabled={saveSystem.isPending}
                onClick={() => saveSystem.mutate({ allowedEmailDomains: domains })}
              >
                <Save className="size-4" />
                저장
              </Button>
            </section>

            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <h2 className="font-semibold">연결 상태</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  메일과 AI 연결이 실제 운영용으로 준비되었는지 보여줍니다. 이 화면에서는 바꿀 수
                  없고, 서버 배포 설정에서 조정합니다.
                </p>
              </div>

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
            </section>
          </TabsContent>

          {/* 1. 초기 비밀번호 규칙 */}
          <TabsContent value="password" className="mt-4 space-y-4">
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <Label htmlFor="password-rule">비밀번호 규칙</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  자동 입력 항목을 눌러 규칙을 조립하거나 직접 입력할 수 있습니다. 생성되는 비밀번호는 8자
                  이상이어야 합니다.
                </p>
              </div>

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
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                placeholder="{birth6}{empno_last4}"
                className="font-mono"
              />
              {ruleError ? (
                <p className="text-xs text-destructive">{ruleError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  사용 가능한 자동 입력 항목: {PASSWORD_TOKENS.map((t) => t.token).join(" ")} · 그 외 문자는
                  그대로 사용됩니다.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!!ruleError || preview.isPending}
                  onClick={() => preview.mutate(rule)}
                >
                  <Eye className="size-4" />
                  샘플 미리보기
                </Button>
                <Button
                  type="button"
                  disabled={!!ruleError || saveSystem.isPending}
                  onClick={() => saveSystem.mutate({ passwordRule: rule })}
                >
                  <Save className="size-4" />
                  저장
                </Button>
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
          </TabsContent>

          {/* 2. 계열사별 마감일 + 리마인더 */}
          <TabsContent value="survey" className="mt-4 space-y-4">
            {data?.companies.map((c) => {
              const draft = drafts[c.id];
              if (!draft) return null;
              return (
                <section key={c.id} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-semibold">{c.name}</h2>
                    <span className="text-xs text-muted-foreground">{c.code}</span>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`deadline-${c.id}`}>마감일</Label>
                      <Input
                        id={`deadline-${c.id}`}
                        type="date"
                        value={draft.deadline}
                        onChange={(e) => updateDraft(c.id, { deadline: e.target.value })}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`days-${c.id}`}>리마인더 일자 (D-N)</Label>
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
                      <Label htmlFor={`stale-${c.id}`}>미진행 기준일 (일)</Label>
                      <Input
                        id={`stale-${c.id}`}
                        type="number"
                        min={1}
                        max={60}
                        value={draft.staleDays}
                        onChange={(e) => updateDraft(c.id, { staleDays: e.target.value })}
                        inputMode="numeric"
                      />
                      <p className="text-xs text-muted-foreground">
                        마지막 저장 이후 이 일수가 지나면 &lsquo;미진행&rsquo;으로 봅니다.
                      </p>
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

                  <Button
                    type="button"
                    disabled={saveSurvey.isPending}
                    onClick={() => submitSurvey(c.id)}
                  >
                    <Save className="size-4" />
                    저장
                  </Button>
                </section>
              );
            })}
          </TabsContent>

          {/* 3. 역할단계 명칭 세트 */}
          <TabsContent value="levels" className="mt-4 space-y-4">
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <Label htmlFor="level-input">역할단계 명칭</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  참여자 직무 카드에서 사용하는 역할단계 목록입니다. 순서대로 표시됩니다.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {levels.map((lv) => (
                  <span
                    key={lv}
                    className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm"
                  >
                    {lv}
                    <button
                      type="button"
                      aria-label={`${lv} 삭제`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setLevels((prev) => prev.filter((v) => v !== lv))}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))}
                {levels.length === 0 && (
                  <p className="text-sm text-muted-foreground">역할단계를 1개 이상 추가해 주세요.</p>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  id="level-input"
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
                <Button type="button" variant="outline" onClick={addLevel}>
                  <Plus className="size-4" />
                  추가
                </Button>
              </div>

              <Button
                type="button"
                disabled={levels.length === 0 || saveSystem.isPending}
                onClick={() => saveSystem.mutate({ roleLevels: levels })}
              >
                <Save className="size-4" />
                저장
              </Button>
            </section>
          </TabsContent>

          {/* 4. 보안 현황 — 읽기 전용(고객 질의 대응용) */}
          <TabsContent value="security" className="mt-4 space-y-4">
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <h2 className="font-semibold">보안 장치 현황</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  현재 시스템에 적용된 보안 장치 현황입니다. 이 화면은 확인용이며, 각 항목은 서버와
                  데이터베이스 수준에서 동작하므로 여기에서 켜고 끌 수 없습니다.
                </p>
              </div>

              <ul className="space-y-2">
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
            </section>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
