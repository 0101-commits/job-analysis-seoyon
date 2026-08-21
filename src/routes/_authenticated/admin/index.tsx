import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge, STATUS_ORDER } from "@/components/StatusBadge";
import { PROGRESS_OF, PROGRESS_ORDER } from "@/lib/glossary";
import { EmptyState } from "@/components/EmptyState";
import { SectionNav, CollapsibleSection } from "@/components/SectionNav";
import {
  orgPathLabel,
  orgSubtreeIds,
  useOrgLens,
  UNASSIGNED_ORG,
} from "@/components/admin/OrgTreeFilter";
import { OrgHeatmap, type HeatGroup, type HeatRow } from "@/components/admin/OrgHeatmap";
import { WaveFilter, useWaveLens, type WaveOption } from "@/components/admin/WaveFilter";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import {
  getOrgOverview,
  type OrgOverview,
  type OverviewParticipant,
  type OverviewUnit,
} from "@/lib/dashboard.functions";
import { listWaves, type Wave } from "@/lib/wave.functions";

export const Route = createFileRoute("/_authenticated/admin/")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
  head: () => ({
    meta: [
      { title: "진행 현황 | 서연 그룹 업무조사" },
      { name: "description", content: "소속별 조사 진행 현황을 한눈에 확인합니다." },
      { property: "og:title", content: "진행 현황 | 서연 그룹 업무조사" },
      { property: "og:description", content: "소속별 조사 진행 현황을 한눈에 확인합니다." },
    ],
  }),
  component: DashboardPage,
});

/** 제출을 마친 상태 — 진행률의 분자. */
const DONE_STATUSES = ["제출", "승인"];
/** 작성을 한 번이라도 시작한 상태 — 착수율의 분자. */
const STARTED_STATUSES = ["작성중", "제출", "반려", "승인"];
/** 조직 미배정 참여자를 묶는 가상 노드 id. */
const UNASSIGNED = "__unassigned__";

/**
 * 딥링크 규약 (기획 P6).
 * 화면에 보이는 모든 수치는 그 수치를 만든 대상 목록으로 갈 수 있어야 한다.
 *   참여자 목록  /admin/participants?status=<상태[,상태]>&org=<소속id|none>
 *   검토 대기    /admin/review?status=submitted
 */
function participantsLink(params: { status?: string; org?: string }) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.org) q.set("org", params.org);
  const query = q.toString();
  return query ? `/admin/participants?${query}` : "/admin/participants";
}

const REVIEW_LINK = "/admin/review?status=submitted";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function daysSince(value: string | null) {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

function daysUntil(deadline: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${deadline}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

type Tracked = OverviewParticipant & {
  done: boolean;
  started: boolean;
  /** 기준일 이상 아무 움직임이 없다 — 미착수 판정의 근거. */
  stale: boolean;
  elapsed: number | null;
  /** 이 사람이 속한 계열사의 무활동 기준일. */
  threshold: number;
  lastActivity: string | null;
};

type Rollup = { total: number; started: number; done: number; approved: number; stalled: number };

const EMPTY_ROLLUP: Rollup = { total: 0, started: 0, done: 0, approved: 0, stalled: 0 };

function rollupOf(members: Tracked[]): Rollup {
  return {
    total: members.length,
    started: members.filter((m) => m.started).length,
    done: members.filter((m) => m.done).length,
    approved: members.filter((m) => m.account_status === "승인").length,
    stalled: members.filter((m) => m.stale).length,
  };
}

/** 계열사 스코프 + 소속 렌즈 + 차수 렌즈 → 조직 트리 → 하위 합산까지, 화면이 쓰는 파생 모델 전부. */
function buildModel(
  overview: OrgOverview,
  companyId: string,
  orgId: string | null,
  waveId: string | null,
) {
  const inScope = (cid: string) => companyId === "all" || cid === companyId;
  const staleDaysBy = new Map(overview.settings.map((s) => [s.company_id, s.stale_days]));

  const units = overview.units.filter((u) => inScope(u.company_id));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const children = new Map<string | null, OverviewUnit[]>();
  for (const u of units) {
    const key = u.parent_id && unitById.has(u.parent_id) ? u.parent_id : null;
    const list = children.get(key);
    if (list) list.push(u);
    else children.set(key, [u]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
  }

  // 소속 렌즈가 걸리면 그 하위 전부로 화면 전체를 좁힌다(미배정 인원은 빠진다).
  const subtree = orgSubtreeIds(units, orgId);
  const allowed = subtree ? new Set(subtree) : null;

  const respondents: Tracked[] = overview.participants
    .filter((p) => p.role === "respondent" && inScope(p.company_id))
    .filter((p) => !allowed || (p.org_unit_id !== null && allowed.has(p.org_unit_id)))
    // 차수 렌즈 — 「전체」(waveId=null)면 그대로, 아니면 이 차수에 지금 배정된 사람만.
    .filter((p) => !waveId || p.wave_id === waveId)
    .map((p) => {
      const lastActivity = p.last_seen_at ?? p.invited_at;
      const elapsed = daysSince(lastActivity);
      const done = DONE_STATUSES.includes(p.account_status);
      const threshold = staleDaysBy.get(p.company_id) ?? 7;
      return {
        ...p,
        lastActivity,
        elapsed,
        done,
        started: STARTED_STATUSES.includes(p.account_status),
        threshold,
        stale: !done && (elapsed === null || elapsed >= threshold),
      };
    });

  // 조직이 삭제돼 링크가 끊긴 인원도 미배정으로 묶는다.
  const membersByUnit = new Map<string, Tracked[]>();
  for (const p of respondents) {
    const key = p.org_unit_id && unitById.has(p.org_unit_id) ? p.org_unit_id : UNASSIGNED;
    const list = membersByUnit.get(key);
    if (list) list.push(p);
    else membersByUnit.set(key, [p]);
  }

  const rollup = new Map<string, Rollup>();
  const compute = (id: string): Rollup => {
    const acc = { ...rollupOf(membersByUnit.get(id) ?? []) };
    for (const child of children.get(id) ?? []) {
      const c = compute(child.id);
      acc.total += c.total;
      acc.started += c.started;
      acc.done += c.done;
      acc.approved += c.approved;
      acc.stalled += c.stalled;
    }
    rollup.set(id, acc);
    return acc;
  };
  for (const root of children.get(null) ?? []) compute(root.id);
  rollup.set(UNASSIGNED, rollupOf(membersByUnit.get(UNASSIGNED) ?? []));

  return { respondents, units, unitById, children, membersByUnit, rollup, staleDaysBy };
}

function DashboardPage() {
  const { companyId } = useCompanyScope();
  const { selectedOrgId, setSelectedOrgId } = useOrgLens();
  const { selectedWaveId, setSelectedWaveId } = useWaveLens();

  const {
    data: overview,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: async () => getOrgOverview({ headers: await authHeaders() }),
  });
  // 차수는 계열사별로 조회하는 함수라, 「전체 계열사」면 회사마다 불러 모은다.
  const companyIds = useMemo(() => (overview?.companies ?? []).map((c) => c.id), [overview]);
  const { data: waves } = useQuery({
    queryKey: ["dashboard-waves", companyId, companyIds.join(",")],
    queryFn: async () => {
      const headers = await authHeaders();
      const ids = companyId === "all" ? companyIds : [companyId];
      const lists = await Promise.all(
        ids.map((id) => listWaves({ data: { companyId: id }, headers })),
      );
      return lists.flat();
    },
    enabled: companyIds.length > 0,
  });

  // 소속 렌즈는 화면 간에 공유되므로, 계열사를 바꿔 트리에서 사라진 선택은 무시한다.
  const reference = useMemo(
    () => (overview ? buildModel(overview, companyId, null, selectedWaveId) : null),
    [overview, companyId, selectedWaveId],
  );
  const orgId = selectedOrgId && reference?.unitById.has(selectedOrgId) ? selectedOrgId : null;
  // 차수 렌즈도 같은 이유로 공유된다 — 계열사를 바꿔 목록에서 사라진 차수 선택은 무시한다.
  const waveId =
    selectedWaveId && (waves ?? []).some((w) => w.id === selectedWaveId) ? selectedWaveId : null;
  const model = useMemo(
    () => (overview ? buildModel(overview, companyId, orgId, waveId) : null),
    [overview, companyId, orgId, waveId],
  );
  const waveOptions: WaveOption[] = useMemo(
    () => (waves ?? []).map((w: Wave) => ({ id: w.id, name: w.name, status: w.status })),
    [waves],
  );
  const selectedWave = (waves ?? []).find((w) => w.id === waveId) ?? null;

  const companyName = useMemo(
    () => new Map((overview?.companies ?? []).map((c) => [c.id, c.name])),
    [overview],
  );

  // 차수를 선택했으면 그 차수의 마감을 기준으로 본다. 「전체」면 가장 이른 계열사 마감일.
  const deadline = useMemo(() => {
    if (selectedWave) return selectedWave.deadline;
    const scoped = (overview?.settings ?? []).filter(
      (s) => companyId === "all" || s.company_id === companyId,
    );
    const dates = scoped.map((s) => s.deadline).filter((d): d is string => Boolean(d));
    return dates.length ? (dates.sort()[0] ?? null) : null;
  }, [overview, companyId, selectedWave]);
  const dday = deadline ? daysUntil(deadline) : null;
  const ddayLabel = selectedWave ? `${selectedWave.name} 마감` : "제출 마감";
  const ddayText =
    selectedWave && selectedWave.status === "마감"
      ? `${selectedWave.name}은 마감되었습니다`
      : dday === null
        ? `${ddayLabel} 미설정`
        : dday < 0
          ? "마감일이 지났습니다"
          : `${ddayLabel}까지 D-${dday}`;

  const respondents = model?.respondents ?? [];
  const total = respondents.length;
  const started = respondents.filter((r) => r.started).length;
  const submitted = respondents.filter((r) => r.done).length;
  const asOf = formatDateTime(new Date().toISOString());
  const scopeLabel = [
    companyId === "all" ? "전체 계열사" : (companyName.get(companyId) ?? "선택 계열사"),
    orgPathLabel(model?.units ?? [], orgId),
    selectedWave?.name ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  // 진행 퍼널은 원상태 7종이 아니라 진행축 4단으로 접는다 (기획 5). 딥링크는 원상태 목록을 넘긴다.
  const funnel = useMemo(
    () =>
      PROGRESS_ORDER.map((stage) => {
        const statuses: string[] = STATUS_ORDER.filter((s) => PROGRESS_OF[s] === stage);
        const rows = respondents.filter((r) => statuses.includes(r.account_status));
        return {
          stage,
          statuses,
          count: rows.length,
          // 「기록이 없는」 미발송은 정체가 아니라 발송이 안 된 것이다 — 경과일이 있는 사람만 센다.
          stalled: rows.filter(
            (r) => r.elapsed !== null && r.elapsed >= r.threshold && r.account_status !== "승인",
          ).length,
        };
      }),
    [respondents],
  );

  // 검토축 요약 — 제출 이후 건이 어떤 판정 상태인지 한 줄로 (기획 5).
  const reviewCounts = useMemo(
    () => ({
      waiting: respondents.filter((r) => r.account_status === "제출").length,
      rejected: respondents.filter((r) => r.account_status === "반려").length,
      approved: respondents.filter((r) => r.account_status === "승인").length,
    }),
    [respondents],
  );

  /**
   * 히트맵 행 — 트리 위상 순서(부모 → 자식) 그대로, 미소속은 계열사별로 맨 아래 한 행.
   * 수치는 buildModel 의 하위 합산(rollup)을 그대로 쓴다.
   */
  const heatGroups: HeatGroup[] = useMemo(() => {
    if (!model) return [];
    const walk = (unit: OverviewUnit, depth: number, out: HeatRow[]) => {
      out.push({
        id: unit.id,
        name: unit.name,
        level: unit.level,
        depth,
        stats: model.rollup.get(unit.id) ?? EMPTY_ROLLUP,
      });
      for (const child of model.children.get(unit.id) ?? []) walk(child, depth + 1, out);
    };

    // 소속 렌즈가 걸리면 그 소속을 뿌리로 하위만 그린다(렌즈에는 미배정 인원이 없다).
    if (orgId) {
      const root = model.unitById.get(orgId);
      if (!root) return [];
      const rows: HeatRow[] = [];
      walk(root, 0, rows);
      return [{ key: orgId, title: null, rows }];
    }

    const unassignedByCompany = new Map<string, Tracked[]>();
    for (const p of model.membersByUnit.get(UNASSIGNED) ?? []) {
      const list = unassignedByCompany.get(p.company_id);
      if (list) list.push(p);
      else unassignedByCompany.set(p.company_id, [p]);
    }

    const roots = model.children.get(null) ?? [];
    const ids = companyId === "all" ? companyIds : [companyId];
    const groups: HeatGroup[] = [];
    for (const cid of ids) {
      const rows: HeatRow[] = [];
      for (const root of roots.filter((u) => u.company_id === cid)) walk(root, 0, rows);
      const unassigned = unassignedByCompany.get(cid);
      if (unassigned?.length) {
        rows.push({
          id: UNASSIGNED_ORG,
          name: "미소속",
          level: null,
          depth: 0,
          stats: rollupOf(unassigned),
        });
      }
      if (rows.length > 0) {
        groups.push({
          key: cid,
          title: companyId === "all" ? (companyName.get(cid) ?? "") : null,
          rows,
        });
      }
    }
    return groups;
  }, [model, orgId, companyId, companyIds, companyName]);

  const sections = [
    { id: "funnel", label: "진행 단계", count: total },
    { id: "participation", label: "조직 참여율" },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-bold sm:text-2xl">진행 현황</h1>
        <EmptyState
          kind="blocked"
          title="현황을 불러오지 못했습니다"
          description={error instanceof Error ? error.message : "잠시 뒤 다시 시도해 주세요."}
          actionLabel="다시 불러오기"
          onAction={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">진행 현황</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scopeLabel} · 대상 {total}명 · 기준 {asOf}
          </p>
        </div>
        {waveOptions.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">조사 차수</span>
            <WaveFilter waves={waveOptions} selectedId={waveId} onSelect={setSelectedWaveId} />
          </div>
        ) : null}
      </div>

      <SectionNav sections={sections} />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : total === 0 && heatGroups.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="이 범위에 참여자가 없습니다"
          description="참여자 명부를 올리거나 소속 선택을 넓히면 현황이 표시됩니다."
        >
          <a
            href="/admin/participants"
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            참여자 관리로 이동 →
          </a>
        </EmptyState>
      ) : (
        <>
          {/* B1 — 진행 단계 퍼널: 단계마다 그 상태의 명단으로 직행한다 */}
          <CollapsibleSection
            storageKey="dashboard"
            id="funnel"
            title="진행 단계"
            subtitle={`착수 ${started}명(${pct(started, total)}%) · 제출 ${submitted}명(${pct(submitted, total)}%) · ${ddayText}`}
          >
            <div className="overflow-x-auto pb-1">
              <ol className="flex items-stretch gap-1">
                {funnel.map((stage, i) => (
                  <li key={stage.stage} className="flex shrink-0 items-stretch gap-1">
                    <a
                      href={participantsLink({ status: stage.statuses.join(",") })}
                      className="flex w-[136px] flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-secondary/50"
                      title={`포함 상태: ${stage.statuses.join(", ")}`}
                    >
                      <StatusBadge status={stage.statuses[0]!} axis="progress" />
                      <span className="text-xl font-bold tabular-nums">{stage.count}명</span>
                      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct(stage.count, total)}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        전체의 {pct(stage.count, total)}%
                      </span>
                    </a>
                    {i < funnel.length - 1 ? (
                      <div className="flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 text-center">
                        <span className="text-muted-foreground" aria-hidden>
                          →
                        </span>
                        {stage.stalled > 0 ? (
                          <a
                            href={participantsLink({ status: stage.statuses.join(",") })}
                            className="text-[11px] font-medium leading-tight text-warning underline underline-offset-2"
                            title={`${stage.stage} 단계에서 기준일 이상 움직임이 없는 인원`}
                          >
                            {stage.stalled}명 정체
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
            {/* 검토축 요약 — 제출 이후 건의 판정 상태 (기획 5) */}
            <p className="mt-3 text-sm">
              <span className="text-muted-foreground">검토 현황 </span>
              <a
                href={REVIEW_LINK}
                className="font-medium text-primary underline underline-offset-2"
              >
                검토 대기 {reviewCounts.waiting}
              </a>
              <span className="text-muted-foreground"> · </span>
              <a
                href={participantsLink({ status: "반려" })}
                className="font-medium text-destructive underline underline-offset-2"
              >
                반려 {reviewCounts.rejected}
              </a>
              <span className="text-muted-foreground"> · </span>
              <a
                href={participantsLink({ status: "승인" })}
                className="font-medium text-success underline underline-offset-2"
              >
                승인 {reviewCounts.approved}
              </a>
            </p>
          </CollapsibleSection>

          {/* G4 — 조직 참여율 히트맵: 상하관계 순서 그대로, 행을 누르면 그 소속 기준으로 좁힌다 */}
          <section id="participation" className="scroll-mt-[var(--sticky-top)] space-y-3">
            <div>
              <h2 className="text-base font-semibold">조직 참여율</h2>
              <p className="text-xs text-muted-foreground">
                참여율 = 제출을 마친 인원 ÷ 배정 인원(하위 소속 합산). 색이 짙을수록 참여율이 높고,
                수치는 항상 함께 표시합니다. 행을 누르면 그 소속 기준으로 이 화면을 조회합니다.
              </p>
            </div>
            <OrgHeatmap
              groups={heatGroups}
              selectedId={orgId}
              selectedLabel={orgId ? orgPathLabel(model?.units ?? [], orgId) : null}
              onSelect={setSelectedOrgId}
              participantsHref={(id) => participantsLink({ org: id })}
            />
          </section>
        </>
      )}
    </div>
  );
}
