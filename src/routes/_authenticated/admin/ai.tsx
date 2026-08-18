import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Copy,
  Loader2,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { readableValue, targetLabel } from "@/components/survey/AiSuggestionCards";
import {
  aiProxyStatus,
  applyMerge,
  applySuggestion,
  confirmAiDrafts,
  detectPoorResponses,
  draftMissingFields,
  listSuggestions,
  pingProxy,
  requestReview,
  scanTypos,
  suggestMerges,
} from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/admin/ai")({
  head: () => ({
    meta: [
      { title: "AI 도구 | 서연 그룹 업무조사" },
      { name: "description", content: "업무기술서 자동 정리 등 AI 보조 기능을 제공합니다." },
      { property: "og:title", content: "AI 도구 | 서연 그룹 업무조사" },
      { property: "og:description", content: "업무기술서 자동 정리 등 AI 보조 기능을 제공합니다." },
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

/** 제출된 응답 목록 (계열사 스코프 반영) */
function useSubmittedResponses(companyId: string) {
  return useQuery({
    queryKey: ["ai-submitted-responses", companyId],
    queryFn: async () => {
      let q = supabase
        .from("responses")
        .select("id, job_name, status, submitted_at, participants(name, emp_no)")
        .eq("status", "submitted")
        .order("submitted_at", { ascending: false });
      if (companyId !== "all") q = q.eq("company_id", companyId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

function ResponsePicker({
  companyId,
  value,
  onChange,
}: {
  companyId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const { data, isLoading } = useSubmittedResponses(companyId);
  const rows = data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full sm:w-[360px]" aria-label="응답 선택">
          <SelectValue placeholder={isLoading ? "불러오는 중..." : "제출된 응답 선택"} />
        </SelectTrigger>
        <SelectContent>
          {rows.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.participants?.name ?? "이름없음"} · {r.job_name ?? "직무명 미기재"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">제출 {rows.length}건</span>
    </div>
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">AI 도구</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          업무기술서 오탈자 검수, 부실 응답 탐지, 빈 항목 초안, 표기 병합을 지원합니다.
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

      <Tabs defaultValue="typos">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="typos">오타 검수</TabsTrigger>
          <TabsTrigger value="poor">부실 응답</TabsTrigger>
          <TabsTrigger value="fill">자동 채움</TabsTrigger>
          <TabsTrigger value="merge">표기 병합</TabsTrigger>
        </TabsList>

        <TabsContent value="typos" className="mt-4">
          <TypoTab companyId={companyId} onProxyError={setProxyError} />
        </TabsContent>
        <TabsContent value="poor" className="mt-4">
          <PoorTab scope={scope} onProxyError={setProxyError} />
        </TabsContent>
        <TabsContent value="fill" className="mt-4">
          <FillTab companyId={companyId} onProxyError={setProxyError} />
        </TabsContent>
        <TabsContent value="merge" className="mt-4">
          <MergeTab scope={scope} onProxyError={setProxyError} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ProxyErrorSetter = (message: string | null) => void;

/* ① 오타 검수 ------------------------------------------------------------ */

function TypoTab({
  companyId,
  onProxyError,
}: {
  companyId: string;
  onProxyError: ProxyErrorSetter;
}) {
  const queryClient = useQueryClient();
  const [responseId, setResponseId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const suggestionsQuery = useQuery({
    queryKey: ["ai-suggestions", responseId, "오타"],
    queryFn: () => listSuggestions({ data: { responseId, kind: "오타" } }),
    enabled: Boolean(responseId),
  });

  const rows = suggestionsQuery.data ?? [];
  const pending = rows.filter((r) => r.status === "제안");
  const history = rows.filter((r) => r.status !== "제안");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["ai-suggestions", responseId, "오타"] });

  const scanMutation = useMutation({
    mutationFn: () => scanTypos({ data: { responseId } }),
    onSuccess: (res) => {
      onProxyError(null);
      setSelected(new Set());
      toast.success(
        res.inserted > 0
          ? `제안 ${res.inserted}건을 찾았습니다.`
          : "수정할 부분을 찾지 못했습니다.",
      );
      void invalidate();
    },
    onError: (err) => {
      const message = errorMessage(err);
      if (message.includes("AI")) onProxyError(message);
      toast.error(message);
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      let ok = 0;
      for (const id of ids) {
        await applySuggestion({ data: { suggestionId: id } });
        ok += 1;
      }
      return ok;
    },
    onSuccess: (ok) => {
      toast.success(`${ok}건을 응답에 반영했습니다.`);
      setSelected(new Set());
      void invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // 오타 검수는 경로 A(관리자 직접 반영) 전용 — 응답자 검토 요청(경로 B)은 제공하지 않는다.
  const busy = scanMutation.isPending || applyMutation.isPending;
  const selectedIds = [...selected];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <ResponsePicker companyId={companyId} value={responseId} onChange={setResponseId} />
        <Button
          className="mt-3"
          disabled={!responseId || busy}
          onClick={() => scanMutation.mutate()}
        >
          {scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          오탈자 스캔 실행
        </Button>
      </div>

      {pending.length > 0 && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">검토 대기 {pending.length}건</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selectedIds.length === 0}
                onClick={() => applyMutation.mutate(selectedIds)}
              >
                {applyMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                관리자가 바로 수정
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            오타 검수는 관리자가 바로 고치는 기능입니다. 작성자에게 확인을 받아야 하면 자동 채움
            탭을 사용하세요.
          </p>

          <ul className="space-y-3">
            {pending.map((s) => (
              <li key={s.id} className="rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(s.id)}
                    onCheckedChange={() => toggle(s.id)}
                    aria-label={`${targetLabel(s.target)} 선택`}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {targetLabel(s.target)}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <p className="rounded bg-secondary p-2 text-sm">{s.original_value ?? "—"}</p>
                      <p className="rounded border border-primary/30 bg-primary-soft/40 p-2 text-sm">
                        {s.suggested_value}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => applyMutation.mutate([s.id])}
                      >
                        바로 수정
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {history.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold">반영 이력 {history.length}건</p>
          <ul className="mt-3 space-y-2 text-sm">
            {history.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
                <Badge variant="outline">{s.status}</Badge>
                <span className="text-xs text-muted-foreground">{targetLabel(s.target)}</span>
                <span className="min-w-0 flex-1 truncate">{s.suggested_value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {responseId && !suggestionsQuery.isLoading && rows.length === 0 && (
        <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
          아직 이 응답에 대한 오타 제안이 없습니다. 스캔을 실행하세요.
        </p>
      )}
    </div>
  );
}

/* ② 부실 응답 ------------------------------------------------------------ */

function PoorTab({
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
    <div className="space-y-4">
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

      {mutation.isSuccess && candidates.length === 0 && (
        <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
          부실 의심 응답이 없습니다.
        </p>
      )}

      <ul className="space-y-3">
        {candidates.map((c) => (
          <li key={c.responseId} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{c.name || "이름없음"}</span>
              <span className="text-xs text-muted-foreground">{c.jobName || "직무명 미기재"}</span>
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

/* ③ 자동 채움 ------------------------------------------------------------ */

function FillTab({
  companyId,
  onProxyError,
}: {
  companyId: string;
  onProxyError: ProxyErrorSetter;
}) {
  const queryClient = useQueryClient();
  const [responseId, setResponseId] = useState("");
  const [target, setTarget] = useState<"skills" | "requirements">("skills");

  const suggestionsQuery = useQuery({
    queryKey: ["ai-suggestions", responseId, "자동채움"],
    queryFn: () => listSuggestions({ data: { responseId, kind: "자동채움" } }),
    enabled: Boolean(responseId),
  });

  const rows = suggestionsQuery.data ?? [];
  const drafts = rows.filter((r) => r.status === "제안");
  const sent = rows.filter((r) => r.status !== "제안");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["ai-suggestions", responseId, "자동채움"] });

  const draftMutation = useMutation({
    mutationFn: () => draftMissingFields({ data: { responseId, target } }),
    onSuccess: (res) => {
      onProxyError(null);
      toast.success(
        res.inserted > 0 ? `초안 ${res.inserted}건을 만들었습니다.` : "채울 빈 항목이 없습니다.",
      );
      void invalidate();
    },
    onError: (err) => {
      const message = errorMessage(err);
      if (message.includes("AI")) onProxyError(message);
      toast.error(message);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (ids: string[]) => requestReview({ data: { suggestionIds: ids } }),
    onSuccess: (res) => {
      toast.success(`${res.requested}건을 작성자 확인으로 넘겼습니다.`);
      void invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // 응답에 남은 'AI 초안' 표시 건수. 이 표시가 남아 있으면 응답을 승인할 수 없다.
  const draftCountKey = ["ai-draft-marks", responseId];
  const draftCountQuery = useQuery({
    queryKey: draftCountKey,
    queryFn: async () => {
      const [skills, reqs] = await Promise.all([
        supabase
          .from("response_skills")
          .select("id", { count: "exact", head: true })
          .eq("response_id", responseId)
          .eq("ai_draft", true),
        supabase
          .from("response_requirements")
          .select("response_id", { count: "exact", head: true })
          .eq("response_id", responseId)
          .eq("ai_draft", true),
      ]);
      return (skills.count ?? 0) + (reqs.count ?? 0);
    },
    enabled: Boolean(responseId),
  });
  const draftMarks = draftCountQuery.data ?? 0;

  const confirmMutation = useMutation({
    mutationFn: () => confirmAiDrafts({ data: { responseId } }),
    onSuccess: (res) => {
      toast.success(`AI 초안 표시 ${res.confirmed}건을 확정했습니다.`);
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: draftCountKey });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <ResponsePicker companyId={companyId} value={responseId} onChange={setResponseId} />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={(v) => setTarget(v as "skills" | "requirements")}>
            <SelectTrigger className="w-[200px]" aria-label="채울 항목">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skills">스킬</SelectItem>
              <SelectItem value="requirements">자격요건</SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={!responseId || draftMutation.isPending}
            onClick={() => draftMutation.mutate()}
          >
            {draftMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            초안 생성
          </Button>
          <Button
            variant="outline"
            disabled={!responseId || draftMarks === 0 || confirmMutation.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  `AI 초안 표시 ${draftMarks}건을 확정합니다. 확정해야 이 응답을 승인할 수 있습니다.`,
                )
              )
                return;
              confirmMutation.mutate();
            }}
          >
            {confirmMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            AI 초안 일괄 확정{draftMarks > 0 ? ` ${draftMarks}건` : ""}
          </Button>
        </div>
        {responseId && draftMarks > 0 && (
          <p className="text-xs text-muted-foreground">
            이 응답에 AI 초안 표시가 {draftMarks}건 남아 있어 승인할 수 없습니다. 내용을 확인한 뒤
            확정하세요.
          </p>
        )}
      </div>

      {drafts.length > 0 && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">초안 미리보기 {drafts.length}건</p>
            <Button
              size="sm"
              disabled={reviewMutation.isPending}
              onClick={() => reviewMutation.mutate(drafts.map((d) => d.id))}
            >
              {reviewMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              작성자에게 확인 요청
            </Button>
          </div>
          <ul className="space-y-2">
            {drafts.map((d) => (
              <li key={d.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-primary-soft text-accent-foreground">AI 초안</Badge>
                  <span className="text-xs text-muted-foreground">{targetLabel(d.target)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {readableValue(d.target, d.suggested_value)}
                </p>
                {d.original_value && (
                  <p className="mt-1 text-xs text-muted-foreground">현재: {d.original_value}</p>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  disabled={reviewMutation.isPending}
                  onClick={() => reviewMutation.mutate([d.id])}
                >
                  이 건만 확인 요청
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sent.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold">진행 상태 {sent.length}건</p>
          <ul className="mt-3 space-y-2 text-sm">
            {sent.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
                <Badge variant="outline">{s.status}</Badge>
                <span className="text-xs text-muted-foreground">{targetLabel(s.target)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {readableValue(s.target, s.suggested_value)}
                </span>
                {(s.status === "수락" || s.status === "수정") && (
                  <ApplyButton suggestionId={s.id} onDone={invalidate} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ApplyButton({ suggestionId, onDone }: { suggestionId: string; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: () => applySuggestion({ data: { suggestionId } }),
    onSuccess: () => {
      toast.success("응답에 반영했습니다.");
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Check className="size-4" />
      )}
      최종 반영
    </Button>
  );
}

/* ④ 표기 병합 ------------------------------------------------------------ */

function MergeTab({
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
          : "병합할 표기 변형이 없습니다.",
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
  const fieldLabel = useMemo(() => (field === "job_name" ? "직무명" : "스킬명"), [field]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4">
        <Select value={field} onValueChange={(v) => setField(v as "job_name" | "skill_name")}>
          <SelectTrigger className="w-[180px]" aria-label="병합 대상 필드">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="job_name">직무명</SelectItem>
            <SelectItem value="skill_name">스킬명</SelectItem>
          </SelectContent>
        </Select>
        <Button disabled={scanMutation.isPending} onClick={() => scanMutation.mutate()}>
          {scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Copy className="size-4" />
          )}
          병합 후보 찾기
        </Button>
        {scanMutation.isSuccess && (
          <span className="text-xs text-muted-foreground">
            고유 {fieldLabel} {distinctCount}종
          </span>
        )}
      </div>

      {scanMutation.isSuccess && clusters.length === 0 && (
        <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
          통일이 필요한 표기 변형을 찾지 못했습니다.
        </p>
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
