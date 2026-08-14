import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

// ilike는 `_`를 와일드카드로 취급하므로 후보를 받아 JS에서 정확히 일치하는 행만 고른다.
async function findByEmail(admin: SupabaseClient, email: string) {
  const { data } = await admin
    .from("participants")
    .select("id, email, failed_login_count, first_login_at, locked_until")
    .ilike("email", email);
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

/**
 * GoTrue password grant를 서버에서 직접 호출한다.
 * supabase-js 클라이언트를 쓰지 않는 이유: 모듈 싱글턴에 세션이 붙어 요청 간 권한이 새는 것을 막고,
 * 신형 opaque publishable key의 Authorization 헤더 처리 분기도 피한다.
 * 반환: 토큰(인증 성공) | null(자격 증명 불일치). 그 외 오류는 throw.
 */
async function passwordGrant(email: string, password: string) {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Supabase 환경 변수가 설정되지 않았습니다.");

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 400 || res.status === 401) return null;
  if (!res.ok) throw new Error("로그인 처리 중 오류가 발생했습니다.");

  const body = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token || !body.refresh_token) throw new Error("로그인 처리 중 오류가 발생했습니다.");
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/**
 * 서버 주도 로그인: 잠금 확인 → 실제 인증 → 실패 누적/잠금 또는 성공 기록.
 * 클라이언트는 성공 여부를 지정할 수 없고, 응답도 status만 받는다(계정 존재 여부·남은 횟수 비노출).
 */
export const signInWithLock = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const participant = await findByEmail(supabaseAdmin, data.email);
    if (participant && isLocked(participant.locked_until)) return { status: "locked" as const };

    const tokens = await passwordGrant(data.email, data.password);
    const now = new Date().toISOString();

    if (!tokens) {
      if (!participant) return { status: "invalid" as const };
      // 잠금 시간이 지난 계정은 카운트를 0부터 다시 센다(1회 실패로 재잠금 방지).
      const base = participant.locked_until ? 0 : participant.failed_login_count;
      const count = base + 1;
      const locked = count >= MAX_ATTEMPTS;
      await supabaseAdmin
        .from("participants")
        .update({
          failed_login_count: count,
          locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
        })
        .eq("id", participant.id);
      return { status: locked ? ("locked" as const) : ("invalid" as const) };
    }

    if (participant) {
      await supabaseAdmin
        .from("participants")
        .update({
          failed_login_count: 0,
          locked_until: null,
          last_seen_at: now,
          first_login_at: participant.first_login_at ?? now,
        })
        .eq("id", participant.id);
    }
    return { status: "ok" as const, session: tokens };
  });

/**
 * 비밀번호 변경 완료 처리(본인 행만).
 * 계약: 성공 시 { ok: true }. DB 오류나 명부에 연결된 행이 없으면 throw하므로
 * 호출부는 반드시 try/catch로 사용자에게 실패를 알려야 한다(조용한 성공 처리 금지).
 */
export const completePasswordChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("participants")
      .update({ must_change_password: false, initial_password: null })
      .eq("user_id", context.userId)
      .select("id");
    if (error) throw new Error("비밀번호 변경 상태를 저장하지 못했습니다.");
    if (!data?.length) throw new Error("명부에 연결된 계정을 찾지 못했습니다. 관리자에게 문의하세요.");
    return { ok: true };
  });
