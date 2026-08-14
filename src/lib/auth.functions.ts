import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

const emailInput = z.object({ email: z.string().trim().email().max(255) });

// ilike는 `_`를 와일드카드로 취급하므로 후보를 받아 JS에서 정확히 일치하는 행만 고른다.
async function findByEmail(admin: SupabaseClient, email: string) {
  const { data } = await admin
    .from("participants")
    .select("id, email, failed_login_count, first_login_at, locked_until")
    .ilike("email", email)
    .limit(20);
  const target = email.toLowerCase();
  return (
    (data as
      | {
          id: string;
          email: string | null;
          failed_login_count: number;
          first_login_at: string | null;
          locked_until: string | null;
        }[]
      | null)?.find((row) => (row.email ?? "").toLowerCase() === target) ?? null
  );
}

function isLocked(lockedUntil: string | null) {
  return !!lockedUntil && new Date(lockedUntil).getTime() > Date.now();
}

/** 로그인 시도 전 잠금 여부 확인. 계정 존재 여부는 노출하지 않는다. */
export const checkLockStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => emailInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const participant = await findByEmail(supabaseAdmin, data.email);
    return { locked: isLocked(participant?.locked_until ?? null) };
  });

/** 로그인 결과 기록: 실패 누적/잠금, 성공 시 초기화 + 접속 시각 갱신. */
export const recordLoginAttempt = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => emailInput.extend({ success: z.boolean() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const participant = await findByEmail(supabaseAdmin, data.email);
    if (!participant) return { locked: false };

    const now = new Date().toISOString();
    if (data.success) {
      await supabaseAdmin
        .from("participants")
        .update({
          failed_login_count: 0,
          locked_until: null,
          last_seen_at: now,
          first_login_at: participant.first_login_at ?? now,
        })
        .eq("id", participant.id);
      return { locked: false };
    }

    const count = participant.failed_login_count + 1;
    const locked = count >= MAX_ATTEMPTS;
    await supabaseAdmin
      .from("participants")
      .update({
        failed_login_count: count,
        locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      })
      .eq("id", participant.id);
    return { locked, remaining: locked ? 0 : MAX_ATTEMPTS - count };
  });

/** 비밀번호 변경 완료 처리(본인 행만). */
export const completePasswordChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("participants")
      .update({ must_change_password: false, initial_password: null })
      .eq("user_id", context.userId);
    return { ok: true };
  });
