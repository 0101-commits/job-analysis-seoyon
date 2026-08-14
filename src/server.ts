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

// 예약 배치 발송 + 자동 리마인더.
// - runScheduledBatches: '예약'→'대기' 조건부 선점으로 cron 동시/중복 실행 시 이중 발송 차단.
// - runReminders: 무force 자동 경로(reminder_auto + D-N 판정 + 회사별 하루 1회 가드 내장).
//   회사별 중복방지가 함수 내부에 있으므로 여기서 전역 name 가드를 두면 안 된다
//   (A사 리마인더 1건이 그날 B·C사 리마인더를 통째로 막던 버그).
async function runScheduledJobs() {
  const { supabaseAdmin } = await import("./integrations/supabase/client.server");
  const { runScheduledBatches, runReminders } = await import("./lib/mailer.server");

  try {
    await runScheduledBatches(supabaseAdmin, null);
  } catch (error) {
    console.error("예약 배치 발송 실패", error);
  }

  try {
    await runReminders(supabaseAdmin, { origin: null });
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
