import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  History,
  Keyboard,
  Pencil,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { SignalCard } from "@/components/SignalCard";
import { FieldHint } from "@/components/FieldHint";
import { ActionBar, DocPane, DocWide, ToolLayer } from "@/components/admin/panes";
import type { ActionGate } from "@/components/admin/panes";
import { AiInspector } from "@/components/admin/AiInspector";
import { QualityBadge } from "@/components/admin/QualityBadge";
import { cn } from "@/lib/utils";
import {
  approveResponse,
  correctField,
  getJobComparison,
  getResponseDetail,
  getSubmissionSnapshots,
  listReviewQueue,
  rejectResponse,
  upsertInterview,
} from "@/lib/review.functions";

/**
 * B3 검토 작업대 — 한 건을 판단하는 데 필요한 것을 한 화면에 놓는다.
 *
 *   좌  검토 대기 목록 (소속·직무·지연일)
 *   중  선택한 응답의 원문 전체. 보조 뷰로 이전 제출 비교·같은 직무 비교
 *   우  판단 패널 (승인·반려·필드 정정·AI 점검·정정 이력)
 *
 * 예전에는 탭 전환식이라 한 건을 판단하려면 원문과 비교와 AI 도구를 오가야 했고
 * 그 사이 맥락이 끊겼다. 좁은 화면에서는 3분할이 불가능하므로 목록 → 상세 2단계로 접힌다.
 */

export type QueueRow = Awaited<ReturnType<typeof listReviewQueue>>["rows"][number];
export type CenterView = "detail" | "diff" | "job";
/** 판단 화면을 덮는 도구 층. null 이면 층이 닫힌 상태다. */
export type ToolKey = "ai" | "history" | null;

type CorrectTable =
  | "responses"
  | "response_tasks"
  | "response_activities"
  | "response_skills"
  | "response_requirements";

/** 우측 판단 패널에서 정정 중인 항목. 가운데 원문에서 항목을 클릭하면 채워진다. */
type PickedField = {
  table: CorrectTable;
  id: string;
  field: string;
  label: string;
  value: string;
  multiline: boolean;
};

/**
 * 정정 연결 — 원문에서 누른 자리에 정정 입력을 띄운다.
 *
 * 예전에는 원문(가운데)에서 누르고 우측 패널에서 고쳤다. 시선이 매번 좌우로 600px 왕복했다.
 * 컨텍스트로 넘기면 원문 부품(Correctable)의 호출부를 스무 곳 고치지 않고도 그 자리에서 고칠 수 있다.
 */
const CorrectionCtx = createContext<{
  responseId: string;
  picked: PickedField | null;
  close: () => void;
} | null>(null);

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
// 시점 저장본(snapshot_submission RPC 산출물)과 현재 데이터를 필드 단위로 비교한다.

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
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style,
      )}
    >
      {count}인 · {label}
    </span>
  );
}

function AiDraftBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
      AI 초안
    </span>
  );
}

/* ── 작업대 껍데기 ──────────────────────────────────────────── */

export function ReviewWorkbench({
  rows,
  isLoading,
  selectedId,
  onSelect,
  status,
  onStatusChange,
  query,
  onQueryChange,
  view,
  onViewChange,
  compareJob,
  onCompareJobChange,
  jobNames,
  companyId,
  sort,
  onSortChange,
  tool,
  onToolChange,
}: {
  rows: QueueRow[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  status: string;
  onStatusChange: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  view: CenterView;
  onViewChange: (v: CenterView) => void;
  compareJob: string | null;
  onCompareJobChange: (v: string | null) => void;
  jobNames: string[];
  companyId: string | null;
  sort: string;
  onSortChange: (v: string) => void;
  tool: ToolKey;
  onToolChange: (v: ToolKey) => void;
}) {
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const prevId = index > 0 ? (rows[index - 1]?.id ?? null) : null;
  const nextId = index >= 0 ? (rows[index + 1]?.id ?? null) : null;

  /**
   * 돌아올 자리를 잃지 않는다.
   *
   * 훑다가 한 건을 열고 판단한 뒤 목록으로 오면, 스무 번째 행을 다시 찾아 내려가야 했다.
   * 판단으로 들어가는 순간의 스크롤 위치를 기억해 두고 돌아올 때 그 자리로 되돌린다.
   */
  const scanScrollRef = useRef(0);
  useEffect(() => {
    if (selectedId) {
      scanScrollRef.current = window.scrollY;
      window.scrollTo({ top: 0 });
    } else if (scanScrollRef.current > 0) {
      window.scrollTo({ top: scanScrollRef.current });
    }
  }, [selectedId]);

  // J/K 이동 — 단축키를 모르는 사용자도 [이전]·[다음] 버튼으로 같은 일을 할 수 있다(P12).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable)
        return;
      // 대화상자가 열려 있으면 그쪽 조작이 우선이다.
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      const target = key === "j" ? nextId : prevId;
      if (!target) return;
      e.preventDefault();
      onSelect(target);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextId, prevId, onSelect]);

  // 판단 상태에서는 목록이 화면에서 빠진다. 훑기와 판단을 나란히 두면 둘 다 좁아진다.
  if (selectedId) {
    return (
      <ResponseWorkspace
        key={selectedId}
        responseId={selectedId}
        onClose={() => onSelect(null)}
        prevId={prevId}
        nextId={nextId}
        onNavigate={onSelect}
        view={view}
        onViewChange={onViewChange}
        compareJob={compareJob}
        onCompareJobChange={onCompareJobChange}
        jobNames={jobNames}
        companyId={companyId}
        tool={tool}
        onToolChange={onToolChange}
        {...(index >= 0 ? { position: { index, total: rows.length } } : {})}
      />
    );
  }

  // 같은 직무 나란히 보기는 넓이가 실제로 필요한 블록이라 읽기 폭 상한을 벗어난다.
  if (view === "job") {
    return (
      <DocWide>
        <JobComparison
          jobNames={jobNames}
          companyId={companyId}
          job={compareJob}
          onJobChange={onCompareJobChange}
          onBack={() => onViewChange("detail")}
        />
      </DocWide>
    );
  }

  return (
    <QueueTable
      rows={rows}
      isLoading={isLoading}
      onSelect={onSelect}
      status={status}
      onStatusChange={onStatusChange}
      query={query}
      onQueryChange={onQueryChange}
      sort={sort}
      onSortChange={onSortChange}
      {...(jobNames.length > 0 ? { onCompareJobs: () => onViewChange("job") } : {})}
    />
  );
}

/* ── 훑기 — 전폭 표 ────────────────────────────────────────── */

/**
 * 목록은 스캔 작업이다. 카드(건당 110px)로는 한 화면에 6~8건뿐이라 훑을 수 없었다.
 * 행 높이 --row-h 표로 바꿔 18~22건이 한 번에 들어오게 한다. 등급은 좌측 스트라이프와
 * 배지로 두 번 부호화해 색만으로 구분하지 않는다.
 */
function QueueTable({
  rows,
  isLoading,
  onSelect,
  status,
  onStatusChange,
  query,
  onQueryChange,
  sort,
  onSortChange,
  onCompareJobs,
}: {
  rows: QueueRow[];
  isLoading: boolean;
  onSelect: (id: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  sort: string;
  onSortChange: (v: string) => void;
  onCompareJobs?: () => void;
}) {
  /**
   * 훑기 커서 — 수십 건을 손으로 넘기고 Enter 로 연다.
   *
   * 마우스로만 고르게 하면 한 건 열 때마다 손이 키보드를 떠난다. 커서는 표 안의 실제 포커스라
   * 화면 낭독기도 같은 행을 읽는다. 단축키를 모르는 사용자는 그대로 행을 누르면 된다.
   */
  const [cursor, setCursor] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // 조건이 바뀌면 목록이 갈리므로 커서를 처음으로 되돌린다.
  useEffect(() => {
    setCursor(0);
  }, [status, sort, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if (rows.length === 0) return;
      const key = e.key.toLowerCase();
      const step =
        key === "j" || e.key === "ArrowDown" ? 1 : key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        e.preventDefault();
        setCursor((c) => {
          const next = Math.min(rows.length - 1, Math.max(0, c + step));
          rowRefs.current[next]?.focus();
          return next;
        });
        return;
      }
      if (e.key === "Enter") {
        const row = rows[Math.min(cursor, rows.length - 1)];
        if (!row) return;
        e.preventDefault();
        onSelect(row.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, onSelect]);

  // 검토 적체 — 지금 목록 안 미검토 건의 평균 대기일 (V15-4)
  const waits = rows
    .filter((r) => r.status === "submitted" && r.submitted_at)
    .map((r) => daysSince(r.submitted_at!));
  const avgWait =
    waits.length > 0
      ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10
      : null;

  const cols =
    "grid-cols-[3px_minmax(0,2.4fr)_minmax(0,1.6fr)_104px_104px_92px] lg:grid-cols-[3px_minmax(0,2.4fr)_minmax(0,1.6fr)_104px_104px_92px_112px]";

  return (
    <div className="space-y-3">
      {/* 렌즈 바 — 좌측 필터 열을 없애고 한 줄로 올린다. 값은 전부 URL 에 남는다. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <Select value={status} onValueChange={onStatusChange}>
          <SelectTrigger className="w-[130px]" aria-label="상태 필터">
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
        <Select value={sort} onValueChange={onSortChange}>
          <SelectTrigger className="w-[190px]" aria-label="목록 정렬">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="risk">주의 필요한 순</SelectItem>
            <SelectItem value="submitted">제출 순 (최근 먼저)</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="직무명 검색 (/)"
            aria-label="직무명 검색"
            className="pl-9"
          />
        </div>
        {avgWait !== null && (
          <p className="text-xs tabular-nums text-muted-foreground">
            미검토 {waits.length}건 · 제출 후 평균 {avgWait}일 대기
          </p>
        )}
        {onCompareJobs ? (
          <Button variant="outline" size="sm" onClick={onCompareJobs}>
            <Columns3 className="size-4" /> 직무별로 나란히 보기
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : rows.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="조건에 맞는 응답이 없습니다"
          description="상태 필터를 바꾸거나 직무명 검색어를 지워 보세요."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className={cn(
              "grid items-center gap-3 border-b bg-secondary px-4 py-2 text-[11px] font-semibold text-muted-foreground",
              cols,
            )}
          >
            <span />
            <span>직무 · 성명</span>
            <span>소속</span>
            <span>등급</span>
            <span>대기</span>
            <span>응답 수</span>
            <span className="hidden lg:block">상태</span>
          </div>

          <ul>
            {rows.map((r, i) => {
              const late =
                r.status === "submitted" && r.submitted_at ? daysSince(r.submitted_at) : null;
              const attention = r.grade === "주의";
              return (
                <li key={r.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    onClick={() => onSelect(r.id)}
                    onFocus={() => setCursor(i)}
                    aria-current={i === cursor}
                    title={r.flags[0] ?? "판단 화면을 엽니다 (Enter)"}
                    className={cn(
                      "grid min-h-[var(--row-h)] w-full items-center gap-3 px-4 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:bg-primary-soft focus-visible:outline-none",
                      i === cursor && "bg-primary-soft/60",
                      cols,
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-5 w-[3px] rounded-full",
                        attention ? "bg-warning" : "bg-success",
                      )}
                    />
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-semibold">
                        {r.job_name ?? "직무 미입력"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {r.participants?.name ?? "-"}
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {r.companies?.name} · {r.participants?.org_text ?? "소속 미지정"}
                    </span>
                    <span className="justify-self-start">
                      <QualityBadge score={r.quality_score} />
                    </span>
                    <span
                      className={cn(
                        "text-xs tabular-nums",
                        late !== null && late > 5
                          ? "font-semibold text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {late !== null ? `${late}일` : "-"}
                    </span>
                    <span className="justify-self-start">
                      <JobCountBadge count={r.jobCount} />
                    </span>
                    <span className="hidden justify-self-start lg:block">
                      <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Keyboard className="size-3.5 shrink-0" aria-hidden />
        J·K(또는 ↑↓) 커서 이동 · Enter 열기 · / 검색. 판단 화면에서는 A 승인 · R 반려 · Esc 목록.
      </p>
    </div>
  );
}

/* ── 중 + 우: 한 건의 작업 공간 ─────────────────────────────── */

function ResponseWorkspace({
  responseId,
  onClose,
  prevId,
  nextId,
  onNavigate,
  view,
  onViewChange,
  compareJob,
  onCompareJobChange,
  jobNames,
  companyId,
  tool,
  onToolChange,
  position,
}: {
  responseId: string;
  onClose: () => void;
  prevId: string | null;
  nextId: string | null;
  onNavigate: (id: string) => void;
  view: CenterView;
  onViewChange: (v: CenterView) => void;
  compareJob: string | null;
  onCompareJobChange: (v: string | null) => void;
  jobNames: string[];
  companyId: string | null;
  tool: ToolKey;
  onToolChange: (v: ToolKey) => void;
  /** 목록에서 몇 번째 건인지 — 컨텍스트 바의 「3 / 47」 */
  position?: { index: number; total: number };
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<PickedField | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  // 1인 응답 직무 승인 창에서 그 자리에 남기는 인터뷰 기록
  const [ivWhen, setIvWhen] = useState("");
  const [ivWho, setIvWho] = useState("");
  const [ivMemo, setIvMemo] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectStep, setRejectStep] = useState("4");
  const [rejectComment, setRejectComment] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["review-detail", responseId],
    queryFn: () => getResponseDetail({ data: { responseId } }),
  });

  // V15-1 — 시점 저장본이 2개 이상(=재제출)일 때만 비교 뷰를 쓸 수 있다.
  const { data: snapData } = useQuery({
    queryKey: ["snapshots", responseId],
    queryFn: () => getSubmissionSnapshots({ data: { responseId } }),
  });
  const snaps = snapData?.list ?? [];
  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const diffOn = view === "diff" && prevSnap !== null;

  const { data: prevPayloadData } = useQuery({
    queryKey: ["snapshot-payload", responseId, prevSnap?.seq],
    queryFn: () => getSubmissionSnapshots({ data: { responseId, seq: prevSnap!.seq } }),
    enabled: diffOn,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["review-detail", responseId] });
    void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    void queryClient.invalidateQueries({ queryKey: ["interview-targets"] });
  }

  /** 판단이 끝나면 다음 건으로 넘긴다 — 목록으로 돌아가 다시 고르는 일을 없앤다. */
  function goNext() {
    if (nextId) onNavigate(nextId);
    else onClose();
  }

  const approve = useMutation({
    /** recordInterview 가 있으면 인터뷰 「완료」 기록을 먼저 남긴 뒤 승인한다(1인 응답 직무 게이트). */
    mutationFn: async (recordInterview?: { when: string; who: string; memo: string }) => {
      if (recordInterview) {
        await upsertInterview({
          data: {
            responseId,
            scheduledAt: recordInterview.when || null,
            interviewer: recordInterview.who.trim() || null,
            status: "완료",
            memo: recordInterview.memo.trim() || null,
          },
        });
      }
      return approveResponse({ data: { responseId } });
    },
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.reason ?? "승인할 수 없습니다.");
        if (result.needsInterview) setApproveOpen(true);
        else setApproveOpen(false);
        invalidate();
        return;
      }
      setApproveOpen(false);
      setIvWhen("");
      setIvWho("");
      setIvMemo("");
      toast.success(nextId ? "승인했습니다. 다음 건을 엽니다." : "응답이 승인되었습니다.");
      invalidate();
      goNext();
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
      toast.success(nextId ? "반려했습니다. 다음 건을 엽니다." : "응답이 반려되었습니다.");
      invalidate();
      goNext();
    },
    onError: (err) => toast.error(`반려에 실패했습니다: ${errorMessage(err)}`),
  });

  /**
   * 승인 실행 — 버튼과 단축키가 같은 경로를 쓴다.
   *
   * early return 앞에 두어야 단축키 훅이 조건 없이 이걸 참조할 수 있다. 그래서 데이터가
   * 아직 없을 때는 스스로 아무 일도 하지 않는다.
   */
  const runApprove = useCallback(() => {
    if (!data) return;
    const status = data.response.status;
    if (status === "approved" || status === "draft" || approve.isPending) return;
    // 1인 응답 직무는 인터뷰 「완료」 기록이 있어야 승인된다.
    const hasInterview = data.interviews.some((iv) => iv.status === "완료");
    if (data.jobCount <= 1 && !hasInterview) {
      setApproveOpen(true);
      return;
    }
    approve.mutate(undefined);
  }, [data, approve]);

  /**
   * 판단 화면 단축키 (기획 v2 P4 선행).
   *
   * 수백 건을 처리하는 화면이라 손이 마우스에 묶이면 안 된다. 단축키를 모르는 사용자도
   * 같은 일을 컨텍스트 바·액션 바 버튼으로 할 수 있고, 입력 중이거나 대화상자가 열려 있으면
   * 전부 비활성이다. 승인이 막힌 건에서 A 는 승인하지 않고 인터뷰 기록 창을 연다.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable)
        return;
      // 대화상자가 열려 있으면 그쪽 조작이 우선이다. 단 도구 층은 판단 화면의 일부이므로
      // 층이 열린 채로도 승인·반려·층 닫기가 손에서 이어져야 한다.
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog && dialog.id !== "tool-layer") return;
      // 정정 팝오버가 열려 있으면 그쪽 조작이 우선이다 (Esc 는 팝오버가 먼저 먹는다).
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        e.preventDefault();
        // 층이 열려 있으면 층만 닫고, 아니면 목록으로 돌아간다.
        if (tool !== null) onToolChange(null);
        else onClose();
        return;
      }
      if (key === "i") {
        e.preventDefault();
        onToolChange(tool === "ai" ? null : "ai");
        return;
      }
      if (key === "d") {
        // 시점 저장본이 없으면 비교할 것이 없다 — 켜 봐야 빈 상태가 URL 에만 남는다.
        if (!prevSnap) return;
        e.preventDefault();
        onViewChange(view === "diff" ? "detail" : "diff");
        return;
      }
      if (key === "r") {
        e.preventDefault();
        setRejectOpen(true);
        return;
      }
      if (key === "a") {
        e.preventDefault();
        runApprove();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, view, prevSnap, runApprove, onToolChange, onViewChange, onClose]);

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">불러오는 중...</p>;
  }

  const r = data.response;
  const req = r.response_requirements;
  const licenses = (req?.licenses ?? []) as { name?: string; kind?: string; grade?: string }[];
  const languages = (req?.languages ?? []) as { language?: string; level?: string }[];

  const diff =
    diffOn && prevSnap && prevPayloadData?.payload
      ? computeDiff(prevPayloadData.payload as SnapshotPayload, r)
      : null;
  // 비교 중에는 표시 레이어와 편집이 섞이지 않게 정정을 잠근다.
  const locked = diff !== null;
  const hlR = (f: string) => !!diff?.response.has(f);
  const hlT = (id: string, f: string) => !!diff?.tasks.changed.get(id)?.has(f);
  const hlS = (id: string, f: string) => !!diff?.skills.changed.get(id)?.has(f);
  const hlQ = (f: string) => !!diff?.requirements.has(f);

  /**
   * 정정 가능한 항목. 예전에는 비교 중이면 onPick 을 넘기지 않아 눌러도 아무 일이 없었다 —
   * 이유를 말하지 않는 침묵 실패였다. 잠긴 상태에서도 누를 수 있게 두고 이유를 알린다.
   */
  const pick = (f: Omit<PickedField, "multiline"> & { multiline?: boolean }) =>
    locked
      ? () =>
          toast.info(
            "이전 제출과 비교하는 동안에는 정정할 수 없습니다. [원문]으로 돌아가면 다시 정정할 수 있습니다.",
          )
      : () => setPicked({ multiline: false, ...f });

  const skillNames = r.response_skills.map((s) => s.name);
  const interviews = data.interviews;
  const interviewDone = interviews.some((iv) => iv.status === "완료");

  /** 막는 이유를 누르면 근거로 데려간다 — 회색 버튼만 남기지 않는다. */
  function focusEvidence() {
    document.getElementById("judge-evidence")?.scrollIntoView({ block: "start" });
  }

  const aiDraftCount = data.aiDraft.skills + (data.aiDraft.requirements ? 1 : 0);

  /** 승인을 막는 조건. 액션 바가 문장 칩으로 세우고, 누르면 근거·도구로 데려간다. */
  const gates: ActionGate[] = [];
  if (r.status === "draft") {
    gates.push({ label: "작성 중 응답", onFocus: focusEvidence });
  }
  if (data.jobCount <= 1 && !interviewDone) {
    gates.push({ label: "인터뷰 기록 없음", onFocus: focusEvidence });
  }
  if (data.aiDraft.any) {
    gates.push({ label: `AI 초안 ${aiDraftCount}건 미확정`, onFocus: () => onToolChange("ai") });
  }

  return (
    <CorrectionCtx.Provider value={{ responseId, picked, close: () => setPicked(null) }}>
      <div className="flex flex-col gap-4">
        {/* 상단 컨텍스트 바 — 맥락과 이동은 위, 결정은 아래, 가운데는 원문뿐 */}
        <div className="sticky top-[var(--header-h)] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2 sm:-mx-6 sm:px-6">
          <Button variant="outline" size="sm" onClick={onClose} title="목록으로 (Esc)">
            <ChevronLeft className="size-4" /> 목록
          </Button>
          {position ? (
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
              {position.index + 1} / {position.total}
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">
              {r.participants?.name ?? "-"} · {r.job_name ?? "직무 미입력"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {r.companies?.name} · {r.participants?.org_text ?? "소속 미지정"}
              {r.submitted_at ? ` · 제출 후 ${daysSince(r.submitted_at)}일` : ""}
            </span>
          </div>
          <QualityBadge score={data.quality.score} />
          <JobCountBadge count={data.jobCount} />
          <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant={view === "detail" ? "secondary" : "outline"}
              size="sm"
              onClick={() => onViewChange("detail")}
            >
              원문
            </Button>
            {prevSnap && (
              <Button
                variant={view === "diff" ? "secondary" : "outline"}
                size="sm"
                title="이전 제출과 비교 (D)"
                onClick={() => onViewChange(view === "diff" ? "detail" : "diff")}
              >
                이전 제출과 비교
              </Button>
            )}
            <Button
              variant={view === "job" ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                if (view !== "job" && r.job_name) onCompareJobChange(r.job_name);
                onViewChange(view === "job" ? "detail" : "job");
              }}
            >
              <Columns3 className="size-4" /> 같은 직무 비교
            </Button>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <Button
              variant={tool === "ai" ? "secondary" : "outline"}
              size="sm"
              title="AI 점검 (I)"
              onClick={() => onToolChange(tool === "ai" ? null : "ai")}
            >
              <Sparkles className="size-4" /> AI 점검
              {aiDraftCount > 0 ? (
                <span className="ml-1 rounded-full bg-warning/20 px-1.5 text-[11px] font-semibold tabular-nums text-warning">
                  {aiDraftCount}
                </span>
              ) : null}
            </Button>
            <Button
              variant={tool === "history" ? "secondary" : "outline"}
              size="sm"
              onClick={() => onToolChange(tool === "history" ? null : "history")}
            >
              <History className="size-4" /> 이력 {r.review_comments.length}
            </Button>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <Button
              variant="outline"
              size="sm"
              disabled={!prevId}
              title="이전 건 (K)"
              onClick={() => prevId && onNavigate(prevId)}
            >
              <ChevronLeft className="size-4" /> 이전
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextId}
              title="다음 건 (J)"
              onClick={() => nextId && onNavigate(nextId)}
            >
              다음 <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        {view === "job" ? (
          <DocWide>
            <JobComparison
              jobNames={jobNames}
              companyId={companyId}
              job={compareJob ?? r.job_name}
              onJobChange={onCompareJobChange}
              onBack={() => onViewChange("detail")}
            />
          </DocWide>
        ) : (
          <DocPane>
            {/*
            근거 스트립 — 판단 「전」에 읽는 것이다. 예전에는 우측 레일 위에 쌓여서
            신호가 많은 건일수록 승인 버튼이 화면 밖으로 밀렸다. 읽기 흐름 안으로 옮긴다.
          */}
            <div id="judge-evidence" className="scroll-mt-[var(--sticky-top)] space-y-2">
              {data.quality.flags.length > 0 && (
                <SignalCard
                  tone={data.quality.grade === "양호" ? "neutral" : "attention"}
                  signal={`점검에서 확인된 주의 사유가 ${data.quality.flags.length}건 있습니다 (${data.quality.grade} ${data.quality.score}점).`}
                  evidence={data.quality.flags}
                  {...(data.quality.checkedAt
                    ? { asOf: new Date(data.quality.checkedAt).toLocaleDateString("ko-KR") }
                    : {})}
                />
              )}

              {data.jobCount <= 1 && (
                <SignalCard
                  tone={interviewDone ? "good" : "attention"}
                  signal={
                    interviewDone
                      ? "1인 응답 직무이며 인터뷰 확인이 끝났습니다."
                      : "1인 응답 직무여서 인터뷰 확인 없이는 승인할 수 없습니다."
                  }
                  evidence={
                    interviewDone
                      ? [
                          `인터뷰 기록 ${interviews.length}건 중 「완료」 기록이 있어 승인 조건을 만족합니다.`,
                          "인터뷰에서 확인한 내용은 아래 원문의 인터뷰 기록에서 볼 수 있습니다.",
                        ]
                      : [
                          `같은 직무 응답이 ${data.jobCount}건뿐이라 응답만으로는 직무를 확정할 수 없습니다.`,
                          "승인을 누르면 인터뷰 기록을 남기는 창이 열립니다. 인터뷰 관리 구획에서 미리 남겨 두어도 됩니다.",
                        ]
                  }
                  asOf={new Date().toLocaleDateString("ko-KR")}
                />
              )}

              {data.aiDraft.any && (
                <SignalCard
                  tone="attention"
                  signal="확정되지 않은 AI 초안이 남아 승인할 수 없습니다."
                  evidence={[
                    `역량 ${data.aiDraft.skills}건${data.aiDraft.requirements ? " · 자격요건 포함" : ""}이 AI 초안 표시 상태입니다.`,
                    "위 [AI 점검]에서 확정하거나 원문에서 항목을 정정하면 승인 게이트가 풀립니다.",
                  ]}
                  asOf={new Date().toLocaleDateString("ko-KR")}
                />
              )}

              {r.status === "submitted" && r.submitted_at && daysSince(r.submitted_at) > 5 && (
                <SignalCard
                  tone="attention"
                  signal={`제출 후 ${daysSince(r.submitted_at)}일째 검토를 기다리고 있습니다.`}
                  evidence={[
                    `제출일 ${formatDate(r.submitted_at)} 기준 경과일입니다.`,
                    "5일을 넘기면 참여자가 보완 요청을 받아도 기억이 흐려집니다.",
                  ]}
                  asOf={new Date().toLocaleDateString("ko-KR")}
                />
              )}

              {r.status === "draft" && (
                <p className="rounded-xl border bg-secondary p-3 text-sm text-muted-foreground">
                  작성 중 응답은 승인·반려할 수 없고 열람·정정만 가능합니다. 정정하면 작성자가
                  화면을 열어 두었던 경우 최신 내용 확인 안내를 받게 됩니다.
                </p>
              )}
            </div>
            {view === "diff" && prevSnap && (
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
                {diff ? (
                  <>
                    {prevSnap.seq}차 제출({formatDate(prevSnap.created_at)}) 대비 변경분을
                    표시합니다 — <span className={HL}>노랑</span>=변경, 신규·삭제는 배지로
                    표시됩니다. 비교 중에는 정정이 잠깁니다.
                  </>
                ) : (
                  "비교 데이터를 불러오는 중..."
                )}
              </p>
            )}

            <Section title="기본 정보">
              <dl className="grid grid-cols-2 gap-3">
                <Field label="성명">{r.participants?.name ?? "-"}</Field>
                <Field label="사번">{r.participants?.emp_no ?? "-"}</Field>
                <Field label="소속">{r.participants?.org_text ?? "-"}</Field>
                <Field label="계열사">{r.companies?.name ?? "-"}</Field>
                <Field label="직급">{r.participants?.grade ?? "-"}</Field>
                <Field label="역할단계" hint="역할단계">
                  {r.participants?.role_level ?? "-"}
                </Field>
                <Field label="제출일">{formatDate(r.submitted_at)}</Field>
                <Field label="검토일">{formatDate(r.reviewed_at)}</Field>
              </dl>
            </Section>

            <Section title="직무">
              <dl className="grid gap-3 sm:grid-cols-3">
                <Field label="직군" hint="직군">
                  <Correctable
                    value={r.job_group}
                    highlight={hlR("job_group")}
                    picked={picked?.field === "job_group"}
                    onPick={pick({
                      table: "responses",
                      id: r.id,
                      field: "job_group",
                      label: "직군",
                      value: r.job_group ?? "",
                    })}
                  />
                </Field>
                <Field label="직렬" hint="직렬">
                  <Correctable
                    value={r.job_series}
                    highlight={hlR("job_series")}
                    picked={picked?.field === "job_series"}
                    onPick={pick({
                      table: "responses",
                      id: r.id,
                      field: "job_series",
                      label: "직렬",
                      value: r.job_series ?? "",
                    })}
                  />
                </Field>
                <Field label="직무명" hint="직무">
                  <Correctable
                    value={r.job_name}
                    highlight={hlR("job_name")}
                    picked={picked?.field === "job_name"}
                    onPick={pick({
                      table: "responses",
                      id: r.id,
                      field: "job_name",
                      label: "직무명",
                      value: r.job_name ?? "",
                    })}
                  />
                </Field>
              </dl>
            </Section>

            <Section title="정의 · 목적">
              <Field label="직무 정의">
                <Correctable
                  value={r.definition}
                  highlight={hlR("definition")}
                  picked={picked?.field === "definition"}
                  onPick={pick({
                    table: "responses",
                    id: r.id,
                    field: "definition",
                    label: "직무 정의",
                    value: r.definition ?? "",
                    multiline: true,
                  })}
                />
              </Field>
              <Field label="직무 미션">
                <Correctable
                  value={r.mission}
                  highlight={hlR("mission")}
                  picked={picked?.field === "mission"}
                  onPick={pick({
                    table: "responses",
                    id: r.id,
                    field: "mission",
                    label: "직무 미션",
                    value: r.mission ?? "",
                    multiline: true,
                  })}
                />
              </Field>
            </Section>

            <Section title={`과업 (${r.response_tasks.length}건)`} hint="과업">
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
                            <Correctable
                              value={t.name}
                              highlight={hlT(t.id, "name")}
                              picked={picked?.id === t.id && picked?.field === "name"}
                              onPick={pick({
                                table: "response_tasks",
                                id: t.id,
                                field: "name",
                                label: `과업 ${i + 1} 이름`,
                                value: t.name ?? "",
                                multiline: true,
                              })}
                            />
                          </div>
                          {diff?.tasks.added.has(t.id) && <NewBadge />}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                              hlT(t.id, "importance") ? "bg-warning/30" : "bg-secondary",
                            )}
                          >
                            중요도 {t.importance ?? "-"}
                            <FieldHint term="중요도" />
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                              hlT(t.id, "authority") ? "bg-warning/30" : "bg-secondary",
                            )}
                          >
                            {t.authority ? AUTHORITY_LABELS[t.authority] : "책임수준 미입력"}
                            <FieldHint term="책임수준" />
                          </span>
                          {t.transferable !== null && (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                                hlT(t.id, "transferable") ? "bg-warning/30" : "bg-secondary",
                              )}
                            >
                              {t.transferable ? "이관 가능" : "이관 불가"}
                              <FieldHint term="이관가능" />
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
                            <Correctable
                              value={t.improve_note}
                              highlight={hlT(t.id, "improve_note")}
                              picked={picked?.id === t.id && picked?.field === "improve_note"}
                              onPick={pick({
                                table: "response_tasks",
                                id: t.id,
                                field: "improve_note",
                                label: `과업 ${i + 1} 개선의견`,
                                value: t.improve_note ?? "",
                                multiline: true,
                              })}
                            />
                          </div>
                        )}
                        {(t.response_activities.length > 0 || removedActs.length > 0) && (
                          <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
                            {t.response_activities.map((a, j) => (
                              <li key={a.id} className="flex gap-2">
                                <span className="text-muted-foreground">·</span>
                                <div className="min-w-0 flex-1">
                                  <Correctable
                                    value={a.name}
                                    highlight={diff?.activityChanged.has(a.id) ?? false}
                                    picked={picked?.id === a.id}
                                    onPick={pick({
                                      table: "response_activities",
                                      id: a.id,
                                      field: "name",
                                      label: `과업 ${i + 1} 세부 활동 ${j + 1}`,
                                      value: a.name ?? "",
                                    })}
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

            <Section
              title={`필요 역량 · 자격요건 (역량 ${r.response_skills.length}건)`}
              hint="필요 역량"
            >
              {r.response_skills.length === 0 ? (
                <p className="text-muted-foreground">등록된 필요 역량이 없습니다.</p>
              ) : (
                <ul className="space-y-2">
                  {r.response_skills.map((s) => (
                    <li key={s.id} className="rounded-lg border p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 font-medium">
                          <Correctable
                            value={s.name}
                            highlight={hlS(s.id, "name")}
                            picked={picked?.id === s.id && picked?.field === "name"}
                            onPick={pick({
                              table: "response_skills",
                              id: s.id,
                              field: "name",
                              label: "역량 이름",
                              value: s.name ?? "",
                            })}
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
                        <Correctable
                          value={s.description}
                          highlight={hlS(s.id, "description")}
                          picked={picked?.id === s.id && picked?.field === "description"}
                          onPick={pick({
                            table: "response_skills",
                            id: s.id,
                            field: "description",
                            label: `역량 설명(${s.name})`,
                            value: s.description ?? "",
                            multiline: true,
                          })}
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
                      <Correctable
                        value={req.proficiency}
                        highlight={hlQ("proficiency")}
                        picked={picked?.field === "proficiency"}
                        onPick={pick({
                          table: "response_requirements",
                          id: req.id,
                          field: "proficiency",
                          label: "숙련 기간",
                          value: req.proficiency ?? "",
                        })}
                      />
                    </Field>
                    <Field label="필수 전공">
                      <Correctable
                        value={req.majors_required}
                        highlight={hlQ("majors_required")}
                        picked={picked?.field === "majors_required"}
                        onPick={pick({
                          table: "response_requirements",
                          id: req.id,
                          field: "majors_required",
                          label: "필수 전공",
                          value: req.majors_required ?? "",
                        })}
                      />
                    </Field>
                    <Field label="우대 전공">
                      <Correctable
                        value={req.majors_preferred}
                        highlight={hlQ("majors_preferred")}
                        picked={picked?.field === "majors_preferred"}
                        onPick={pick({
                          table: "response_requirements",
                          id: req.id,
                          field: "majors_preferred",
                          label: "우대 전공",
                          value: req.majors_preferred ?? "",
                        })}
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
                        <Correctable
                          value={req.trainings}
                          highlight={hlQ("trainings")}
                          picked={picked?.field === "trainings"}
                          onPick={pick({
                            table: "response_requirements",
                            id: req.id,
                            field: "trainings",
                            label: "교육 이수",
                            value: req.trainings ?? "",
                            multiline: true,
                          })}
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
                    <Correctable
                      value={r.missed_note}
                      highlight={hlR("missed_note")}
                      picked={picked?.field === "missed_note"}
                      onPick={pick({
                        table: "responses",
                        id: r.id,
                        field: "missed_note",
                        label: "누락된 업무",
                        value: r.missed_note ?? "",
                        multiline: true,
                      })}
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="업무 애로사항">
                    <Correctable
                      value={r.pain_note}
                      highlight={hlR("pain_note")}
                      picked={picked?.field === "pain_note"}
                      onPick={pick({
                        table: "responses",
                        id: r.id,
                        field: "pain_note",
                        label: "업무 애로사항",
                        value: r.pain_note ?? "",
                        multiline: true,
                      })}
                    />
                  </Field>
                </div>
              </dl>
            </Section>

            {interviews.length > 0 && (
              <Section title="인터뷰 기록">
                <ul className="space-y-2">
                  {interviews.map((iv) => (
                    <li key={iv.id} className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">
                        {iv.status} ·{" "}
                        {iv.scheduled_at
                          ? new Date(iv.scheduled_at).toLocaleString("ko-KR")
                          : "일정 미정"}{" "}
                        · {iv.interviewer || "담당 미지정"}
                      </p>
                      {iv.memo ? (
                        <p className="mt-1 whitespace-pre-wrap">{iv.memo}</p>
                      ) : (
                        <p className="mt-1 text-muted-foreground">남긴 내용이 없습니다.</p>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  인터뷰에서 확인한 내용은 그대로 보관되어 직무기술서 작성에서 근거로 함께 읽힙니다.
                </p>
              </Section>
            )}
          </DocPane>
        )}

        <ActionBar
          className="-mx-4 sm:-mx-6"
          primary={
            <Button
              disabled={approve.isPending || r.status === "approved" || r.status === "draft"}
              onClick={runApprove}
            >
              승인 <span className="ml-1 text-xs opacity-70">A</span>
            </Button>
          }
          secondary={
            <Button
              variant="outline"
              disabled={reject.isPending || r.status === "rejected" || r.status === "draft"}
              onClick={() => setRejectOpen(true)}
            >
              반려 <span className="ml-1 text-xs text-muted-foreground">R</span>
            </Button>
          }
          gates={gates}
          hint={
            <span className="tabular-nums">
              A 승인 · R 반려 · I 점검 · D 비교 · J·K 이동 · Esc 목록
              {nextId ? " · 판단하면 다음 건이 열립니다" : ""}
            </span>
          }
        />

        {/*
        도구 층 — 점검·이력은 한 건에 한두 번 쓴다. 상시 폭을 주지 않고 원문을 덮는 층으로 띄운다.
        층은 원문을 밀어내지 않으므로 닫으면 읽던 자리가 그대로 남는다.
      */}
        <ToolLayer
          open={tool !== null}
          onOpenChange={(open) => onToolChange(open ? (tool ?? "ai") : null)}
          title={tool === "history" ? "정정·검토 이력" : "AI 점검"}
          description={
            tool === "history"
              ? `이 응답에 남은 정정·반려 기록 ${r.review_comments.length}건입니다.`
              : "AI 초안을 확정하거나 보완 요청 문구 초안을 만듭니다."
          }
        >
          {tool === "history" ? (
            r.review_comments.length === 0 ? (
              <p className="rounded-xl border border-dashed bg-card p-4 text-center text-xs text-muted-foreground">
                아직 남은 이력이 없습니다. 정정·반려를 하면 여기에 기록됩니다.
              </p>
            ) : (
              <ul className="space-y-2">
                {r.review_comments.map((c) => (
                  <li key={c.id} className="rounded-lg border bg-card p-3 text-xs">
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
            )
          ) : (
            <AiInspector
              responseId={responseId}
              jobName={r.job_name}
              skillNames={skillNames}
              aiDraftCount={aiDraftCount}
              companyId={companyId}
              onUseRejectDraft={(text, step) => {
                setRejectComment(text);
                setRejectStep(String(step));
                onToolChange(null);
                setRejectOpen(true);
              }}
              onApplied={invalidate}
            />
          )}
        </ToolLayer>

        <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>인터뷰 확인 후 승인</DialogTitle>
              <DialogDescription>
                「{r.job_name ?? "직무 미입력"}」은 응답이 {data.jobCount}건뿐입니다. 후속 인터뷰로
                내용을 확인하고 그 기록을 남긴 경우에만 승인할 수 있습니다. 아래에 인터뷰 내용을
                적으면 「완료」 기록으로 남기고 바로 승인합니다.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="iv-when">인터뷰 일시 (선택)</Label>
                  <Input
                    id="iv-when"
                    type="datetime-local"
                    value={ivWhen}
                    onChange={(e) => setIvWhen(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="iv-who">담당 (선택)</Label>
                  <Input
                    id="iv-who"
                    value={ivWho}
                    onChange={(e) => setIvWho(e.target.value)}
                    placeholder="인터뷰를 진행한 사람"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="iv-memo">인터뷰에서 확인한 내용 (필수)</Label>
                <Textarea
                  id="iv-memo"
                  rows={5}
                  value={ivMemo}
                  onChange={(e) => setIvMemo(e.target.value)}
                  placeholder="응답에서 확인·보완한 내용을 적어 주세요. 이 기록이 승인 근거로 남고 직무기술서 작성에서 함께 읽힙니다."
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setApproveOpen(false)}>
                취소
              </Button>
              <Button
                disabled={!ivMemo.trim() || approve.isPending}
                onClick={() => approve.mutate({ when: ivWhen, who: ivWho, memo: ivMemo })}
              >
                인터뷰 기록 후 승인
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
                  rows={5}
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
    </CorrectionCtx.Provider>
  );
}

/* ── 원문 표시 부품 ─────────────────────────────────────────── */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  /** FIELD_DEFINITIONS 항목명 — 제목 옆에 뜻을 붙인다. */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-primary">
        {title}
        {hint ? <FieldHint term={hint} /> : null}
      </h3>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint ? <FieldHint term={hint} /> : null}
      </p>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}

/**
 * 정정 가능한 값. 클릭하면 우측 판단 패널이 그 항목의 정정 상태가 된다.
 * onPick 이 없으면(비교 중·정정 불가 필드) 그냥 텍스트로만 보인다.
 */
function Correctable({
  value,
  highlight,
  picked,
  onPick,
}: {
  value: string | null;
  highlight?: boolean;
  picked?: boolean;
  onPick?: (() => void) | undefined;
}) {
  const ctx = useContext(CorrectionCtx);
  const text = (
    <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", highlight && HL)}>
      {value || "-"}
    </span>
  );
  if (!onPick) return <span className="block">{text}</span>;

  const trigger = (
    <button
      type="button"
      onClick={onPick}
      title="누르면 이 자리에서 정정할 수 있습니다"
      className={cn(
        "group flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary",
        picked && "bg-primary-soft ring-1 ring-primary",
      )}
    >
      {text}
      <Pencil
        className={cn(
          "mt-0.5 size-3 shrink-0 text-muted-foreground transition-opacity",
          picked ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        aria-hidden
      />
    </button>
  );

  if (!picked || !ctx?.picked) return trigger;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) ctx.close();
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(30rem,92vw)] border-0 bg-transparent p-0 shadow-none"
      >
        <CorrectionPanel responseId={ctx.responseId} picked={ctx.picked} onClose={ctx.close} />
      </PopoverContent>
    </Popover>
  );
}

/* ── 우: 필드 정정 ──────────────────────────────────────────── */

/** 관리자 직접 정정 — 저장하면 review_comments 에 정정 이력이 남는다. */
function CorrectionPanel({
  responseId,
  picked,
  onClose,
}: {
  responseId: string;
  picked: PickedField;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  // 다른 항목을 고르면 그 값으로 갈아탄다.
  useEffect(() => {
    setDraft(picked.value);
  }, [picked.table, picked.id, picked.field, picked.value]);

  const mutation = useMutation({
    mutationFn: () =>
      correctField({
        data: {
          responseId,
          table: picked.table,
          id: picked.id,
          field: picked.field,
          value: draft,
        },
      }),
    onSuccess: (result) => {
      if (result.changed) {
        toast.success("정정 내용이 기록되었습니다.");
        void queryClient.invalidateQueries({ queryKey: ["review-detail", responseId] });
        void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      } else {
        toast.info("바뀐 내용이 없어 그대로 두었습니다.");
      }
      onClose();
    },
    onError: (err) => toast.error(`정정에 실패했습니다: ${errorMessage(err)}`),
  });

  return (
    <div className="space-y-2 rounded-xl border border-primary/40 bg-card p-4 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold">{picked.label} 정정</p>
        <button
          type="button"
          aria-label="정정 닫기"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      {picked.multiline ? (
        <Textarea
          value={draft}
          rows={5}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`${picked.label} 정정 내용`}
        />
      ) : (
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`${picked.label} 정정 내용`}
        />
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Check className="size-4" /> 저장
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X className="size-4" /> 취소
        </Button>
      </div>
    </div>
  );
}

/* ── 중앙 보조 뷰: 같은 직무 나란히 보기 ───────────────────── */

function JobComparison({
  jobNames,
  companyId,
  job,
  onJobChange,
  onBack,
}: {
  jobNames: string[];
  companyId: string | null;
  job: string | null;
  onJobChange: (v: string | null) => void;
  onBack: () => void;
}) {
  const selected = job ?? "";
  const { data, isFetching } = useQuery({
    queryKey: ["job-comparison", selected, companyId],
    queryFn: () => getJobComparison({ data: { jobName: selected, companyId } }),
    enabled: selected.length > 0,
  });

  const options = useMemo(
    () => (selected && !jobNames.includes(selected) ? [selected, ...jobNames] : jobNames),
    [jobNames, selected],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-primary/30 bg-primary-soft p-3 text-sm text-accent-foreground">
        <p className="font-semibold">역할단계 참조표</p>
        <p className="mt-1">{LV_GUIDE}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Select value={selected} onValueChange={onJobChange}>
            <SelectTrigger aria-label="비교할 직무 선택">
              <SelectValue placeholder="비교할 직무를 선택하세요" />
            </SelectTrigger>
            <SelectContent>
              {options.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>
          원문으로
        </Button>
      </div>

      {!selected ? (
        <EmptyState
          kind="nothing"
          title="비교할 직무를 고르세요"
          description="직무를 선택하면 같은 직무를 맡은 응답자들의 과업·필요 역량을 나란히 놓고 볼 수 있습니다."
        />
      ) : isFetching || !data ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : data.columns.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="비교할 응답이 없습니다"
          description={`「${selected}」에는 제출·승인된 응답이 없습니다. 다른 직무를 선택하거나 참여자 진행 상황을 확인해 보세요.`}
        />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {data.columns.map((c) => (
            <div key={c.id} className="w-[280px] shrink-0 rounded-xl border bg-card p-4 shadow-sm">
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
                필요 역량 {c.response_skills.length}건
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
