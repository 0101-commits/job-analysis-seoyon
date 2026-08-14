import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const provisionAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ participantIds: z.array(z.string().uuid()).min(1).max(1000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderPasswordRule } = await import("@/lib/password-rule");

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("password_rule")
      .maybeSingle();
    const rule = settings?.password_rule ?? "{birth6}{empno_last4}";

    const { data: participants } = await supabaseAdmin
      .from("participants")
      .select("id, name, email, emp_no, birth_date, user_id, account_status")
      .in("id", data.participantIds);

    let created = 0;
    let updated = 0;
    const failures: { name: string; reason: string }[] = [];

    for (const p of participants ?? []) {
      if (!p.email) {
        failures.push({ name: p.name, reason: "이메일 없음" });
        continue;
      }
      const password = renderPasswordRule(rule, p);
      try {
        let userId = p.user_id as string | null;
        if (userId) {
          const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
          if (error) throw new Error(error.message);
          updated += 1;
        } else {
          const { data: createdUser, error } = await supabaseAdmin.auth.admin.createUser({
            email: p.email,
            password,
            email_confirm: true,
          });
          if (error || !createdUser.user) {
            const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
            const existing = list?.users.find(
              (u) => (u.email ?? "").toLowerCase() === (p.email as string).toLowerCase(),
            );
            if (!existing) throw new Error(error?.message ?? "계정 생성 실패");
            await supabaseAdmin.auth.admin.updateUserById(existing.id, { password });
            userId = existing.id;
            updated += 1;
          } else {
            userId = createdUser.user.id;
            created += 1;
          }
        }

        await supabaseAdmin.from("user_roles").upsert(
          { user_id: userId, role: "respondent" },
          { onConflict: "user_id,role", ignoreDuplicates: true },
        );

        await supabaseAdmin
          .from("participants")
          .update({
            user_id: userId,
            initial_password: password,
            must_change_password: true,
            failed_login_count: 0,
            locked_until: null,
            invited_at: new Date().toISOString(),
            account_status: ["미발송", "초대발송"].includes(p.account_status)
              ? "초대발송"
              : p.account_status,
          })
          .eq("id", p.id);
      } catch (err) {
        failures.push({ name: p.name, reason: err instanceof Error ? err.message : "오류" });
      }
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "계정 일괄 생성",
      target_type: "participants",
      detail: { created, updated, failed: failures.length },
    });

    return { created, updated, failures };
  });

export const resetParticipantPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ participantId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderPasswordRule } = await import("@/lib/password-rule");

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("password_rule")
      .maybeSingle();
    const { data: p } = await supabaseAdmin
      .from("participants")
      .select("id, name, email, emp_no, birth_date, user_id")
      .eq("id", data.participantId)
      .maybeSingle();
    if (!p) throw new Error("참여자를 찾을 수 없습니다.");
    if (!p.user_id) throw new Error("아직 계정이 생성되지 않았습니다.");

    const password = renderPasswordRule(settings?.password_rule ?? "{birth6}{empno_last4}", p);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(p.user_id, { password });
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("participants")
      .update({
        initial_password: password,
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null,
      })
      .eq("id", p.id);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "비밀번호 초기화",
      target_type: "participant",
      target_id: p.id,
    });

    return { password };
  });

export const sendMailBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(120),
        templateId: z.string().uuid(),
        filters: z.object({
          companyId: z.string().uuid().nullable().optional(),
          statuses: z.array(z.string()).optional(),
          participantIds: z.array(z.string().uuid()).optional(),
        }),
        scheduledAt: z.string().datetime().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processBatch, isSimulationMode } = await import("@/lib/mailer.server");

    const { data: batch, error } = await supabaseAdmin
      .from("mail_batches")
      .insert({
        name: data.name,
        template_id: data.templateId,
        company_id: data.filters.companyId ?? null,
        filters: data.filters,
        scheduled_at: data.scheduledAt ?? null,
        status: data.scheduledAt ? "예약" : "대기",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error || !batch) throw new Error(error?.message ?? "배치 생성 실패");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.scheduledAt ? "메일 예약" : "메일 발송",
      target_type: "mail_batch",
      target_id: batch.id,
    });

    if (data.scheduledAt) {
      return { batchId: batch.id, scheduled: true, simulated: isSimulationMode() };
    }
    const result = await processBatch(supabaseAdmin, batch.id, data.origin ?? null);
    return { batchId: batch.id, scheduled: false, ...result };
  });

export const resendMailLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ logId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resendLog } = await import("@/lib/mailer.server");
    return resendLog(supabaseAdmin, data.logId);
  });

export const triggerReminders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runReminders } = await import("@/lib/mailer.server");
    const results = await runReminders(supabaseAdmin, {
      force: true,
      companyId: data.companyId ?? null,
      origin: data.origin ?? null,
    });
    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "리마인더 수동 발송",
      detail: { results },
    });
    return { results };
  });

export const mailModeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    return { simulation: !process.env["RESEND_API_KEY"] };
  });
