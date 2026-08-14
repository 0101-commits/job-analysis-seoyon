import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Supabase Auth 최소 비밀번호 길이(6자) 미만이면 계정 생성이 통째로 실패한다.
 * 사번·생년월일이 비어 규칙 결과가 짧아진 경우에만 난수로 채운다(초기PW 는 저장·안내되므로 확인 가능).
 */
function ensureMinLength(password: string) {
  if (password.length >= 6) return password;
  const pad = String(Math.floor(1000 + Math.random() * 9000));
  return (password + pad).slice(0, Math.max(8, password.length + 4));
}

/** listUsers 는 페이지당 최대치가 있어 1페이지만 보면 기존 계정을 놓친다. 전 페이지를 훑어 이메일로 찾는다. */
async function findAuthUserByEmail(
  auth: { listUsers: (p: { page: number; perPage: number }) => Promise<{ data: { users: { id: string; email?: string | undefined }[] } | null }> },
  email: string,
) {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const { data } = await auth.listUsers({ page, perPage });
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

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
      const password = ensureMinLength(renderPasswordRule(rule, p));
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
            const existing = await findAuthUserByEmail(supabaseAdmin.auth.admin, p.email);
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

        // initial_password 는 초대 메일 {초기PW} 안내에 필요해 평문으로 남긴다.
        // 최초 로그인(must_change_password 소진) 이후 비우는 정리 작업은 이번 범위 밖.
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

    const password = ensureMinLength(
      renderPasswordRule(settings?.password_rule ?? "{birth6}{empno_last4}", p),
    );
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
  .inputValidator((input: unknown) =>
    z
      .object({ logId: z.string().uuid(), origin: z.string().url().optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resendLog } = await import("@/lib/mailer.server");
    return resendLog(supabaseAdmin, data.logId, data.origin ?? null);
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
