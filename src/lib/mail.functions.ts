import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const filtersSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  statuses: z.array(z.string()).optional(),
});

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
    const { appUrl } = await import("@/lib/mailer.server");
    const { buildMailVars, renderMailText } = await import("@/lib/mail-vars");

    let query = supabaseAdmin
      .from("participants")
      .select("name, email, org_text, company_id, companies(name)")
      .eq("role", "respondent")
      .not("email", "is", null)
      .order("emp_no")
      .limit(1);
    if (data.companyId) query = query.eq("company_id", data.companyId);
    const { data: rows } = await query;
    const sample = rows?.[0] ?? null;

    let deadline: string | null = null;
    if (sample) {
      const { data: setting } = await supabaseAdmin
        .from("survey_settings")
        .select("deadline")
        .eq("company_id", sample.company_id)
        .maybeSingle();
      deadline = setting?.deadline ?? null;
    }

    const vars = buildMailVars({
      name: sample?.name ?? "홍길동",
      company: sample?.companies?.name ?? "서연",
      org: sample?.org_text ?? "경영지원팀",
      email: sample?.email ?? "hong@example.com",
      initialPassword: "●●●●",
      deadline,
      link: appUrl(data.origin ?? null),
    });

    return {
      sampleName: sample?.name ?? null,
      subject: renderMailText(data.subject, vars),
      body: renderMailText(data.body, vars),
    };
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
