import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

const filtersSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  statuses: z.array(z.string()).optional(),
});

/** 미리보기와 테스트 발송이 함께 쓰는 표본 치환 변수. 초기 비밀번호는 노출하지 않고 마스킹한다. */
async function buildSampleVars(
  admin: SupabaseClient<Database>,
  companyId?: string | null,
  origin?: string,
) {
  const { appUrl } = await import("@/lib/mailer.server");
  const { buildMailVars } = await import("@/lib/mail-vars");

  let query = admin
    .from("participants")
    .select("name, email, org_text, company_id, companies(name)")
    .eq("role", "respondent")
    .not("email", "is", null)
    .order("emp_no")
    .limit(1);
  if (companyId) query = query.eq("company_id", companyId);
  const { data: rows } = await query;
  const sample = rows?.[0] ?? null;

  let deadline: string | null = null;
  if (sample) {
    const { data: setting } = await admin
      .from("survey_settings")
      .select("deadline")
      .eq("company_id", sample.company_id)
      .maybeSingle();
    deadline = setting?.deadline ?? null;
  }

  return {
    sampleName: (sample?.name as string | undefined) ?? null,
    vars: buildMailVars({
      name: sample?.name ?? "홍길동",
      company: sample?.companies?.name ?? "서연",
      org: sample?.org_text ?? "경영지원팀",
      email: sample?.email ?? "hong@example.com",
      initialPassword: "●●●●",
      deadline,
      link: appUrl(origin ?? null),
    }),
  };
}

export const listTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("mail_templates")
      .select("id, name, kind, subject, body, is_default, updated_at")
      .order("created_at");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const upsertTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(120),
        kind: z.enum(["invite", "reminder", "custom"]),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(20000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const row = { name: data.name, kind: data.kind, subject: data.subject, body: data.body };
    const query = data.id
      ? supabaseAdmin.from("mail_templates").update(row).eq("id", data.id).select("id").single()
      : supabaseAdmin.from("mail_templates").insert(row).select("id").single();
    const { data: saved, error } = await query;
    if (error || !saved) throw new Error(error?.message ?? "템플릿 저장 실패");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.id ? "메일 템플릿 수정" : "메일 템플릿 생성",
      target_type: "mail_template",
      target_id: saved.id,
      detail: { name: data.name, kind: data.kind },
    });
    return { id: saved.id };
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: tpl } = await supabaseAdmin
      .from("mail_templates")
      .select("id, name, is_default")
      .eq("id", data.id)
      .maybeSingle();
    if (!tpl) throw new Error("템플릿을 찾을 수 없습니다.");
    if (tpl.is_default) throw new Error("기본 템플릿은 삭제할 수 없습니다.");

    const { error } = await supabaseAdmin.from("mail_templates").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "메일 템플릿 삭제",
      target_type: "mail_template",
      target_id: data.id,
      detail: { name: tpl.name },
    });
    return { ok: true };
  });

/** 실제 참여자 1명을 표본으로 치환 미리보기. 초기 비밀번호는 노출하지 않고 마스킹한다. */
export const previewTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        subject: z.string().max(300),
        body: z.string().max(20000),
        companyId: z.string().uuid().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderMailHtml } = await import("@/lib/mailer.server");
    const { renderMailText } = await import("@/lib/mail-vars");

    const { sampleName, vars } = await buildSampleVars(supabaseAdmin, data.companyId, data.origin);
    const body = renderMailText(data.body, vars);

    return {
      sampleName,
      subject: renderMailText(data.subject, vars),
      body,
      html: renderMailHtml(body, vars["접속링크"]),
    };
  });

/** 로그인한 관리자 본인에게만 1건 발송한다(수신자 지정 불가 — 오발송 방지). */
export const sendTestMail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        templateId: z.string().uuid(),
        companyId: z.string().uuid().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { isSimulationMode, sendMail } = await import("@/lib/mailer.server");
    const { renderMailText } = await import("@/lib/mail-vars");

    const { data: userData } = await context.supabase.auth.getUser();
    const to = userData?.user?.email ?? null;
    if (!to) throw new Error("로그인 계정에 이메일이 없어 테스트 발송을 할 수 없습니다.");

    const { data: template } = await supabaseAdmin
      .from("mail_templates")
      .select("id, subject, body")
      .eq("id", data.templateId)
      .maybeSingle();
    if (!template) throw new Error("메일 템플릿을 찾을 수 없습니다.");

    const { vars } = await buildSampleVars(supabaseAdmin, data.companyId, data.origin);
    const subject = `[테스트] ${renderMailText(template.subject, vars)}`;
    const body = renderMailText(template.body, vars);

    const simulated = isSimulationMode();
    let status: "성공" | "실패" | "시뮬레이션" = "시뮬레이션";
    let errorMessage: string | null = null;
    let providerId: string | null = null;
    if (!simulated) {
      try {
        providerId = await sendMail(to, subject, body, vars["접속링크"]);
        status = "성공";
      } catch (err) {
        status = "실패";
        errorMessage = err instanceof Error ? err.message : "알 수 없는 오류";
      }
    }

    // 테스트 발송은 배치에 속하지 않으므로 batch_id 는 비운다(nullable 컬럼).
    await supabaseAdmin.from("mail_logs").insert({
      batch_id: null,
      participant_id: null,
      template_id: template.id,
      to_email: to,
      to_name: "테스트 발송",
      subject,
      body,
      status,
      error_message: errorMessage,
      provider_id: providerId,
    });

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      actor_email: to,
      action: "테스트 메일 발송",
      target_type: "mail_template",
      target_id: template.id,
      detail: { to, status },
    });

    return { to, status, simulated, error: errorMessage };
  });

export const countRecipients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => filtersSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { selectTargets } = await import("@/lib/mailer.server");
    const targets = await selectTargets(supabaseAdmin, {
      companyId: data.companyId ?? null,
      statuses: data.statuses ?? [],
    });
    return { count: targets.length };
  });

export const listBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("mail_batches")
      .select(
        "id, name, status, total_count, sent_count, failed_count, simulated, scheduled_at, finished_at, created_at, companies(name), mail_templates(name)",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ batchId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: logs, error } = await supabaseAdmin
      .from("mail_logs")
      .select("id, to_name, to_email, subject, status, error_message, sent_at")
      .eq("batch_id", data.batchId)
      .order("sent_at", { ascending: false });
    if (error) throw new Error(error.message);
    return logs ?? [];
  });
