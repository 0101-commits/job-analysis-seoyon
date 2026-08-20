import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Building2, ClipboardCheck, Clock, Search, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useCompanyScope } from "@/components/CompanyContext";
import { useOrgLens } from "@/components/admin/OrgTreeFilter";
import { usePersistedState } from "@/hooks/use-persisted-ui";

/**
 * 전역 찾기 (기획 A3).
 *
 * 참여자 500명 규모에서 사람 한 명을 찾으려면 메뉴 → 탭 → 필터 → 검색 네 단계였다.
 * 어느 화면에 있든 한 번에 열어 사번·이름·메일·직무·소속을 함께 찾고, 고른 대상으로
 * 곧장 이동한다. 이동 규약(다른 화면들이 이 주소를 받는다):
 *   참여자 → /admin/participants?p=<participant id>
 *   응답   → /admin/review?response=<response id>
 *   직무   → /admin/master?job=<job_catalog id>
 * 소속은 이동할 화면이 따로 없으므로 소속 렌즈를 그 조직으로 바꾸고 참여자 명부를 연다.
 */

/** 이동 대상 — 수신 화면들이 각자 주소 항목을 선언하는 중이라 라우터 타입에는 아직 없다. */
type NavTarget = { to: string; search?: Record<string, string> };

type Hit = {
  key: string;
  label: string;
  sub: string;
  run: () => void;
};

const RESPONSE_STATUS: Record<string, string> = {
  draft: "작성중",
  submitted: "제출",
  rejected: "반려",
  approved: "승인",
};

/** PostgREST or() 문법을 깨는 글자를 지운다. 검색어는 사람이 손으로 치는 값이다. */
function safeTerm(raw: string) {
  return raw.replace(/[,()%*\\"']/g, " ").trim();
}

export function CommandPalette({ screens }: { screens: { to: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { companyId } = useCompanyScope();
  const { setSelectedOrgId } = useOrgLens();
  const [recent, setRecent] = usePersistedState<string[]>("admin-recent-screens", []);

  // 최근 방문 화면 — 검색어가 없을 때 보여 줄 목록.
  useEffect(() => {
    const hit = screens.find((s) => s.to === pathname);
    if (!hit) return;
    setRecent((prev) => [hit.to, ...prev.filter((p) => p !== hit.to)].slice(0, 5));
    // screens 는 상수 목록이라 경로가 바뀔 때만 기록한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(term.trim()), 200);
    return () => window.clearTimeout(id);
  }, [term]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (target: NavTarget) => {
    setOpen(false);
    setTerm("");
    navigate(target as never);
  };

  const q = safeTerm(debounced);

  const { data, isFetching } = useQuery({
    queryKey: ["admin-search", companyId, q],
    enabled: open && q.length >= 1,
    queryFn: async () => {
      let people = supabase
        .from("participants")
        .select("id, name, emp_no, email, org_text")
        .or(`emp_no.ilike.%${q}%,name.ilike.%${q}%,email.ilike.%${q}%`)
        .is("archived_at", null)
        .limit(6);
      if (companyId !== "all") people = people.eq("company_id", companyId);

      let responses = supabase
        .from("responses")
        .select("id, job_name, status, participants!inner(name, emp_no)")
        .ilike("job_name", `%${q}%`)
        .limit(6);
      if (companyId !== "all") responses = responses.eq("company_id", companyId);

      let units = supabase
        .from("org_units")
        .select("id, name, level")
        .ilike("name", `%${q}%`)
        .limit(6);
      if (companyId !== "all") units = units.eq("company_id", companyId);

      let jobs = supabase
        .from("job_catalog")
        .select("id, job_name, job_series, job_group")
        .or(`job_name.ilike.%${q}%,job_series.ilike.%${q}%,job_group.ilike.%${q}%`)
        .limit(6);
      if (companyId !== "all") jobs = jobs.contains("company_ids", [companyId]);

      const [p, r, u, j] = await Promise.all([people, responses, units, jobs]);
      if (p.error) throw p.error;
      if (r.error) throw r.error;
      if (u.error) throw u.error;
      if (j.error) throw j.error;
      return {
        people: p.data ?? [],
        responses: r.data ?? [],
        units: u.data ?? [],
        jobs: j.data ?? [],
      };
    },
  });

  const groups = useMemo(() => {
    if (!data) return [] as { title: string; icon: typeof Users; hits: Hit[] }[];

    const people: Hit[] = data.people.map((p) => ({
      key: `p-${p.id}`,
      label: `${p.name} (${p.emp_no})`,
      sub: [p.org_text, p.email].filter(Boolean).join(" · ") || "참여자 명부에서 열기",
      run: () => go({ to: "/admin/participants", search: { p: p.id } }),
    }));

    const responses: Hit[] = data.responses.map((r) => {
      const owner = Array.isArray(r.participants) ? r.participants[0] : r.participants;
      return {
        key: `r-${r.id}`,
        label: r.job_name ?? "직무명 미입력",
        sub: [owner?.name, RESPONSE_STATUS[r.status] ?? r.status].filter(Boolean).join(" · "),
        run: () => go({ to: "/admin/review", search: { response: r.id } }),
      };
    });

    const jobs: Hit[] = data.jobs.map((j) => ({
      key: `j-${j.id}`,
      label: j.job_name,
      sub: `${j.job_group} / ${j.job_series}`,
      run: () => go({ to: "/admin/master", search: { job: j.id } }),
    }));

    const units: Hit[] = data.units.map((u) => ({
      key: `u-${u.id}`,
      label: u.name,
      sub: `${u.level ?? "소속"} · 이 소속만 보기`,
      run: () => {
        setSelectedOrgId(u.id);
        go({ to: "/admin/participants" });
      },
    }));

    return [
      { title: "참여자", icon: Users, hits: people },
      { title: "응답", icon: ClipboardCheck, hits: responses },
      { title: "직무", icon: Briefcase, hits: jobs },
      { title: "소속", icon: Building2, hits: units },
    ].filter((g) => g.hits.length > 0);
    // go/setSelectedOrgId 는 매 렌더 새로 만들어지므로 데이터에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const recentScreens = recent
    .map((to) => screens.find((s) => s.to === to))
    .filter((s): s is { to: string; label: string } => Boolean(s));

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden sm:inline">찾기</span>
        <CommandShortcut className="hidden lg:inline">Ctrl K</CommandShortcut>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0">
          <DialogTitle className="sr-only">전체 찾기</DialogTitle>
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2"
          >
            <CommandInput
              value={term}
              onValueChange={setTerm}
              placeholder="사번 · 이름 · 메일 · 직무 · 소속으로 찾기"
            />
            <CommandList className="max-h-[60vh]">
              {q.length === 0 ? (
                <>
                  {recentScreens.length > 0 && (
                    <>
                      <CommandGroup heading="최근 본 화면">
                        {recentScreens.map((s) => (
                          <CommandItem
                            key={`recent-${s.to}`}
                            value={`recent-${s.to}`}
                            onSelect={() => go({ to: s.to })}
                          >
                            <Clock className="mr-2 size-4 text-muted-foreground" aria-hidden />
                            {s.label}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                      <CommandSeparator />
                    </>
                  )}
                  <CommandGroup heading="화면 이동">
                    {screens.map((s) => (
                      <CommandItem key={s.to} value={s.to} onSelect={() => go({ to: s.to })}>
                        {s.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              ) : (
                <>
                  {isFetching && groups.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      찾고 있습니다…
                    </p>
                  ) : (
                    <CommandEmpty>
                      <span className="block text-sm">‘{debounced}’ 로는 찾지 못했습니다.</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        사번 전체·이름 일부·직무명으로 다시 찾아 보세요.
                        {companyId !== "all" && " 지금은 선택한 계열사 안에서만 찾습니다."}
                      </span>
                    </CommandEmpty>
                  )}
                  {groups.map((g) => (
                    <CommandGroup key={g.title} heading={g.title}>
                      {g.hits.map((h) => (
                        <CommandItem key={h.key} value={h.key} onSelect={h.run}>
                          <g.icon
                            className="mr-2 size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate">{h.label}</span>
                          <span className="ml-2 shrink-0 truncate text-xs text-muted-foreground">
                            {h.sub}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
                </>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
