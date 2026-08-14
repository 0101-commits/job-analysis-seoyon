import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// 예약 배치 발송 + 자동 리마인더. cron 두 번 울려도 리마인더가 겹치지 않도록
// 같은 날짜 리마인더 배치가 이미 있으면 건너뛴다.
async function runScheduledJobs() {
  const { supabaseAdmin } = await import("./integrations/supabase/client.server");
  const { processBatch, runReminders } = await import("./lib/mailer.server");

  const { data: due } = await supabaseAdmin
    .from("mail_batches")
    .select("id")
    .eq("status", "예약")
    .lte("scheduled_at", new Date().toISOString());

  for (const batch of due ?? []) {
    try {
      await processBatch(supabaseAdmin, batch.id);
    } catch (error) {
      console.error(`예약 배치 ${batch.id} 발송 실패`, error);
    }
  }

  try {
    const todayName = `리마인더 ${new Date().toISOString().slice(0, 10)}`;
    const { data: already } = await supabaseAdmin
      .from("mail_batches")
      .select("id")
      .eq("name", todayName)
      .limit(1);
    if (!already?.length) {
      await runReminders(supabaseAdmin, { companyId: null, origin: null });
    }
  } catch (error) {
    console.error("자동 리마인더 실패", error);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },

  // Cloudflare Workers cron 진입점.
  // wrangler.toml(또는 배포 산출물 .output/server/wrangler.json)은 매 빌드 초기화되므로
  // 배포 파이프라인에서 아래 트리거를 매번 주입해야 한다.
  //
  //   [triggers]
  //   crons = ["0 21,9 * * *"]   # UTC 21:00 / 09:00 = KST 06:00 / 18:00
  //
  async scheduled(
    _event: unknown,
    _env: unknown,
    ctx: { waitUntil?: (p: Promise<unknown>) => void },
  ) {
    const job = runScheduledJobs().catch((error) => console.error("스케줄러 실패", error));
    ctx?.waitUntil?.(job);
    await job;
  },
};
