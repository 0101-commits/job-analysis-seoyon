// 설정 화면의 운영 자동화 두 묶음 (기획 F3·F4).
//
// - BackupPanel         백업 목록 + 지금 백업 + 되돌리기(차이 확인 후 반영)
// - ReminderRulesPanel  독려 규칙 추가·수정·삭제 + 대상 미리보기 + 지금 실행
//
// 설정 화면(settings.tsx)이 길어 탭 본문만 여기로 뺐다. 저장 결과는 전역 알림이 아니라
// 누른 자리에 남긴다(설정 화면의 SaveRow 와 같은 원칙).
// (v4: 정기 실행 현황·진행 리포트 화면(F2·F5)은 기획 13에 따라 내렸다.)

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Play, Plus, Save, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { EmptyState } from "@/components/EmptyState";
import { CollapsibleSection } from "@/components/SectionNav";
import {
  applyBackupRestore,
  createBackupNow,
  deleteReminderRule,
  getAutomationStatus,
  getReminderRules,
  listBackupFiles,
  previewBackupRestore,
  runReminderRuleNow,
  saveReminderRule,
  updateAutomationSettings,
} from "@/lib/settings.functions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.";
}

function when(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function fileSize(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 탭 맨 위 한 줄 설명. */
function Intro({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-secondary/40 p-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** 눌린 자리에 남기는 결과 한 줄. */
type Feedback = { tone: "ok" | "error"; text: string };

function FeedbackLine({ value }: { value?: Feedback | undefined }) {
  if (!value) return null;
  if (value.tone === "ok") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-success"
        role="status"
      >
        <Check className="size-3.5" aria-hidden />
        {value.text}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-start gap-1.5 text-xs font-medium text-destructive"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{value.text}</span>
    </span>
  );
}

/* ─────────────────── F3 백업 ─────────────────── */

type RestorePreview = Awaited<ReturnType<typeof previewBackupRestore>>;

export function BackupPanel() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [retention, setRetention] = useState("30");
  const [pending, setPending] = useState<{ id: string; preview: RestorePreview } | null>(null);

  const { data: status } = useQuery({
    queryKey: ["admin-automation"],
    queryFn: async () => getAutomationStatus({ headers: await authHeaders() }),
  });
  const { data, isLoading } = useQuery({
    queryKey: ["admin-backups"],
    queryFn: async () => listBackupFiles({ headers: await authHeaders() }),
  });

  useEffect(() => {
    if (status) setRetention(String(status.retentionDays));
  }, [status]);

  const backupNow = useMutation({
    mutationFn: async () => createBackupNow({ data: {}, headers: await authHeaders() }),
    onSuccess: (res) => {
      setFeedback((prev) => ({
        ...prev,
        create: { tone: "ok", text: `백업했습니다 — ${res.totalRows}건` },
      }));
      void queryClient.invalidateQueries({ queryKey: ["admin-backups"] });
    },
    onError: (err) =>
      setFeedback((prev) => ({ ...prev, create: { tone: "error", text: errorMessage(err) } })),
  });

  const saveRetention = useMutation({
    mutationFn: async () =>
      updateAutomationSettings({
        data: { backupRetentionDays: Number(retention) },
        headers: await authHeaders(),
      }),
    onSuccess: () => {
      setFeedback((prev) => ({ ...prev, retention: { tone: "ok", text: "저장했습니다" } }));
      void queryClient.invalidateQueries({ queryKey: ["admin-automation"] });
    },
    onError: (err) =>
      setFeedback((prev) => ({ ...prev, retention: { tone: "error", text: errorMessage(err) } })),
  });

  const preview = useMutation({
    mutationFn: async (id: string) =>
      previewBackupRestore({ data: { id }, headers: await authHeaders() }),
    onSuccess: (res, id) => setPending({ id, preview: res }),
    onError: (err) =>
      setFeedback((prev) => ({ ...prev, restore: { tone: "error", text: errorMessage(err) } })),
  });

  const apply = useMutation({
    mutationFn: async (id: string) =>
      applyBackupRestore({ data: { id }, headers: await authHeaders() }),
    onSuccess: (res) => {
      setPending(null);
      const total = res.diffs.reduce((sum, d) => sum + d.restored + d.removed + d.changed, 0);
      setFeedback((prev) => ({
        ...prev,
        restore: {
          tone: "ok",
          text: `되돌렸습니다 — ${total}건 반영. 되돌리기 직전 상태도 백업으로 남겼습니다.`,
        },
      }));
      void queryClient.invalidateQueries({ queryKey: ["admin-backups"] });
    },
    onError: (err) => {
      setPending(null);
      setFeedback((prev) => ({ ...prev, restore: { tone: "error", text: errorMessage(err) } }));
    },
  });

  const changed = pending
    ? pending.preview.diffs.reduce((sum, d) => sum + d.restored + d.removed + d.changed, 0)
    : 0;

  return (
    <div className="space-y-5">
      <Intro>
        이 탭에서는{" "}
        <strong>응답과 설정 전체를 파일로 남기고, 필요하면 그 시점으로 되돌립니다.</strong> 자동
        백업은 매일 돌고, 보존 기간이 지난 파일은 자동으로 지워집니다. 되돌리기는 반영 전에 무엇이
        달라지는지 먼저 보여 줍니다.
      </Intro>

      <CollapsibleSection
        storageKey="settings"
        id="backup-list"
        title="백업 목록"
        subtitle="최근 50건 — 되돌리기는 응답 관련 자료에만 적용됩니다"
        aside={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={backupNow.isPending}
            onClick={() => backupNow.mutate()}
          >
            {backupNow.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            지금 백업
          </Button>
        }
      >
        <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
          <FeedbackLine value={feedback["create"]} />
          <FeedbackLine value={feedback["restore"]} />

          {isLoading ? (
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          ) : (data?.rows ?? []).length === 0 ? (
            <EmptyState
              kind="nothing"
              title="백업이 아직 없습니다"
              description="[지금 백업]을 누르면 현재 상태를 파일로 남깁니다. 자동 백업은 매일 정해진 시각에 돕니다."
              actionLabel="지금 백업"
              onAction={() => backupNow.mutate()}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">시각</th>
                    <th className="py-2 pr-3 font-medium">종류</th>
                    <th className="py-2 pr-3 font-medium">담긴 건수</th>
                    <th className="py-2 pr-3 font-medium">용량</th>
                    <th className="py-2 pr-3 font-medium">메모</th>
                    <th className="py-2 font-medium">되돌리기</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rows ?? []).map((row) => (
                    <tr key={row.id} className="border-b align-top last:border-0">
                      <td className="py-2 pr-3 tabular-nums text-xs">{when(row.created_at)}</td>
                      <td className="py-2 pr-3">
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold">
                          {row.kind}
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{row.totalRows}건</td>
                      <td className="py-2 pr-3 tabular-nums text-xs">{fileSize(row.size_bytes)}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{row.note ?? ""}</td>
                      <td className="py-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={preview.isPending}
                          onClick={() => preview.mutate(row.id)}
                        >
                          {preview.isPending && preview.variables === row.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          되돌리기
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="settings"
        id="backup-retention"
        title="보존 기간"
        subtitle="이 기간이 지난 백업은 자동으로 파일과 목록에서 함께 지워집니다"
      >
        <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
          <div className="flex items-center gap-2">
            <Input
              id="backup-retention-days"
              aria-label="보존 기간"
              type="number"
              min={7}
              max={365}
              inputMode="numeric"
              className="w-24 tabular-nums"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">일</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={saveRetention.isPending}
              onClick={() => saveRetention.mutate()}
            >
              <Save className="size-4" />
              {saveRetention.isPending ? "저장 중..." : "저장"}
            </Button>
            <FeedbackLine value={feedback["retention"]} />
          </div>
        </section>
      </CollapsibleSection>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>이 시점으로 되돌릴까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? changed === 0
                  ? "지금 상태와 다른 점이 없습니다. 되돌려도 바뀌는 것이 없습니다."
                  : `${when(pending.preview.createdAt)} 상태로 되돌립니다. 참여자 계정·조직도·설정은 그대로 두고, 아래 응답 자료만 바뀝니다.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pending && changed > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">자료</th>
                    <th className="py-1.5 pr-3 font-medium">다시 살아남</th>
                    <th className="py-1.5 pr-3 font-medium">사라짐</th>
                    <th className="py-1.5 font-medium">내용 달라짐</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.preview.diffs.map((d) => (
                    <tr key={d.table} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">{d.label}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{d.restored}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-destructive">{d.removed}</td>
                      <td className="py-1.5 tabular-nums">{d.changed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={apply.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pending) apply.mutate(pending.id);
              }}
            >
              {apply.isPending ? "반영 중..." : "되돌리기 실행"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ─────────────────── F4 독려 규칙 ─────────────────── */

type RuleDraft = {
  name: string;
  trigger: string;
  days: string;
  companyId: string;
  templateId: string;
  enabled: boolean;
  dailyCap: string;
};

const NEW_RULE = "new";
const ALL_COMPANIES = "all";
const NO_TEMPLATE = "none";

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  trigger: "미로그인",
  days: "3",
  companyId: ALL_COMPANIES,
  templateId: NO_TEMPLATE,
  enabled: false,
  dailyCap: "200",
};

export function ReminderRulesPanel() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-reminder-rules"],
    queryFn: async () => getReminderRules({ headers: await authHeaders() }),
  });

  useEffect(() => {
    if (!data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const rule of data.rules) {
        next[rule.id] = {
          name: rule.name,
          trigger: rule.trigger,
          days: String(rule.days),
          companyId: rule.companyId ?? ALL_COMPANIES,
          templateId: rule.templateId ?? NO_TEMPLATE,
          enabled: rule.enabled,
          dailyCap: String(rule.dailyCap),
        };
      }
      return next;
    });
  }, [data]);

  const save = useMutation({
    mutationFn: async (key: string) => {
      const draft = drafts[key] ?? EMPTY_DRAFT;
      const days = Number(draft.days);
      const cap = Number(draft.dailyCap);
      if (!draft.name.trim()) throw new Error("규칙 이름을 입력해 주세요.");
      if (!Number.isInteger(days) || days < 1 || days > 60) {
        throw new Error("기준 일수는 1~60 사이 숫자로 입력해 주세요.");
      }
      if (!Number.isInteger(cap) || cap < 1 || cap > 2000) {
        throw new Error("하루 최대 발송은 1~2000 사이 숫자로 입력해 주세요.");
      }
      return saveReminderRule({
        data: {
          ...(key === NEW_RULE ? {} : { id: key }),
          name: draft.name.trim(),
          trigger: draft.trigger as "미로그인" | "작성정체" | "반려미수정" | "마감임박",
          days,
          companyId: draft.companyId === ALL_COMPANIES ? null : draft.companyId,
          templateId: draft.templateId === NO_TEMPLATE ? null : draft.templateId,
          enabled: draft.enabled,
          dailyCap: cap,
        },
        headers: await authHeaders(),
      });
    },
    onSuccess: (_res, key) => {
      setFeedback((prev) => ({ ...prev, [key]: { tone: "ok", text: "저장했습니다" } }));
      if (key === NEW_RULE) {
        setAdding(false);
        setDrafts((prev) => ({ ...prev, [NEW_RULE]: EMPTY_DRAFT }));
      }
      void queryClient.invalidateQueries({ queryKey: ["admin-reminder-rules"] });
    },
    onError: (err, key) =>
      setFeedback((prev) => ({ ...prev, [key]: { tone: "error", text: errorMessage(err) } })),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      deleteReminderRule({ data: { id }, headers: await authHeaders() }),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-reminder-rules"] });
    },
    onError: (err, id) => {
      setRemoving(null);
      setFeedback((prev) => ({ ...prev, [id]: { tone: "error", text: errorMessage(err) } }));
    },
  });

  const runRule = useMutation({
    mutationFn: async (id: string) =>
      runReminderRuleNow({ data: { id }, headers: await authHeaders() }),
    onSuccess: (res, id) => {
      const parts = [
        res.status,
        `발송 ${res.sent}명`,
        res.skipped > 0 ? `남긴 대상 ${res.skipped}명` : null,
        res.reason,
        res.error,
      ].filter(Boolean);
      setFeedback((prev) => ({
        ...prev,
        [id]: { tone: res.error ? "error" : "ok", text: parts.join(" · ") },
      }));
      void queryClient.invalidateQueries({ queryKey: ["admin-reminder-rules"] });
    },
    onError: (err, id) =>
      setFeedback((prev) => ({ ...prev, [id]: { tone: "error", text: errorMessage(err) } })),
  });

  function patch(key: string, value: Partial<RuleDraft>) {
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_DRAFT), ...value } }));
  }

  function ruleForm(key: string, rule?: NonNullable<typeof data>["rules"][number]) {
    const draft = drafts[key] ?? EMPTY_DRAFT;
    const triggerDesc = (data?.triggers ?? []).find((t) => t.value === draft.trigger)?.desc;
    return (
      <section key={key} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`rule-name-${key}`}>규칙 이름</Label>
            <Input
              id={`rule-name-${key}`}
              value={draft.name}
              onChange={(e) => patch(key, { name: e.target.value })}
              placeholder="예: 미접속 3일 독려"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-trigger-${key}`}>보낼 대상</Label>
            <Select value={draft.trigger} onValueChange={(v) => patch(key, { trigger: v })}>
              <SelectTrigger id={`rule-trigger-${key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(data?.triggers ?? []).map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {triggerDesc ? <p className="text-xs text-muted-foreground">{triggerDesc}</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-days-${key}`}>
              {draft.trigger === "마감임박" ? "마감 며칠 전" : "며칠 지나면"}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`rule-days-${key}`}
                type="number"
                min={1}
                max={60}
                inputMode="numeric"
                className="w-24 tabular-nums"
                value={draft.days}
                onChange={(e) => patch(key, { days: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">일</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-company-${key}`}>적용 계열사</Label>
            <Select value={draft.companyId} onValueChange={(v) => patch(key, { companyId: v })}>
              <SelectTrigger id={`rule-company-${key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_COMPANIES}>전체 계열사</SelectItem>
                {(data?.companies ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-template-${key}`}>보낼 안내 문구</Label>
            <Select value={draft.templateId} onValueChange={(v) => patch(key, { templateId: v })}>
              <SelectTrigger id={`rule-template-${key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE}>고르지 않음</SelectItem>
                {(data?.templates ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draft.templateId === NO_TEMPLATE ? (
              <p className="text-xs text-warning">
                문구를 고르지 않으면 이 규칙은 실행되지 않고 건너뜁니다.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-cap-${key}`}>하루 최대 발송</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`rule-cap-${key}`}
                type="number"
                min={1}
                max={2000}
                inputMode="numeric"
                className="w-28 tabular-nums"
                value={draft.dailyCap}
                onChange={(e) => patch(key, { dailyCap: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">통</span>
            </div>
            <p className="text-xs text-muted-foreground">
              넘는 대상은 버리지 않고 다음 실행으로 넘깁니다.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor={`rule-enabled-${key}`} className="cursor-pointer">
              자동 발송 사용
            </Label>
            <Switch
              id={`rule-enabled-${key}`}
              checked={draft.enabled}
              onCheckedChange={(v) => patch(key, { enabled: v })}
            />
          </div>
        </div>

        {rule ? (
          <div className="space-y-1 rounded-lg bg-secondary/60 p-3 text-xs">
            <p>
              지금 이 규칙을 돌리면 <strong className="tabular-nums">{rule.targetCount}명</strong>이
              대상입니다.
              {rule.targetNote ? ` ${rule.targetNote}` : ""}
            </p>
            <p className="text-muted-foreground">
              {rule.lastRun
                ? `마지막 실행 ${when(rule.lastRun.at)} — 발송 ${rule.lastRun.sent ?? 0}명${
                    rule.lastRun.skipped ? `, 남긴 대상 ${rule.lastRun.skipped}명` : ""
                  }`
                : "실행 기록 없음 — 이 규칙은 아직 한 번도 돌지 않았습니다."}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate(key)}>
            <Save className="size-4" />
            {save.isPending && save.variables === key ? "저장 중..." : "저장"}
          </Button>
          {rule ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={runRule.isPending}
                onClick={() => runRule.mutate(rule.id)}
              >
                {runRule.isPending && runRule.variables === rule.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                지금 실행
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setRemoving({ id: rule.id, name: rule.name })}
              >
                <Trash2 className="size-4" />
                삭제
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              취소
            </Button>
          )}
          <FeedbackLine value={feedback[key]} />
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <Intro>
        이 탭에서는 <strong>어떤 상태로 며칠 멈춰 있으면 누구에게 무엇을 보낼지</strong> 규칙으로
        정합니다. 규칙은 <strong>하루에 한 번</strong>만 돌고, 같은 사람에게 같은 날 두 번 가지
        않습니다.
      </Intro>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : (data?.rules ?? []).length === 0 && !adding ? (
        <EmptyState
          kind="nothing"
          title="독려 규칙이 없습니다"
          description="예: 안내를 받고 3일이 지나도 접속하지 않은 참여자에게 독려 안내를 보내는 규칙을 만들 수 있습니다."
          actionLabel="규칙 추가"
          onAction={() => setAdding(true)}
        />
      ) : (
        <>
          {(data?.rules ?? []).map((rule) => ruleForm(rule.id, rule))}
          {adding ? ruleForm(NEW_RULE) : null}
          {!adding && (
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              규칙 추가
            </Button>
          )}
        </>
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>규칙을 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              「{removing?.name}」 규칙과 그 실행 기록이 함께 지워집니다. 이미 보낸 안내 메일은
              그대로 남습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (removing) remove.mutate(removing.id);
              }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
