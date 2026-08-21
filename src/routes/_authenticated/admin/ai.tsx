import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { SectionNav } from "@/components/SectionNav";
import { ScreenAlert } from "@/components/admin/ScreenAlert";
import { StatusBadge } from "@/components/StatusBadge";
import { useCompanyScope } from "@/components/CompanyContext";
import { JobDescriptionEditor } from "@/components/admin/JobDescriptionEditor";
import { cn } from "@/lib/utils";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { DEFAULT_OPS, getOpsValues } from "@/lib/settings.functions";
import {
  aiProxyStatus,
  applyMerge,
  detectPoorResponses,
  getAiLedger,
  listPendingSuggestions,
  pingProxy,
  suggestMerges,
} from "@/lib/ai.functions";
import {
  draftJobDescriptions,
  listJobDescriptions,
  listJobDrafts,
  type JobDescriptionView,
  type JobDraftView,
} from "@/lib/export.functions";
import { draftDutyCharts, draftJobCatalog } from "@/lib/master.functions";

/**
 * AI 도구 — AI 로 만들고(직무기술서 초안) 훑는(일괄 점검) 일을 한 화면에 모았다.
 *
 * 한 건을 판단하며 쓰는 AI(오탈자 검수·부실 점검·빈 항목 초안·표기 통일)는 검토 화면의
 * 판단 패널에 있다(A2). 여기서는 ① 직무기술서 초안을 만들어 다듬고 확정하며(기획 9b),
 * ② 전 응답을 훑어 대상 목록을 만든다 — 목록의 각 행은 그 응답의 검토 화면
 * (`/admin/review?response=<id>`)으로 곧장 들어간다(P6).
 */
export const Route = createFileRoute("/_authenticated/admin/ai")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
  head: () => ({
    meta: [
      { title: "AI 도구 | 서연 그룹 업무조사" },
      { name: "description", content: "직무기술서 초안을 만들고 전 응답을 일괄 점검합니다." },
      { property: "og:title", content: "AI 도구 | 서연 그룹 업무조사" },
      {
        property: "og:description",
        content: "직무기술서 초안을 만들고 전 응답을 일괄 점검합니다.",
      },
    ],
  }),
  component: AiPage,
});

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label}을(를) 클립보드에 복사했습니다.`);
  } catch {
    toast.error("클립보드 복사에 실패했습니다.");
  }
}

/** 해당 응답의 검토 화면으로 바로 들어가는 링크 (딥링크 규약). */
function ReviewLink({ responseId, label }: { responseId: string; label: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/admin/review" search={{ response: responseId }}>
        {label}
      </Link>
    </Button>
  );
}

function AiPage() {
  const { companyId } = useCompanyScope();
  const scope = companyId === "all" ? null : companyId;
  const [proxyError, setProxyError] = useState<string | null>(null);

  const { data: proxy } = useQuery({
    queryKey: ["ai-proxy-status"],
    queryFn: () => aiProxyStatus(),
  });

  const pingMutation = useMutation({
    mutationFn: () => pingProxy(),
    onSuccess: () => {
      setProxyError(null);
      toast.success("AI 서버에 정상 연결됩니다.");
    },
    onError: (err) => {
      setProxyError(errorMessage(err));
      toast.error("AI 서버에 연결할 수 없습니다. 조사 진행에는 영향이 없습니다.");
    },
  });

  const pendingQuery = useQuery({
    queryKey: ["ai-pending-suggestions", scope],
    queryFn: () => listPendingSuggestions({ data: { companyId: scope } }),
  });
  const pendingGroups = pendingQuery.data?.groups ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">AI 도구</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          직무기술서 초안을 만들어 다듬고, 전 응답을 훑어 손봐야 할 건을 찾습니다. 한 건을 고치는
          일은 각 행의 [검토 화면 열기]에서 합니다.
        </p>
        <ScreenAlert screen="ai" className="mt-3" />
      </div>

      {/* 1. AI 서버 연결 상태 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 items-start gap-3 text-sm">
          {proxyError && <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
          <div className="min-w-0">
            <p className="font-semibold">
              {proxyError
                ? "AI 서버: 연결 실패"
                : proxy?.configured
                  ? "AI 서버: 연결 설정 완료"
                  : "AI 서버: 기본 연결 사용 중(운영 설정 권장)"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {proxyError ?? "AI 기능을 쓰지 않아도 조사 진행에는 영향이 없습니다."}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pingMutation.isPending}
          onClick={() => pingMutation.mutate()}
        >
          {pingMutation.isPending && <Loader2 className="size-4 animate-spin" />}
          연결 점검
        </Button>
      </div>

      <SectionNav
        sections={[
          { id: "jd-draft", label: "직무기술서 초안" },
          { id: "sweep-poor", label: "부실 응답 스윕" },
          { id: "sweep-merge", label: "표기 통일" },
          { id: "sweep-pending", label: "미결 AI 제안", count: pendingGroups.length },
          { id: "sweep-ledger", label: "AI 사용 현황" },
        ]}
      />

      {/* 2. 직무기술서 초안 — 만들고, 다듬고, 확정한다 (기획 9b: 내보내기 화면에서 이동) */}
      <section id="jd-draft" className="scroll-mt-[var(--sticky-top)] space-y-3">
        <h2 className="text-base font-semibold">직무기술서 초안</h2>
        <JobDescriptionSection />
      </section>

      {/* 3. 일괄 점검 */}
      <section id="sweep-poor" className="scroll-mt-[var(--sticky-top)] space-y-3">
        <h2 className="text-base font-semibold">부실 응답 스윕</h2>
        <PoorSweep scope={scope} onProxyError={setProxyError} />
      </section>

      <section id="sweep-merge" className="scroll-mt-[var(--sticky-top)] space-y-3">
        <h2 className="text-base font-semibold">표기 통일</h2>
        <MergeSweep scope={scope} onProxyError={setProxyError} />
      </section>

      <section id="sweep-pending" className="scroll-mt-[var(--sticky-top)] space-y-3">
        <h2 className="text-base font-semibold">미결 AI 제안</h2>
        <p className="text-sm text-muted-foreground">
          아직 수락·거절되지 않은 제안이 남은 응답입니다. 제안이 남아 있으면 승인 게이트가 막힐 수
          있습니다.
        </p>
        {pendingQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : pendingGroups.length === 0 ? (
          <EmptyState
            kind="nothing"
            title="미결 제안이 없습니다"
            description="모든 AI 제안이 처리됐습니다. 새 제안은 검토 화면의 AI 점검에서 만듭니다."
          />
        ) : (
          <ul className="space-y-2">
            {pendingGroups.map((g) => (
              <li
                key={g.responseId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-4"
              >
                <div className="min-w-0">
                  <p className="font-semibold">
                    {g.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {g.jobName}
                    </span>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.entries(g.kinds).map(([kind, count]) => (
                      <Badge key={kind} variant="outline">
                        {kind} {count}
                      </Badge>
                    ))}
                  </div>
                </div>
                <ReviewLink responseId={g.responseId} label="검토 화면 열기" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. AI 사용 현황 */}
      <section id="sweep-ledger" className="scroll-mt-[var(--sticky-top)] space-y-3">
        <h2 className="text-base font-semibold">AI 사용 현황</h2>
        <p className="text-sm text-muted-foreground">
          AI 가 무엇을 얼마나 바꿨고 어디서 실패했는지 봅니다.
        </p>
        <AiLedgerPanel />
      </section>
    </div>
  );
}

/* ═══════════════ 직무기술서 초안 (기획 9b — 내보내기 화면에서 이식) ═══════════════ */

/** 응답 상태 코드 → 화면 상태 문구. 배지 색·문구는 StatusBadge 한 곳에서만 정한다. */
const STATUS_LABEL: Record<string, string> = {
  draft: "작성중",
  submitted: "제출",
  rejected: "반려",
  approved: "승인",
};

function whenShort(at: string | null) {
  return at ? new Date(at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : null;
}

/**
 * 응답 수에 따른 신뢰도 배지 (검토 화면과 같은 3단계).
 * 기준값은 설정 화면(운영 기본 → 판정 기준)에서 바꿀 수 있다.
 */
function JobCountBadge({ count, ok, caution }: { count: number; ok: number; caution: number }) {
  const label = count >= ok ? "정상" : count >= caution ? "심층검토" : "확인 필요";
  const style =
    count >= ok
      ? "bg-success/15 text-success"
      : count >= caution
        ? "bg-warning/15 text-warning"
        : "bg-destructive/10 text-destructive";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style,
      )}
    >
      {count}인 · {label}
    </span>
  );
}

/** 직무기술서 상태 — 초안 / 검토중 / 확정. 아직 만들지 않은 직무는 「미작성」. */
function JdStatusBadge({ status, active }: { status: string | null; active: boolean }) {
  const style = active
    ? "bg-primary-foreground/20 text-primary-foreground"
    : status === "확정"
      ? "bg-success/15 text-success"
      : status === "검토중"
        ? "bg-warning/15 text-warning"
        : status === "초안"
          ? "bg-secondary text-muted-foreground"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style,
      )}
    >
      {status ?? "미작성"}
    </span>
  );
}

/** 초안 한 줄 + 그 내용이 어느 응답에서 왔는지로 가는 링크. */
function SourceLine({ text, responseId }: { text: string; responseId: string }) {
  return (
    <li className="flex items-start justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5">
      <span className="min-w-0 text-[13px] leading-relaxed">{text}</span>
      <a
        href={`/admin/review?response=${responseId}`}
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        응답 보기
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </li>
  );
}

/** 목록 한 줄 = 직무 하나. 응답에서 모은 원문과 저장된 직무기술서를 같은 줄에 묶는다. */
type JobRow = {
  key: string;
  jobName: string;
  company: string;
  responses: number;
  pending: number;
  jd: JobDescriptionView | null;
  view: JobDraftView | null;
};

function JobDescriptionSection() {
  const { companyId: scopedCompany } = useCompanyScope();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState(scopedCompany);
  const [approvedOnly, setApprovedOnly] = useState(true);
  const [failedJobs, setFailedJobs] = useState<{ key: string; label: string }[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: companies } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

  const { data: ops } = useQuery({
    queryKey: ["admin-ops-values"],
    queryFn: async () => getOpsValues({ headers: await authHeaders() }),
  });
  const okCount = ops?.values.jobCountOk ?? DEFAULT_OPS.jobCountOk;
  const cautionCount = ops?.values.jobCountCaution ?? DEFAULT_OPS.jobCountCaution;

  const companyParam = company === "all" ? null : company;
  const scopeParam: "approved" | "all" = approvedOnly ? "approved" : "all";

  /** 응답에 적힌 원문 — AI 를 돌리지 않아도 무엇이 나갈지 미리 보여 준다. */
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ["job-drafts", companyParam, null, scopeParam],
    queryFn: async () =>
      listJobDrafts({
        data: { companyId: companyParam, orgUnitId: null, scope: scopeParam },
        headers: await authHeaders(),
      }),
  });

  /** 저장된 직무기술서 — 새로고침해도 남아 있는 산출물 본체. */
  const { data: stored, isLoading: storedLoading } = useQuery({
    queryKey: ["job-descriptions", companyParam],
    queryFn: async () =>
      listJobDescriptions({ data: { companyId: companyParam }, headers: await authHeaders() }),
  });

  const jdCounts = stored?.counts ?? { total: 0, draft: 0, review: 0, confirmed: 0 };

  const jobRows: JobRow[] = useMemo(() => {
    const byKey = new Map<string, JobRow>();
    for (const v of preview?.jobs ?? []) {
      byKey.set(v.key, {
        key: v.key,
        jobName: v.jobName,
        company: v.company,
        responses: v.responses.length,
        pending: v.responses.filter((r) => r.status !== "approved").length,
        jd: null,
        view: v,
      });
    }
    for (const jd of stored?.jobs ?? []) {
      const key = `${jd.companyId}|${jd.jobName}`;
      const prev = byKey.get(key);
      if (prev) prev.jd = jd;
      else
        byKey.set(key, {
          key,
          jobName: jd.jobName,
          company: jd.company,
          responses: jd.responseCount,
          pending: 0,
          jd,
          view: null,
        });
    }
    return [...byKey.values()].sort((a, b) => a.jobName.localeCompare(b.jobName, "ko"));
  }, [preview, stored]);

  const selected = jobRows.find((r) => r.key === selectedKey) ?? jobRows[0] ?? null;

  function refreshStored() {
    void queryClient.invalidateQueries({ queryKey: ["job-descriptions"] });
  }

  function reportDraftResult(res: {
    saved: number;
    preserved: number;
    preservedJobs: string[];
    lockedJobs: string[];
    failedJobs: { key: string; label: string }[];
  }) {
    setFailedJobs(res.failedJobs);
    refreshStored();
    if (res.saved === 0 && res.failedJobs.length === 0 && res.lockedJobs.length === 0) {
      toast.info("조건에 해당하는 승인된 응답이 없습니다.");
      return;
    }
    if (res.failedJobs.length > 0) {
      toast.error(`${res.failedJobs.length}건 실패 — [실패 직무만 다시 생성]으로 재시도해 주세요.`);
    } else if (res.saved > 0) {
      toast.success(`직무 ${res.saved}건의 초안을 저장했습니다.`);
    }
    if (res.preserved > 0) {
      toast.info(
        `직접 고친 ${res.preserved}개 항목은 그대로 두었습니다. (${res.preservedJobs.slice(0, 3).join(", ")}${
          res.preservedJobs.length > 3 ? " 외" : ""
        })`,
      );
    }
    if (res.lockedJobs.length > 0) {
      toast.info(`확정된 ${res.lockedJobs.length}개 직무는 건드리지 않았습니다.`);
    }
  }

  const buildDrafts = useMutation({
    mutationFn: async () =>
      draftJobDescriptions({
        data: { companyId: companyParam },
        headers: await authHeaders(),
      }),
    onSuccess: reportDraftResult,
    onError: (err) => toast.error(errorMessage(err)),
  });

  const retryDrafts = useMutation({
    mutationFn: async () =>
      draftJobDescriptions({
        data: {
          companyId: companyParam,
          jobs: failedJobs.map((f) => f.key),
        },
        headers: await authHeaders(),
      }),
    onSuccess: reportDraftResult,
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      <p className="text-sm text-muted-foreground">
        왼쪽에서 직무를 고르면 그 직무의 직무기술서가 오른쪽에 나옵니다. 고친 내용은 [저장]을 누르면
        남고, 다시 생성해도 직접 고친 항목은 덮어쓰지 않습니다. 항목마다 몇 명이 같은 내용을
        적었는지와 그 응답으로 가는 링크가 붙습니다. 확정본은{" "}
        <Link to="/admin/export" className="font-medium text-primary hover:underline">
          내보내기 화면
        </Link>
        의 표준 직무기술서 엑셀에 담깁니다.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>대상 계열사</Label>
          <Select
            value={company}
            onValueChange={(v) => {
              setCompany(v);
              setFailedJobs([]);
              setSelectedKey(null);
            }}
          >
            <SelectTrigger className="w-full sm:w-[220px]" aria-label="대상 계열사">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 계열사</SelectItem>
              {companies?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 self-end rounded-lg border px-3 py-2">
          <Label htmlFor="jd-approved" className="cursor-pointer">
            승인된 응답만 포함
          </Label>
          <Switch id="jd-approved" checked={approvedOnly} onCheckedChange={setApprovedOnly} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={buildDrafts.isPending || retryDrafts.isPending}
          onClick={() => buildDrafts.mutate()}
        >
          <Sparkles className="size-4" />
          {buildDrafts.isPending ? "만드는 중... (직무당 수 초)" : "초안 생성 (AI)"}
        </Button>
        {failedJobs.length > 0 && (
          <Button
            type="button"
            variant="outline"
            disabled={buildDrafts.isPending || retryDrafts.isPending}
            onClick={() => retryDrafts.mutate()}
          >
            <RefreshCw className="size-4" />
            {retryDrafts.isPending ? "다시 만드는 중..." : "실패 직무만 다시 생성"}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          저장됨 {jdCounts.total}건 · 초안 {jdCounts.draft} · 검토중 {jdCounts.review} · 확정{" "}
          {jdCounts.confirmed}
        </span>
      </div>

      {failedJobs.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-xs text-destructive">
            AI 응답이 중간에 끊기거나 저장에 실패한 직무가 있습니다 — [실패 직무만 다시 생성]을 눌러
            주세요.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {failedJobs.map((f) => (
              <Badge key={f.key} variant="destructive">
                {f.label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {previewLoading || storedLoading ? (
        <p className="text-sm text-muted-foreground">직무를 모으는 중...</p>
      ) : jobRows.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="조건에 해당하는 응답이 없습니다"
          description={
            approvedOnly
              ? "아직 승인된 응답이 없습니다. [승인된 응답만 포함]을 꺼서 작성 중인 응답까지 보거나, 응답 검토에서 먼저 승인해 주세요."
              : "선택한 계열사에 작성된 응답이 없습니다. 대상을 넓혀 보세요."
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_1fr]">
          {/* 좌: 직무 목록 */}
          <ul className="max-h-[640px] space-y-1.5 overflow-y-auto rounded-lg border p-2">
            {jobRows.map((row) => {
              const active = selected?.key === row.key;
              const madeAt = whenShort(row.jd?.generatedAt ?? null);
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(row.key)}
                    className={cn(
                      "w-full rounded-md px-2.5 py-2 text-left transition-colors",
                      active ? "bg-primary text-primary-foreground" : "hover:bg-secondary",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{row.jobName}</span>
                      <JdStatusBadge status={row.jd?.status ?? null} active={active} />
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 block truncate text-[11px]",
                        active ? "text-primary-foreground/80" : "text-muted-foreground",
                      )}
                    >
                      {row.company} · 응답 {row.responses}건
                      {row.pending > 0 ? ` · 검토 전 ${row.pending}건` : ""}
                      {madeAt ? ` · ${madeAt} 생성` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* 우: 고른 직무 */}
          {selected && (
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-2 border-b pb-3">
                <h3 className="text-base font-semibold">{selected.jobName}</h3>
                <JobCountBadge count={selected.responses} ok={okCount} caution={cautionCount} />
                <span className="text-xs text-muted-foreground">
                  {selected.company}
                  {selected.view && (selected.view.jobGroup || selected.view.jobSeries)
                    ? ` · ${selected.view.jobGroup} / ${selected.view.jobSeries}`
                    : ""}
                </span>
              </div>

              {selected.responses < cautionCount && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  응답이 {selected.responses}건뿐입니다. 이대로 확정하지 말고 후속 인터뷰로 내용을
                  확인해 주세요.
                </p>
              )}

              {selected.view && (
                <div className="flex flex-wrap gap-1.5">
                  {selected.view.responses.map((r) => (
                    <a
                      key={r.id}
                      href={`/admin/review?response=${r.id}`}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] hover:bg-secondary"
                    >
                      <StatusBadge
                        status={STATUS_LABEL[r.status] ?? r.status}
                        className="px-2 py-0 text-[10px]"
                      />
                      {r.roleLevel ?? "역할단계 미기재"}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ))}
                </div>
              )}

              {selected.jd ? (
                <JobDescriptionEditor
                  key={`${selected.jd.id}-${selected.jd.updatedAt}`}
                  jd={selected.jd}
                  authHeaders={authHeaders}
                  onChanged={refreshStored}
                />
              ) : (
                <p className="rounded-lg border border-dashed bg-secondary/40 p-3 text-xs text-muted-foreground">
                  아직 이 직무의 직무기술서를 만들지 않았습니다. 아래는 응답에 적힌 내용을 그대로
                  모은 것입니다. [초안 생성 (AI)]을 누르면 중복을 합쳐 다듬은 직무기술서가 이 자리에
                  생기고, 항목마다 근거가 함께 붙습니다.
                </p>
              )}

              {/* 응답에서 온 원문 — 어느 응답에서 왔는지 링크로 확인한다 */}
              {selected.view && (
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground">응답에 적힌 원문</p>
                  {(
                    [
                      ["정의(Description)", selected.view.definitions],
                      ["목적(Mission)", selected.view.missions],
                      ["자격요건", selected.view.requirements],
                    ] as const
                  ).map(([label, lines]) => (
                    <div key={label} className="space-y-1.5">
                      <p className="text-xs font-semibold">
                        {label}{" "}
                        <span className="font-normal text-muted-foreground">
                          응답 {lines.length}건
                        </span>
                      </p>
                      {lines.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          작성된 내용이 없습니다 — 응답 검토에서 보완을 요청해 주세요.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {lines.map((l, i) => (
                            <SourceLine
                              key={`${l.responseId}-${i}`}
                              text={l.text}
                              responseId={l.responseId}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}

                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold">
                      과업{" "}
                      <span className="font-normal text-muted-foreground">
                        {selected.view.tasks.length}건
                      </span>
                    </p>
                    {selected.view.tasks.length === 0 ? (
                      <p className="text-xs text-muted-foreground">작성된 과업이 없습니다.</p>
                    ) : (
                      <ul className="space-y-1">
                        {selected.view.tasks.map((t, i) => (
                          <SourceLine
                            key={`${t.responseId}-${i}`}
                            text={`${t.isKey ? "[핵심] " : ""}${t.name}${
                              t.activities.length ? ` — ${t.activities.join(" / ")}` : ""
                            }`}
                            responseId={t.responseId}
                          />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold">
                      필요 역량{" "}
                      <span className="font-normal text-muted-foreground">
                        {selected.view.skills.length}건
                      </span>
                    </p>
                    {selected.view.skills.length === 0 ? (
                      <p className="text-xs text-muted-foreground">작성된 역량이 없습니다.</p>
                    ) : (
                      <ul className="space-y-1">
                        {selected.view.skills.map((s, i) => (
                          <SourceLine
                            key={`${s.responseId}-${i}`}
                            text={`${s.name}${s.ksao || s.hardSoft ? ` (${[s.ksao, s.hardSoft].filter(Boolean).join("/")})` : ""}`}
                            responseId={s.responseId}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ProxyErrorSetter = (message: string | null) => void;

/**
 * F17: AI 사용 원장 — AI 가 무엇을 얼마나 바꿨고 어디서 실패했는지 한 자리에서 본다.
 * 실패 목록의 재실행은 대상을 정확히 지정해 다시 만들 수 있는 기능(직무분류 가안·업무분장
 * 가안)에만 버튼이 붙는다. 그 외 기능(예: 직무기술서 초안)은 대상 키를 기록에서 되짚을 수
 * 없어 위의 [직무기술서 초안] 구획에서 다시 생성한다.
 */
function AiLedgerPanel() {
  const ledgerQuery = useQuery({ queryKey: ["ai-ledger"], queryFn: () => getAiLedger() });

  const retryCatalog = useMutation({
    mutationFn: (group: string) => draftJobCatalog({ data: { groups: [group] } }),
    onSuccess: (res, group) => {
      if (res.failedGroups.includes(group)) {
        toast.error(`「${group}」 재생성에 다시 실패했습니다.`);
      } else {
        toast.success(`「${group}」 직군을 다시 생성했습니다.`);
      }
      void ledgerQuery.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const retryDuty = useMutation({
    mutationFn: (orgId: string) => draftDutyCharts({ data: { orgIds: [orgId] } }),
    onSuccess: (res, orgId) => {
      if (res.failedOrgs.some((o) => o.orgId === orgId)) {
        toast.error("업무분장 가안 재생성에 다시 실패했습니다.");
      } else {
        toast.success("업무분장 가안을 다시 생성했습니다.");
      }
      void ledgerQuery.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (ledgerQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">불러오는 중...</p>;
  }
  if (ledgerQuery.isError) {
    return (
      <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        조회 실패 — {errorMessage(ledgerQuery.error)}
      </p>
    );
  }
  const ledger = ledgerQuery.data;
  if (!ledger) return null;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">기능별 사용 현황</h3>
        <p className="mt-1 text-xs text-muted-foreground">최근 {ledger.sampleSize}건 기준 집계</p>
        {ledger.features.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">아직 AI 를 호출한 기록이 없습니다.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">기능</th>
                  <th className="pb-2 pr-4 font-medium">호출 수</th>
                  <th className="pb-2 pr-4 font-medium">성공</th>
                  <th className="pb-2 pr-4 font-medium">실패</th>
                  <th className="pb-2 pr-4 font-medium">평균 소요 시간</th>
                  <th className="pb-2 font-medium">마지막 성공</th>
                </tr>
              </thead>
              <tbody>
                {ledger.features.map((f) => (
                  <tr key={f.feature} className="border-t">
                    <td className="py-2 pr-4 font-medium">{f.feature}</td>
                    <td className="py-2 pr-4">{f.total}</td>
                    <td className="py-2 pr-4 text-success">{f.success}</td>
                    <td className="py-2 pr-4 text-destructive">{f.failed}</td>
                    <td className="py-2 pr-4">
                      {f.avgDurationMs != null ? `${(f.avgDurationMs / 1000).toFixed(1)}초` : "-"}
                    </td>
                    <td className="py-2">
                      {f.lastSuccessAt ? new Date(f.lastSuccessAt).toLocaleString("ko-KR") : "없음"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">제안 채택률</h3>
        {ledger.adoption.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">아직 생성된 AI 제안이 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {ledger.adoption.map((a) => (
              <li
                key={a.kind}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary p-3 text-sm"
              >
                <span className="font-medium">{a.kind}</span>
                <span className="text-muted-foreground">
                  수락 {a.accepted} · 수정 {a.edited} · 거절 {a.rejected} · 대기 {a.pending}
                  {a.acceptedRate != null ? ` — 채택률 ${a.acceptedRate}%` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">응답 대비 AI 개입 비중</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          전체 응답 {ledger.involvement.totalResponses}건 중 AI 제안이 반영된 응답{" "}
          {ledger.involvement.respondedWithAi}건
          {ledger.involvement.ratio != null ? ` (${ledger.involvement.ratio}%)` : ""}
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">최근 실패 {ledger.failures.length}건</h3>
        {ledger.failures.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">최근 실패한 AI 호출이 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {ledger.failures.map((f) => (
              <li
                key={f.id}
                className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {f.feature}
                      {f.target && (
                        <span className="ml-1 font-normal text-muted-foreground">— {f.target}</span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(f.createdAt).toLocaleString("ko-KR")}
                    </p>
                  </div>
                  {f.retry?.kind === "jobCatalog" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retryCatalog.isPending}
                      onClick={() => retryCatalog.mutate(f.retry!.value)}
                    >
                      {retryCatalog.isPending && <Loader2 className="size-4 animate-spin" />}이
                      직군만 다시 생성
                    </Button>
                  )}
                  {f.retry?.kind === "dutyChart" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retryDuty.isPending}
                      onClick={() => retryDuty.mutate(f.retry!.value)}
                    >
                      {retryDuty.isPending && <Loader2 className="size-4 animate-spin" />}이 조직만
                      다시 생성
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-destructive">
                  {f.errorMessage ?? "사유가 남아 있지 않습니다."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* 부실 응답 스윕 — 결과의 각 건은 검토 화면으로 넘긴다. */

function PoorSweep({
  scope,
  onProxyError,
}: {
  scope: string | null;
  onProxyError: ProxyErrorSetter;
}) {
  const mutation = useMutation({
    mutationFn: () => detectPoorResponses({ data: { companyId: scope } }),
    onSuccess: (res) => {
      onProxyError(null);
      toast.success(`${res.scanned}건 중 ${res.candidates.length}건이 부실 의심으로 분류됐습니다.`);
    },
    onError: (err) => {
      const message = errorMessage(err);
      if (message.includes("AI")) onProxyError(message);
      toast.error(message);
    },
  });

  const candidates = mutation.data?.candidates ?? [];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          제출 상태 응답 최대 30건을 검사해 과업·활동이 부실한 응답을 찾고 반려 사유 초안을
          만듭니다. 결과는 저장되지 않습니다.
        </p>
        <Button className="mt-3" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          부실 응답 스캔
        </Button>
      </div>

      {mutation.isError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          스캔 실패 — {errorMessage(mutation.error)}
        </p>
      )}

      {mutation.isSuccess && candidates.length === 0 && (
        <EmptyState
          kind="nothing"
          title="부실 의심 응답이 없습니다"
          description="검사한 범위에서는 판정 기준에 걸리는 응답을 찾지 못했습니다."
        />
      )}

      <ul className="space-y-3">
        {candidates.map((c) => (
          <li key={c.responseId} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{c.name || "이름없음"}</span>
                <span className="text-xs text-muted-foreground">
                  {c.jobName || "직무명 미기재"}
                </span>
              </div>
              <ReviewLink responseId={c.responseId} label="검토 화면 열기" />
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {c.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
            <div className="mt-3 rounded-lg bg-secondary p-3">
              <p className="text-xs font-medium text-muted-foreground">반려 사유 초안</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{c.rejectDraft}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void copyText(c.rejectDraft, "반려 사유")}
            >
              <ClipboardCopy className="size-4" />
              반려 사유로 복사
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* 표기 통일 — 전사 범위 작업이라 일괄 점검 화면에 남긴다. */

function MergeSweep({
  scope,
  onProxyError,
}: {
  scope: string | null;
  onProxyError: ProxyErrorSetter;
}) {
  const [field, setField] = useState<"job_name" | "skill_name">("job_name");
  const [canonical, setCanonical] = useState<Record<number, string>>({});
  const [applied, setApplied] = useState<Set<number>>(new Set());

  const scanMutation = useMutation({
    mutationFn: () => suggestMerges({ data: { companyId: scope, field } }),
    onSuccess: (res) => {
      onProxyError(null);
      setCanonical(Object.fromEntries(res.clusters.map((c, i) => [i, c.canonical])));
      setApplied(new Set());
      toast.success(
        res.clusters.length > 0
          ? `병합 후보 ${res.clusters.length}묶음을 찾았습니다.`
          : "통일할 표기 변형이 없습니다.",
      );
    },
    onError: (err) => {
      const message = errorMessage(err);
      if (message.includes("AI")) onProxyError(message);
      toast.error(message);
    },
  });

  const applyMutation = useMutation({
    mutationFn: (input: { index: number; from: string[]; to: string }) =>
      applyMerge({ data: { field, from: input.from, to: input.to, companyId: scope } }).then(
        (res) => ({ ...res, index: input.index }),
      ),
    onSuccess: (res) => {
      setApplied((prev) => new Set(prev).add(res.index));
      toast.success(`${res.updated}건의 표기를 통일했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const clusters = scanMutation.data?.clusters ?? [];
  const distinctCount = scanMutation.data?.distinct.length ?? 0;
  const fieldLabel = useMemo(() => (field === "job_name" ? "직무명" : "역량명"), [field]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4">
        <Select value={field} onValueChange={(v) => setField(v as "job_name" | "skill_name")}>
          <SelectTrigger className="w-[180px]" aria-label="통일 대상 항목">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="job_name">직무명</SelectItem>
            <SelectItem value="skill_name">역량명</SelectItem>
          </SelectContent>
        </Select>
        <Button disabled={scanMutation.isPending} onClick={() => scanMutation.mutate()}>
          {scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Copy className="size-4" />
          )}
          통일 후보 찾기
        </Button>
        {scanMutation.isSuccess && (
          <span className="text-xs text-muted-foreground">
            고유 {fieldLabel} {distinctCount}종
          </span>
        )}
      </div>

      {scanMutation.isError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          점검 실패 — {errorMessage(scanMutation.error)}
        </p>
      )}

      {scanMutation.isSuccess && clusters.length === 0 && (
        <EmptyState
          kind="nothing"
          title="통일할 표기가 없습니다"
          description={`${fieldLabel} ${distinctCount}종을 검사했지만 같은 대상을 다르게 적은 표기를 찾지 못했습니다.`}
        />
      )}

      <ul className="space-y-3">
        {clusters.map((c, i) => {
          const to = canonical[i] ?? c.canonical;
          const done = applied.has(i);
          return (
            <li key={`${c.canonical}-${i}`} className="rounded-xl border bg-card p-4">
              <p className="text-sm font-semibold">
                {c.variants.length}개 표기 → 대표 표기 선택
                {done && (
                  <Badge className="ml-2 bg-success/15 text-success" variant="secondary">
                    적용됨
                  </Badge>
                )}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {c.variants.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setCanonical((prev) => ({ ...prev, [i]: v }))}
                    className={
                      v === to
                        ? "rounded-full border border-primary bg-primary-soft px-3 py-1 text-xs font-semibold text-accent-foreground"
                        : "rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
                    }
                  >
                    {v}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                className="mt-3"
                disabled={done || applyMutation.isPending}
                onClick={() => applyMutation.mutate({ index: i, from: c.variants, to })}
              >
                {applyMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                「{to}」로 통일
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
