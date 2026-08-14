import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

/** 직무별 응답 수 집계에 포함되는 상태 (초안·반려는 제외) */
const COUNTED_STATUSES = ["submitted", "approved"];

/** 관리자가 직접 정정할 수 있는 텍스트 필드 화이트리스트 */
const CORRECTABLE = {
  responses: [
    "job_group",
    "job_series",
    "job_name",
    "definition",
    "mission",
    "missed_note",
    "pain_note",
  ],
  response_tasks: ["name", "improve_note"],
  response_activities: ["name"],
  response_skills: ["name", "description"],
  response_requirements: ["majors_required", "majors_preferred", "trainings", "proficiency"],
} as const;

type CorrectableTable = keyof typeof CORRECTABLE;

const queueInput = z.object({
  companyId: z.string().uuid().nullable().optional(),
  status: z.enum(["submitted", "rejected", "approved"]).nullable().optional(),
  jobName: z.string().trim().max(120).optional(),
});

/** 직무명 → 응답 수 (제출·승인 기준). 회사 스코프가 있으면 그 안에서만 센다. */
async function jobCounts(
  admin: SupabaseClient<Database>,
  companyId: string | null,
): Promise<Record<string, number>> {
  let q = admin.from("responses").select("job_name").in("status", COUNTED_STATUSES);
  if (companyId) q = q.eq("company_id", companyId);
  const { data } = await q;
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row.job_name) counts[row.job_name] = (counts[row.job_name] ?? 0) + 1;
  }
  return counts;
}

export const listReviewQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => queueInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const companyId = data.companyId ?? null;

    let q = supabaseAdmin
      .from("responses")
      .select(
        "id, job_group, job_series, job_name, status, submitted_at, updated_at, company_id, companies(name), participants(name, emp_no, org_text, grade, role_level, account_status)",
      )
      .neq("status", "draft")
      .order("submitted_at", { ascending: false });
    if (companyId) q = q.eq("company_id", companyId);
    if (data.status) q = q.eq("status", data.status);
    if (data.jobName) q = q.ilike("job_name", `%${data.jobName}%`);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const counts = await jobCounts(supabaseAdmin, companyId);

    return {
      rows: (rows ?? []).map((r) => ({
        ...r,
        jobCount: r.job_name ? (counts[r.job_name] ?? 0) : 0,
      })),
      jobCounts: counts,
    };
  });

export const getResponseDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin
      .from("responses")
      .select(
        "*, companies(name), participants(id, name, emp_no, email, org_text, grade, role_level, account_status), response_tasks(*, response_activities(*)), response_skills(*), response_requirements(*), review_comments(*)",
      )
      .eq("id", data.responseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("응답을 찾을 수 없습니다.");

    // 중첩 임베드는 정렬을 보장하지 않으므로 여기서 맞춘다.
    const tasks = [...row.response_tasks]
      .sort((a, b) => a.seq - b.seq)
      .map((t) => ({
        ...t,
        response_activities: [...t.response_activities].sort((a, b) => a.seq - b.seq),
      }));
    const comments = [...row.review_comments].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );

    const counts = await jobCounts(supabaseAdmin, row.company_id);
    const aiDraftSkills = row.response_skills.filter((s) => s.ai_draft).length;

    return {
      response: {
        ...row,
        response_tasks: tasks,
        review_comments: comments,
      },
      aiDraft: {
        skills: aiDraftSkills,
        requirements: row.response_requirements?.ai_draft ?? false,
        any: aiDraftSkills > 0 || (row.response_requirements?.ai_draft ?? false),
      },
      jobCount: row.job_name ? (counts[row.job_name] ?? 0) : 0,
    };
  });

export const approveResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
        interviewConfirmed: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, company_id, job_name, status")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!row) throw new Error("응답을 찾을 수 없습니다.");
    if (row.status === "draft") throw new Error("아직 제출되지 않은 응답입니다.");

    // 게이트 1 — 미확정 AI 초안
    const { count: draftSkills } = await supabaseAdmin
      .from("response_skills")
      .select("id", { count: "exact", head: true })
      .eq("response_id", row.id)
      .eq("ai_draft", true);
    const { data: req } = await supabaseAdmin
      .from("response_requirements")
      .select("ai_draft")
      .eq("response_id", row.id)
      .maybeSingle();
    if ((draftSkills ?? 0) > 0 || req?.ai_draft) {
      return {
        ok: false as const,
        needsInterview: false,
        reason:
          "확정되지 않은 AI 초안 항목이 남아 있습니다. 응답자 확인 또는 정정 후 승인할 수 있습니다.",
      };
    }

    // 게이트 2 — 1인 응답 직무는 후속 인터뷰 확인 필요
    const counts = await jobCounts(supabaseAdmin, row.company_id);
    const count = row.job_name ? (counts[row.job_name] ?? 0) : 0;
    if (count <= 1 && !data.interviewConfirmed) {
      return {
        ok: false as const,
        needsInterview: true,
        reason: "1인 응답 직무는 후속 인터뷰 확인 후 확정할 수 있습니다.",
      };
    }

    const { error } = await supabaseAdmin
      .from("responses")
      .update({
        status: "approved",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("participants")
      .update({ account_status: "승인" })
      .eq("id", row.participant_id);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 승인",
      target_type: "response",
      target_id: row.id,
      detail: { job_name: row.job_name, job_count: count, interview_confirmed: !!data.interviewConfirmed },
    });

    return { ok: true as const, needsInterview: false, reason: null };
  });

export const rejectResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
        step: z.number().int().min(1).max(6).nullable().optional(),
        comment: z.string().trim().min(1, "반려 사유를 입력하세요.").max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, job_name, status")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!row) throw new Error("응답을 찾을 수 없습니다.");
    if (row.status === "draft") throw new Error("아직 제출되지 않은 응답입니다.");

    const { error: commentError } = await supabaseAdmin.from("review_comments").insert({
      response_id: row.id,
      author_id: context.userId,
      step: data.step ?? null,
      body: data.comment,
      kind: "reject",
    });
    if (commentError) throw new Error(commentError.message);

    const { error } = await supabaseAdmin
      .from("responses")
      .update({
        status: "rejected",
        ...(data.step ? { current_step: data.step } : {}),
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("participants")
      .update({ account_status: "반려" })
      .eq("id", row.participant_id);

    // TODO(P1 메일 인프라 연동): 반려 시 응답자에게 사유 메일 발송 — 이번 범위 밖.

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 반려",
      target_type: "response",
      target_id: row.id,
      detail: { step: data.step ?? null, job_name: row.job_name },
    });

    return { ok: true };
  });

export const correctField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
        table: z.enum([
          "responses",
          "response_tasks",
          "response_activities",
          "response_skills",
          "response_requirements",
        ]),
        id: z.string().uuid(),
        field: z.string().min(1).max(60),
        value: z.string().max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const table = data.table as CorrectableTable;
    if (!(CORRECTABLE[table] as readonly string[]).includes(data.field)) {
      throw new Error("정정할 수 없는 항목입니다.");
    }

    // 테이블명이 런타임 값이라 제네릭 타입 추론이 불가능하다. 이 함수 안에서만 스키마 타입을 벗긴다.
    const db = supabaseAdmin as unknown as {
      from: (t: string) => any;
    };

    // 대상 행이 정말 이 응답에 속하는지 확인 (다른 응답 데이터 오염 방지)
    if (table === "responses") {
      if (data.id !== data.responseId) throw new Error("대상 응답이 일치하지 않습니다.");
    } else if (table === "response_activities") {
      const { data: act } = await supabaseAdmin
        .from("response_activities")
        .select("task_id")
        .eq("id", data.id)
        .maybeSingle();
      const { data: task } = act
        ? await supabaseAdmin
            .from("response_tasks")
            .select("response_id")
            .eq("id", act.task_id)
            .maybeSingle()
        : { data: null };
      if (!task || task.response_id !== data.responseId) {
        throw new Error("대상 응답이 일치하지 않습니다.");
      }
    } else {
      const { data: owner } = await db
        .from(table)
        .select("response_id")
        .eq("id", data.id)
        .maybeSingle();
      if (!owner || owner.response_id !== data.responseId) {
        throw new Error("대상 응답이 일치하지 않습니다.");
      }
    }

    const { data: before } = await db
      .from(table)
      .select(data.field)
      .eq("id", data.id)
      .maybeSingle();
    const previous: string = before?.[data.field] ?? "";
    if (previous === data.value) return { ok: true, changed: false };

    // 이력 먼저 남기고 수정한다 (수정 성공 후 이력 실패 시 근거가 사라지는 것을 피함).
    const { error: logError } = await supabaseAdmin.from("review_comments").insert({
      response_id: data.responseId,
      author_id: context.userId,
      body: `[정정] ${table}.${data.field}\n이전: ${previous || "(비어 있음)"}\n이후: ${data.value || "(비어 있음)"}`,
      kind: "correction",
    });
    if (logError) throw new Error(logError.message);

    const { error } = await db
      .from(table)
      .update({ [data.field]: data.value })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 필드 정정",
      target_type: table,
      target_id: data.id,
      detail: { response_id: data.responseId, field: data.field },
    });

    return { ok: true, changed: true };
  });

export const getJobComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        jobName: z.string().trim().min(1).max(120),
        companyId: z.string().uuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = supabaseAdmin
      .from("responses")
      .select(
        "id, job_name, status, definition, mission, participants(name, emp_no, org_text, grade, role_level), response_tasks(id, seq, name, importance, authority, is_key, transferable), response_skills(id, name, ksao, hard_soft, description)",
      )
      .eq("job_name", data.jobName)
      .in("status", COUNTED_STATUSES);
    if (data.companyId) q = q.eq("company_id", data.companyId);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("role_levels")
      .maybeSingle();
    const order = settings?.role_levels ?? [];
    const rank = (level: string | null) => {
      const i = level ? order.indexOf(level) : -1;
      return i === -1 ? order.length : i;
    };

    const columns = (rows ?? [])
      .map((r) => ({
        ...r,
        response_tasks: [...r.response_tasks].sort((a, b) => a.seq - b.seq),
      }))
      .sort((a, b) => {
        const d = rank(a.participants?.role_level ?? null) - rank(b.participants?.role_level ?? null);
        return d !== 0 ? d : (a.participants?.name ?? "").localeCompare(b.participants?.name ?? "");
      });

    return { jobName: data.jobName, roleLevels: order, columns };
  });
