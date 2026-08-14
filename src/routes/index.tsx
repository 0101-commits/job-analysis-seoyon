import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchMyRole } from "@/lib/auth";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "서연 그룹 업무조사 | HCG 컨설팅" },
      { name: "description", content: "서연 그룹 계열사 업무조사 참여 및 관리 시스템입니다." },
      { property: "og:title", content: "서연 그룹 업무조사" },
      { property: "og:description", content: "서연 그룹 계열사 업무조사 참여 및 관리 시스템입니다." },
    ],
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const role = await fetchMyRole();
    throw redirect({ to: role === "admin" ? "/admin" : "/home" });
  },
  component: () => null,
});
