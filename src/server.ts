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

/**
 * 환경변수 읽기 — llm.server.ts / mailer.server.ts 와 같은 순서.
 * nitro cloudflare 프리셋이 매 요청 `globalThis.__env__ = env` 를 하고, 아래 fetch 가
 * `__CF_ENV__` 로 한 벌 더 스태시한다. 로컬 dev 는 process.env 로 떨어진다.
 */
function readEnv(name: string) {
  const g = globalThis as Record<string, unknown>;
  const env = (g["__env__"] ?? g["__CF_ENV__"]) as Record<string, unknown> | undefined;
  const fromWorker = env?.[name];
  if (typeof fromWorker === "string" && fromWorker.trim()) return fromWorker;
  const fromProcess = process.env[name];
  return fromProcess?.trim() ? fromProcess : undefined;
}

/**
 * 토큰 비교. 길이가 같을 때 앞에서 몇 자가 맞았는지가 응답 시간에 드러나지 않게
 * 전부 훑어서 비교한다(공개 주소라 반복 시도를 막는 값이 곧 이 토큰뿐이다).
 */
function sameToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 정기 실행 진입점 — POST /api/cron?job=<이름|all>
 *
 * CF 무료 플랜 cron 5개 상한 때문에 실행 주체는 GitHub Actions(.github/workflows/cron.yml)다.
 * 토큰이 맞지 않으면 이유를 알려 주지 않고 401 만 돌려준다(어떤 값이 틀렸는지 노출 금지).
 * 작업 하나라도 실패하면 HTTP 500 으로 내려 호출한 워크플로가 빨갛게 뜨도록 한다.
 */
async function handleCronRequest(request: Request, url: URL) {
  const expected = readEnv("CRON_TOKEN");
  // 토큰은 머리값으로만 받는다 — 쿼리스트링에 실으면 접속 기록에 그대로 남는다.
  const provided = request.headers.get("x-cron-token");
  if (!expected || !provided || !sameToken(provided, expected)) {
    return json({ error: "정기 실행 권한이 없습니다." }, 401);
  }

  const job = url.searchParams.get("job") ?? "all";
  const { runAllCronJobs } = await import("./lib/cron.server");
  const results = await runAllCronJobs(job === "all" ? undefined : [job]);
  const failed = results.filter((r) => r.status === "실패");
  return json({ ran: results.length, failed: failed.length, results }, failed.length ? 500 : 200);
}

/**
 * 메일 반송 수집 진입점 — POST /api/mail/webhook (기획 F1, 담당 분리).
 * 처리 로직은 mail-webhook.server.ts 소유다. 아직 없으면 503 으로 알린다(조용히 200 금지).
 */
async function handleMailWebhookRequest(request: Request) {
  try {
    const mod = await import("./lib/mail-webhook.server");
    return await mod.handleMailWebhook(request);
  } catch (error) {
    console.error("메일 반송 수집 실패", error);
    return json({ error: "메일 반송 수집이 아직 준비되지 않았습니다." }, 503);
  }
}

// 정기 실행 작업 묶음. CF cron 트리거가 등록된 환경(scheduled)과 HTTP 진입점이 같은 함수를 쓴다.
async function runScheduledJobs() {
  const { runAllCronJobs } = await import("./lib/cron.server");
  const results = await runAllCronJobs();
  for (const r of results) {
    if (r.status === "실패") console.error(`정기 실행 실패 (${r.job})`, r.error);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // CF 워커 바인딩(서비스 바인딩 등)을 서버 모듈에서 쓸 수 있게 노출.
    // workers.dev 워커끼리는 일반 fetch 가 오류 1042 로 차단되므로
    // llm.server.ts 가 ELIZAX_PROXY 서비스 바인딩을 이 경로로 찾는다.
    (globalThis as Record<string, unknown>)["__CF_ENV__"] = env;
    try {
      // 운영 진입점은 SSR 로 넘기기 전에 가로챈다(라우트 파일이 아니라 워커 진입점이 처리).
      if (request.method === "POST") {
        const url = new URL(request.url);
        if (url.pathname === "/api/cron") return await handleCronRequest(request, url);
        if (url.pathname === "/api/mail/webhook") return await handleMailWebhookRequest(request);
      }

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
  //
  // 기본 실행 경로는 GitHub Actions → POST /api/cron 이다(.github/workflows/cron.yml).
  // CF 무료 플랜은 계정당 cron 5개 상한이라 이 트리거는 등록되지 않을 수 있고,
  // deploy.yml 이 ENABLE_CRON=1 일 때만 아래 트리거를 주입한다. 둘 중 어느 경로로
  // 들어와도 runAllCronJobs 하나만 돈다.
  //
  //   [triggers]
  //   crons = ["0 21,9 * * *"]   # UTC 21:00 / 09:00 = KST 06:00 / 18:00
  //
  async scheduled(
    _event: unknown,
    env: unknown,
    ctx: { waitUntil?: (p: Promise<unknown>) => void },
  ) {
    (globalThis as Record<string, unknown>)["__CF_ENV__"] = env;
    const job = runScheduledJobs().catch((error) => console.error("스케줄러 실패", error));
    ctx?.waitUntil?.(job);
    await job;
  },
};
