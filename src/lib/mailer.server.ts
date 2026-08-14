import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMailVars, renderMailText } from "./mail-vars";

export type BatchFilters = {
  companyId?: string | null;
  statuses?: string[];
  participantIds?: string[];
};

export function appUrl(fallbackOrigin?: string | null) {
  return (
    process.env["APP_URL"] ??
    fallbackOrigin ??
    "https://project--b4c6c58c-96a0-4f8e-872f-d5479003f8b6.lovable.app"
  );
}

export function isSimulationMode() {
  return !process.env["RESEND_API_KEY"];
}

type ParticipantRow = {
  id: string;
  name: string;
  email: string | null;
  org_text: string | null;
  company_id: string;
  initial_password: string | null;
  account_status: string;
  last_seen_at: string | null;
};

export async function selectTargets(
  admin: SupabaseClient,
  filters: BatchFilters,
): Promise<ParticipantRow[]> {
  let query = admin
    .from("participants")
    .select("id, name, email, org_text, company_id, initial_password, account_status, last_seen_at")
    .eq("role", "respondent")
    .not("email", "is", null)
    .order("emp_no");

  if (filters.participantIds?.length) query = query.in("id", filters.participantIds);
  if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.statuses?.length) query = query.in("account_status", filters.statuses);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ParticipantRow[];
}

async function sendViaResend(to: string, subject: string, text: string) {
  const key = process.env["RESEND_API_KEY"];
  const from = process.env["RESEND_FROM"] ?? "서연 그룹 업무조사 <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(json.message ?? `발송 실패 (HTTP ${res.status})`);
  return json.id ?? null;
}

export async function processBatch(admin: SupabaseClient, batchId: string, origin?: string | null) {
  const { data: batch, error: batchError } = await admin
    .from("mail_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (batchError || !batch) throw new Error("배치를 찾을 수 없습니다.");

  const { data: template } = await admin
    .from("mail_templates")
    .select("*")
    .eq("id", batch.template_id)
    .maybeSingle();
  if (!template) throw new Error("메일 템플릿을 찾을 수 없습니다.");

  await admin
    .from("mail_batches")
    .update({ status: "발송중", started_at: new Date().toISOString() })
    .eq("id", batchId);

  const targets = await selectTargets(admin, (batch.filters ?? {}) as BatchFilters);
  const { data: companies } = await admin.from("companies").select("id, name");
  const { data: settings } = await admin.from("survey_settings").select("company_id, deadline");
  const link = appUrl(origin);
  const simulate = isSimulationMode();

  let sent = 0;
  let failed = 0;

  for (const p of targets) {
    const vars = buildMailVars({
      name: p.name,
      company: companies?.find((c) => c.id === p.company_id)?.name ?? "",
      org: p.org_text,
      email: p.email,
      initialPassword: p.initial_password,
      deadline: settings?.find((s) => s.company_id === p.company_id)?.deadline ?? null,
      link,
    });
    const subject = renderMailText(template.subject, vars);
    const body = renderMailText(template.body, vars);

    let status: "성공" | "실패" | "시뮬레이션" = "시뮬레이션";
    let errorMessage: string | null = null;
    let providerId: string | null = null;

    if (!simulate) {
      try {
        providerId = await sendViaResend(p.email as string, subject, body);
        status = "성공";
      } catch (err) {
        status = "실패";
        errorMessage = err instanceof Error ? err.message : "알 수 없는 오류";
      }
    }

    if (status === "실패") failed += 1;
    else sent += 1;

    await admin.from("mail_logs").insert({
      batch_id: batchId,
      participant_id: p.id,
      template_id: template.id,
      to_email: p.email,
      to_name: p.name,
      subject,
      body,
      status,
      error_message: errorMessage,
      provider_id: providerId,
    });

    if (status !== "실패" && template.kind === "invite") {
      await admin
        .from("participants")
        .update({ invited_at: new Date().toISOString() })
        .eq("id", p.id)
        .in("account_status", ["미발송", "초대발송"]);
      await admin
        .from("participants")
        .update({ account_status: "초대발송" })
        .eq("id", p.id)
        .eq("account_status", "미발송");
    }
  }

  await admin
    .from("mail_batches")
    .update({
      status: failed > 0 && sent === 0 ? "실패" : "완료",
      total_count: targets.length,
      sent_count: sent,
      failed_count: failed,
      simulated: simulate,
      finished_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  return { total: targets.length, sent, failed, simulated: simulate };
}

export async function resendLog(admin: SupabaseClient, logId: string, origin?: string | null) {
  const { data: log } = await admin.from("mail_logs").select("*").eq("id", logId).maybeSingle();
  if (!log) throw new Error("발송 로그를 찾을 수 없습니다.");
  const simulate = isSimulationMode();
  let status: "성공" | "실패" | "시뮬레이션" = "시뮬레이션";
  let errorMessage: string | null = null;
  let providerId: string | null = null;
  if (!simulate) {
    try {
      providerId = await sendViaResend(log.to_email, log.subject, log.body);
      status = "성공";
    } catch (err) {
      status = "실패";
      errorMessage = err instanceof Error ? err.message : "알 수 없는 오류";
    }
  }
  void origin;
  await admin.from("mail_logs").insert({
    batch_id: log.batch_id,
    participant_id: log.participant_id,
    template_id: log.template_id,
    to_email: log.to_email,
    to_name: log.to_name,
    subject: log.subject,
    body: log.body,
    status,
    error_message: errorMessage,
    provider_id: providerId,
  });
  return { status };
}

export async function runReminders(admin: SupabaseClient, opts: { force?: boolean; companyId?: string | null; origin?: string | null }) {
  const { data: settings } = await admin
    .from("survey_settings")
    .select("company_id, deadline, reminder_days, reminder_target, reminder_auto");
  const { data: template } = await admin
    .from("mail_templates")
    .select("id")
    .eq("kind", "reminder")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!template) throw new Error("리마인더 템플릿이 없습니다.");

  const today = new Date();
  const results: { companyId: string; sent: number }[] = [];

  for (const s of settings ?? []) {
    if (opts.companyId && s.company_id !== opts.companyId) continue;
    if (!opts.force) {
      if (!s.reminder_auto || !s.deadline) continue;
      const diff = Math.ceil(
        (new Date(`${s.deadline}T00:00:00Z`).getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
          86400000,
      );
      if (!(s.reminder_days ?? []).includes(diff)) continue;
    }
    const statuses =
      s.reminder_target === "미접속"
        ? ["초대발송", "미접속"]
        : ["미발송", "초대발송", "미접속", "작성중", "반려"];

    const { data: batch } = await admin
      .from("mail_batches")
      .insert({
        name: `리마인더 ${new Date().toISOString().slice(0, 10)}`,
        template_id: template.id,
        company_id: s.company_id,
        filters: { companyId: s.company_id, statuses },
        status: "대기",
      })
      .select("id")
      .single();
    if (!batch) continue;
    const res = await processBatch(admin, batch.id, opts.origin);
    results.push({ companyId: s.company_id, sent: res.sent });
  }
  return results;
}
