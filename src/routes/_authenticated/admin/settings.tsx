import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Plus, Save, X } from "lucide-react";
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
  REMINDER_TARGETS,
  getSettings,
  previewPasswordRule,
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

type SurveyDraft = {
  deadline: string;
  reminderDays: string;
  reminderTarget: ReminderTarget;
  reminderAuto: boolean;
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

  const [rule, setRule] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [levelInput, setLevelInput] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SurveyDraft>>({});
  const [samples, setSamples] = useState<
    { id: string; name: string; empNo: string; password: string }[]
  >([]);

  useEffect(() => {
    if (!data) return;
    setRule(data.passwordRule);
    setLevels(data.roleLevels);
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
            },
          ];
        }),
      ),
    );
  }, [data]);

  const ruleError = rule ? validatePasswordRule(rule) : null;

  const saveSystem = useMutation({
    mutationFn: async (payload: { passwordRule?: string; roleLevels?: string[] }) =>
      updateSystemSettings({ data: payload, headers: await authHeaders() }),
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
    saveSurvey.mutate({
      companyId,
      deadline: draft.deadline || null,
      reminderDays: days,
      reminderTarget: draft.reminderTarget,
      reminderAuto: draft.reminderAuto,
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
        <Tabs defaultValue="password">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="password">초기 비밀번호</TabsTrigger>
            <TabsTrigger value="survey">계열사 운영</TabsTrigger>
            <TabsTrigger value="levels">역할단계</TabsTrigger>
          </TabsList>

          {/* 1. 초기 비밀번호 규칙 */}
          <TabsContent value="password" className="mt-4 space-y-4">
            <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
              <div>
                <Label htmlFor="password-rule">비밀번호 규칙</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  토큰을 눌러 규칙을 조립하거나 직접 입력할 수 있습니다. 생성되는 비밀번호는 8자
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
                  사용 가능한 토큰: {PASSWORD_TOKENS.map((t) => t.token).join(" ")} · 그 외 문자는
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

                    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:mt-6">
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
        </Tabs>
      )}
    </div>
  );
}
