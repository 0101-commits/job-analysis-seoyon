import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Pencil, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { useCompanyScope } from "@/components/CompanyContext";
import { cn } from "@/lib/utils";
import {
  approveResponse,
  correctField,
  getJobComparison,
  getResponseDetail,
  getSubmissionSnapshots,
  handleInfoRequest,
  listInfoRequests,
  listReviewQueue,
  rejectResponse,
} from "@/lib/review.functions";
import { infoFieldLabel } from "@/lib/survey.data";

export const Route = createFileRoute("/_authenticated/admin/review")({
  head: () => ({
    meta: [
      { title: "응답 검토 | 서연 그룹 업무조사" },
      { name: "description", content: "제출된 업무조사를 검토하고 승인 또는 반려합니다." },
      { property: "og:title", content: "응답 검토 | 서연 그룹 업무조사" },
      { property: "og:description", content: "제출된 업무조사를 검토하고 승인 또는 반려합니다." },
    ],
  }),
  component: ReviewPage,
});

type CorrectTable =
  | "responses"
  | "response_tasks"
  | "response_activities"
  | "response_skills"
  | "response_requirements";

const STATUS_LABELS: Record<string, string> = {
  draft: "작성중",
  submitted: "제출",
  rejected: "반려",
  approved: "승인",
};

const AUTHORITY_LABELS: Record<string, string> = {
  D: "D 결정",
  R: "R 검토",
  O: "O 실행",
  S: "S 지원",
};

const STEPS = [
  "1. 기본 정보",
  "2. 직무 확인",
  "3. 정의·목적",
  "4. 과업·활동",
  "5. 스킬·요건",
  "6. 자기평가",
];

const LV_GUIDE = "Lv.1 기본·일상 수행 → Lv.2 독립 완결 → Lv.3 복잡 업무·코칭 → Lv.4 방향 제시";

/** K/S/A 코드만 보면 뜻을 모르므로 화면에는 한글을 함께 적는다. */
const KSAO_LABEL: Record<string, string> = { K: "지식 K", S: "기술 S", A: "태도 A" };
const ksaoLabel = (code: string) => KSAO_LABEL[code] ?? code;

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("ko-KR") : "-";
}

function daysSince(value: string) {
  return Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
}

// ── V15-1 재제출 변경분 비교 ──────────────────────────────────
// 스냅샷 payload(snapshot_submission RPC 산출물)와 현재 데이터를 필드 단위로 비교한다.

type SnapRec = Record<string, unknown>;

interface SnapshotPayload {
  response?: SnapRec;
  tasks?: (SnapRec & { activities?: SnapRec[] })[];
  skills?: SnapRec[];
  requirements?: SnapRec[];
}

/** 상세 화면에 표시되는 필드만 비교 대상으로 삼는다 (하이라이트는 표시 레이어이므로). */
const RESPONSE_DIFF_FIELDS = [
  "job_group",
  "job_series",
  "job_name",
  "definition",
  "mission",
  "missed_note",
  "pain_note",
  "coverage_pct",
  "onboarding_done",
] as const;
const TASK_DIFF_FIELDS = [
  "name",
  "importance",
  "authority",
  "transferable",
  "improve_type",
  "improve_note",
] as const;
const SKILL_DIFF_FIELDS = ["name", "ksao", "hard_soft", "description"] as const;
const REQ_DIFF_FIELDS = [
  "education",
  "proficiency",
  "majors_required",
  "majors_preferred",
  "trainings",
  "licenses",
  "languages",
] as const;

/** null·undefined·빈 문자열은 같은 값으로, jsonb 배열·객체는 직렬화해 비교한다. */
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

interface ListDiff {
  /** 현재 항목 id → 바뀐 필드 집합 */
  changed: Map<string, Set<string>>;
  /** 직전 제출에 없던 현재 항목 id */
  added: Set<string>;
  /** 직전 제출에만 있던 항목 (원본 그대로) */
  removed: SnapRec[];
  /** 현재 항목 id → 매칭된 직전 항목 */
  pairs: Map<string, SnapRec>;
}

/** id 우선, 없으면 이름으로 직전 제출 항목과 매칭해 필드 단위 변경을 계산한다. */
function diffList(prev: SnapRec[], cur: { id: string }[], fields: readonly string[]): ListDiff {
  const prevById = new Map(prev.map((p) => [String(p["id"]), p]));
  const changed = new Map<string, Set<string>>();
  const added = new Set<string>();
  const pairs = new Map<string, SnapRec>();
  const matched = new Set<SnapRec>();

  const compare = (c: { id: string }, p: SnapRec) => {
    matched.add(p);
    pairs.set(c.id, p);
    const fieldDiff = new Set<string>();
    for (const f of fields) {
      if (norm((c as SnapRec)[f]) !== norm(p[f])) fieldDiff.add(f);
    }
    if (fieldDiff.size > 0) changed.set(c.id, fieldDiff);
  };

  const unmatchedCur: { id: string }[] = [];
  for (const c of cur) {
    const p = prevById.get(c.id);
    if (p) compare(c, p);
    else unmatchedCur.push(c);
  }
  for (const c of unmatchedCur) {
    const name = norm((c as SnapRec)["name"]);
    const p = name ? prev.find((x) => !matched.has(x) && norm(x["name"]) === name) : undefined;
    if (p) compare(c, p);
    else added.add(c.id);
  }
  return { changed, added, removed: prev.filter((p) => !matched.has(p)), pairs };
}

type DetailResponse = Awaited<ReturnType<typeof getResponseDetail>>["response"];

interface SnapshotDiff {
  response: Set<string>;
  tasks: ListDiff;
  activityChanged: Set<string>;
  activityAdded: Set<string>;
  /** 현재 과업 id → 그 과업에서 삭제된 활동들 */
  activityRemoved: Map<string, SnapRec[]>;
  skills: ListDiff;
  requirements: Set<string>;
}

function computeDiff(prev: SnapshotPayload, r: DetailResponse): SnapshotDiff {
  const response = new Set<string>();
  const cur = r as unknown as SnapRec;
  for (const f of RESPONSE_DIFF_FIELDS) {
    if (norm(prev.response?.[f]) !== norm(cur[f])) response.add(f);
  }

  const tasks = diffList(prev.tasks ?? [], r.response_tasks, TASK_DIFF_FIELDS);

  const activityChanged = new Set<string>();
  const activityAdded = new Set<string>();
  const activityRemoved = new Map<string, SnapRec[]>();
  for (const t of r.response_tasks) {
    const p = tasks.pairs.get(t.id);
    if (!p) continue; // 신규 과업은 통째로 "신규" 배지 — 활동은 개별 표시하지 않는다.
    const d = diffList(
      ((p as { activities?: SnapRec[] }).activities ?? []) as SnapRec[],
      t.response_activities,
      ["name"],
    );
    for (const id of d.changed.keys()) activityChanged.add(id);
    for (const id of d.added) activityAdded.add(id);
    if (d.removed.length > 0) activityRemoved.set(t.id, d.removed);
  }

  const skills = diffList(prev.skills ?? [], r.response_skills, SKILL_DIFF_FIELDS);

  const requirements = new Set<string>();
  const prevReq = prev.requirements?.[0];
  const curReq = r.response_requirements as unknown as SnapRec | null;
  for (const f of REQ_DIFF_FIELDS) {
    if (norm(prevReq?.[f]) !== norm(curReq?.[f])) requirements.add(f);
  }

  return { response, tasks, activityChanged, activityAdded, activityRemoved, skills, requirements };
}

/** 변경 필드 노랑 하이라이트 (비교 모드 전용 표시 레이어) */
const HL = "rounded bg-warning/30 px-1";

function NewBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
      신규
    </span>
  );
}

function RemovedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
      삭제됨
    </span>
  );
}

/** 직무 응답 수에 따른 신뢰도 배지 — 1인 응답은 인터뷰 없이는 확정할 수 없다. */
function JobCountBadge({ count }: { count: number }) {
  const style =
    count >= 5
      ? "bg-success/15 text-success"
      : count >= 2
        ? "bg-warning/15 text-warning"
        : "bg-destructive/10 text-destructive";
  const label = count >= 5 ? "정상" : count >= 2 ? "주의" : "인터뷰 필수";
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", style)}>
      {count}인 · {label}
    </span>
  );
}

function ReviewPage() {
  const { companyId } = useCompanyScope();
  const scope = companyId === "all" ? null : companyId;
  const [status, setStatus] = useState("submitted");
  const [jobQuery, setJobQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue", scope, status, jobQuery],
    queryFn: () =>
      listReviewQueue({
        data: {
          companyId: scope,
          status:
            status === "all" ? null : (status as "draft" | "submitted" | "rejected" | "approved"),
          jobName: jobQuery.trim() || undefined,
        },
      }),
  });

  const rows = data?.rows ?? [];
  const jobNames = Object.keys(data?.jobCounts ?? {}).sort((a, b) => a.localeCompare(b));

  // V15-4 검토 적체 — 현재 목록 중 미검토(제출 상태) 건의 평균 대기일
  const pendingWaits = rows
    .filter((r) => r.status === "submitted" && r.submitted_at)
    .map((r) => daysSince(r.submitted_at!));
  const avgWait =
    pendingWaits.length > 0
      ? Math.round((pendingWaits.reduce((a, b) => a + b, 0) / pendingWaits.length) * 10) / 10
      : null;

  const selectedIndex = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;

  const [infoStatus, setInfoStatus] = useState("요청");
  const { data: infoData, isLoading: infoLoading } = useQuery({
    queryKey: ["info-requests", infoStatus],
    queryFn: () =>
      listInfoRequests({
        data: { status: infoStatus === "all" ? null : (infoStatus as "요청" | "처리완료" | "반려") },
      }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">응답 검토</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          제출된 업무조사를 검토하고 승인 또는 반려합니다. 총 {rows.length}건
        </p>
      </div>

      <Tabs defaultValue="queue">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="queue" className="flex-1 sm:flex-none">
            건별 검토
          </TabsTrigger>
          <TabsTrigger value="compare" className="flex-1 sm:flex-none">
            직무 비교
          </TabsTrigger>
          <TabsTrigger value="info" className="flex-1 gap-2 sm:flex-none">
            정정 요청
            {infoData?.pending ? (
              <span className="rounded-full bg-destructive px-1.5 py-0.5 text-[11px] font-semibold text-destructive-foreground">
                {infoData.pending}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          {/* 좌우 분할이 아니라 전환형 — 응답을 고르면 응답자 화면과 같은 한 단 흐름으로 상세만 본다. */}
          <div className="space-y-4">
            <div className={cn("space-y-3", selectedId && "hidden")}>
              <div className="space-y-2 rounded-xl border bg-card p-3 shadow-sm">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger aria-label="상태 필터">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="submitted">제출</SelectItem>
                    <SelectItem value="draft">작성중</SelectItem>
                    <SelectItem value="rejected">반려</SelectItem>
                    <SelectItem value="approved">승인</SelectItem>
                    <SelectItem value="all">전체</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={jobQuery}
                    onChange={(e) => setJobQuery(e.target.value)}
                    placeholder="직무명 검색"
                    aria-label="직무명 검색"
                    className="pl-9"
                  />
                </div>
                {avgWait !== null && (
                  <p className="text-xs text-muted-foreground">
                    미검토 {pendingWaits.length}건 · 제출 후 평균 {avgWait}일 대기
                  </p>
                )}
              </div>

              {isLoading ? (
                <p className="text-sm text-muted-foreground">불러오는 중...</p>
              ) : rows.length === 0 ? (
                <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
                  조건에 맞는 응답이 없습니다.
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(r.id)}
                        className={cn(
                          "w-full rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary",
                          selectedId === r.id && "border-primary ring-1 ring-primary",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-semibold">
                            {r.participants?.name ?? "-"}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {r.participants?.role_level ?? "-"}
                            </span>
                          </p>
                          <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {r.companies?.name} · {r.participants?.org_text ?? "-"}
                        </p>
                        <p className="mt-2 truncate text-sm font-medium">{r.job_name ?? "직무 미입력"}</p>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <JobCountBadge count={r.jobCount} />
                            {r.status === "submitted" && r.submitted_at && (
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                                  daysSince(r.submitted_at) > 5
                                    ? "bg-warning/15 text-warning"
                                    : "bg-secondary text-muted-foreground",
                                )}
                              >
                                제출 후 {daysSince(r.submitted_at)}일
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(r.submitted_at)}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selectedId && (
              // 응답자가 보던 폭과 비슷하게 가운데 한 단으로. 목록은 [목록] 버튼으로 돌아간다.
              <div className="mx-auto w-full max-w-3xl">
                <ReviewDetail
                  responseId={selectedId}
                  onClose={() => setSelectedId(null)}
                  prevId={selectedIndex > 0 ? (rows[selectedIndex - 1]?.id ?? null) : null}
                  nextId={selectedIndex >= 0 ? (rows[selectedIndex + 1]?.id ?? null) : null}
                  onNavigate={setSelectedId}
                />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="compare" className="mt-4">
          <JobComparison jobNames={jobNames} companyId={scope} />
        </TabsContent>

        <TabsContent value="info" className="mt-4">
          <InfoRequests
            rows={infoData?.rows ?? []}
            isLoading={infoLoading}
            status={infoStatus}
            onStatusChange={setInfoStatus}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 관리자 직접 정정 — 저장 시 review_comments 에 correction 이력이 남는다. */
function EditableText({
  responseId,
  table,
  id,
  field,
  value,
  multiline,
  className,
  highlight,
  readOnly,
}: {
  responseId: string;
  table: CorrectTable;
  id: string;
  field: string;
  value: string | null;
  multiline?: boolean;
  className?: string;
  /** 비교 모드 — 직전 제출과 값이 달라진 필드 */
  highlight?: boolean;
  /** 비교 모드 중에는 정정(연필)을 숨긴다 — 표시 레이어와 편집이 섞이지 않게 */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  const mutation = useMutation({
    mutationFn: () => correctField({ data: { responseId, table, id, field, value: draft } }),
    onSuccess: (result) => {
      setEditing(false);
      if (result.changed) {
        toast.success("정정 내용이 기록되었습니다.");
        void queryClient.invalidateQueries({ queryKey: ["review-detail", responseId] });
        void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      }
    },
    onError: (err) => toast.error(`정정에 실패했습니다: ${errorMessage(err)}`),
  });

  if (editing) {
    return (
      <div className="space-y-2">
        {multiline ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            aria-label="정정 내용"
          />
        ) : (
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="정정 내용" />
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            <Check className="size-4" /> 저장
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(value ?? "");
              setEditing(false);
            }}
          >
            <X className="size-4" /> 취소
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", highlight && HL)}>
        {value || "-"}
      </span>
      {!readOnly && (
        <button
          type="button"
          aria-label="정정"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          onClick={() => {
            setDraft(value ?? "");
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="text-sm font-bold text-primary">{title}</h3>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}

function AiDraftBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
      AI 초안
    </span>
  );
}

function ReviewDetail({
  responseId,
  onClose,
  prevId,
  nextId,
  onNavigate,
}: {
  responseId: string;
  onClose: () => void;
  prevId: string | null;
  nextId: string | null;
  onNavigate: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [approveOpen, setApproveOpen] = useState(false);
  const [interviewChecked, setInterviewChecked] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectStep, setRejectStep] = useState("4");
  const [rejectComment, setRejectComment] = useState("");
  const [compareOn, setCompareOn] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["review-detail", responseId],
    queryFn: () => getResponseDetail({ data: { responseId } }),
  });

  // V15-1 — 스냅샷이 2개 이상(=재제출)일 때만 비교 버튼을 노출한다.
  const { data: snapData } = useQuery({
    queryKey: ["snapshots", responseId],
    queryFn: () => getSubmissionSnapshots({ data: { responseId } }),
  });
  const snaps = snapData?.list ?? [];
  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;

  const { data: prevPayloadData } = useQuery({
    queryKey: ["snapshot-payload", responseId, prevSnap?.seq],
    queryFn: () => getSubmissionSnapshots({ data: { responseId, seq: prevSnap!.seq } }),
    enabled: compareOn && prevSnap !== null,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["review-detail", responseId] });
    void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
  }

  const approve = useMutation({
    mutationFn: (interviewConfirmed: boolean) =>
      approveResponse({ data: { responseId, interviewConfirmed } }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.reason ?? "승인할 수 없습니다.");
        if (result.needsInterview) setApproveOpen(true);
        return;
      }
      setApproveOpen(false);
      setInterviewChecked(false);
      toast.success("응답이 승인되었습니다.");
      invalidate();
    },
    onError: (err) => toast.error(`승인에 실패했습니다: ${errorMessage(err)}`),
  });

  const reject = useMutation({
    mutationFn: () =>
      rejectResponse({
        data: { responseId, step: Number(rejectStep), comment: rejectComment.trim() },
      }),
    onSuccess: () => {
      setRejectOpen(false);
      setRejectComment("");
      toast.success("응답이 반려되었습니다.");
      invalidate();
    },
    onError: (err) => toast.error(`반려에 실패했습니다: ${errorMessage(err)}`),
  });

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">불러오는 중...</p>;
  }

  const r = data.response;
  const req = r.response_requirements;
  const licenses = (req?.licenses ?? []) as { name?: string; kind?: string; grade?: string }[];
  const languages = (req?.languages ?? []) as { language?: string; level?: string }[];

  const diff =
    compareOn && prevSnap && prevPayloadData?.payload
      ? computeDiff(prevPayloadData.payload as SnapshotPayload, r)
      : null;
  const ro = diff !== null;
  const hlR = (f: string) => !!diff?.response.has(f);
  const hlT = (id: string, f: string) => !!diff?.tasks.changed.get(id)?.has(f);
  const hlS = (id: string, f: string) => !!diff?.skills.changed.get(id)?.has(f);
  const hlQ = (f: string) => !!diff?.requirements.has(f);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {/* 전환형 레이아웃이라 폭에 관계없이 목록 복귀 버튼이 필요하다. */}
          <Button variant="outline" size="sm" onClick={onClose}>
            <ChevronLeft className="size-4" /> 목록
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!prevId}
            onClick={() => prevId && onNavigate(prevId)}
          >
            <ChevronLeft className="size-4" /> 이전
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!nextId}
            onClick={() => nextId && onNavigate(nextId)}
          >
            다음 <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          {prevSnap && (
            <Button
              variant={compareOn ? "secondary" : "outline"}
              size="sm"
              onClick={() => setCompareOn((v) => !v)}
            >
              이전 제출과 비교
            </Button>
          )}
          <JobCountBadge count={data.jobCount} />
          <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />
        </div>
      </div>

      {compareOn && prevSnap && (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {diff ? (
            <>
              {prevSnap.seq}차 제출({formatDate(prevSnap.created_at)}) 대비 변경분을 표시합니다 —{" "}
              <span className={HL}>노랑</span>=변경, 신규·삭제는 배지로 표시됩니다. 비교 중에는
              정정이 비활성화됩니다.
            </>
          ) : (
            "비교 데이터를 불러오는 중..."
          )}
        </p>
      )}

      {r.status === "draft" && (
        <p className="rounded-xl border bg-secondary p-3 text-sm text-muted-foreground">
          작성 중 응답은 승인·반려할 수 없고 열람·정정만 가능합니다. 정정하면 작성자가 화면을 열어
          두었던 경우 최신 내용 확인 안내를 받게 됩니다.
        </p>
      )}

      {data.aiDraft.any && (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          확정되지 않은 AI 초안이 남아 있습니다 (스킬 {data.aiDraft.skills}건
          {data.aiDraft.requirements ? ", 자격요건 포함" : ""}). 승인 전에 확정 또는 정정이
          필요합니다.
        </p>
      )}

      <Section title="기본 정보">
        <dl className="grid grid-cols-2 gap-3">
          <Field label="성명">{r.participants?.name ?? "-"}</Field>
          <Field label="사번">{r.participants?.emp_no ?? "-"}</Field>
          <Field label="소속">{r.participants?.org_text ?? "-"}</Field>
          <Field label="계열사">{r.companies?.name ?? "-"}</Field>
          <Field label="직급">{r.participants?.grade ?? "-"}</Field>
          <Field label="역할단계">{r.participants?.role_level ?? "-"}</Field>
          <Field label="제출일">{formatDate(r.submitted_at)}</Field>
          <Field label="검토일">{formatDate(r.reviewed_at)}</Field>
        </dl>
      </Section>

      <Section title="직무">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Field label="직군">
            <EditableText responseId={r.id} table="responses" id={r.id} field="job_group" value={r.job_group} highlight={hlR("job_group")} readOnly={ro} />
          </Field>
          <Field label="직렬">
            <EditableText responseId={r.id} table="responses" id={r.id} field="job_series" value={r.job_series} highlight={hlR("job_series")} readOnly={ro} />
          </Field>
          <Field label="직무명">
            <EditableText responseId={r.id} table="responses" id={r.id} field="job_name" value={r.job_name} highlight={hlR("job_name")} readOnly={ro} />
          </Field>
        </dl>
      </Section>

      <Section title="정의 · 목적">
        <Field label="직무 정의">
          <EditableText
            responseId={r.id}
            table="responses"
            id={r.id}
            field="definition"
            value={r.definition}
            multiline
            highlight={hlR("definition")}
            readOnly={ro}
          />
        </Field>
        <Field label="직무 미션">
          <EditableText
            responseId={r.id}
            table="responses"
            id={r.id}
            field="mission"
            value={r.mission}
            multiline
            highlight={hlR("mission")}
            readOnly={ro}
          />
        </Field>
      </Section>

      <Section title={`과업 (${r.response_tasks.length}건)`}>
        {r.response_tasks.length === 0 ? (
          <p className="text-muted-foreground">등록된 과업이 없습니다.</p>
        ) : (
          <ul className="space-y-3">
            {r.response_tasks.map((t, i) => {
              const removedActs = diff?.activityRemoved.get(t.id) ?? [];
              return (
                <li key={t.id} className="rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-xs font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <EditableText
                        responseId={r.id}
                        table="response_tasks"
                        id={t.id}
                        field="name"
                        value={t.name}
                        multiline
                        highlight={hlT(t.id, "name")}
                        readOnly={ro}
                      />
                    </div>
                    {diff?.tasks.added.has(t.id) && <NewBadge />}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        hlT(t.id, "importance") ? "bg-warning/30" : "bg-secondary",
                      )}
                    >
                      중요도 {t.importance ?? "-"}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        hlT(t.id, "authority") ? "bg-warning/30" : "bg-secondary",
                      )}
                    >
                      {t.authority ? AUTHORITY_LABELS[t.authority] : "책임수준 미입력"}
                    </span>
                    {t.transferable !== null && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5",
                          hlT(t.id, "transferable") ? "bg-warning/30" : "bg-secondary",
                        )}
                      >
                        {t.transferable ? "이관 가능" : "이관 불가"}
                      </span>
                    )}
                    {t.improve_type && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-accent-foreground",
                          hlT(t.id, "improve_type") ? "bg-warning/30" : "bg-primary-soft",
                        )}
                      >
                        개선: {t.improve_type}
                      </span>
                    )}
                  </div>
                  {t.improve_note && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      <EditableText
                        responseId={r.id}
                        table="response_tasks"
                        id={t.id}
                        field="improve_note"
                        value={t.improve_note}
                        multiline
                        highlight={hlT(t.id, "improve_note")}
                        readOnly={ro}
                      />
                    </div>
                  )}
                  {(t.response_activities.length > 0 || removedActs.length > 0) && (
                    <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
                      {t.response_activities.map((a) => (
                        <li key={a.id} className="flex gap-2">
                          <span className="text-muted-foreground">·</span>
                          <div className="min-w-0 flex-1">
                            <EditableText
                              responseId={r.id}
                              table="response_activities"
                              id={a.id}
                              field="name"
                              value={a.name}
                              highlight={diff?.activityChanged.has(a.id) ?? false}
                              readOnly={ro}
                            />
                          </div>
                          {diff?.activityAdded.has(a.id) && <NewBadge />}
                        </li>
                      ))}
                      {removedActs.map((a, j) => (
                        <li key={`removed-act-${j}`} className="flex items-center gap-2">
                          <span className="text-muted-foreground">·</span>
                          <span className="min-w-0 flex-1 text-muted-foreground line-through">
                            {norm(a["name"]) || "-"}
                          </span>
                          <RemovedBadge />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {diff && diff.tasks.removed.length > 0 && (
          <ul className="space-y-2">
            {diff.tasks.removed.map((t, i) => (
              <li
                key={`removed-task-${i}`}
                className="flex items-center gap-2 rounded-lg border border-dashed p-3"
              >
                <span className="min-w-0 flex-1 text-muted-foreground line-through">
                  {norm(t["name"]) || "-"}
                </span>
                <RemovedBadge />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`스킬 · 자격요건 (스킬 ${r.response_skills.length}건)`}>
        {r.response_skills.length === 0 ? (
          <p className="text-muted-foreground">등록된 스킬이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {r.response_skills.map((s) => (
              <li key={s.id} className="rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 font-medium">
                    <EditableText
                      responseId={r.id}
                      table="response_skills"
                      id={s.id}
                      field="name"
                      value={s.name}
                      highlight={hlS(s.id, "name")}
                      readOnly={ro}
                    />
                  </div>
                  {diff?.skills.added.has(s.id) && <NewBadge />}
                  {s.ai_draft && <AiDraftBadge />}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {s.ksao && (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        hlS(s.id, "ksao") ? "bg-warning/30" : "bg-secondary",
                      )}
                    >
                      {ksaoLabel(s.ksao)}
                    </span>
                  )}
                  {s.hard_soft && (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        hlS(s.id, "hard_soft") ? "bg-warning/30" : "bg-secondary",
                      )}
                    >
                      {s.hard_soft}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <EditableText
                    responseId={r.id}
                    table="response_skills"
                    id={s.id}
                    field="description"
                    value={s.description}
                    multiline
                    highlight={hlS(s.id, "description")}
                    readOnly={ro}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {diff && diff.skills.removed.length > 0 && (
          <ul className="space-y-2">
            {diff.skills.removed.map((s, i) => (
              <li
                key={`removed-skill-${i}`}
                className="flex items-center gap-2 rounded-lg border border-dashed p-3"
              >
                <span className="min-w-0 flex-1 text-muted-foreground line-through">
                  {norm(s["name"]) || "-"}
                </span>
                <RemovedBadge />
              </li>
            ))}
          </ul>
        )}

        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-muted-foreground">자격요건</p>
            {req?.ai_draft && <AiDraftBadge />}
          </div>
          {req ? (
            <dl className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="학력">
                <span className={cn(hlQ("education") && HL)}>{req.education ?? "-"}</span>
              </Field>
              <Field label="숙련 기간">
                <EditableText
                  responseId={r.id}
                  table="response_requirements"
                  id={req.id}
                  field="proficiency"
                  value={req.proficiency}
                  highlight={hlQ("proficiency")}
                  readOnly={ro}
                />
              </Field>
              <Field label="필수 전공">
                <EditableText
                  responseId={r.id}
                  table="response_requirements"
                  id={req.id}
                  field="majors_required"
                  value={req.majors_required}
                  highlight={hlQ("majors_required")}
                  readOnly={ro}
                />
              </Field>
              <Field label="우대 전공">
                <EditableText
                  responseId={r.id}
                  table="response_requirements"
                  id={req.id}
                  field="majors_preferred"
                  value={req.majors_preferred}
                  highlight={hlQ("majors_preferred")}
                  readOnly={ro}
                />
              </Field>
              <Field label="자격증">
                <span className={cn(hlQ("licenses") && HL)}>
                  {licenses.length === 0
                    ? "-"
                    : licenses
                        .map((l) => [l.name, l.grade, l.kind].filter(Boolean).join(" "))
                        .join(", ")}
                </span>
              </Field>
              <Field label="어학">
                <span className={cn(hlQ("languages") && HL)}>
                  {languages.length === 0
                    ? "-"
                    : languages
                        .map((l) => [l.language, l.level].filter(Boolean).join(" "))
                        .join(", ")}
                </span>
              </Field>
              <div className="sm:col-span-2">
                <Field label="교육 이수">
                  <EditableText
                    responseId={r.id}
                    table="response_requirements"
                    id={req.id}
                    field="trainings"
                    value={req.trainings}
                    multiline
                    highlight={hlQ("trainings")}
                    readOnly={ro}
                  />
                </Field>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-muted-foreground">작성된 자격요건이 없습니다.</p>
          )}
        </div>
      </Section>

      <Section title="자기평가">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="업무 포괄 정도">
            <span className={cn(hlR("coverage_pct") && HL)}>
              {r.coverage_pct ? `${r.coverage_pct}%` : "-"}
            </span>
          </Field>
          <Field label="온보딩 완료">
            <span className={cn(hlR("onboarding_done") && HL)}>
              {r.onboarding_done ? "예" : "아니오"}
            </span>
          </Field>
          <div className="sm:col-span-2">
            <Field label="누락된 업무">
              <EditableText
                responseId={r.id}
                table="responses"
                id={r.id}
                field="missed_note"
                value={r.missed_note}
                multiline
                highlight={hlR("missed_note")}
                readOnly={ro}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="업무 애로사항">
              <EditableText
                responseId={r.id}
                table="responses"
                id={r.id}
                field="pain_note"
                value={r.pain_note}
                multiline
                highlight={hlR("pain_note")}
                readOnly={ro}
              />
            </Field>
          </div>
        </dl>
      </Section>

      {r.review_comments.length > 0 && (
        <Section title={`검토 이력 (${r.review_comments.length}건)`}>
          <ul className="space-y-2">
            {r.review_comments.map((c) => (
              <li key={c.id} className="rounded-lg border p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {c.kind === "reject" ? "반려" : c.kind === "correction" ? "정정" : "코멘트"}
                    {c.step ? ` · ${STEPS[c.step - 1] ?? `${c.step}단계`}` : ""}
                  </span>
                  <span className="text-muted-foreground">{formatDate(c.created_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="sticky bottom-0 flex gap-2 border-t bg-card p-3 shadow-sm">
        <Button
          className="flex-1"
          disabled={approve.isPending || r.status === "approved" || r.status === "draft"}
          onClick={() => {
            if (data.jobCount <= 1) {
              setApproveOpen(true);
              return;
            }
            approve.mutate(false);
          }}
        >
          승인
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          disabled={reject.isPending || r.status === "rejected" || r.status === "draft"}
          onClick={() => setRejectOpen(true)}
        >
          반려
        </Button>
      </div>

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>인터뷰 확인 후 승인</DialogTitle>
            <DialogDescription>
              「{r.job_name ?? "직무 미입력"}」은 응답이 {data.jobCount}건뿐입니다. 후속 인터뷰로
              내용을 확인한 경우에만 승인할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox
              checked={interviewChecked}
              onCheckedChange={(v) => setInterviewChecked(v === true)}
            />
            <span>후속 인터뷰를 통해 응답 내용을 확인했습니다.</span>
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              취소
            </Button>
            <Button
              disabled={!interviewChecked || approve.isPending}
              onClick={() => approve.mutate(true)}
            >
              승인
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>응답 반려</DialogTitle>
            <DialogDescription>
              돌아갈 단계와 사유를 남기면 응답자가 해당 단계부터 다시 작성합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reject-step">되돌릴 단계</Label>
              <Select value={rejectStep} onValueChange={setRejectStep}>
                <SelectTrigger id="reject-step">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STEPS.map((label, i) => (
                    <SelectItem key={label} value={String(i + 1)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reject-comment">반려 사유 (필수)</Label>
              <Textarea
                id="reject-comment"
                rows={4}
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="어떤 부분을 어떻게 보완해야 하는지 구체적으로 적어 주세요."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectComment.trim() || reject.isPending}
              onClick={() => reject.mutate()}
            >
              반려
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type InfoRequestRow = Awaited<ReturnType<typeof listInfoRequests>>["rows"][number];
type InfoField = { field: string; current: string; requested: string };

/** A9 정정 수신함 — 참여자가 보낸 인사정보 정정 요청을 확인하고 반영한다. */
function InfoRequests({
  rows,
  isLoading,
  status,
  onStatusChange,
}: {
  rows: InfoRequestRow[];
  isLoading: boolean;
  status: string;
  onStatusChange: (v: string) => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{ row: InfoRequestRow; action: "처리완료" | "반려" } | null>(
    null,
  );
  const [adminNote, setAdminNote] = useState("");
  const [apply, setApply] = useState(true);

  const handle = useMutation({
    mutationFn: () =>
      handleInfoRequest({
        data: {
          id: target!.row.id,
          action: target!.action,
          adminNote: adminNote.trim() || undefined,
          apply: target!.action === "처리완료" ? apply : false,
        },
      }),
    onSuccess: (result) => {
      setTarget(null);
      setAdminNote("");
      toast.success(
        result.applied.length > 0
          ? `처리했습니다. ${result.applied.map(infoFieldLabel).join(", ")} 항목을 반영했습니다.`
          : "처리했습니다.",
      );
      void queryClient.invalidateQueries({ queryKey: ["info-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(`처리에 실패했습니다: ${errorMessage(err)}`),
  });

  const fieldsOf = (value: unknown): InfoField[] =>
    Array.isArray(value) ? (value as InfoField[]) : [];

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Select value={status} onValueChange={onStatusChange}>
          <SelectTrigger aria-label="정정 요청 상태 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="요청">요청</SelectItem>
            <SelectItem value="처리완료">처리완료</SelectItem>
            <SelectItem value="반려">반려</SelectItem>
            <SelectItem value="all">전체</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          조건에 맞는 정정 요청이 없습니다.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {r.participants?.name ?? "-"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      사번 {r.participants?.emp_no ?? "-"} ·{" "}
                      {r.participants?.companies?.name ?? "계열사 미지정"}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-muted-foreground">{formatDate(r.created_at)}</span>
                </div>
              </div>

              <ul className="mt-3 space-y-1 text-sm">
                {fieldsOf(r.fields).map((f, i) => (
                  <li key={`${f.field}-${i}`} className="flex flex-wrap gap-2">
                    <span className="font-medium">{infoFieldLabel(f.field)}</span>
                    <span className="text-muted-foreground">{f.current || "(비어 있음)"}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium text-primary">{f.requested}</span>
                  </li>
                ))}
              </ul>

              {r.note && (
                <p className="mt-2 whitespace-pre-wrap rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                  {r.note}
                </p>
              )}

              {r.admin_note && (
                <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                  관리자 의견: {r.admin_note}
                </p>
              )}

              {r.status === "요청" && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setApply(true);
                      setAdminNote("");
                      setTarget({ row: r, action: "처리완료" });
                    }}
                  >
                    처리
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAdminNote("");
                      setTarget({ row: r, action: "반려" });
                    }}
                  >
                    반려
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.action === "반려" ? "정정 요청 반려" : "정정 요청 처리"}
            </DialogTitle>
            <DialogDescription>
              처리 결과와 의견은 참여자의 1단계 화면에 그대로 표시됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {target?.action === "처리완료" && (
              <>
                <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                  <Checkbox checked={apply} onCheckedChange={(v) => setApply(v === true)} />
                  <span>
                    요청값을 참여자 정보에 바로 반영합니다. 성명·이메일·소속·직급·역할단계만
                    반영되며 사번·회사는 반영되지 않습니다.
                  </span>
                </label>
                <p className="rounded-lg bg-secondary p-3 text-xs text-muted-foreground">
                  이메일 변경 시 계정 이메일은 참여자 관리에서 별도 갱신해야 합니다.
                </p>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="info-admin-note">관리자 의견 (선택)</Label>
              <Textarea
                id="info-admin-note"
                rows={3}
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="처리 결과나 반려 사유를 적어 주세요."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={handle.isPending}>
              취소
            </Button>
            <Button
              variant={target?.action === "반려" ? "destructive" : "default"}
              disabled={handle.isPending}
              onClick={() => handle.mutate()}
            >
              {target?.action === "반려" ? "반려" : "처리완료"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function JobComparison({ jobNames, companyId }: { jobNames: string[]; companyId: string | null }) {
  const [job, setJob] = useState("");

  const { data, isFetching } = useQuery({
    queryKey: ["job-comparison", job, companyId],
    queryFn: () => getJobComparison({ data: { jobName: job, companyId } }),
    enabled: job.length > 0,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-primary/30 bg-primary-soft p-3 text-sm text-accent-foreground">
        <p className="font-semibold">역할단계 참조표</p>
        <p className="mt-1">{LV_GUIDE}</p>
      </div>

      <div className="max-w-sm">
        <Select value={job} onValueChange={setJob}>
          <SelectTrigger aria-label="비교할 직무 선택">
            <SelectValue placeholder="비교할 직무를 선택하세요" />
          </SelectTrigger>
          <SelectContent>
            {jobNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!job ? (
        <p className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          직무를 선택하면 응답자별 과업·스킬을 나란히 비교합니다.
        </p>
      ) : isFetching || !data ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : data.columns.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          비교할 응답이 없습니다.
        </p>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {data.columns.map((c) => (
            <div key={c.id} className="w-[300px] shrink-0 rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{c.participants?.name ?? "-"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.participants?.org_text ?? "-"}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold">
                  {c.participants?.role_level ?? "미지정"}
                </span>
              </div>

              <p className="mt-3 text-xs font-semibold text-muted-foreground">
                과업 {c.response_tasks.length}건
              </p>
              <ul className="mt-2 space-y-2">
                {c.response_tasks.map((t) => (
                  <li key={t.id} className="rounded-lg border p-2 text-xs">
                    <span className="block min-w-0">{t.name}</span>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className="rounded-full bg-secondary px-1.5 py-0.5">
                        중요도 {t.importance ?? "-"}
                      </span>
                      <span className="rounded-full bg-secondary px-1.5 py-0.5">
                        {t.authority ? AUTHORITY_LABELS[t.authority] : "미입력"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-xs font-semibold text-muted-foreground">
                스킬 {c.response_skills.length}건
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {c.response_skills.map((s) => (
                  <li key={s.id} className="flex gap-1.5">
                    <span className="text-muted-foreground">·</span>
                    <span className="min-w-0 flex-1">
                      {s.name}
                      {s.ksao ? ` (${ksaoLabel(s.ksao)})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
