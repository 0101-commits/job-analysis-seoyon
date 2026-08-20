/**
 * 발송 실패 통지 수신 (기획 F1).
 *
 * 발송 서비스는 "보냈다" 까지만 즉시 알려 준다. 주소가 없는 계정·꽉 찬 메일함·수신 거부는
 * 몇 초~몇 분 뒤에 별도 통지로 되돌아온다. 이 통지를 받아 두지 않으면 참여자 500명 중
 * 몇 명에게 메일이 닿지 않았는지 영영 알 수 없고, 독려만 계속 나간다.
 *
 * 이 파일은 그 통지 하나를 받아 발송 기록과 참여자 표시에 반영한다.
 * src/server.ts 가 `POST /api/mail/webhook` 으로 이 함수를 불러 준다(그 파일은 다른 담당 소유).
 */

type BounceInfo = { message?: string; type?: string; subType?: string };

type MailEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: BounceInfo;
  };
};

/** 통지 종류 → 발송 기록에 남길 사유의 앞머리. 값이 없는 종류는 여기 없다. */
const BOUNCE_KIND: Record<string, string> = {
  "email.bounced": "메일이 되돌아왔습니다",
  "email.complained": "수신자가 수신 거부했습니다",
  "email.failed": "발송 서비스가 발송을 포기했습니다",
};

/** 통지 시각이 이보다 오래됐으면 받지 않는다(같은 통지를 가로채 재사용하는 것을 막는다). */
const MAX_AGE_SECONDS = 5 * 60;

function envValue(name: string) {
  const g = globalThis as Record<string, unknown>;
  const env = (g["__env__"] ?? g["__CF_ENV__"]) as Record<string, unknown> | undefined;
  const fromWorker = env?.[name];
  if (typeof fromWorker === "string" && fromWorker.trim()) return fromWorker;
  const fromProcess = process.env[name];
  return fromProcess?.trim() ? fromProcess : undefined;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 서명 확인.
 *
 * 발송 서비스는 `svix-id`, `svix-timestamp`, `svix-signature` 세 머리값을 붙여 보내고,
 * `{id}.{timestamp}.{본문}` 을 공유 비밀키로 HMAC-SHA256 한 값을 서명으로 싣는다.
 * 비밀키(RESEND_WEBHOOK_SECRET)가 없으면 확인을 건너뛰되 그 사실을 서버 기록에 남긴다 —
 * 확인 없이 통과시킨 사실이 어디에도 없으면 나중에 왜 이상한 값이 들어왔는지 알 수 없다.
 */
async function verifySignature(request: Request, rawBody: string) {
  const secret = envValue("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    // 비밀키가 없으면 받지 않는다. 확인 없이 처리하면 아무나 이 주소로 가짜 통지를 보내
    // 재직자를 「메일 반송」으로 표시할 수 있다. 발송을 켤 때 비밀키를 함께 넣는다.
    console.warn(
      "발송 실패 통지 거부: 확인용 비밀키(RESEND_WEBHOOK_SECRET)가 없습니다. 통지를 처리하지 않았습니다.",
    );
    return { ok: false, verified: false, reason: "확인용 비밀키가 설정되지 않았습니다" };
  }

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatureHeader = request.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, verified: false, reason: "서명 정보가 없습니다" };
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) {
    return { ok: false, verified: false, reason: "통지 시각이 너무 오래됐습니다" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`) as unknown as ArrayBuffer,
  );
  const expected = bytesToBase64(digest);
  // 머리값에는 서명이 여러 개 실릴 수 있다(키 교체 중). 하나라도 맞으면 통과.
  const matched = signatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .some((sig) => sig === expected);
  return matched
    ? { ok: true, verified: true, reason: null }
    : { ok: false, verified: false, reason: "서명이 맞지 않습니다" };
}

function bounceReason(event: MailEvent) {
  const head = BOUNCE_KIND[event.type ?? ""] ?? "발송이 실패했습니다";
  const bounce = event.data?.bounce;
  const detail = [bounce?.message, bounce?.subType ?? bounce?.type].filter(Boolean).join(" · ");
  return detail ? `${head} — ${detail}` : head;
}

/**
 * 통지 1건 처리.
 *
 * 성공·실패 어느 쪽이든 발송 서비스에는 200 을 돌려준다(서명 오류만 401). 우리 쪽 사정으로
 * 500 을 돌려주면 발송 서비스가 같은 통지를 몇 시간 동안 반복해서 보낸다.
 */
export async function handleMailWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST 로만 받습니다." }, 405);
  }

  const rawBody = await request.text();
  const check = await verifySignature(request, rawBody);
  if (!check.ok) {
    console.warn(`발송 실패 통지 거부: ${check.reason}`);
    return json({ ok: false, error: check.reason }, 401);
  }

  let event: MailEvent;
  try {
    event = JSON.parse(rawBody) as MailEvent;
  } catch {
    return json({ ok: false, error: "내용을 읽지 못했습니다." }, 400);
  }

  const providerId = event.data?.email_id;
  if (!providerId) return json({ ok: true, skipped: "발송 식별값이 없는 통지" });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: log } = await supabaseAdmin
    .from("mail_logs")
    .select("id, participant_id, to_email, status")
    .eq("provider_id", providerId)
    .maybeSingle();
  if (!log) {
    // 우리가 보낸 기록에 없는 통지(다른 시스템·삭제된 기록). 되돌려 받을 이유가 없으니 200.
    console.warn(`발송 실패 통지: 해당 발송 기록을 찾지 못했습니다 (${providerId})`);
    return json({ ok: true, skipped: "발송 기록 없음" });
  }

  const isBounce = Boolean(BOUNCE_KIND[event.type ?? ""]);
  const now = new Date().toISOString();

  if (!isBounce) {
    // 도달·열람 같은 통지는 판정을 바꾸지 않고 근거만 붙여 둔다.
    await supabaseAdmin.from("mail_logs").update({ provider_event: event }).eq("id", log.id);
    return json({ ok: true, recorded: event.type ?? "알 수 없는 종류" });
  }

  const reason = bounceReason(event);
  await supabaseAdmin
    .from("mail_logs")
    .update({ status: "반송", bounced_at: now, provider_event: event, error_message: reason })
    .eq("id", log.id);

  if (log.participant_id) {
    await supabaseAdmin
      .from("participants")
      .update({ mail_bounced_at: now, mail_bounce_reason: reason })
      .eq("id", log.participant_id);
  }

  return json({ ok: true, applied: "반송", verified: check.verified });
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
