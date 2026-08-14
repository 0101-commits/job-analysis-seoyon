import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const DEFAULT_ROLE_LEVELS = ["담당", "선임", "책임", "리더"];
export const REMINDER_TARGETS = ["미접속", "미제출"] as const;

// 미리보기는 실제 참여자 대신 더미로만 만든다(생년월일·사번이 화면에 노출되지 않게).
const PREVIEW_SAMPLES = [
  { id: "sample-1", name: "홍*동", emp_no: "20150908", birth_date: "1990-03-12" },
  { id: "sample-2", name: "김**", emp_no: "20210114", birth_date: "1985-11-02" },
  { id: "sample-3", name: "이*", emp_no: "9902", birth_date: null },
];

const roleLevelsSchema = z.array(z.string().trim().min(1).max(20)).min(1).max(12);

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: system }, { data: companies }, { data: surveys }] = await Promise.all([
      supabaseAdmin.from("system_settings").select("*").maybeSingle(),
      supabaseAdmin.from("companies").select("id, name, code").order("created_at"),
      supabaseAdmin
        .from("survey_settings")
        .select("company_id, deadline, reminder_days, reminder_target, reminder_auto"),
    ]);

    return {
      passwordRule: system?.password_rule ?? "{birth6}{empno_last4}",
      roleLevels: system?.role_levels?.length ? system.role_levels : DEFAULT_ROLE_LEVELS,
      companies: companies ?? [],
      surveys: surveys ?? [],
    };
  });

export const updateSystemSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        passwordRule: z.string().trim().min(1).max(120).optional(),
        roleLevels: roleLevelsSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { validatePasswordRule } = await import("@/lib/password-rule");

    const patch: Record<string, unknown> = {};
    if (data.passwordRule !== undefined) {
      const invalid = validatePasswordRule(data.passwordRule);
      if (invalid) throw new Error(invalid);
      patch["password_rule"] = data.passwordRule;
    }
    if (data.roleLevels !== undefined) {
      const unique = [...new Set(data.roleLevels.map((v) => v.trim()))];
      if (unique.length !== data.roleLevels.length) throw new Error("중복된 역할단계가 있습니다.");
      patch["role_levels"] = unique;
    }
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("system_settings")
      .update(patch as never)
      .eq("id", true);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "시스템 설정 변경",
      target_type: "system_settings",
      detail: patch,
    });
    return { ok: true };
  });

export const upsertSurveySetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        deadline: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다.")
          .nullable(),
        reminderDays: z.array(z.number().int().min(0).max(60)).max(10),
        reminderTarget: z.enum(REMINDER_TARGETS),
        reminderAuto: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const reminderDays = [...new Set(data.reminderDays)].sort((a, b) => b - a);
    const { error } = await supabaseAdmin.from("survey_settings").upsert(
      {
        company_id: data.companyId,
        deadline: data.deadline,
        reminder_days: reminderDays,
        reminder_target: data.reminderTarget,
        reminder_auto: data.reminderAuto,
      },
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 운영 설정 변경",
      target_type: "survey_settings",
      target_id: data.companyId,
      detail: {
        deadline: data.deadline,
        reminder_days: reminderDays,
        reminder_target: data.reminderTarget,
        reminder_auto: data.reminderAuto,
      },
    });
    return { ok: true };
  });

export const previewPasswordRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ rule: z.string().trim().min(1).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { renderPasswordRule, validatePasswordRule } = await import("@/lib/password-rule");

    const invalid = validatePasswordRule(data.rule);
    if (invalid) throw new Error(invalid);

    return {
      samples: PREVIEW_SAMPLES.map((p) => ({
        id: p.id,
        name: p.name,
        empNo: p.emp_no,
        password: renderPasswordRule(data.rule, p),
      })),
    };
  });
