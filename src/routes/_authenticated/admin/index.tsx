import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge } from "@/components/StatusBadge";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";

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

function DashboardPage() {
  const { companyId } = useCompanyScope();

  const { data } = useQuery({
    queryKey: ["dashboard", companyId],
    queryFn: async () => {
      let query = supabase.from("participants").select("account_status, role");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const rows = data ?? [];
  const respondents = rows.filter((r) => r.role === "respondent");
  const submitted = respondents.filter((r) =>
    ["제출", "승인"].includes(r.account_status),
  ).length;
  const rate = respondents.length
    ? Math.round((submitted / respondents.length) * 100)
    : 0;

  const cards = [
    { label: "대상 인원", value: `${respondents.length}명` },
    { label: "제출 완료", value: `${submitted}명` },
    { label: "제출률", value: `${rate}%` },
    { label: "남은 기한", value: "D-–" },
  ];

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
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">상태별 현황</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ACCOUNT_STATUS_LABELS.map((status) => (
            <li
              key={status}
              className="flex items-center justify-between rounded-lg border bg-background px-3 py-2.5"
            >
              <StatusBadge status={status} />
              <span className="text-sm font-semibold">
                {rows.filter((r) => r.account_status === status).length}명
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
