import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "respondent" | "admin";

export async function fetchMyRole(): Promise<AppRole | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;

  const { data } = await supabase.from("user_roles").select("role").eq("user_id", uid);
  if (data?.some((r) => r.role === "admin")) return "admin";
  if (data?.length) return "respondent";

  // 최초 로그인: 참여자 명단과 계정 연결
  const { data: linked } = await supabase.rpc("link_current_user");
  return (linked as AppRole | null) ?? null;
}

export function useMyRole() {
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetchMyRole()
      .then((r) => active && setRole(r))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  return { role, loading };
}

export const ACCOUNT_STATUS_LABELS = [
  "미발송",
  "초대발송",
  "미접속",
  "작성중",
  "제출",
  "반려",
  "승인",
] as const;
