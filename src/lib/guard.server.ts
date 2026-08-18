import type { SupabaseClient } from "@supabase/supabase-js";

export async function requireAdmin(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("관리자 권한이 필요합니다.");
}

/**
 * 자식 테이블(response_tasks/skills/requirements/activities)을 고친 뒤 부모 responses.updated_at 을 민다.
 * 참여자 저장(save_*_tx)의 낙관적 락이 이 값을 비교하므로, 안 밀면 관리자 정정이 흔적 없이 덮인다.
 * responses 자체 컬럼 수정은 updated_at 트리거가 이미 갱신하므로 호출 불요.
 */
export async function touchResponse(admin: SupabaseClient, responseId: string) {
  const { error } = await admin
    .from("responses")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", responseId);
  if (error) throw new Error(error.message);
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
