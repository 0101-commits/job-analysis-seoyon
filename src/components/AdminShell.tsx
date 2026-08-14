import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ClipboardCheck,
  Database,
  Download,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Settings,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Users;
  exact?: boolean;
};

const NAV: NavItem[] = [
  { to: "/admin", label: "대시보드", icon: LayoutDashboard, exact: true },
  { to: "/admin/participants", label: "참여자 관리", icon: Users },
  { to: "/admin/review", label: "검토 큐", icon: ClipboardCheck },
  { to: "/admin/master", label: "마스터 관리", icon: Database },
  { to: "/admin/mail", label: "메일 발송", icon: Mail },
  { to: "/admin/ai", label: "AI 도구", icon: Sparkles },
  { to: "/admin/settings", label: "설정", icon: Settings },
  { to: "/admin/export", label: "내보내기", icon: Download },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companyId, setCompanyId } = useCompanyScope();

  const { data: companies } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const nav = (
    <nav className="space-y-1">
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to as never}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-secondary",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-secondary">
      <header className="sticky top-0 z-30 border-b bg-card">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="메뉴 열기"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">HCG 컨설팅 · 관리자</p>
            <p className="truncate text-sm font-bold sm:text-base">서연 그룹 업무조사</p>
          </div>
          <div className="flex items-center gap-2">
            <Building2 className="hidden size-4 text-muted-foreground sm:block" />
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-[130px] sm:w-[170px]" aria-label="계열사 전환">
                <SelectValue placeholder="계열사 전환" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 계열사</SelectItem>
                {companies?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" aria-label="로그아웃" onClick={handleSignOut}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px]">
        <aside className="sticky top-[61px] hidden h-[calc(100vh-61px)] w-60 shrink-0 border-r bg-sidebar p-4 lg:block">
          {nav}
        </aside>

        {open && (
          <div className="fixed inset-0 top-[57px] z-20 lg:hidden">
            <button
              type="button"
              aria-label="메뉴 닫기"
              className="absolute inset-0 bg-foreground/30"
              onClick={() => setOpen(false)}
            />
            <div className="relative h-full w-64 max-w-[80vw] border-r bg-sidebar p-4">{nav}</div>
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

export function AdminPagePlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-xl border border-dashed bg-card p-8 text-center sm:p-12">
        <p className="text-sm text-muted-foreground">
          이 화면은 다음 단계에서 구현될 예정입니다.
        </p>
      </div>
    </div>
  );
}
