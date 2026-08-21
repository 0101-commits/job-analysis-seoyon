import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { EmptyState } from "@/components/EmptyState";
import { SectionNav, CollapsibleSection } from "@/components/SectionNav";
import { ReviewWorkbench, type CenterView, type ToolKey } from "@/components/admin/ReviewWorkbench";
import { ReviewQualityPanel } from "@/components/admin/ReviewQualityPanel";
import { InterviewPanel } from "@/components/admin/InterviewPanel";
import { InquiryInbox, inquiryAlerts, useInquiries } from "@/components/admin/InquiryInbox";
import { useCompanyScope } from "@/components/CompanyContext";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { handleInfoRequest, listInfoRequests, listReviewQueue } from "@/lib/review.functions";
import { infoFieldLabel } from "@/lib/survey.data";

/**
 * 응답 검토 화면.
 *
 * URL 규약 (D4) — 화면 상태는 전부 URL 이 원천이다. 새로고침·뒤로가기·링크 공유가 모두 동작하고,
 * 대시보드·참여자 목록·전역 검색·메일은 `?response=<id>` 로 이 화면의 한 건을 바로 연다.
 *
 *   ?response=<응답 id>            그 응답을 연 상태로 렌더 (딥링크 수신 규약)
 *   &status=submitted|draft|rejected|approved|all   검토 대기 목록 상태 필터 (기본 submitted)
 *   &q=<직무명 검색어>
 *   &view=detail|diff|job          가운데 패널: 원문 / 이전 제출과 비교 / 같은 직무 비교
 *   &job=<직무명>                  view=job 일 때 비교 대상 직무
 *   &req=요청|처리완료|반려|all    정보 수정 요청 구획 상태 필터 (기본 요청)
 *   &sort=risk|submitted           검토 대기 목록 정렬 (기본 risk = 주의 필요한 순)
 *   &tool=ai|history               판단 화면을 덮는 도구 층 (없으면 닫힌 상태)
 *   ?tab=inquiry                   문의함 구획을 펼친 상태로 열고 그 위치로 이동 (진행 현황 딥링크 수신)
 *   &co=<계열사 id> &org=<소속 id>  계열사·소속 렌즈 (기획 v2 P2) — 모든 관리 화면이 공유한다
 */

const QUEUE_STATUSES = ["submitted", "draft", "rejected", "approved", "all"] as const;
const VIEWS = ["detail", "diff", "job"] as const;
const REQ_STATUSES = ["요청", "처리완료", "반려", "all"] as const;
const SORTS = ["risk", "submitted"] as const;
const TOOLS = ["ai", "history"] as const;
const TABS = ["inquiry"] as const;

type QueueStatus = (typeof QUEUE_STATUSES)[number];
type ReqStatus = (typeof REQ_STATUSES)[number];
type QueueSort = (typeof SORTS)[number];
type Tool = (typeof TOOLS)[number];
type Tab = (typeof TABS)[number];

interface ReviewSearch extends LensSearch {
  response?: string;
  status?: QueueStatus;
  q?: string;
  view?: CenterView;
  job?: string;
  req?: ReqStatus;
  sort?: QueueSort;
  tool?: Tool;
  tab?: Tab;
}

/** 상태 변경 요청 — undefined 는 "이 키를 URL 에서 지운다"는 뜻이다. */
type SearchPatch = { [K in keyof ReviewSearch]?: ReviewSearch[K] | undefined };

/** 값이 없는 키는 URL 에 남기지 않는다 (exactOptionalPropertyTypes). */
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export const Route = createFileRoute("/_authenticated/admin/review")({
  validateSearch: (search: Record<string, unknown>): ReviewSearch => {
    const out: ReviewSearch = { ...pickLens(search) };
    const response = search["response"];
    if (typeof response === "string" && response.length > 0) out.response = response;
    const status = pick(search["status"], QUEUE_STATUSES);
    if (status) out.status = status;
    const q = search["q"];
    if (typeof q === "string" && q.trim().length > 0) out.q = q;
    const view = pick(search["view"], VIEWS);
    if (view) out.view = view;
    const job = search["job"];
    if (typeof job === "string" && job.length > 0) out.job = job;
    const req = pick(search["req"], REQ_STATUSES);
    if (req) out.req = req;
    const sort = pick(search["sort"], SORTS);
    if (sort) out.sort = sort;
    const tool = pick(search["tool"], TOOLS);
    if (tool) out.tool = tool;
    const tab = pick(search["tab"], TABS);
    if (tab) out.tab = tab;
    return out;
  },
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

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("ko-KR") : "-";
}

function ReviewPage() {
  const { companyId } = useCompanyScope();
  const scope = companyId === "all" ? null : companyId;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const status = search.status ?? "submitted";
  const jobQuery = search.q ?? "";
  const view = search.view ?? "detail";
  const reqStatus = search.req ?? "요청";
  const sort = search.sort ?? "risk";
  const selectedId = search.response ?? null;
  const tool: ToolKey = search.tool ?? null;
  // 판단 중에는 화면을 그 한 건에 내준다 — 훑기·문의·정정 요청 구획은 함께 띄우지 않는다.
  const focused = selectedId !== null;

  /** 화면 상태 변경은 전부 URL 갱신으로 처리한다. 빈 값은 키째 지운다. */
  function setSearch(patch: SearchPatch, replace = false) {
    void navigate({
      search: (prev: ReviewSearch) => {
        const next: SearchPatch = { ...prev, ...patch };
        for (const key of Object.keys(next) as (keyof SearchPatch)[]) {
          const value = next[key];
          if (value === undefined || value === "") delete next[key];
        }
        return next as ReviewSearch;
      },
      replace,
    });
  }

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue", scope, status, jobQuery, sort],
    queryFn: () =>
      listReviewQueue({
        data: {
          companyId: scope,
          status: status === "all" ? null : status,
          jobName: jobQuery.trim() || undefined,
          sort,
        },
      }),
  });

  const rows = data?.rows ?? [];
  const jobNames = Object.keys(data?.jobCounts ?? {}).sort((a, b) => a.localeCompare(b));
  const attention = rows.filter((r) => r.grade === "주의").length;

  const { data: infoData, isLoading: infoLoading } = useQuery({
    queryKey: ["info-requests", reqStatus],
    queryFn: () => listInfoRequests({ data: { status: reqStatus === "all" ? null : reqStatus } }),
  });

  // 문의는 구획이 접혀 있어도 건수·주의 표시를 띄워야 하므로 화면 쪽에서 읽는다.
  const inquiryQuery = useInquiries();
  const inquiry = inquiryAlerts(inquiryQuery.data);

  // 진행 현황의 「접수된 문의 N건」 카드가 ?tab=inquiry 로 이 화면을 연다.
  const inquiryTab = search.tab === "inquiry";
  useEffect(() => {
    if (inquiryTab) document.getElementById("inquiries")?.scrollIntoView({ block: "start" });
  }, [inquiryTab]);

  return (
    <div className="space-y-5">
      {!focused && (
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">응답 검토</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            제출된 업무조사를 한 건씩 판단합니다. 지금 조건에 맞는 응답 {rows.length}건.
          </p>
        </div>
      )}

      {!focused && (
        <SectionNav
          sections={[
            { id: "workbench", label: "검토 대기", count: rows.length },
            { id: "quality", label: "점검 결과", count: attention },
            { id: "interviews", label: "인터뷰 관리" },
            {
              id: "inquiries",
              label: inquiry.heavy.length > 0 ? "문의함 (주의)" : "문의함",
              count: inquiry.pending,
            },
            { id: "info-requests", label: "정보 수정 요청", count: infoData?.pending ?? 0 },
          ]}
        />
      )}

      <section id="workbench" className="scroll-mt-[var(--sticky-top)]">
        <ReviewWorkbench
          rows={rows}
          isLoading={isLoading}
          selectedId={selectedId}
          onSelect={(id) => setSearch({ response: id ?? undefined })}
          status={status}
          onStatusChange={(v) => setSearch({ status: v as QueueStatus })}
          query={jobQuery}
          onQueryChange={(v) => setSearch({ q: v }, true)}
          view={view}
          onViewChange={(v) => setSearch({ view: v === "detail" ? undefined : v })}
          compareJob={search.job ?? null}
          onCompareJobChange={(v) => setSearch({ job: v ?? undefined })}
          jobNames={jobNames}
          companyId={scope}
          sort={sort}
          onSortChange={(v) => setSearch({ sort: v === "risk" ? undefined : (v as QueueSort) })}
          tool={tool}
          onToolChange={(v) => setSearch({ tool: v ?? undefined })}
        />
      </section>

      {focused ? null : (
        <>
          <CollapsibleSection
            storageKey="review-page"
            id="quality"
            title="점검 결과 · 일괄 승인 후보"
            subtitle="규칙으로 응답을 확인해 주의가 필요한 건을 목록 위로 올리고, 양호한 건은 묶어서 승인합니다."
            aside={
              attention > 0 ? (
                <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground">
                  주의 {attention}
                </span>
              ) : null
            }
          >
            <ReviewQualityPanel
              rows={rows}
              unchecked={data?.unchecked ?? 0}
              companyId={scope}
              onSelect={(id) => setSearch({ response: id })}
            />
          </CollapsibleSection>

          <CollapsibleSection
            storageKey="review-page"
            id="interviews"
            title="인터뷰 관리"
            subtitle="응답자가 1명인 직무는 인터뷰 기록이 있어야 승인됩니다. 2~4명인 직무는 심층 검토 대상입니다."
            defaultCollapsed
          >
            <InterviewPanel companyId={scope} onSelect={(id) => setSearch({ response: id })} />
          </CollapsibleSection>

          {/*
        딥링크(?tab=inquiry)로 들어오면 펼친 채로 보여야 한다. 접힘 상태는 화면 단위 localStorage 에
        저장돼 밖에서 열 수 없으므로, 딥링크일 때만 저장 키를 갈라 접힘 기록을 타지 않게 한다.
        ponytail: 저장 키 분리로 해결 — CollapsibleSection 에 열림 제어 prop 이 생기면 그걸로 바꾼다.
      */}
          <CollapsibleSection
            storageKey={inquiryTab ? "review-page-inquiry-link" : "review-page"}
            id="inquiries"
            title="문의함"
            subtitle="참여자가 보낸 문의를 확인하고 답변합니다."
            defaultCollapsed={!inquiryTab}
            aside={
              inquiry.pending > 0 ? (
                <span
                  className={
                    inquiry.heavy.length > 0
                      ? "rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground"
                      : "rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"
                  }
                >
                  {inquiry.heavy.length > 0 ? `주의 ${inquiry.pending}` : inquiry.pending}
                </span>
              ) : null
            }
          >
            <InquiryInbox query={inquiryQuery} />
          </CollapsibleSection>

          <CollapsibleSection
            storageKey="review-page"
            id="info-requests"
            title="정보 수정 요청"
            subtitle="참여자가 보낸 인사정보 정정 요청을 확인하고 반영합니다."
            defaultCollapsed
            aside={
              infoData?.pending ? (
                <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground">
                  {infoData.pending}
                </span>
              ) : null
            }
          >
            <InfoRequests
              rows={infoData?.rows ?? []}
              isLoading={infoLoading}
              status={reqStatus}
              onStatusChange={(v) => setSearch({ req: v as ReqStatus })}
            />
          </CollapsibleSection>
        </>
      )}
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
        <EmptyState
          kind="nothing"
          title="처리할 정정 요청이 없습니다"
          description="참여자가 1단계에서 인사정보 정정을 요청하면 여기에 쌓입니다. 다른 상태를 보려면 위 필터를 바꾸세요."
        />
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
