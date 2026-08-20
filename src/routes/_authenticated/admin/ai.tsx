import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, ClipboardCopy, Copy, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { SectionNav } from "@/components/SectionNav";
import { useCompanyScope } from "@/components/CompanyContext";
import {
  aiProxyStatus,
  applyMerge,
  detectPoorResponses,
  listPendingSuggestions,
  pingProxy,
  suggestMerges,
} from "@/lib/ai.functions";

/**
 * AI 일괄 점검 — 여러 건을 한 번에 훑는 자리.
 *
 * 한 건을 판단하며 쓰는 AI(오탈자 검수·부실 점검·빈 항목 초안·표기 통일)는 검토 화면의
 * 판단 패널로 옮겼다(A2). 여기 남는 것은 "전 응답을 훑어 대상 목록을 만드는 일"뿐이고,
 * 목록의 각 행은 그 응답의 검토 화면(`/admin/review?response=<id>`)으로 곧장 들어간다(P6).
 */
export const Route = createFileRoute("/_authenticated/admin/ai")({
  head: () => ({
    meta: [
      { title: "AI 일괄 점검 | 서연 그룹 업무조사" },
      { name: "description", content: "전 응답을 훑어 손봐야 할 건을 찾습니다." },
      { property: "og:title", content: "AI 일괄 점검 | 서연 그룹 업무조사" },
      { property: "og:description", content: "전 응답을 훑어 손봐야 할 건을 찾습니다." },
    ],
  }),
  component: AiPage,
});

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
        <h1 className="text-xl font-bold sm:text-2xl">AI 일괄 점검</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          전 응답을 훑어 손봐야 할 건을 찾습니다. 한 건을 고치는 일은 각 행의 [검토 화면 열기]에서
          합니다.
        </p>
      </div>

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
          { id: "sweep-pending", label: "미결 AI 제안", count: pendingGroups.length },
          { id: "sweep-poor", label: "부실 응답 스윕" },
          { id: "sweep-merge", label: "표기 통일" },
        ]}
      />

      <section id="sweep-pending" className="scroll-mt-20 space-y-3">
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

      <section id="sweep-poor" className="scroll-mt-20 space-y-3">
        <h2 className="text-base font-semibold">부실 응답 스윕</h2>
        <PoorSweep scope={scope} onProxyError={setProxyError} />
      </section>

      <section id="sweep-merge" className="scroll-mt-20 space-y-3">
        <h2 className="text-base font-semibold">표기 통일</h2>
        <MergeSweep scope={scope} onProxyError={setProxyError} />
      </section>
    </div>
  );
}

type ProxyErrorSetter = (message: string | null) => void;

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
