import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge } from "@/components/StatusBadge";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import { fetchAll } from "@/lib/paginate";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "대시보드 | 서연 그룹 업무조사" },
      { name: "description", content: "계열사별 조사 진행 현황을 한눈에 확인합니다." },
      { property: "og:title", content: "대시보드 | 서연 그룹 업무조사" },
      { property: "og:description", content: "계열사별 조사 진행 현황을 한눈에 확인합니다." },
    ],
  }),
  component: DashboardPage,
});

const DONE_STATUSES = ["제출", "승인"];
/** 이 일수 이상 움직임이 없는 미제출자를 미진행자로 본다. */
const STALE_DAYS = 7;

type ParticipantRow = {
  id: string;
  name: string;
  emp_no: string;
  org_text: string | null;
  account_status: string;
  role: string;
  company_id: string;
  invited_at: string | null;
  last_seen_at: string | null;
  companies: { name: string } | null;
};

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

function DashboardPage() {
  const { companyId } = useCompanyScope();
  const [statusFilter, setStatusFilter] = useState("all");
  const [staleOnly, setStaleOnly] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", companyId],
    queryFn: async () => {
      // 전사 스코프에서는 1000명을 넘길 수 있어 페이지를 이어 받는다.
      return fetchAll<ParticipantRow>(async (from, to) => {
        let query = supabase
          .from("participants")
          .select(
            "id, name, emp_no, org_text, account_status, role, company_id, invited_at, last_seen_at, companies(name)",
          )
          // emp_no 는 계열사끼리 겹칠 수 있다. id 로 순서를 확정해야 페이지가 어긋나지 않는다.
          .order("emp_no")
          .order("id")
          .range(from, to);
        if (companyId !== "all") query = query.eq("company_id", companyId);
        const { data, error } = await query;
        return { data: (data ?? []) as ParticipantRow[], error };
      });
    },
  });

  const { data: settings } = useQuery({
    queryKey: ["dashboard-deadlines"],
    queryFn: async () => {
      const { data, error } = await supabase.from("survey_settings").select("company_id, deadline");
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(() => data ?? [], [data]);
  const respondents = useMemo(() => rows.filter((r) => r.role === "respondent"), [rows]);
  const submitted = respondents.filter((r) => DONE_STATUSES.includes(r.account_status)).length;
  const rate = respondents.length ? Math.round((submitted / respondents.length) * 100) : 0;

  // 스코프가 전체면 가장 이른 마감일을 기준으로 보여준다.
  const deadline = useMemo(() => {
    const scoped = (settings ?? []).filter(
      (s) => companyId === "all" || s.company_id === companyId,
    );
    const dates = scoped.map((s) => s.deadline).filter((d): d is string => Boolean(d));
    return dates.length ? dates.sort()[0] : null;
  }, [settings, companyId]);
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

  /** 계열사별 제출률 (응답자 기준) */
  const byCompany = useMemo(() => {
    const map = new Map<string, { name: string; total: number; done: number }>();
    for (const r of respondents) {
      const key = r.company_id;
      const entry = map.get(key) ?? { name: r.companies?.name ?? "미지정", total: 0, done: 0 };
      entry.total += 1;
      if (DONE_STATUSES.includes(r.account_status)) entry.done += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [respondents]);

  /** 개인별 상태 — 최종 활동 시각과 경과일을 함께 본다. */
  const tracked = useMemo(
    () =>
      respondents.map((r) => {
        const lastActivity = r.last_seen_at ?? r.invited_at;
        const elapsed = daysSince(lastActivity);
        const stale =
          !DONE_STATUSES.includes(r.account_status) && (elapsed === null || elapsed >= STALE_DAYS);
        return { ...r, lastActivity, elapsed, stale };
      }),
    [respondents],
  );

  const filtered = tracked.filter(
    (r) => (statusFilter === "all" || r.account_status === statusFilter) && (!staleOnly || r.stale),
  );
  const staleCount = tracked.filter((r) => r.stale).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">대시보드</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          계열사별 조사 진행 현황을 한눈에 확인합니다.
        </p>
      </div>

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

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">계열사별 제출률</h2>
        {byCompany.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">표시할 계열사가 없습니다.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {byCompany.map((c) => {
              const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
              return (
                <li key={c.name}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground">
                      {c.done}/{c.total}명 · {pct}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">개인별 상태</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {STALE_DAYS}일 이상 움직임이 없는 미제출자 {staleCount}명
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[150px]" aria-label="상태 필터">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 상태</SelectItem>
                {ACCOUNT_STATUS_LABELS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={staleOnly}
                onCheckedChange={(checked) => setStaleOnly(checked === true)}
                aria-label={`${STALE_DAYS}일 이상 미진행자만 보기`}
              />
              {STALE_DAYS}일 이상 미진행자
            </label>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">조건에 맞는 인원이 없습니다.</p>
        ) : (
          <>
            {/* 모바일: 카드 스택 */}
            <ul className="space-y-3 md:hidden">
              {filtered.map((r) => (
                <li key={r.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {r.name}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {r.emp_no}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {r.companies?.name} · {r.org_text ?? "-"}
                      </p>
                    </div>
                    <StatusBadge status={r.account_status} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    최종 활동 {formatDateTime(r.lastActivity)} ·{" "}
                    {r.elapsed === null ? "기록 없음" : `${r.elapsed}일 경과`}
                    {r.stale && <span className="ml-1 font-medium text-destructive">정체</span>}
                  </p>
                </li>
              ))}
            </ul>

            {/* 데스크톱: 표 */}
            <div className="hidden overflow-x-auto rounded-lg border md:block">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">사번</th>
                    <th className="px-4 py-3 font-medium">이름</th>
                    <th className="px-4 py-3 font-medium">계열사</th>
                    <th className="px-4 py-3 font-medium">소속</th>
                    <th className="px-4 py-3 font-medium">상태</th>
                    <th className="px-4 py-3 font-medium">최종 활동</th>
                    <th className="px-4 py-3 font-medium">경과일</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className={r.stale ? "border-t bg-destructive/5" : "border-t"}>
                      <td className="px-4 py-3 text-muted-foreground">{r.emp_no}</td>
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3">{r.companies?.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.org_text ?? "-"}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.account_status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(r.lastActivity)}
                      </td>
                      <td
                        className={r.stale ? "px-4 py-3 font-medium text-destructive" : "px-4 py-3"}
                      >
                        {r.elapsed === null ? "-" : `${r.elapsed}일`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
