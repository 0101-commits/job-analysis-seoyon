import type { SupabaseClient } from "@supabase/supabase-js";

export async function requireAdmin(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("관리자 권한이 필요합니다.");
}

export async function writeAudit(
  admin: SupabaseClient,
  entry: {
    actor_id?: string | null;
    actor_email?: string | null;
    action: string;
    target_type?: string;
    target_id?: string;
    detail?: Record<string, unknown>;
  },
) {
  await admin.from("audit_logs").insert({
    actor_id: entry.actor_id ?? null,
    actor_email: entry.actor_email ?? null,
    action: entry.action,
    target_type: entry.target_type ?? null,
    target_id: entry.target_id ?? null,
    detail: entry.detail ?? {},
  });
}
