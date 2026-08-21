import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Send, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CollapsibleSection } from "@/components/SectionNav";
import { readableValue, targetLabel } from "@/components/survey/AiSuggestionCards";
import { cn } from "@/lib/utils";
import {
  aiProxyStatus,
  applyMerge,
  checkResponseQuality,
  confirmAiDrafts,
  decideSuggestionAsAdmin,
  draftMissingFields,
  listSuggestions,
  requestReview,
  scanTypos,
  suggestMerges,
} from "@/lib/ai.functions";

/**
 * A2 인라인 AI 점검 — 검토 중인 응답 한 건에 대해 AI 도구를 그 자리에서 쓴다.
 *
 * 예전에는 /admin/ai 라는 별도 화면에 4기능이 격리돼 있어서, 검토하다 AI를 쓰려면
 * 화면을 떠나고 응답을 다시 골라야 했다. 여기서는 지금 보고 있는 응답이 곧 대상이다.
 * 여러 건을 한 번에 훑는 일은 /admin/ai(일괄 점검)에 남아 있다.
 *
 * 실행 상태(실행 중·성공·실패·미연결)는 반드시 화면에 남긴다 — 조용히 실패하지 않는다(P8).
 */

type RunState =
  | { phase: "idle" }
  | { phase: "running"; label: string }
  | { phase: "ok"; label: string; at: string }
  | { phase: "failed"; label: string; message: string };

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function RunStatus({ state, configured }: { state: RunState; configured: boolean | undefined }) {
  if (state.phase === "running") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {state.label} 실행 중입니다. 응답까지 최대 1분쯤 걸립니다.
      </p>
    );
  }
  if (state.phase === "failed") {
    return (
      <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {state.label} 실패 — {state.message}
          <br />
          AI를 쓰지 않아도 검토·승인은 그대로 진행할 수 있습니다.
        </span>
      </p>
    );
  }
  if (state.phase === "ok") {
    return (
      <p className="text-xs text-muted-foreground">
        {state.label} 완료 · {state.at}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {configured === false
        ? "AI 서버가 운영 설정 없이 기본 연결로 동작합니다. 실패하면 설정을 확인하세요."
        : "아직 실행하지 않았습니다."}
    </p>
  );
}

export function AiInspector({
  responseId,
  jobName,
  skillNames,
  aiDraftCount,
  companyId,
  onUseRejectDraft,
  onApplied,
}: {
  responseId: string;
  jobName: string | null;
  skillNames: string[];
  /** 응답에 남은 AI 초안 표시 수 — 0이 아니면 승인 게이트가 막힌다. */
  aiDraftCount: number;
  companyId: string | null;
  /** 반려 사유 초안을 판단 패널의 반려 대화상자로 넘긴다. */
  onUseRejectDraft: (text: string, step: number) => void;
  /** 응답 본문이 바뀌었을 때 상세를 다시 읽게 한다. */
  onApplied: () => void;
}) {
  const queryClient = useQueryClient();
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  // 반영 방식 선택 — 기본은 즉시 반영. 켜면 자동 채움 제안을 응답자 확인 카드로 보낸다.
  const [askAuthor, setAskAuthor] = useState(false);

  const { data: proxy } = useQuery({
    queryKey: ["ai-proxy-status"],
    queryFn: () => aiProxyStatus(),
  });

  const started = (label: string) => setRun({ phase: "running", label });
  const ok = (label: string) =>
    setRun({ phase: "ok", label, at: new Date().toLocaleTimeString("ko-KR") });
  const failed = (label: string, err: unknown) => {
    setRun({ phase: "failed", label, message: errorMessage(err) });
    toast.error(`${label}에 실패했습니다: ${errorMessage(err)}`);
  };

  const suggestionsQuery = useQuery({
    queryKey: ["ai-suggestions", responseId],
    queryFn: () => listSuggestions({ data: { responseId } }),
  });
  const suggestions = suggestionsQuery.data ?? [];
  const pending = suggestions.filter((s) => s.status === "제안" || s.status === "요청중");
  const decided = suggestions.filter((s) => s.status !== "제안" && s.status !== "요청중");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["ai-suggestions", responseId] });
    onApplied();
  };

  const scan = useMutation({
    mutationFn: () => scanTypos({ data: { responseId } }),
    onMutate: () => started("오탈자 검수"),
    onSuccess: (res) => {
      ok("오탈자 검수");
      toast.success(
        res.inserted > 0
          ? `제안 ${res.inserted}건을 찾았습니다.`
          : "수정할 부분을 찾지 못했습니다.",
      );
      invalidate();
    },
    onError: (err) => failed("오탈자 검수", err),
  });

  const [fillTarget, setFillTarget] = useState<"skills" | "requirements">("skills");
  const draft = useMutation({
    mutationFn: () => draftMissingFields({ data: { responseId, target: fillTarget } }),
    onMutate: () => started("빈 항목 초안"),
    onSuccess: (res) => {
      ok("빈 항목 초안");
      toast.success(
        res.inserted > 0 ? `초안 ${res.inserted}건을 만들었습니다.` : "채울 빈 항목이 없습니다.",
      );
      invalidate();
    },
    onError: (err) => failed("빈 항목 초안", err),
  });

  const quality = useMutation({
    mutationFn: () => checkResponseQuality({ data: { responseId } }),
    onMutate: () => started("부실 점검"),
    onSuccess: () => ok("부실 점검"),
    onError: (err) => failed("부실 점검", err),
  });

  const merge = useMutation({
    mutationFn: () => suggestMerges({ data: { companyId, field: "job_name" } }),
    onMutate: () => started("표기 통일 점검"),
    onSuccess: () => ok("표기 통일 점검"),
    onError: (err) => failed("표기 통일 점검", err),
  });

  const applyMergeMutation = useMutation({
    mutationFn: (input: { from: string[]; to: string }) =>
      applyMerge({ data: { field: "job_name", from: input.from, to: input.to, companyId } }),
    onSuccess: (res) => {
      toast.success(`${res.updated}건의 표기를 통일했습니다.`);
      merge.reset();
      invalidate();
    },
    onError: (err) => toast.error(`표기 통일에 실패했습니다: ${errorMessage(err)}`),
  });

  const review = useMutation({
    mutationFn: (ids: string[]) => requestReview({ data: { suggestionIds: ids } }),
    onSuccess: (res) => {
      toast.success(`${res.requested}건을 작성자 확인으로 넘겼습니다.`);
      invalidate();
    },
    onError: (err) => toast.error(`확인 요청에 실패했습니다: ${errorMessage(err)}`),
  });

  const confirm = useMutation({
    mutationFn: () => confirmAiDrafts({ data: { responseId } }),
    onSuccess: (res) => {
      toast.success(`AI 초안 표시 ${res.confirmed}건을 확정했습니다.`);
      invalidate();
    },
    onError: (err) => toast.error(`확정에 실패했습니다: ${errorMessage(err)}`),
  });

  // 이 응답의 직무명·역량명이 걸린 표기 묶음만 남긴다 — 전사 목록을 여기서 다 볼 이유가 없다.
  const myNames = new Set([jobName ?? "", ...skillNames].filter(Boolean));
  const myClusters = (merge.data?.clusters ?? []).filter((c) =>
    c.variants.some((v) => myNames.has(v)),
  );

  const busy = scan.isPending || draft.isPending || quality.isPending || merge.isPending;

  return (
    <CollapsibleSection
      storageKey="review-panel"
      id="ai-inspector"
      title="AI 점검"
      subtitle={pending.length > 0 ? `미결 제안 ${pending.length}건` : "이 응답 한 건만 검사합니다"}
    >
      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <RunStatus state={run} configured={proxy?.configured} />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => scan.mutate()}>
            {scan.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            오탈자 검수
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => quality.mutate()}>
            {quality.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            부실 점검
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => merge.mutate()}>
            {merge.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            표기 통일 점검
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={fillTarget}
            onValueChange={(v) => setFillTarget(v as "skills" | "requirements")}
          >
            <SelectTrigger className="w-[150px]" aria-label="초안을 채울 항목">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skills">필요 역량</SelectItem>
              <SelectItem value="requirements">자격요건</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => draft.mutate()}>
            {draft.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            빈 항목 초안
          </Button>
        </div>

        {aiDraftCount > 0 && (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="text-xs">
              AI 초안 표시가 {aiDraftCount}건 남아 있어 승인할 수 없습니다. 내용을 확인한 뒤
              확정하세요.
            </p>
            <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              {confirm.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              AI 초안 {aiDraftCount}건 확정
            </Button>
          </div>
        )}
      </div>

      {quality.data && (
        <div className="space-y-2 rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-sm font-semibold">
            부실 점검 결과{quality.data.issues.length === 0 ? " — 걸리는 항목 없음" : ""}
          </p>
          {quality.data.issues.length > 0 && (
            <>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {quality.data.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
              {quality.data.rejectDraft && (
                <>
                  <p className="whitespace-pre-wrap rounded-lg bg-secondary p-3 text-xs">
                    {quality.data.rejectDraft}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onUseRejectDraft(quality.data.rejectDraft, quality.data.suggestedStep)
                    }
                  >
                    이 문구로 반려하기
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {merge.isSuccess && (
        <div className="space-y-2 rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-sm font-semibold">표기 통일 후보</p>
          {myClusters.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              이 응답의 직무명과 섞여 쓰이는 다른 표기를 찾지 못했습니다. 전사 표기 정리는 AI 일괄
              점검 화면에서 할 수 있습니다.
            </p>
          ) : (
            <ul className="space-y-2">
              {myClusters.map((c) => (
                <li key={c.canonical} className="rounded-lg border p-3 text-xs">
                  <p className="font-medium">{c.variants.join(" · ")}</p>
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={applyMergeMutation.isPending}
                    onClick={() => applyMergeMutation.mutate({ from: c.variants, to: c.canonical })}
                  >
                    「{c.canonical}」로 통일
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-2 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">AI 제안 {pending.length}건</p>
            {pending.some((s) => s.route === "B" && s.status === "제안") && (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={askAuthor}
                  onCheckedChange={(v) => setAskAuthor(v === true)}
                  aria-label="작성자에게 확인 요청"
                />
                작성자에게 확인 요청
              </label>
            )}
          </div>
          {askAuthor && (
            <p className="text-xs text-muted-foreground">
              켜져 있는 동안에는 자동 채움 제안을 바로 반영하지 않고 작성자(응답자) 화면에 확인
              카드로 보냅니다. 오탈자 제안은 항상 관리자가 직접 반영합니다.
            </p>
          )}
          <ul className="space-y-2">
            {pending.map((s) => (
              <SuggestionRow
                key={s.id}
                suggestion={s}
                onDone={invalidate}
                {...(askAuthor && s.route === "B" && s.status === "제안"
                  ? { onRequestReview: () => review.mutate([s.id]) }
                  : {})}
              />
            ))}
          </ul>
        </div>
      )}

      {decided.length > 0 && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-sm font-semibold">처리 이력 {decided.length}건</p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {decided.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 border-t pt-1.5">
                <Badge variant="outline">{s.status}</Badge>
                <span className="text-muted-foreground">{targetLabel(s.target)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {readableValue(s.target, s.suggested_value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CollapsibleSection>
  );
}

type SuggestionItem = Awaited<ReturnType<typeof listSuggestions>>[number];

/**
 * 제안 한 건 — 원문과 나란히 놓고 수락·수정·거절한다.
 * onRequestReview 가 있으면(「작성자에게 확인 요청」이 켜진 자동 채움 건) 즉시 반영 대신
 * 응답자 확인 카드로 보내는 버튼이 뜬다.
 */
function SuggestionRow({
  suggestion: s,
  onDone,
  onRequestReview,
}: {
  suggestion: SuggestionItem;
  onDone: () => void;
  onRequestReview?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.suggested_value);

  const decide = useMutation({
    mutationFn: (input: { decision: "수락" | "수정" | "거절"; editedValue?: string }) =>
      decideSuggestionAsAdmin({
        data: {
          suggestionId: s.id,
          decision: input.decision,
          ...(input.editedValue === undefined ? {} : { editedValue: input.editedValue }),
        },
      }),
    onSuccess: (res) => {
      toast.success(res.applied ? "응답에 반영했습니다." : "제안을 거절했습니다.");
      setEditing(false);
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const isNewSkill = s.target.endsWith(":new");

  return (
    <li className="rounded-lg border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{s.kind}</Badge>
        <span className="text-muted-foreground">{targetLabel(s.target)}</span>
        {s.status === "요청중" && (
          <Badge className="bg-primary-soft text-accent-foreground">작성자 확인 중</Badge>
        )}
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <p className="rounded bg-secondary p-2">{s.original_value || "(비어 있음)"}</p>
        <p className={cn("rounded border border-primary/30 bg-primary-soft/40 p-2")}>
          {readableValue(s.target, s.suggested_value)}
        </p>
      </div>

      {editing && (
        <Textarea
          className="mt-2"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="제안 수정 내용"
        />
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {onRequestReview ? (
          <Button size="sm" disabled={decide.isPending} onClick={onRequestReview}>
            <Send className="size-4" /> 작성자 확인 요청
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() =>
                editing
                  ? decide.mutate({ decision: "수정", editedValue: draft })
                  : decide.mutate({ decision: "수락" })
              }
            >
              <Check className="size-4" /> {editing ? "수정해서 반영" : "수락"}
            </Button>
            {/* 신규 역량 제안은 구조화된 값이라 자유 편집 시 반영이 깨진다 — 수락·거절만 둔다. */}
            {!isNewSkill && (
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => {
                  setDraft(s.suggested_value);
                  setEditing((v) => !v);
                }}
              >
                {editing ? "수정 취소" : "수정"}
              </Button>
            )}
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ decision: "거절" })}
        >
          <X className="size-4" /> 거절
        </Button>
      </div>
    </li>
  );
}
