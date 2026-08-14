import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMailVars, renderMailText } from "./mail-vars";
import { fetchAll } from "./paginate";

export type BatchFilters = {
  companyId?: string | null;
  statuses?: string[];
  participantIds?: string[];
};

/** 리마인더 대상 상태. '미발송'(초대 메일 전)은 리마인드할 대상이 아니라 초대 대상이라 제외한다. */
export const REMINDER_STATUSES = {
  미접속: ["초대발송", "미접속"],
  미제출: ["초대발송", "미접속", "작성중", "반려"],
} as const;

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

const PARTICIPANT_COLUMNS =
  "id, name, email, org_text, company_id, initial_password, account_status, last_seen_at";

export async function selectTargets(
  admin: SupabaseClient,
  filters: BatchFilters,
): Promise<ParticipantRow[]> {
  return fetchAll<ParticipantRow>((from, to) => {
    let query = admin
      .from("participants")
      .select(PARTICIPANT_COLUMNS)
      .eq("role", "respondent")
      .not("email", "is", null)
      .order("emp_no")
      .range(from, to);
    if (filters.participantIds?.length) query = query.in("id", filters.participantIds);
    if (filters.companyId) query = query.eq("company_id", filters.companyId);
    if (filters.statuses?.length) query = query.in("account_status", filters.statuses);
    return query;
  });
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

  // 여기서부터는 배치가 '발송중' 으로 잠겨 있으므로, 어떤 예외가 나도 상태를 마감하고 나간다.
  let sent = 0;
  let failed = 0;
  let simulatedCount = 0;
  let total = 0;
  const simulate = isSimulationMode();

  try {
    const targets = await selectTargets(admin, (batch.filters ?? {}) as BatchFilters);
    total = targets.length;
    const { data: companies } = await admin.from("companies").select("id, name");
    const { data: settings } = await admin.from("survey_settings").select("company_id, deadline");
    const link = appUrl(origin);

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
      else if (status === "시뮬레이션") simulatedCount += 1;
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
  } catch (err) {
    await admin
      .from("mail_batches")
      .update({
        status: "실패",
        total_count: total,
        // sent_count 는 실제 발송 성공 건만 센다(시뮬레이션은 simulated 플래그로 구분).
        sent_count: sent,
        failed_count: failed,
        simulated: simulate,
        finished_at: new Date().toISOString(),
      })
      .eq("id", batchId);
    throw err;
  }

  const processed = sent + simulatedCount;
  await admin
    .from("mail_batches")
    .update({
      status: failed > 0 && processed === 0 ? "실패" : "완료",
      total_count: total,
      sent_count: sent,
      failed_count: failed,
      simulated: simulate,
      finished_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  return { total, sent, failed, simulated: simulate, simulatedCount };
}

/** 로그에 남은 본문 대신, 원 템플릿 + 현재 접속링크로 다시 렌더한다(옛 링크 재전송 방지). */
async function rerenderFromTemplate(
  admin: SupabaseClient,
  log: { template_id: string | null; participant_id: string | null },
  origin?: string | null,
) {
  if (!log.template_id || !log.participant_id) return null;
  const { data: template } = await admin
    .from("mail_templates")
    .select("subject, body")
    .eq("id", log.template_id)
    .maybeSingle();
  const { data: p } = await admin
    .from("participants")
    .select(PARTICIPANT_COLUMNS)
    .eq("id", log.participant_id)
    .maybeSingle();
  if (!template || !p) return null;

  const { data: company } = await admin
    .from("companies")
    .select("name")
    .eq("id", p.company_id)
    .maybeSingle();
  const { data: setting } = await admin
    .from("survey_settings")
    .select("deadline")
    .eq("company_id", p.company_id)
    .maybeSingle();

  const vars = buildMailVars({
    name: p.name,
    company: company?.name ?? "",
    org: p.org_text,
    email: p.email,
    initialPassword: p.initial_password,
    deadline: setting?.deadline ?? null,
    link: appUrl(origin),
  });
  return {
    subject: renderMailText(template.subject, vars),
    body: renderMailText(template.body, vars),
    email: p.email as string | null,
  };
}

export async function resendLog(admin: SupabaseClient, logId: string, origin?: string | null) {
  const { data: log } = await admin.from("mail_logs").select("*").eq("id", logId).maybeSingle();
  if (!log) throw new Error("발송 로그를 찾을 수 없습니다.");

  const fresh = await rerenderFromTemplate(admin, log, origin);
  const subject = fresh?.subject ?? log.subject;
  const body = fresh?.body ?? log.body;
  const toEmail = fresh?.email ?? log.to_email;

  const simulate = isSimulationMode();
  let status: "성공" | "실패" | "시뮬레이션" = "시뮬레이션";
  let errorMessage: string | null = null;
  let providerId: string | null = null;
  if (!simulate) {
    try {
      providerId = await sendViaResend(toEmail, subject, body);
      status = "성공";
    } catch (err) {
      status = "실패";
      errorMessage = err instanceof Error ? err.message : "알 수 없는 오류";
    }
  }
  await admin.from("mail_logs").insert({
    batch_id: log.batch_id,
    participant_id: log.participant_id,
    template_id: log.template_id,
    to_email: toEmail,
    to_name: log.to_name,
    subject,
    body,
    status,
    error_message: errorMessage,
    provider_id: providerId,
  });
  return { status };
}

/** 예약(status='예약') 배치 중 시각이 지난 건을 실행한다. 크론에서 호출한다. */
export async function runScheduledBatches(admin: SupabaseClient, origin?: string | null) {
  const { data: due, error } = await admin
    .from("mail_batches")
    .select("id")
    .eq("status", "예약")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at");
  if (error) throw new Error(error.message);

  const results: { batchId: string; sent?: number; failed?: number; error?: string }[] = [];
  for (const b of due ?? []) {
    // '예약' → '대기' 를 조건부로 선점한 실행자만 처리한다(크론 중복 실행 방지).
    const { data: claimed } = await admin
      .from("mail_batches")
      .update({ status: "대기" })
      .eq("id", b.id)
      .eq("status", "예약")
      .select("id");
    if (!claimed?.length) continue;
    try {
      const res = await processBatch(admin, b.id, origin);
      results.push({ batchId: b.id, sent: res.sent, failed: res.failed });
    } catch (err) {
      // 템플릿 누락 등으로 '발송중' 전환 전에 터진 경우 '대기' 로 남아 영영 안 돌므로 여기서 마감한다.
      await admin
        .from("mail_batches")
        .update({ status: "실패", finished_at: new Date().toISOString() })
        .eq("id", b.id)
        .eq("status", "대기");
      results.push({ batchId: b.id, error: err instanceof Error ? err.message : "알 수 없는 오류" });
    }
  }
  return results;
}

/**
 * 리마인더 발송.
 * - force: true  → 관리자 수동 발송(마감일·D-N 판정 무시)
 * - force 없음   → 크론용. reminder_auto=true 이고 오늘이 D-N 인 회사만, 하루 1회.
 */
export async function runReminders(
  admin: SupabaseClient,
  opts: { force?: boolean; companyId?: string | null; origin?: string | null } = {},
) {
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
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  ).toISOString();
  const results: { companyId: string; sent: number }[] = [];

  for (const s of settings ?? []) {
    if (opts.companyId && s.company_id !== opts.companyId) continue;
    if (!opts.force) {
      if (!s.reminder_auto || !s.deadline) continue;
      const diff = Math.ceil(
        (new Date(`${s.deadline}T00:00:00Z`).getTime() - Date.parse(todayStart)) / 86400000,
      );
      if (!(s.reminder_days ?? []).includes(diff)) continue;
      // 크론이 하루에 여러 번 돌아도 회사당 1회만 나가게 한다.
      const { count } = await admin
        .from("mail_batches")
        .select("id", { count: "exact", head: true })
        .eq("company_id", s.company_id)
        .eq("template_id", template.id)
        .gte("created_at", todayStart);
      if ((count ?? 0) > 0) continue;
    }
    const statuses = [
      ...(s.reminder_target === "미접속" ? REMINDER_STATUSES.미접속 : REMINDER_STATUSES.미제출),
    ];

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
