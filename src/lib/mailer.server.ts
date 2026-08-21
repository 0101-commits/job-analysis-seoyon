import type { SupabaseClient } from "@supabase/supabase-js";
import { MAIL_ASSET_BUCKET, buildMailVars, renderMailText, replaceImageTokens } from "./mail-vars";
import { fetchAll } from "./paginate";

export type BatchFilters = {
  companyId?: string | null;
  statuses?: string[];
  participantIds?: string[];
  /** v4: 차수 발송. 있으면 대상을 이 차수 배정자(participants.wave_id)로 좁힌다. */
  waveId?: string | null;
};

/** 리마인더 대상 상태. '미발송'(초대 메일 전)은 리마인드할 대상이 아니라 초대 대상이라 제외한다. */
export const REMINDER_STATUSES = {
  미접속: ["초대발송", "미접속"],
  미제출: ["초대발송", "미접속", "작성중", "반려"],
} as const;

/**
 * 환경변수 읽기의 단일 창구.
 *
 * CF Workers 배포에서는 시크릿이 워커 env 로 들어온다. nitro cloudflare 프리셋이 매 요청
 * `globalThis.__env__ = env` 를 해 주고, server.ts 가 `__CF_ENV__` 로 한 벌 더 스태시한다.
 * llm.server.ts 와 같은 순서(`__env__` → `__CF_ENV__` → process.env)로 찾아, 어느 배포에서든
 * 같은 값을 보게 한다.
 */
export function mailEnv(name: string) {
  const g = globalThis as Record<string, unknown>;
  const env = (g["__env__"] ?? g["__CF_ENV__"]) as Record<string, unknown> | undefined;
  const fromWorker = env?.[name];
  if (typeof fromWorker === "string" && fromWorker.trim()) return fromWorker;
  const fromProcess = process.env[name];
  return fromProcess?.trim() ? fromProcess : undefined;
}

export function appUrl(fallbackOrigin?: string | null) {
  return (
    mailEnv("APP_URL") ??
    fallbackOrigin ??
    "https://project--b4c6c58c-96a0-4f8e-872f-d5479003f8b6.lovable.app"
  );
}

export function isSimulationMode() {
  return !mailEnv("RESEND_API_KEY");
}

/** 발송 키를 등록하기 전의 임시 발신 주소. 운영에서는 RESEND_FROM 으로 반드시 바꿔야 한다. */
export const DEFAULT_MAIL_FROM = "서연 그룹 업무조사 <onboarding@resend.dev>";

export function mailFrom() {
  return mailEnv("RESEND_FROM") ?? DEFAULT_MAIL_FROM;
}

/** `이름 <주소@도메인>` 또는 `주소@도메인` 에서 도메인만 뽑는다. */
export function mailFromDomain(from = mailFrom()) {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  const domain = address.trim().split("@")[1];
  return domain?.trim().toLowerCase() || null;
}

/** '오늘'·'이번 달' 은 한국 시간 기준. 관리자가 보는 날짜와 상한 계산이 어긋나지 않게 한다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstDayStartIso(now = Date.now()) {
  const k = new Date(now + KST_OFFSET_MS);
  const start = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
  return new Date(start - KST_OFFSET_MS).toISOString();
}

export function kstMonthStartIso(now = Date.now()) {
  const k = new Date(now + KST_OFFSET_MS);
  const start = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1);
  return new Date(start - KST_OFFSET_MS).toISOString();
}

/** 발송 상한 기본값. system_settings.mail_daily_cap 의 DB 기본값과 같은 수를 쓴다. */
export const DEFAULT_DAILY_CAP = 500;

/**
 * 실제로 발송기를 거친 건수만 센다.
 * 연습 모드 기록은 나간 적이 없고, 발송 실패는 수신자에게 닿지 않았다.
 * 반송은 이미 한 번 나간 뒤 되돌아온 것이므로 발송량에 포함한다.
 */
const CONSUMED_STATUSES = ["성공", "반송"];

export async function countSentSince(admin: SupabaseClient, sinceIso: string) {
  const { count, error } = await admin
    .from("mail_logs")
    .select("id", { count: "exact", head: true })
    .in("status", CONSUMED_STATUSES)
    .gte("sent_at", sinceIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function mailDailyCap(admin: SupabaseClient) {
  const { data } = await admin.from("system_settings").select("mail_daily_cap").maybeSingle();
  return (data as { mail_daily_cap?: number } | null)?.mail_daily_cap ?? DEFAULT_DAILY_CAP;
}

/** 오늘 남은 발송 여유. 상한을 이미 넘겼으면 0. */
export async function dailyHeadroom(admin: SupabaseClient) {
  const cap = await mailDailyCap(admin);
  const sentToday = await countSentSince(admin, kstDayStartIso());
  return { cap, sentToday, remaining: Math.max(cap - sentToday, 0) };
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
    if (filters.waveId) query = query.eq("wave_id", filters.waveId);
    return query;
  });
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function mailAssetUrl(path: string) {
  const base = process.env["SUPABASE_URL"] ?? "";
  return `${base}/storage/v1/object/public/${MAIL_ASSET_BUCKET}/${path}`;
}

/**
 * 변수 치환이 끝난 평문 본문 → 메일용 HTML.
 * 본문에 있는 URL 을 통째로 링크로 만들면 피싱으로 오인되므로, 접속링크 값만 <a> 로 감싼다.
 */
export function renderMailHtml(body: string, link?: string | null) {
  let html = escapeHtml(body);
  if (link) {
    const safeLink = escapeHtml(link);
    html = html.replaceAll(
      safeLink,
      `<a href="${safeLink}" style="color:#1d4ed8;text-decoration:underline">${safeLink}</a>`,
    );
  }
  html = replaceImageTokens(
    html,
    (path, width) =>
      `<img src="${mailAssetUrl(path)}" width="${width}" alt="" style="max-width:100%;height:auto;border:0;display:block;margin:12px 0" />`,
  );
  html = html.replace(/\r?\n/g, "<br />");
  return [
    '<div style="margin:0;padding:24px 12px;background:#f4f5f7">',
    '<div style="max-width:600px;margin:0 auto;padding:28px 24px;background:#ffffff;border-radius:12px;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;",
    'font-size:14px;line-height:1.75;color:#1f2937">',
    html,
    "</div></div>",
  ].join("");
}

/** 이미지 토큰은 HTML 전용이므로 평문 폴백에서는 지운다. */
function toPlainText(body: string) {
  return replaceImageTokens(body, () => "");
}

/** 발송 실패를 "다시 보내면 될 수도 있는 것" 과 "사람이 고쳐야 하는 것" 으로 나눠 담는다. */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

export async function sendMail(to: string, subject: string, body: string, link?: string | null) {
  const key = mailEnv("RESEND_API_KEY");
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: mailFrom(),
        to: [to],
        subject,
        html: renderMailHtml(body, link),
        text: toPlainText(body),
      }),
    });
  } catch (err) {
    // 발송 서비스에 닿지도 못한 경우(네트워크 단절·타임아웃) — 다시 시도할 가치가 있다.
    throw new MailSendError(
      err instanceof Error ? err.message : "메일 서버에 닿지 못했습니다",
      null,
      true,
    );
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) {
    throw new MailSendError(
      json.message ?? `발송 실패 (HTTP ${res.status})`,
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  return json.id ?? null;
}

/** 재시도 전 대기. 429 는 초당 상한이라 짧은 대기로 대부분 풀린다. */
const RETRY_DELAY_MS = 2000;

/**
 * 발송 1건 + 자동 재시도.
 *
 * 재시도 정책
 * - 일시적 오류만 **1회** 재시도한다: 429(초당 발송 초과), 5xx(발송 서비스 장애),
 *   네트워크 단절·타임아웃.
 * - 영구 오류는 재시도하지 않는다: 그 밖의 4xx — 형식이 잘못된 수신 주소, 거부된 발송 키,
 *   인증되지 않은 발신 도메인. 같은 요청을 다시 보내도 같은 답이 오고, 잘못된 주소로 반복
 *   발송하면 발신 도메인 평판만 깎인다. 이런 건은 사람이 원인을 고친 뒤 화면에서
 *   [재발송] 을 눌러야 한다.
 * - 재시도까지 실패하면 '실패' 로 기록하고 retry_count 에 몇 번 더 시도했는지 남긴다.
 */
export async function sendMailWithRetry(
  to: string,
  subject: string,
  body: string,
  link?: string | null,
) {
  let retryCount = 0;
  for (;;) {
    try {
      const providerId = await sendMail(to, subject, body, link);
      return { providerId, retryCount, error: null as string | null };
    } catch (err) {
      const transient = err instanceof MailSendError ? err.transient : true;
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      if (!transient || retryCount >= 1) return { providerId: null, retryCount, error: message };
      retryCount += 1;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

export type DomainRecordCheck = {
  label: string;
  status: string;
  tone: "ok" | "warn" | "unknown";
};

export type DomainVerification = {
  /** 정상 | 미완료 | 미등록 | 확인 불가 | 조회 실패 */
  state: string;
  detail: string;
  records: DomainRecordCheck[];
};

const RECORD_STATUS_LABELS: Record<string, string> = {
  verified: "확인됨",
  pending: "확인 중",
  not_started: "등록 대기",
  failed: "실패",
  temporary_failure: "일시 실패",
};

/**
 * 발신 도메인의 인증 상태를 발송 서비스에서 조회한다 (기획 F1).
 *
 * 500명 이상에게 초대 메일을 보내는데 발신 도메인 인증이 안 돼 있으면 상당수가 스팸함으로
 * 간다. 발송 버튼을 누르기 전에 화면에서 이 값을 눈으로 확인할 수 있어야 한다.
 * 조회할 수 없는 상황은 빈칸으로 두지 않고 왜 못 했는지를 그대로 돌려준다.
 */
export async function fetchDomainVerification(
  domain: string | null = mailFromDomain(),
): Promise<DomainVerification> {
  const key = mailEnv("RESEND_API_KEY");
  if (!key) {
    return {
      state: "확인 불가",
      detail: "발송 키가 등록되지 않아 발송 서비스에 물어볼 수 없습니다.",
      records: [],
    };
  }
  if (!domain) {
    return {
      state: "확인 불가",
      detail: "발신 주소에서 도메인을 읽지 못했습니다. 발신 주소 설정을 확인하세요.",
      records: [],
    };
  }

  const headers = { Authorization: `Bearer ${key}` };
  try {
    const listRes = await fetch("https://api.resend.com/domains", { headers });
    const listJson = (await listRes.json().catch(() => ({}))) as {
      data?: { id?: string; name?: string; status?: string }[];
      message?: string;
    };
    if (!listRes.ok) {
      return {
        state: "조회 실패",
        detail: `발송 서비스가 조회를 거부했습니다 — ${listJson.message ?? `HTTP ${listRes.status}`}`,
        records: [],
      };
    }
    const match = (listJson.data ?? []).find((d) => d.name?.toLowerCase() === domain);
    if (!match?.id) {
      return {
        state: "미등록",
        detail: `${domain} 이(가) 발송 서비스에 등록되어 있지 않습니다. 도메인을 등록하고 안내된 DNS 값을 넣어 인증을 마치세요.`,
        records: [],
      };
    }

    const detailRes = await fetch(`https://api.resend.com/domains/${match.id}`, { headers });
    const detailJson = (await detailRes.json().catch(() => ({}))) as {
      status?: string;
      records?: { record?: string; type?: string; name?: string; status?: string }[];
      message?: string;
    };
    if (!detailRes.ok) {
      return {
        state: "조회 실패",
        detail: `도메인 상세를 읽지 못했습니다 — ${detailJson.message ?? `HTTP ${detailRes.status}`}`,
        records: [],
      };
    }

    const records: DomainRecordCheck[] = (detailJson.records ?? []).map((r) => {
      const status = r.status ?? "";
      return {
        label: [r.record, r.type].filter(Boolean).join(" ") || (r.name ?? "확인 항목"),
        status: RECORD_STATUS_LABELS[status] ?? (status || "상태 없음"),
        tone: status === "verified" ? "ok" : "warn",
      };
    });
    // DMARC 는 발송 서비스가 확인해 주지 않는다. 없는 값을 정상으로 꾸미지 않고 그대로 말한다.
    records.push({
      label: "DMARC",
      status: "발송 서비스가 확인하지 않음 — 도메인 관리자가 직접 확인",
      tone: "unknown",
    });

    const verified = (detailJson.status ?? match.status) === "verified";
    return {
      state: verified ? "정상" : "미완료",
      detail: verified
        ? `${domain} 인증이 끝났습니다. 이 주소로 보내면 수신자 쪽에서 정상 발신으로 인정됩니다.`
        : `${domain} 인증이 아직 끝나지 않았습니다(현재 ${detailJson.status ?? match.status ?? "상태 없음"}). 이 상태로 보내면 상당수가 스팸함으로 갈 수 있습니다.`,
      records,
    };
  } catch (err) {
    return {
      state: "조회 실패",
      detail: `발송 서비스에 닿지 못했습니다 — ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
      records: [],
    };
  }
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
  /** 일일 상한을 넘겨 아예 보내지 않은 건수. 조용히 버리지 않고 배치에 남긴다. */
  let held = 0;
  let cap = 0;
  const simulate = isSimulationMode();

  try {
    const targets = await selectTargets(admin, (batch.filters ?? {}) as BatchFilters);
    total = targets.length;
    const { data: companies } = await admin.from("companies").select("id, name");
    const { data: settings } = await admin.from("survey_settings").select("company_id, deadline");
    const link = appUrl(origin);

    // 하루 발송 상한. 연습 모드는 실제로 나가지 않으므로 상한을 쓰지 않는다.
    const headroom = simulate ? null : await dailyHeadroom(admin);
    cap = headroom?.cap ?? 0;
    let remaining = headroom?.remaining ?? Number.POSITIVE_INFINITY;

    for (const p of targets) {
      if (remaining <= 0) {
        held += 1;
        continue;
      }

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
      let retryCount = 0;

      if (!simulate) {
        const result = await sendMailWithRetry(p.email as string, subject, body, link);
        retryCount = result.retryCount;
        if (result.error) {
          status = "실패";
          errorMessage = result.error;
        } else {
          status = "성공";
          providerId = result.providerId;
          // 상한은 실제로 나간 건만 차감한다(거절당한 요청은 수신자에게 닿지 않았다).
          remaining -= 1;
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
        retry_count: retryCount,
      });

      if (status === "성공") await clearBounceFlag(admin, p.id);

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
      // 상한에 걸려 보내지 않은 건이 있으면 배치에 그 사실을 남긴다. mail_batches 에 전용 칸이
      // 없어(구조 변경 없이) filters 에 함께 적고, 이력 화면이 이 값을 읽어 보여 준다.
      ...(held > 0
        ? { filters: { ...((batch.filters ?? {}) as object), heldByDailyCap: held, dailyCap: cap } }
        : {}),
    })
    .eq("id", batchId);

  if (held > 0) {
    console.warn(`발송 상한(${cap}건) 초과로 ${held}건 보류 — 배치 ${batchId}`);
  }

  return { total, sent, failed, simulated: simulate, simulatedCount, held, cap };
}

/**
 * 마지막 발송이 반송됐다는 표시를 지운다.
 * 발송 서비스가 새 발송을 받아들였으면 "직전 발송이 되돌아왔다" 는 표시는 더 이상 사실이 아니다.
 * 또 반송되면 반송 통지가 다시 들어와 표시가 되살아난다.
 */
async function clearBounceFlag(admin: SupabaseClient, participantId: string | null) {
  if (!participantId) return;
  await admin
    .from("participants")
    .update({ mail_bounced_at: null, mail_bounce_reason: null })
    .eq("id", participantId)
    .not("mail_bounced_at", "is", null);
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
  let retryCount = 0;
  if (!simulate) {
    // 재발송도 일일 상한을 지킨다. 넘겼으면 조용히 넘기지 않고 왜 못 보내는지 알린다.
    const { cap, remaining } = await dailyHeadroom(admin);
    if (remaining <= 0) {
      throw new Error(
        `오늘 보낼 수 있는 상한 ${cap}건을 이미 채웠습니다. 내일 다시 보내거나 운영 설정에서 상한을 올리세요.`,
      );
    }
    const result = await sendMailWithRetry(toEmail, subject, body, appUrl(origin));
    retryCount = result.retryCount;
    if (result.error) {
      status = "실패";
      errorMessage = result.error;
    } else {
      status = "성공";
      providerId = result.providerId;
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
    retry_count: retryCount,
  });
  if (status === "성공") await clearBounceFlag(admin, log.participant_id);
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
      results.push({
        batchId: b.id,
        error: err instanceof Error ? err.message : "알 수 없는 오류",
      });
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
