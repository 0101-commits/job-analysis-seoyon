import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge, STATUS_ORDER } from "@/components/StatusBadge";
import { josa } from "@/lib/glossary";
import { SignalCard, type SignalAction, type SignalTone } from "@/components/SignalCard";
import { EmptyState } from "@/components/EmptyState";
import { SectionNav, CollapsibleSection } from "@/components/SectionNav";
import {
  OrgTreeFilter,
  orgPathLabel,
  orgSubtreeIds,
  useOrgLens,
} from "@/components/admin/OrgTreeFilter";
import { WaveFilter, useWaveLens, type WaveOption } from "@/components/admin/WaveFilter";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import {
  checkIntegrity,
  getDashboardSignals,
  getLaunchReadiness,
  getOrgOverview,
  type DashboardSignals,
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
/** 독려 안내를 보낼 대상 상태 — 아직 시작하지 않은 사람들. */
const NOT_STARTED_STATUSES = ["미발송", "초대발송", "미접속"];
/** 조직 미배정 참여자를 묶는 가상 노드 id. */
const UNASSIGNED = "__unassigned__";
/** 한 화면에 띄우는 미착수 소속 카드 수 상한 — 더 많으면 소속별 표에서 본다. */
const ORG_SIGNAL_LIMIT = 3;

/**
 * 딥링크 규약 (기획 P6).
 * 화면에 보이는 모든 수치는 그 수치를 만든 대상 목록으로 갈 수 있어야 한다.
 *   참여자 목록  /admin/participants?status=<상태>&org=<소속id|unassigned>
 *   메일 화면    /admin/mail?org=<소속id>&status=<상태,상태>   (template·ids 는 쓰지 않는다)
 *   검토 대기    /admin/review?status=submitted
 */
function participantsLink(params: { status?: string; org?: string }) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.org) q.set("org", params.org);
  const query = q.toString();
  return query ? `/admin/participants?${query}` : "/admin/participants";
}

function mailLink(orgId: string, statuses: string[]) {
  const q = new URLSearchParams({ org: orgId, status: statuses.join(",") });
  return `/admin/mail?${q.toString()}`;
}

const REVIEW_LINK = "/admin/review?status=submitted";
/**
 * 문의함·재확인 화면은 아직 만들어지지 않았다(각각 다른 담당). 그 화면이 생기면 이
 * 규약대로 탭을 열게 맞춰 달라고 최종 보고에 남긴다.
 */
const INQUIRY_LINK = "/admin/review?tab=inquiry";
const RECHECK_LINK = "/admin/master?tab=recheck";

/** 개시 준비 항목별로 가야 할 화면 — 못 채운 항목은 카드로 남기고 그 화면으로 보낸다. */
const READINESS_LINKS: Record<string, { label: string; href: string }> = {
  org: { label: "기준정보에서 조직도 올리기", href: "/admin/master" },
  jobs: { label: "기준정보에서 직무 분류 올리기", href: "/admin/master" },
  deadline: { label: "설정에서 제출 마감 지정", href: "/admin/settings" },
  mail: { label: "설정에서 발송 상태 확인", href: "/admin/settings" },
  roster: { label: "참여자 명부 올리기", href: "/admin/participants" },
  testMail: { label: "메일 화면에서 시험 발송", href: "/admin/mail" },
};

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

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
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

type Model = ReturnType<typeof buildModel>;

type PeriodKey = "today" | "week" | "all";

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "오늘" },
  { key: "week", label: "이번 주" },
  { key: "all", label: "조사 전체" },
];

/** 기간의 시작 시각. 「조사 전체」는 경계가 없다. */
function periodStart(key: PeriodKey): Date | null {
  if (key === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (key === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 월요일 시작
  return d;
}

function DashboardPage() {
  const { companyId } = useCompanyScope();
  const { selectedOrgId, setSelectedOrgId } = useOrgLens();
  const { selectedWaveId, setSelectedWaveId } = useWaveLens();
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  const {
    data: overview,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: async () => getOrgOverview({ headers: await authHeaders() }),
  });
  const { data: signals } = useQuery({
    queryKey: ["dashboard-signals"],
    queryFn: async () => getDashboardSignals({ headers: await authHeaders() }),
  });
  const { data: integrity } = useQuery({
    queryKey: ["dashboard-integrity"],
    queryFn: async () => checkIntegrity({ headers: await authHeaders() }),
  });
  const { data: readiness } = useQuery({
    queryKey: ["dashboard-readiness"],
    queryFn: async () => getLaunchReadiness({ headers: await authHeaders() }),
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
  const treeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    reference?.rollup.forEach((v, k) => {
      if (k !== UNASSIGNED) out[k] = v.total;
    });
    return out;
  }, [reference]);

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
  const asOf = signals ? formatDateTime(signals.asOf) : formatDateTime(new Date().toISOString());
  const scopeLabel = [
    companyId === "all" ? "전체 계열사" : (companyName.get(companyId) ?? "선택 계열사"),
    orgPathLabel(model?.units ?? [], orgId),
    selectedWave?.name ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  // ── 응답 원천을 현재 스코프의 참여자에 붙인다 ──
  const scoped = useMemo(
    () => scopeSignals(signals, respondents),
    // respondents 는 model 이 바뀔 때만 새로 만들어진다.
    [signals, model], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const funnel = useMemo(
    () =>
      STATUS_ORDER.map((status) => {
        const rows = respondents.filter((r) => r.account_status === status);
        return {
          status,
          count: rows.length,
          // 「기록이 없는」 미발송은 정체가 아니라 발송이 안 된 것이다 — 경과일이 있는 사람만 센다.
          stalled: rows.filter(
            (r) => r.elapsed !== null && r.elapsed >= r.threshold && r.account_status !== "승인",
          ).length,
        };
      }),
    [respondents],
  );

  const orgRows = useMemo(() => {
    if (!model) return [];
    const rows = (model.children.get(orgId) ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      level: u.level,
      companyId: u.company_id,
      stats: model.rollup.get(u.id) ?? EMPTY_ROLLUP,
    }));
    if (orgId === null) {
      const unassigned = model.rollup.get(UNASSIGNED) ?? EMPTY_ROLLUP;
      if (unassigned.total > 0) {
        rows.push({
          id: UNASSIGNED,
          name: "미배정",
          level: null,
          companyId: "",
          stats: unassigned,
        });
      }
    }
    return rows;
  }, [model, orgId]);

  const cards = useMemo(
    () =>
      model && reference
        ? buildSignalCards({
            model,
            reference,
            scoped,
            orgRows,
            asOf,
            ddayText,
            companyId,
            integrityChecks: integrity?.checks ?? [],
            reviewTurnaroundDays: signals?.reviewTurnaroundDays ?? null,
            onSelectOrg: setSelectedOrgId,
          })
        : [],
    // 의존값 전부를 나열하면 매 렌더 새 배열이 되는 orgRows·scoped 때문에 의미가 없다.
    [model, reference, scoped, orgRows, asOf, ddayText, companyId, integrity, signals], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const unmetReadiness = (readiness?.items ?? []).filter((i) => !i.ok);
  const metReadiness = (readiness?.items ?? []).filter((i) => i.ok);
  /** 한 명이라도 안내를 받았다면 조사는 이미 시작된 것이다 — 개시 점검은 뒤로 접는다. */
  const launched = respondents.some((r) => r.account_status !== "미발송");

  const report = buildReport({
    period,
    respondents,
    scoped,
    integrityTotal: integrity?.total ?? 0,
    scopeLabel,
    asOf,
  });

  const sections = [
    { id: "funnel", label: "진행 단계", count: total },
    { id: "signals", label: "확인할 일", count: cards.length + unmetReadiness.length },
    { id: "orgs", label: "소속별 현황", count: orgRows.length },
    { id: "report", label: "마감 리포트" },
  ];

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(report.text);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
  };

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

      <div className="grid gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="space-y-2 lg:sticky lg:top-[var(--sticky-top)] lg:self-start">
          <OrgTreeFilter
            units={reference?.units ?? []}
            selectedId={orgId}
            onSelect={setSelectedOrgId}
            counts={treeCounts}
            title="소속으로 좁히기"
          />
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            고른 소속과 그 하위로 이 화면 전체가 좁혀집니다.
          </p>
        </aside>

        <div className="min-w-0 space-y-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          ) : total === 0 ? (
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
                      <li key={stage.status} className="flex shrink-0 items-stretch gap-1">
                        <a
                          href={participantsLink({ status: stage.status })}
                          className="flex w-[136px] flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-secondary/50"
                        >
                          <StatusBadge status={stage.status} withHelp />
                          <span className="text-xl font-bold tabular-nums">{stage.count}명</span>
                          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${pct(stage.count, total)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            전체의 {pct(stage.count, total)}%
                            {stage.status === "제출" ? " · 검토 대기" : ""}
                          </span>
                        </a>
                        {i < funnel.length - 1 ? (
                          <div className="flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 text-center">
                            <span className="text-muted-foreground" aria-hidden>
                              →
                            </span>
                            {stage.stalled > 0 ? (
                              <a
                                href={participantsLink({ status: stage.status })}
                                className="text-[11px] font-medium leading-tight text-warning underline underline-offset-2"
                                title={`${stage.status} 단계에서 기준일 이상 움직임이 없는 인원`}
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
              </CollapsibleSection>

              {/* B2 — 알림은 전부 신호·근거·행동 3단 규격 */}
              <section id="signals" className="scroll-mt-[var(--sticky-top)] space-y-3">
                <div>
                  <h2 className="text-base font-semibold">확인할 일</h2>
                  <p className="text-xs text-muted-foreground">
                    지금 손을 쓸 수 있는 것만 올립니다. 아무것도 없으면 이 구획은 비어 있는 것이
                    정상입니다.
                  </p>
                </div>

                {cards.length === 0 && unmetReadiness.length === 0 ? (
                  <EmptyState
                    kind="nothing"
                    title="지금 확인할 일이 없습니다"
                    description="미착수·검토 적체·정합성 오류·발송 실패가 모두 없습니다. 진행 단계와 소속별 현황으로 흐름만 확인하세요."
                  />
                ) : (
                  <div className="space-y-3">
                    {/* 개시 준비: 개시 후에는 못 채운 항목만 카드로 남긴다 */}
                    {launched
                      ? unmetReadiness.map((item) => {
                          const link = READINESS_LINKS[item.key];
                          return (
                            <SignalCard
                              key={`readiness-${item.key}`}
                              tone="attention"
                              signal={`개시 준비 항목 「${item.label}」${josa(item.label, "이/가")} 아직 충족되지 않았습니다`}
                              evidence={[
                                item.hint ??
                                  "이 항목을 채우지 않으면 진행 중 문제가 생길 수 있습니다.",
                                `조사는 이미 시작되었습니다(안내를 받은 참여자 ${total - funnel[0]!.count}명).`,
                              ]}
                              asOf={asOf}
                              scope={`개시 점검 ${readiness?.items.length ?? 0}항목 중 미충족 ${unmetReadiness.length}항목`}
                              actions={link ? [{ label: link.label, href: link.href }] : []}
                            />
                          );
                        })
                      : null}
                    {cards.map((c) => (
                      <SignalCard
                        key={c.key}
                        signal={c.signal}
                        evidence={c.evidence}
                        asOf={c.asOf}
                        scope={c.scope}
                        actions={c.actions}
                        tone={c.tone}
                      />
                    ))}
                  </div>
                )}

                {/* 개시 전이면 점검표 자체가 이 화면의 일이다 */}
                {readiness && !launched ? (
                  <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
                    <h3 className="text-sm font-semibold">개시 준비 점검</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      조사를 열기 전에 갖춰야 할 항목입니다. 안내를 한 번이라도 보내면 이 점검표는
                      접힙니다.
                    </p>
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {readiness.items.map((item) => (
                        <li key={item.key} className="flex items-start gap-2 text-sm">
                          <span className={item.ok ? "text-success" : "text-destructive"}>
                            {item.ok ? "✓" : "✗"}
                          </span>
                          <span>
                            {item.label}
                            {item.hint ? (
                              <span className="block text-xs text-muted-foreground">
                                {item.hint}
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {launched && metReadiness.length > 0 ? (
                  <CollapsibleSection
                    storageKey="dashboard"
                    id="readiness-passed"
                    title={`개시 준비 통과 ${metReadiness.length}항목`}
                    subtitle="조사가 시작된 뒤에는 확인만 하면 되는 항목입니다."
                    defaultCollapsed
                  >
                    <ul className="grid gap-1.5 rounded-xl border bg-card p-4 sm:grid-cols-2">
                      {metReadiness.map((item) => (
                        <li key={item.key} className="text-sm text-muted-foreground">
                          <span className="text-success">✓</span> {item.label}
                        </li>
                      ))}
                    </ul>
                  </CollapsibleSection>
                ) : null}
              </section>

              {/* B1 — 소속별 합계. 행을 누르면 그 소속의 참여자 명단으로 간다 */}
              <CollapsibleSection
                storageKey="dashboard"
                id="orgs"
                title="소속별 현황"
                subtitle="수치는 하위 소속까지 합한 값입니다. 행을 누르면 그 소속의 참여자 명단으로 갑니다."
              >
                {orgRows.length === 0 ? (
                  <EmptyState
                    kind="nothing"
                    title="하위 소속이 없습니다"
                    description="이 소속의 개인별 상태는 참여자 명단에서 확인하세요."
                  >
                    <a
                      href={participantsLink(orgId ? { org: orgId } : {})}
                      className="text-sm font-medium text-primary underline underline-offset-2"
                    >
                      참여자 명단 보기 →
                    </a>
                  </EmptyState>
                ) : (
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <div className="min-w-[640px]">
                      <div className="grid grid-cols-[minmax(150px,1fr)_64px_64px_64px_104px_72px] gap-2 border-b bg-secondary px-4 py-2.5 text-xs font-medium text-muted-foreground">
                        <span>소속</span>
                        <span className="text-right">대상</span>
                        <span className="text-right">착수</span>
                        <span className="text-right">제출</span>
                        <span className="text-right">제출률</span>
                        <span className="text-right">정체</span>
                      </div>
                      {orgRows.map((row) => (
                        <a
                          key={row.id}
                          href={participantsLink({
                            org: row.id === UNASSIGNED ? "unassigned" : row.id,
                          })}
                          className="grid grid-cols-[minmax(150px,1fr)_64px_64px_64px_104px_72px] items-center gap-2 border-b px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-secondary/50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {row.name}
                              {row.level ? (
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                  {row.level}
                                </span>
                              ) : null}
                            </span>
                            {orgId === null && companyId === "all" && row.companyId ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {companyName.get(row.companyId) ?? ""}
                              </span>
                            ) : null}
                          </span>
                          <span className="text-right tabular-nums">{row.stats.total}</span>
                          <span className="text-right tabular-nums">{row.stats.started}</span>
                          <span className="text-right tabular-nums">{row.stats.done}</span>
                          <span className="text-right">
                            <span className="block text-xs tabular-nums">
                              {pct(row.stats.done, row.stats.total)}%
                            </span>
                            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-secondary">
                              <span
                                className="block h-full rounded-full bg-primary"
                                style={{ width: `${pct(row.stats.done, row.stats.total)}%` }}
                              />
                            </span>
                          </span>
                          <span
                            className={
                              row.stats.stalled > 0
                                ? "text-right font-medium tabular-nums text-warning"
                                : "text-right tabular-nums text-muted-foreground"
                            }
                          >
                            {row.stats.stalled}
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CollapsibleSection>

              {/* B8 — 보고에 그대로 쓰는 한 장 요약 */}
              <CollapsibleSection
                storageKey="dashboard"
                id="report"
                title="마감 리포트"
                subtitle="선택한 기간의 진행 상황을 한 장으로 요약합니다. 그대로 복사해 보고에 쓸 수 있습니다."
                aside={
                  <div className="flex shrink-0 gap-1">
                    {PERIODS.map((p) => (
                      <Button
                        key={p.key}
                        size="sm"
                        variant={period === p.key ? "default" : "outline"}
                        onClick={() => {
                          setPeriod(p.key);
                          setCopyState("idle");
                        }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                }
              >
                <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
                  {report.noChange ? (
                    <p className="text-sm">
                      변동 없음 —{" "}
                      <span className="text-muted-foreground">
                        {report.periodLabel} 동안 제출·검토 처리·접속 기록이 없습니다.
                      </span>
                    </p>
                  ) : (
                    <>
                      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {report.metrics.map((m) => (
                          <div key={m.label} className="rounded-lg border p-3">
                            <dt className="text-xs text-muted-foreground">{m.label}</dt>
                            <dd className="mt-1 text-lg font-bold tabular-nums">{m.value}</dd>
                            <dd className="mt-0.5 text-xs text-muted-foreground">{m.note}</dd>
                          </div>
                        ))}
                      </dl>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-secondary/50 p-3 text-xs leading-relaxed">
                        {report.text}
                      </pre>
                    </>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" variant="outline" onClick={() => void copySummary()}>
                      요약 복사
                    </Button>
                    {copyState === "ok" ? (
                      <span className="text-xs text-success">복사했습니다</span>
                    ) : null}
                    {copyState === "fail" ? (
                      <span className="text-xs text-destructive">
                        복사하지 못했습니다. 위 글상자를 직접 선택해 복사해 주세요.
                      </span>
                    ) : null}
                  </div>
                </div>
              </CollapsibleSection>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 파생 계산 ───────────────────────── */

type ScopedSignals = {
  /** 현재 스코프 참여자의 응답만. */
  responses: DashboardSignals["responses"];
  waiting: number;
  backlog: { days: number }[];
  aiBlocked: number;
  failedMails: DashboardSignals["failedMails"];
  /** 검토 적체 판정에 쓴 기준일(스코프 안에서 가장 짧은 값). */
  threshold: number;
  /** F6 접수된 문의 — 현재 스코프 참여자의 것만. */
  openInquiries: DashboardSignals["openInquiries"];
  /** F10 변경 재확인 미확인 응답 — 현재 스코프 참여자의 것만. */
  recheckResponses: DashboardSignals["recheckResponses"];
};

function scopeSignals(
  signals: DashboardSignals | undefined,
  respondents: Tracked[],
): ScopedSignals {
  const byParticipant = new Map(respondents.map((r) => [r.id, r]));
  const thresholds = respondents.map((r) => r.threshold);
  const threshold = thresholds.length ? Math.min(...thresholds) : 7;
  if (!signals) {
    return {
      responses: [],
      waiting: 0,
      backlog: [],
      aiBlocked: 0,
      failedMails: [],
      threshold,
      openInquiries: [],
      recheckResponses: [],
    };
  }

  const responses = signals.responses.filter((r) => byParticipant.has(r.participant_id));
  const submittedRows = responses.filter((r) => r.status === "submitted");
  const backlog = submittedRows
    .map((r) => ({
      days: daysSince(r.submitted_at) ?? 0,
      limit: byParticipant.get(r.participant_id)?.threshold ?? threshold,
    }))
    .filter((x) => x.days >= x.limit)
    .map((x) => ({ days: x.days }));

  const inScopeIds = new Set(responses.map((r) => r.id));
  return {
    responses,
    waiting: submittedRows.length,
    backlog,
    aiBlocked: signals.aiBlockedResponseIds.filter((id) => inScopeIds.has(id)).length,
    failedMails: signals.failedMails.filter(
      (m) => m.participant_id !== null && byParticipant.has(m.participant_id),
    ),
    threshold,
    openInquiries: signals.openInquiries.filter((q) => byParticipant.has(q.participant_id)),
    recheckResponses: signals.recheckResponses.filter((r) => byParticipant.has(r.participant_id)),
  };
}

type Card = {
  key: string;
  signal: string;
  evidence: string[];
  asOf: string;
  scope: string;
  actions: SignalAction[];
  tone: SignalTone;
};

function buildSignalCards(args: {
  model: Model;
  reference: Model;
  scoped: ScopedSignals;
  orgRows: { id: string; name: string; stats: Rollup }[];
  asOf: string;
  ddayText: string;
  companyId: string;
  integrityChecks: {
    key: string;
    label: string;
    count: number;
    items: string[];
    link: string;
    linkLabel: string;
  }[];
  reviewTurnaroundDays: number | null;
  onSelectOrg: (id: string | null) => void;
}): Card[] {
  const { model, reference, scoped, orgRows, asOf, ddayText, integrityChecks } = args;
  const cards: Card[] = [];

  const refTotal = reference.respondents.length;
  const refStarted = reference.respondents.filter((r) => r.started).length;
  const refRate = pct(refStarted, refTotal);

  // ⑴ 미착수·지연 소속 — 착수율이 전체보다 낮고 미착수가 남은 곳만
  const laggards = orgRows
    .filter((row) => row.id !== UNASSIGNED && row.stats.total > 0)
    .map((row) => ({ ...row, notStarted: row.stats.total - row.stats.started }))
    .filter((row) => row.notStarted > 0 && pct(row.stats.started, row.stats.total) < refRate)
    .sort((a, b) => b.notStarted - a.notStarted)
    .slice(0, ORG_SIGNAL_LIMIT);

  for (const row of laggards) {
    const members = subtreeMembers(model, row.id);
    const invitedElapsed = members
      .map((m) => daysSince(m.invited_at))
      .filter((d): d is number => d !== null);
    const viewed = members.filter((m) => m.last_seen_at !== null).length;
    const sinceInvite = average(invitedElapsed);
    cards.push({
      key: `laggard-${row.id}`,
      tone: "attention",
      signal: `${row.name} ${row.notStarted}명이 아직 작성을 시작하지 않았습니다`,
      evidence: [
        `착수율 ${pct(row.stats.started, row.stats.total)}% — 전체 착수율 ${refRate}%(대상 ${refTotal}명)보다 낮습니다.`,
        sinceInvite === null
          ? "아직 안내가 발송되지 않은 인원이 있습니다."
          : `안내 발송 후 평균 ${sinceInvite}일 지났습니다(발송 완료 ${invitedElapsed.length}명 기준).`,
        `한 번이라도 화면을 연 사람은 ${viewed}명입니다.`,
        ddayText,
      ],
      asOf,
      scope: `대상 ${row.stats.total}명 중 미착수 ${row.notStarted}명`,
      actions: [
        { label: "독려 안내 보내기", href: mailLink(row.id, NOT_STARTED_STATUSES) },
        { label: "명단 보기", href: participantsLink({ org: row.id }), variant: "outline" },
        {
          label: "이 소속만 보기",
          onClick: () => args.onSelectOrg(row.id),
          variant: "ghost",
        },
      ],
    });
  }

  // ⑵ 검토 적체
  if (scoped.backlog.length > 0) {
    const days = scoped.backlog.map((b) => b.days);
    const worst = Math.max(...days);
    const thresholdLabel = args.companyId === "all" ? "계열사별 기준일" : `${scoped.threshold}일`;
    cards.push({
      key: "review-backlog",
      tone: "attention",
      signal: `제출 후 ${thresholdLabel}${josa(thresholdLabel, "이/가")} 지나도록 검토되지 않은 응답이 ${scoped.backlog.length}건입니다`,
      evidence: [
        args.reviewTurnaroundDays === null
          ? "아직 검토를 마친 응답이 없어 비교할 평균이 없습니다."
          : `지금까지 평균 검토 소요는 ${args.reviewTurnaroundDays}일입니다.`,
        `가장 오래 기다린 건은 ${worst}일 경과했습니다.`,
        `평균 대기 ${average(days) ?? 0}일`,
      ],
      asOf,
      scope: `검토 대기 ${scoped.waiting}건 중 ${scoped.backlog.length}건`,
      actions: [{ label: "검토 대기로 이동", href: REVIEW_LINK }],
    });
  }

  // ⑶ 정합성 점검 — 항목별로 한 장. 계열사·소속 스코프가 걸리지 않는 전사 기준임을 밝힌다
  for (const check of integrityChecks) {
    if (check.count === 0) continue;
    const sample = check.items.slice(0, 5).join(", ");
    cards.push({
      key: `integrity-${check.key}`,
      tone: "attention",
      signal: `${check.label} ${check.count}건을 확인해야 합니다`,
      evidence: [
        sample
          ? `예: ${sample}${check.count > 5 ? ` 외 ${check.count - 5}건` : ""}`
          : "대상 목록은 이동한 화면에서 확인할 수 있습니다.",
        `정합성 점검 ${integrityChecks.length}항목 중 이 항목에서 발견되었습니다.`,
        "이 점검은 계열사·소속 선택과 무관하게 전사 기준으로 셉니다.",
      ],
      asOf,
      scope: `전사 기준 ${check.count}건`,
      actions: [{ label: check.linkLabel, href: check.link }],
    });
  }

  // ⑷ 미확정 AI 제안 — 승인을 막고 있는 것만
  if (scoped.aiBlocked > 0) {
    cards.push({
      key: "ai-blocked",
      tone: "attention",
      signal: `확정하지 않은 AI 제안 때문에 승인할 수 없는 응답이 ${scoped.aiBlocked}건입니다`,
      evidence: [
        "AI 초안 상태로 남은 필요 역량·자격요건이 있으면 승인 버튼이 막힙니다.",
        "참여자 확인을 받거나 관리자가 정정하면 풀립니다.",
      ],
      asOf,
      scope: `검토 대기 ${scoped.waiting}건 중 ${scoped.aiBlocked}건`,
      actions: [
        { label: "검토 화면에서 확정하기", href: REVIEW_LINK },
        { label: "AI 제안 관리", href: "/admin/ai", variant: "outline" },
      ],
    });
  }

  // ⑸ 발송 실패
  if (scoped.failedMails.length > 0) {
    const latest = scoped.failedMails[0]?.sent_at ?? null;
    cards.push({
      key: "mail-failed",
      tone: "attention",
      signal: `안내 메일 발송이 ${scoped.failedMails.length}건 실패했습니다`,
      evidence: [
        `가장 최근 실패는 ${formatDateTime(latest)}입니다.`,
        "주소 오류·수신 거부는 명부를 고친 뒤 다시 보내야 도착합니다.",
      ],
      asOf,
      scope: `대상 ${model.respondents.length}명 중 실패 ${scoped.failedMails.length}건`,
      actions: [
        { label: "메일 화면에서 재발송", href: "/admin/mail" },
        { label: "명부 확인", href: "/admin/participants", variant: "outline" },
      ],
    });
  }

  // ⑹ 접수된 문의 — 같은 유형이 몰리면 개별 답변보다 공지가 나을 수 있다는 것까지 알려 준다.
  if (scoped.openInquiries.length > 0) {
    const tally = new Map<string, number>();
    for (const q of scoped.openInquiries) tally.set(q.category, (tally.get(q.category) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const emphasize = (top?.[1] ?? 0) >= 5;
    cards.push({
      key: "inquiries-open",
      tone: emphasize ? "attention" : "neutral",
      signal: `접수된 문의 ${scoped.openInquiries.length}건이 답변을 기다리고 있습니다`,
      evidence: [
        top
          ? `가장 많은 유형은 「${top[0]}」 ${top[1]}건입니다.`
          : "아직 한 유형에 몰려 있지는 않습니다.",
        emphasize
          ? "같은 유형이 5건 이상이면 공지·안내문으로 한 번에 안내하는 편이 낫습니다."
          : "지금은 개별 답변으로 충분한 수준입니다.",
      ],
      asOf,
      scope: `대상 ${model.respondents.length}명 중 문의 ${scoped.openInquiries.length}건`,
      actions: [{ label: "검토 화면 문의함에서 답변", href: INQUIRY_LINK }],
    });
  }

  // ⑺ 변경 재확인 미확인 — 조직·직무 변경 등으로 다시 확인이 필요하다고 표시된 응답.
  if (scoped.recheckResponses.length > 0) {
    cards.push({
      key: "recheck-open",
      tone: "attention",
      signal: `변경 재확인이 필요한 응답이 ${scoped.recheckResponses.length}건 있습니다`,
      evidence: [
        "조직·직무 변경 등으로 다시 확인이 필요하다고 표시된 응답입니다.",
        "참여자가 확인하거나 관리자가 정정하면 이 목록에서 빠집니다.",
      ],
      asOf,
      scope: `대상 ${model.respondents.length}명 중 재확인 대기 ${scoped.recheckResponses.length}건`,
      actions: [{ label: "마스터 화면에서 확인", href: RECHECK_LINK }],
    });
  }

  return cards;
}

/** 소속과 그 하위에 속한 참여자 전부. */
function subtreeMembers(model: Model, rootId: string): Tracked[] {
  const ids = orgSubtreeIds(model.units, rootId) ?? [rootId];
  return ids.flatMap((id) => model.membersByUnit.get(id) ?? []);
}

function buildReport(args: {
  period: PeriodKey;
  respondents: Tracked[];
  scoped: ScopedSignals;
  integrityTotal: number;
  scopeLabel: string;
  asOf: string;
}) {
  const { period, respondents, scoped, integrityTotal, scopeLabel, asOf } = args;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "조사 전체";
  const since = periodStart(period);
  const within = (value: string | null) =>
    value !== null && (since === null || new Date(value).getTime() >= since.getTime());

  const total = respondents.length;
  const started = respondents.filter((r) => r.started).length;
  const submitted = respondents.filter((r) => r.done).length;
  const approved = respondents.filter((r) => r.account_status === "승인").length;

  const submittedInPeriod = scoped.responses.filter((r) => within(r.submitted_at)).length;
  const reviewedInPeriod = scoped.responses.filter((r) => within(r.reviewed_at)).length;
  const seenInPeriod = respondents.filter((r) => within(r.last_seen_at)).length;
  const noChange =
    period !== "all" && submittedInPeriod === 0 && reviewedInPeriod === 0 && seenInPeriod === 0;

  const metrics = [
    {
      label: "착수율",
      value: `${pct(started, total)}%`,
      note: `대상 ${total}명 중 ${started}명`,
    },
    {
      label: "제출률",
      value: `${pct(submitted, total)}%`,
      note: `제출·승인 ${submitted}명 · 승인 ${approved}명`,
    },
    {
      label: "검토 적체",
      value: `${scoped.backlog.length}건`,
      note: `검토 대기 ${scoped.waiting}건 중 기준일 초과`,
    },
    {
      label: "정합성 오류",
      value: `${integrityTotal}건`,
      note: "전사 기준 확인 필요 건수",
    },
  ];

  const changeLine = `${periodLabel} 변동: 제출 ${submittedInPeriod}건 · 검토 처리 ${reviewedInPeriod}건 · 접속 ${seenInPeriod}명`;
  const text = noChange
    ? `[업무조사 ${periodLabel} 요약] 변동 없음 (기준 ${asOf} · ${scopeLabel})`
    : [
        `[업무조사 ${periodLabel} 요약] 기준 ${asOf} · ${scopeLabel}`,
        `· 대상 ${total}명 / 착수 ${started}명(${pct(started, total)}%) / 제출 ${submitted}명(${pct(submitted, total)}%) / 승인 ${approved}명`,
        `· 검토 대기 ${scoped.waiting}건, 이 중 기준일 초과 ${scoped.backlog.length}건`,
        `· 미확정 AI 제안으로 승인 대기 ${scoped.aiBlocked}건 · 발송 실패 ${scoped.failedMails.length}건`,
        `· 정합성 점검 확인 필요 ${integrityTotal}건 (전사 기준)`,
        `· ${changeLine}`,
      ].join("\n");

  return { periodLabel, noChange, metrics, text };
}
