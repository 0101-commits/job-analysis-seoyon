import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatusBadge } from "@/components/StatusBadge";
import { useCompanyScope } from "@/components/CompanyContext";

export const Route = createFileRoute("/_authenticated/admin/participants")({
  head: () => ({
    meta: [
      { title: "참여자 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "계열사별 참여자 명단과 계정 상태를 관리합니다." },
      { property: "og:title", content: "참여자 관리 | 서연 그룹 업무조사" },
      { property: "og:description", content: "계열사별 참여자 명단과 계정 상태를 관리합니다." },
    ],
  }),
  component: ParticipantsPage,
});

function ParticipantsPage() {
  const { companyId } = useCompanyScope();

  const { data, isLoading } = useQuery({
    queryKey: ["participants", companyId],
    queryFn: async () => {
      let query = supabase
        .from("participants")
        .select("id, emp_no, name, email, org_text, grade, role, account_status, companies(name)")
        .order("emp_no");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">참여자 관리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          계열사별 참여자 명단과 계정 상태를 관리합니다. 총 {rows.length}명
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : (
        <>
          {/* 모바일: 카드 스택 */}
          <ul className="space-y-3 md:hidden">
            {rows.map((p) => (
              <li key={p.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {p.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {p.emp_no}
                      </span>
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {p.companies?.name} · {p.org_text}
                    </p>
                  </div>
                  <StatusBadge status={p.account_status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">직급</dt>
                    <dd className="mt-0.5 font-medium">{p.grade ?? "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">권한</dt>
                    <dd className="mt-0.5 font-medium">
                      {p.role === "admin" ? "관리자" : "응답자"}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">이메일</dt>
                    <dd className="mt-0.5 truncate font-medium">{p.email ?? "-"}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          {/* 데스크톱: 표 */}
          <div className="hidden overflow-hidden rounded-xl border bg-card shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="bg-secondary text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">사번</th>
                  <th className="px-4 py-3 font-medium">이름</th>
                  <th className="px-4 py-3 font-medium">계열사</th>
                  <th className="px-4 py-3 font-medium">소속</th>
                  <th className="px-4 py-3 font-medium">직급</th>
                  <th className="px-4 py-3 font-medium">권한</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="px-4 py-3 text-muted-foreground">{p.emp_no}</td>
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3">{p.companies?.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{p.org_text}</td>
                    <td className="px-4 py-3">{p.grade ?? "-"}</td>
                    <td className="px-4 py-3">{p.role === "admin" ? "관리자" : "응답자"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.account_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
