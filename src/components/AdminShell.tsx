import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ClipboardCheck,
  Database,
  Download,
  Layers,
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
import { CommandPalette } from "@/components/admin/CommandPalette";
import { orgPathLabel, useOrgLens } from "@/components/admin/OrgTreeFilter";
import { listActiveCompanies } from "@/lib/companies";
import { applyLensPatch } from "@/lib/lens-search";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Users;
  exact?: boolean;
  /** 검토 대기 건수를 배지로 붙인다. */
  badge?: "review";
};

type NavGroup = {
  /** 구획 이름. 없으면 최상단 단독 항목. */
  label?: string;
  items: NavItem[];
};

/**
 * 메뉴는 조사 진행 순서다 (기획 A1).
 *
 * 평면 8개였을 때는 "지금 뭘 해야 하는지"가 메뉴에서 읽히지 않았다. 준비 → 수집 → 산출
 * 순서로 묶고 이름을 업무 어휘로 바꿔서, 메뉴만 봐도 조사 한 바퀴가 보이게 한다.
 */
const NAV: NavGroup[] = [
  { items: [{ to: "/admin", label: "진행 현황", icon: LayoutDashboard, exact: true }] },
  {
    label: "1 · 준비",
    items: [
      { to: "/admin/master", label: "조직·직무 기준정보", icon: Database },
      { to: "/admin/participants", label: "참여자 명부", icon: Users },
      { to: "/admin/waves", label: "차수 관리", icon: Layers },
      { to: "/admin/settings", label: "조사 설정", icon: Settings },
    ],
  },
  {
    label: "2 · 수집",
    items: [
      { to: "/admin/mail", label: "메일 템플릿", icon: Mail },
      { to: "/admin/review", label: "응답 검토", icon: ClipboardCheck, badge: "review" },
    ],
  },
  {
    label: "3 · 산출",
    items: [{ to: "/admin/export", label: "직무기술서·내보내기", icon: Download }],
  },
];

/** AI 점검은 응답 검토 화면으로 흡수되는 중이다. 그때까지 들어갈 길만 남겨 둔다. */
const AI_TOOLS: NavItem = { to: "/admin/ai", label: "AI 일괄 점검", icon: Sparkles };

/** 전역 찾기의 화면 이동 목록 — 메뉴와 어긋나지 않도록 NAV 에서 뽑는다. */
const FLAT_SCREENS = [...NAV.flatMap((g) => g.items), AI_TOOLS].map((i) => ({
  to: i.to,
  label: i.label,
}));

export function AdminShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companyId } = useCompanyScope();
  const { selectedOrgId, setSelectedOrgId } = useOrgLens();

  // 스위처에는 운영 중 계열사만 — 중지된 계열사는 화면에서 빠진다 (기획 11).
  const { data: companies } = useQuery({
    queryKey: ["companies", "active"],
    queryFn: listActiveCompanies,
  });

  // 헤더에 "지금 무엇을 보는 중인지" 표시하려면 선택한 소속의 경로 이름이 필요하다.
  const { data: orgUnits } = useQuery({
    queryKey: ["org-units-filter", companyId],
    queryFn: async () => {
      let query = supabase.from("org_units").select("id, parent_id, name, sort").order("sort");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(selectedOrgId),
  });

  const { data: reviewWaiting } = useQuery({
    queryKey: ["review-waiting-count", companyId],
    queryFn: async () => {
      let query = supabase
        .from("responses")
        .select("id", { count: "exact", head: true })
        .eq("status", "submitted");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    },
  });

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  /**
   * 계열사를 바꾸면 소속 렌즈는 반드시 풀어야 한다. 다른 계열사의 조직을 그대로 물고 있으면
   * 목록이 이유 없이 텅 비어 보인다 — 침묵 실패(기획 P8).
   *
   * 두 값 다 URL 렌즈이므로 한 번의 navigate 로 함께 바꾼다 — 따로 바꾸면 두 번째 호출이
   * 첫 번째가 아직 반영되지 않은 이전 URL 위에 얹혀 하나가 씹힐 수 있고, 히스토리도 두 건이 된다.
   */
  function handleCompanyChange(next: string) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        applyLensPatch(prev, {
          co: next === "all" ? null : next,
          ...(next !== companyId ? { org: null } : {}),
        }),
    });
  }

  const lensLabel = selectedOrgId ? orgPathLabel(orgUnits ?? [], selectedOrgId) : null;

  /*
   * 헤더 높이가 97px·93px 로 하드코딩되어 여섯 곳에 퍼져 있으면, 헤더 구성(배지 추가 등)이
   * 바뀔 때마다 sticky 사이드바·모바일 드로어가 헤더 뒤로 숨는다. 실측해서 CSS 변수 하나로
   * 흘려보낸다.
   */
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--header-h", `${h}px`);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function NavLink({ item }: { item: NavItem }) {
    const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
    const badge = item.badge === "review" ? reviewWaiting : undefined;
    return (
      <Link
        to={item.to as never}
        onClick={() => setOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-secondary",
        )}
      >
        <item.icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge ? (
          <span
            className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-warning"
            title={`검토 대기 ${badge}건`}
          >
            {badge}
          </span>
        ) : null}
      </Link>
    );
  }

  const nav = (
    <nav className="space-y-4">
      {NAV.map((group, gi) => (
        <div key={group.label ?? `top-${gi}`} className="space-y-1">
          {group.label ? (
            <p className="px-3 pb-0.5 text-xs font-semibold text-muted-foreground">{group.label}</p>
          ) : null}
          {group.items.map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
        </div>
      ))}

      <div className="border-t pt-3">
        <Link
          to={AI_TOOLS.to as never}
          onClick={() => setOpen(false)}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors hover:bg-secondary",
            pathname.startsWith(AI_TOOLS.to) ? "text-accent-foreground" : "text-muted-foreground",
          )}
        >
          <AI_TOOLS.icon className="size-3.5 shrink-0" />
          {AI_TOOLS.label}
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-secondary">
      <header ref={headerRef} className="sticky top-0 z-30 border-b bg-card">
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
            <CommandPalette screens={FLAT_SCREENS} />
            <Building2 className="hidden size-4 text-muted-foreground sm:block" />
            <Select value={companyId} onValueChange={handleCompanyChange}>
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
            {lensLabel ? (
              <button
                type="button"
                onClick={() => setSelectedOrgId(null)}
                title="이 소속만 보는 상태입니다. 눌러서 전체로 돌아갑니다."
                className="hidden max-w-[220px] items-center gap-1 rounded-full border bg-primary-soft px-2.5 py-1 text-xs font-medium text-accent-foreground hover:opacity-80 sm:inline-flex"
              >
                <span className="truncate">{lensLabel}</span>
                <X className="size-3 shrink-0" aria-hidden />
              </button>
            ) : null}
            <Button variant="ghost" size="icon" aria-label="로그아웃" onClick={handleSignOut}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* 헤더 높이는 위 ResizeObserver 가 --header-h 로 실측해 넣는다. */}
      {/* 읽기 폭은 셸이 아니라 내용이 갖는다 — 화면마다 필요한 폭이 다르므로 여기서 상한을 두지 않는다. */}
      <div className="flex w-full">
        <aside className="sticky top-[var(--header-h)] hidden h-[calc(100vh-var(--header-h))] w-60 shrink-0 overflow-y-auto border-r bg-sidebar p-4 lg:block">
          {nav}
        </aside>

        {open && (
          <div className="fixed inset-0 top-[var(--header-h)] z-20 lg:hidden">
            <button
              type="button"
              aria-label="메뉴 닫기"
              className="absolute inset-0 bg-foreground/30"
              onClick={() => setOpen(false)}
            />
            <div className="relative h-full w-64 max-w-[80vw] overflow-y-auto border-r bg-sidebar p-4">
              {nav}
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
