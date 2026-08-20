import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

const filtersSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  statuses: z.array(z.string()).optional(),
});

/**
 * 미리보기와 테스트 발송이 함께 쓰는 표본 치환 변수. 초기 비밀번호는 노출하지 않고 마스킹한다.
 * `participantId` 를 주면 그 사람으로, 없으면 조건에 맞는 첫 참여자로 치환한다.
 */
async function buildSampleVars(
  admin: SupabaseClient<Database>,
  companyId?: string | null,
  origin?: string,
  participantId?: string | null,
) {
  const { appUrl } = await import("@/lib/mailer.server");
  const { buildMailVars } = await import("@/lib/mail-vars");

  let query = admin
    .from("participants")
    .select("id, name, email, org_text, company_id, companies(name)")
    .eq("role", "respondent")
    .not("email", "is", null)
    .order("emp_no")
    .limit(1);
  if (participantId) query = query.eq("id", participantId);
  else if (companyId) query = query.eq("company_id", companyId);
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
    sampleId: (sample?.id as string | undefined) ?? null,
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

export type TemplatePreview = {
  id: string;
  name: string;
  kind: string;
  updatedAt: string;
  subject: string;
  html: string;
  /** 치환되지 않고 남은 `{항목}` — 하나라도 있으면 발송 전에 고쳐야 한다. */
  unreplaced: string[];
};

/**
 * 등록된 모든 템플릿을 한 사람 기준으로 한꺼번에 렌더한다 (기획 B6).
 * 발송 전에 실물을 눈으로 확인하고 승인하는 화면이 쓴다. 초기 비밀번호는 마스킹된다.
 */
export const previewAllTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        participantId: z.string().uuid().nullable().optional(),
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
    const { findUnreplacedTokens, renderMailText } = await import("@/lib/mail-vars");

    const { sampleId, sampleName, vars } = await buildSampleVars(
      supabaseAdmin,
      data.companyId,
      data.origin,
      data.participantId,
    );

    const { data: templates, error } = await supabaseAdmin
      .from("mail_templates")
      .select("id, name, kind, subject, body, updated_at")
      .order("created_at");
    if (error) throw new Error(error.message);

    // 표본을 바꿀 수 있게 후보 명단도 같이 준다(이메일이 있는 참여자만).
    let candidateQuery = supabaseAdmin
      .from("participants")
      .select("id, name, emp_no, org_text, account_status")
      .eq("role", "respondent")
      .not("email", "is", null)
      .order("emp_no")
      .limit(50);
    if (data.companyId) candidateQuery = candidateQuery.eq("company_id", data.companyId);
    const { data: candidates } = await candidateQuery;

    const previews: TemplatePreview[] = (templates ?? []).map((t) => {
      const subject = renderMailText(t.subject, vars);
      const body = renderMailText(t.body, vars);
      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        updatedAt: t.updated_at,
        subject,
        html: renderMailHtml(body, vars["접속링크"]),
        unreplaced: [
          ...new Set([...findUnreplacedTokens(subject), ...findUnreplacedTokens(body)]),
        ],
      };
    });

    return {
      sampleId,
      sampleName,
      sampleEmail: vars["ID"] ?? "",
      candidates: candidates ?? [],
      previews,
    };
  });

export type SendTargetRow = {
  id: string;
  name: string;
  emp_no: string;
  email: string | null;
  org_text: string | null;
  org_unit_id: string | null;
  company_id: string;
  account_status: string;
  invited_at: string | null;
  last_seen_at: string | null;
  archived_at: string | null;
};

/**
 * 발송 대상 후보 전량 + 소속 트리 (기획 B5·B7).
 *
 * 회사·계정상태·참여자 지정까지는 `selectTargets` 와 같은 조건으로 좁히고, 소속 하위 필터는
 * 화면이 트리에서 고른 뒤 걸러 낸다(트리를 그리기 전에는 하위 소속 목록을 알 수 없다).
 * 이메일이 없어 제외되는 사람도 그대로 담아 보내, 화면이 "왜 제외됐는지" 를 말할 수 있게 한다.
 */
export const listSendTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid().nullable().optional(),
        statuses: z.array(z.string()).optional(),
        participantIds: z.array(z.string().uuid()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { fetchAll } = await import("@/lib/paginate");

    const rows = await fetchAll<SendTargetRow>((from, to) => {
      let query = supabaseAdmin
        .from("participants")
        .select(
          "id, name, emp_no, email, org_text, org_unit_id, company_id, account_status, invited_at, last_seen_at, archived_at",
        )
        .eq("role", "respondent")
        .order("emp_no")
        .range(from, to);
      if (data.participantIds?.length) query = query.in("id", data.participantIds);
      if (data.companyId) query = query.eq("company_id", data.companyId);
      // 화면이 고르는 값은 계정 상태 목록에서만 나온다. 없는 값이 와도 그냥 아무도 안 걸린다.
      if (data.statuses?.length) {
        query = query.in(
          "account_status",
          data.statuses as Database["public"]["Enums"]["account_status"][],
        );
      }
      return query;
    });

    let unitQuery = supabaseAdmin
      .from("org_units")
      .select("id, company_id, parent_id, name, level, sort");
    if (data.companyId) unitQuery = unitQuery.eq("company_id", data.companyId);
    const { data: units, error: unitError } = await unitQuery;
    if (unitError) throw new Error(unitError.message);

    return { rows, units: units ?? [], asOf: new Date().toISOString() };
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

/** 발송 확인 다이얼로그용 실제 수신 대상 명단. countRecipients 와 같은 selectTargets 를 쓴다. */
export const listRecipientPreview = createServerFn({ method: "POST" })
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
    return {
      count: targets.length,
      recipients: targets.map((t) => ({ name: t.name, email: t.email as string })),
    };
  });

/**
 * 예약 배치 취소. mail_batches.status CHECK 에 '취소' 가 없어(DB 변경 불가) 배치 행을 삭제한다.
 * 예약 배치는 발송 전이라 mail_logs 가 없으므로 잃는 발송 기록이 없고, 취소 사실은 audit_logs 에 남긴다.
 * '예약' 상태 조건부 삭제라 크론의 '예약'→'대기' 선점과 경합해도 한쪽만 성공한다.
 */
export const cancelScheduledBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ batchId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: batch } = await supabaseAdmin
      .from("mail_batches")
      .select("id, name, status, scheduled_at")
      .eq("id", data.batchId)
      .maybeSingle();
    if (!batch) throw new Error("배치를 찾을 수 없습니다.");
    if (batch.status !== "예약") throw new Error("예약 상태의 배치만 취소할 수 있습니다.");

    const { data: deleted, error } = await supabaseAdmin
      .from("mail_batches")
      .delete()
      .eq("id", data.batchId)
      .eq("status", "예약")
      .select("id");
    if (error) throw new Error(error.message);
    if (!deleted?.length) throw new Error("이미 발송이 시작되어 취소할 수 없습니다.");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "메일 예약 취소",
      target_type: "mail_batch",
      target_id: data.batchId,
      detail: { name: batch.name, scheduled_at: batch.scheduled_at },
    });
    return { ok: true };
  });

/**
 * 배치의 실패 건만 모아 재발송한다(개별 재발송과 같은 파이프라인, 건별 새 로그 기록).
 * 이미 개별 재발송으로 회복된 참여자는 건너뛰어 중복 발송을 막는다.
 */
export const resendFailedLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ batchId: z.string().uuid(), origin: z.string().url().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resendLog } = await import("@/lib/mailer.server");

    const { data: logs, error } = await supabaseAdmin
      .from("mail_logs")
      .select("id, participant_id, status, sent_at")
      .eq("batch_id", data.batchId)
      .order("sent_at");
    if (error) throw new Error(error.message);

    const recovered = new Set(
      (logs ?? [])
        .filter((l) => l.status !== "실패" && l.participant_id)
        .map((l) => l.participant_id),
    );
    const fails = (logs ?? []).filter(
      (l) => l.status === "실패" && (!l.participant_id || !recovered.has(l.participant_id)),
    );
    if (!fails.length) return { total: 0, ok: 0, failed: 0 };

    let ok = 0;
    let failed = 0;
    for (const log of fails) {
      const { status } = await resendLog(supabaseAdmin, log.id, data.origin ?? null);
      if (status === "실패") failed += 1;
      else ok += 1;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "실패 건 일괄 재발송",
      target_type: "mail_batch",
      target_id: data.batchId,
      detail: { total: fails.length, ok, failed },
    });
    return { total: fails.length, ok, failed };
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
      // participant 의 마지막 접속 시각을 함께 받아 "보낸 뒤 실제로 들어왔는지" 를 화면에서 판단한다.
      .select(
        "id, to_name, to_email, subject, status, error_message, sent_at, participant_id, participants(last_seen_at)",
      )
      .eq("batch_id", data.batchId)
      .order("sent_at", { ascending: false });
    if (error) throw new Error(error.message);
    return logs ?? [];
  });
