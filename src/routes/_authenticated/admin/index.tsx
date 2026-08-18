import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge } from "@/components/StatusBadge";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import {
  checkIntegrity,
  getLaunchReadiness,
  getOrgOverview,
  type OrgOverview,
  type OverviewParticipant,
  type OverviewUnit,
} from "@/lib/dashboard.functions";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "대시보드 | 서연 그룹 업무조사" },
      { name: "description", content: "조직별 조사 진행 현황을 한눈에 확인합니다." },
      { property: "og:title", content: "대시보드 | 서연 그룹 업무조사" },
      { property: "og:description", content: "조직별 조사 진행 현황을 한눈에 확인합니다." },
    ],
  }),
  component: DashboardPage,
});

const DONE_STATUSES = ["제출", "승인"];
/** 조직 미배정 참여자를 묶는 가상 노드 id. */
const UNASSIGNED = "__unassigned__";

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

type Tracked = OverviewParticipant & {
  done: boolean;
  stale: boolean;
  elapsed: number | null;
  lastActivity: string | null;
};

type Rollup = { total: number; done: number; stale: number };

/** 스코프 필터 → 조직 트리 인덱스 → 하위 합산 롤업까지, 화면이 쓰는 파생 모델 전부. */
function buildModel(overview: OrgOverview, companyId: string) {
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

  const scoped = overview.participants.filter((p) => inScope(p.company_id));
  const respondents: Tracked[] = scoped
    .filter((p) => p.role === "respondent")
    .map((p) => {
      const lastActivity = p.last_seen_at ?? p.invited_at;
      const elapsed = daysSince(lastActivity);
      const done = DONE_STATUSES.includes(p.account_status);
      const staleDays = staleDaysBy.get(p.company_id) ?? 7;
      return {
        ...p,
        lastActivity,
        elapsed,
        done,
        stale: !done && (elapsed === null || elapsed >= staleDays),
      };
    });

  // 조직이 삭제돼 링크가 끊긴(dangling) 인원도 미배정으로 묶는다.
  const membersByUnit = new Map<string, Tracked[]>();
  for (const p of respondents) {
    const key = p.org_unit_id && unitById.has(p.org_unit_id) ? p.org_unit_id : UNASSIGNED;
    const list = membersByUnit.get(key);
    if (list) list.push(p);
    else membersByUnit.set(key, [p]);
  }
  for (const list of membersByUnit.values()) {
    list.sort((a, b) => a.emp_no.localeCompare(b.emp_no));
  }

  const rollup = new Map<string, Rollup>();
  const compute = (id: string): Rollup => {
    const own = membersByUnit.get(id) ?? [];
    const acc: Rollup = {
      total: own.length,
      done: own.filter((m) => m.done).length,
      stale: own.filter((m) => m.stale).length,
    };
    for (const child of children.get(id) ?? []) {
      const c = compute(child.id);
      acc.total += c.total;
      acc.done += c.done;
      acc.stale += c.stale;
    }
    rollup.set(id, acc);
    return acc;
  };
  for (const root of children.get(null) ?? []) compute(root.id);

  const unassigned = membersByUnit.get(UNASSIGNED) ?? [];
  rollup.set(UNASSIGNED, {
    total: unassigned.length,
    done: unassigned.filter((m) => m.done).length,
    stale: unassigned.filter((m) => m.stale).length,
  });

  return { scoped, respondents, units, unitById, children, membersByUnit, rollup, staleDaysBy };
}

function DashboardPage() {
  const { companyId } = useCompanyScope();
  /** 드릴다운 경로(조직 id 나열). 마지막 요소가 현재 보고 있는 조직이다. */
  const [path, setPath] = useState<string[]>([]);
  const [showIntegrity, setShowIntegrity] = useState(false);
  useEffect(() => setPath([]), [companyId]);

  const { data: overview, isLoading } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: async () => getOrgOverview({ headers: await authHeaders() }),
  });
  const { data: integrity } = useQuery({
    queryKey: ["dashboard-integrity"],
    queryFn: async () => checkIntegrity({ headers: await authHeaders() }),
  });
  const { data: readiness } = useQuery({
    queryKey: ["dashboard-readiness"],
    queryFn: async () => getLaunchReadiness({ headers: await authHeaders() }),
  });

  const model = useMemo(
    () => (overview ? buildModel(overview, companyId) : null),
    [overview, companyId],
  );
  const companyName = useMemo(
    () => new Map((overview?.companies ?? []).map((c) => [c.id, c.name])),
    [overview],
  );

  const respondents = model?.respondents ?? [];
  const submitted = respondents.filter((r) => r.done).length;
  const rate = respondents.length ? Math.round((submitted / respondents.length) * 100) : 0;
  const staleList = respondents.filter((r) => r.stale);

  // 스코프가 전체면 가장 이른 마감일을 기준으로 보여준다.
  const deadline = useMemo(() => {
    const scoped = (overview?.settings ?? []).filter(
      (s) => companyId === "all" || s.company_id === companyId,
    );
    const dates = scoped.map((s) => s.deadline).filter((d): d is string => Boolean(d));
    return dates.length ? dates.sort()[0] : null;
  }, [overview, companyId]);
  const dday = deadline ? daysUntil(deadline) : null;

  const cards = [
    { label: "대상 인원", value: `${respondents.length}명` },
    { label: "제출 완료", value: `${submitted}명` },
    { label: "제출률", value: `${rate}%` },
    {
      label: "남은 기한",
      value: dday === null ? "미설정" : dday < 0 ? "마감됨" : dday === 0 ? "D-Day" : `D-${dday}`,
      hint: deadline ?? "마감일 미설정",
    },
  ];

  // ── 드릴다운 현재 위치 ──
  const currentId = path.length > 0 ? (path[path.length - 1] ?? null) : null;
  const levelNodes =
    !model || currentId === UNASSIGNED
      ? []
      : (model.children.get(currentId) ?? []);
  const memberList = !model
    ? []
    : currentId === null
      ? [] // 최상위 화면에는 개인 목록을 두지 않는다.
      : (model.membersByUnit.get(currentId) ?? []);
  const atRoot = currentId === null;
  const crumbs = [
    { id: null as string | null, label: "전체" },
    ...path.map((id) => ({
      id: id as string | null,
      label: id === UNASSIGNED ? "미배정" : (model?.unitById.get(id)?.name ?? "?"),
    })),
  ];

  const staleLabel =
    companyId !== "all"
      ? `${model?.staleDaysBy.get(companyId) ?? 7}일 이상 무활동`
      : "계열사별 기준일 이상 무활동";

  const failedChecks = (integrity?.checks ?? []).filter((c) => c.count > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">대시보드</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          조직별 조사 진행 현황을 한눈에 확인합니다.
        </p>
      </div>

      {/* 정합성 점검: 문제가 있을 때만 보이는 카드 */}
      {integrity && integrity.total > 0 && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 shadow-sm">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 p-4 text-left sm:px-5"
            onClick={() => setShowIntegrity((v) => !v)}
          >
            <div>
              <p className="text-sm font-semibold text-destructive">
                확인 필요 {integrity.total}건
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                데이터 정합성 점검에서 확인이 필요한 항목이 있습니다. 눌러서 펼치기
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{showIntegrity ? "접기" : "펼치기"}</span>
          </button>
          {showIntegrity && (
            <ul className="space-y-3 border-t border-destructive/20 p-4 sm:px-5">
              {failedChecks.map((c) => (
                <li key={c.key} className="rounded-lg border bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {c.label} <span className="text-destructive">{c.count}건</span>
                    </p>
                    <a href={c.link} className="text-xs font-medium text-primary underline">
                      {c.linkLabel} →
                    </a>
                  </div>
                  {c.items.length > 0 && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {c.items.join(", ")}
                      {c.count > c.items.length && ` 외 ${c.count - c.items.length}건`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 개시 준비 점검: 전부 통과면 한 줄로 접는다 */}
      {readiness &&
        (readiness.ready ? (
          <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
            ✓ 개시 준비 점검 6항목을 모두 통과했습니다.
          </p>
        ) : (
          <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <h2 className="text-base font-semibold">개시 준비 점검</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              조사 개시 전에 갖춰야 할 항목을 자동 판정합니다.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {readiness.items.map((item) => (
                <li key={item.key} className="flex items-start gap-2 text-sm">
                  <span className={item.ok ? "text-primary" : "text-destructive"}>
                    {item.ok ? "✓" : "✗"}
                  </span>
                  <span>
                    {item.label}
                    {item.hint && (
                      <span className="block text-xs text-muted-foreground">{item.hint}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="mt-2 text-2xl font-bold">{c.value}</p>
            {c.hint && <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>}
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">진행 단계 현황</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          미발송에서 승인까지 단계별 인원입니다. 막대는 전체 대비 비율입니다.
        </p>
        <ul className="mt-4 space-y-2">
          {ACCOUNT_STATUS_LABELS.map((status) => {
            const rows = model?.scoped ?? [];
            const count = rows.filter((r) => r.account_status === status).length;
            const pct = rows.length ? Math.round((count / rows.length) * 100) : 0;
            return (
              <li key={status} className="flex items-center gap-3">
                <div className="w-24 shrink-0">
                  <StatusBadge status={status} />
                </div>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right text-sm font-semibold">{count}명</span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 조직별 현황 보드: 카드 클릭으로 드릴다운, 말단에서 개인 목록 */}
      <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div>
          <h2 className="text-base font-semibold">조직별 현황</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            수치는 하위 조직을 합산한 값입니다. 카드를 누르면 하위 조직과 인원으로 들어갑니다.
          </p>
        </div>

        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="조직 경로">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={`${crumb.id ?? "root"}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground">/</span>}
                {last ? (
                  <span className="font-medium">{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    className="text-primary underline-offset-2 hover:underline"
                    onClick={() => setPath(path.slice(0, i))}
                  >
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : (
          <>
            {(levelNodes.length > 0 || (atRoot && (model?.rollup.get(UNASSIGNED)?.total ?? 0) > 0)) && (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {levelNodes.map((unit) => {
                  const stats = model?.rollup.get(unit.id) ?? { total: 0, done: 0, stale: 0 };
                  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
                  return (
                    <li key={unit.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-secondary/50"
                        onClick={() => setPath([...path, unit.id])}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="min-w-0 truncate font-medium">
                            {unit.name}
                            {unit.level && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                {unit.level}
                              </span>
                            )}
                          </p>
                          <span className="shrink-0 text-sm font-semibold">{pct}%</span>
                        </div>
                        {atRoot && companyId === "all" && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {companyName.get(unit.company_id) ?? ""}
                          </p>
                        )}
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          대상 {stats.total}명 · 제출 {stats.done}명
                          {stats.stale > 0 && (
                            <span className="ml-1 font-medium text-destructive">
                              · 미진행 {stats.stale}명
                            </span>
                          )}
                        </p>
                      </button>
                    </li>
                  );
                })}
                {atRoot && (model?.rollup.get(UNASSIGNED)?.total ?? 0) > 0 && (
                  <li>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-dashed p-3 text-left transition-colors hover:bg-secondary/50"
                      onClick={() => setPath([UNASSIGNED])}
                    >
                      {(() => {
                        const stats = model!.rollup.get(UNASSIGNED)!;
                        const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
                        return (
                          <>
                            <div className="flex items-baseline justify-between gap-2">
                              <p className="font-medium text-muted-foreground">미배정</p>
                              <span className="shrink-0 text-sm font-semibold">{pct}%</span>
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              대상 {stats.total}명 · 제출 {stats.done}명
                              {stats.stale > 0 && (
                                <span className="ml-1 font-medium text-destructive">
                                  · 미진행 {stats.stale}명
                                </span>
                              )}
                            </p>
                          </>
                        );
                      })()}
                    </button>
                  </li>
                )}
              </ul>
            )}

            {atRoot && levelNodes.length === 0 && (model?.rollup.get(UNASSIGNED)?.total ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">
                표시할 조직이 없습니다. 마스터 관리에서 조직도를 업로드하세요.
              </p>
            )}

            {/* 현재 조직 직속 인원 (말단이면 이 목록만 남는다) */}
            {!atRoot &&
              (memberList.length === 0 && levelNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">이 조직에 배정된 인원이 없습니다.</p>
              ) : (
                memberList.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-secondary text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 font-medium">사번</th>
                          <th className="px-4 py-3 font-medium">이름</th>
                          <th className="px-4 py-3 font-medium">상태</th>
                          <th className="px-4 py-3 font-medium">최근 활동</th>
                          <th className="px-4 py-3 font-medium">경과일</th>
                        </tr>
                      </thead>
                      <tbody>
                        {memberList.map((r) => (
                          <tr
                            key={r.id}
                            className={r.stale ? "border-t bg-destructive/5" : "border-t"}
                          >
                            <td className="px-4 py-3 text-muted-foreground">{r.emp_no}</td>
                            <td className="px-4 py-3 font-medium">{r.name}</td>
                            <td className="px-4 py-3">
                              <StatusBadge status={r.account_status} />
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {formatDateTime(r.lastActivity)}
                            </td>
                            <td
                              className={
                                r.stale ? "px-4 py-3 font-medium text-destructive" : "px-4 py-3"
                              }
                            >
                              {r.elapsed === null ? "-" : `${r.elapsed}일`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ))}
          </>
        )}
      </div>

      {/* 미진행자: 리마인더 발송 진입점 */}
      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">미진행자 {staleList.length}명</h2>
            <p className="mt-1 text-xs text-muted-foreground">{staleLabel} 미제출자입니다.</p>
          </div>
          {staleList.length > 0 && (
            <Button asChild size="sm">
              <Link to="/admin/mail">리마인더 보내기</Link>
            </Button>
          )}
        </div>
        {staleList.length === 0 ? (
          <p className="text-sm text-muted-foreground">미진행자가 없습니다.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {staleList.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {r.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {r.emp_no}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {companyName.get(r.company_id)}
                    {r.org_unit_id && model?.unitById.get(r.org_unit_id)
                      ? ` · ${model.unitById.get(r.org_unit_id)!.name}`
                      : r.org_text
                        ? ` · ${r.org_text}`
                        : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={r.account_status} />
                  <span className="text-xs text-muted-foreground">
                    {r.elapsed === null ? "기록 없음" : `${r.elapsed}일 경과`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
