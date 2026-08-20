// 응답자 문의함 (F6) + 변경 재확인 처리 (F10).
//
// 문의 작성은 본인 participant 행을 서버에서 직접 찾아 소유권을 확인한 뒤 쓴다 — 클라이언트가
// participantId 를 보내지 않는다(위조 방지). 답변 확인(markAnswerSeen)과 재확인 해제
// (clearRecheck)는 RLS 상 본인이 직접 UPDATE 할 수 없는 행이라(문의 답변란은 관리자만
// 고칠 수 있고, responses 는 draft/rejected 상태에서만 본인이 고칠 수 있다) service-role
// 로 쓰되, 참여자 본인 행이 맞는지를 여기서 먼저 확인한다.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const INQUIRY_CATEGORIES = ["직무없음", "항목이해", "접속문제", "기타"] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];

export const INQUIRY_CATEGORY_LABELS: Record<InquiryCategory, string> = {
  직무없음: "내 직무가 목록에 없어요",
  항목이해: "이 항목이 무슨 뜻인지 모르겠어요",
  접속문제: "접속이 잘 안 돼요",
  기타: "기타 문의",
};

/** 문의 접수 안내 문구 — 화면 여러 곳에서 같은 말을 쓰기 위한 단일 원천. */
export const INQUIRY_SLA_NOTICE = "보통 1~2 영업일 안에 답변해 드립니다.";

async function myParticipantId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from("participants").select("id").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("참여자 정보를 찾을 수 없습니다.");
  return data.id;
}

/** 문의 등록. 본문 길이는 10~2000자만 받는다(너무 짧으면 처리할 수 없고, 너무 길면 붙여넣기 사고다). */
export const createInquiry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        category: z.enum(INQUIRY_CATEGORIES).default("기타"),
        body: z
          .string()
          .trim()
          .min(10, "10자 이상 적어 주세요.")
          .max(2000, "2000자 이내로 적어 주세요."),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const participantId = await myParticipantId(context.supabase);
    const { error } = await context.supabase.from("inquiries").insert({
      participant_id: participantId,
      category: data.category,
      body: data.body,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** 본인이 낸 문의 전체(답변 포함), 최신순. RLS(own inquiries) 로도 걸러지지만 명시적으로도 좁힌다. */
export const listMyInquiries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const participantId = await myParticipantId(context.supabase);
    const { data, error } = await context.supabase
      .from("inquiries")
      .select("id, category, body, status, answer, answer_seen_at, answered_at, created_at")
      .eq("participant_id", participantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export type MyInquiry = Awaited<ReturnType<typeof listMyInquiries>>[number];

/**
 * 답변 확인 처리. inquiries 의 UPDATE RLS 는 관리자 전용이라(답변 변조 방지) 본인이 직접
 * 고칠 수 없다 — service-role 로 쓰되, 본인 문의가 맞는지 먼저 확인한다.
 */
export const markAnswerSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const participantId = await myParticipantId(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("inquiries")
      .select("id, participant_id, status, answer_seen_at")
      .eq("id", data.id)
      .maybeSingle();
    if (!row || row.participant_id !== participantId) {
      throw new Error("본인 문의만 확인 처리할 수 있습니다.");
    }
    if (row.status !== "답변완료" || row.answer_seen_at) return { ok: true };

    const { error } = await supabaseAdmin
      .from("inquiries")
      .update({ answer_seen_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * F10 재확인 해제 — "확인했습니다" 처리.
 *
 * responses 는 draft/rejected 상태에서만 본인이 UPDATE 할 수 있어(owners update own draft
 * response 정책) 제출·승인된 응답은 본인 토큰으로 재확인을 내릴 수 없다. 재확인 자체는
 * 상태와 무관하게 걸 수 있어야 하므로 service-role 로 쓰고, 본인 응답인지와 실제로
 * 재확인이 걸려 있는지를 여기서 확인한다. guard_response_update 트리거의 "세우기는
 * 막고 내리기만 허용" 규칙과 같은 방향(false 로만 바꾼다)이라 트리거를 우회해도 안전하다.
 */
export const clearRecheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const participantId = await myParticipantId(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, recheck_required")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!row || row.participant_id !== participantId) {
      throw new Error("본인 응답만 확인 처리할 수 있습니다.");
    }
    if (!row.recheck_required) return { ok: true };

    const { error } = await supabaseAdmin
      .from("responses")
      .update({ recheck_required: false, recheck_cleared_at: new Date().toISOString() })
      .eq("id", data.responseId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- 관리자용 (화면은 별도 담당 — 여기서는 서버함수만 제공) ----------

/** 문의 대기 목록. jobName 검색이 없으므로 admin.functions.ts 의 필터 관례만 따른다. */
export const listInquiries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["접수", "답변완료"]).nullable().optional(),
        category: z.enum(INQUIRY_CATEGORIES).nullable().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = supabaseAdmin
      .from("inquiries")
      .select(
        "id, category, body, status, answer, answered_at, created_at, participants(id, name, emp_no, org_text, companies(name))",
      )
      .order("created_at", { ascending: false });
    if (data.status) q = q.eq("status", data.status);
    if (data.category) q = q.eq("category", data.category);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const answerInquiry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        answer: z.string().trim().min(1, "답변 내용을 적어 주세요.").max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("inquiries")
      .update({
        answer: data.answer,
        status: "답변완료",
        answered_by: context.userId,
        answered_at: new Date().toISOString(),
        // 재답변 시에도 새 답변으로 다시 안내되도록 확인 표시를 초기화한다.
        answer_seen_at: null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "문의 답변",
      target_type: "inquiries",
      target_id: data.id,
    });
    return { ok: true };
  });
