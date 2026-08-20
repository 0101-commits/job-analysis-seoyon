// elizax-proxy(Cloudflare Worker) 경유 Anthropic Messages 호출. 서버 전용 모듈.
// 라우트/*.functions.ts 는 클라이언트 번들에 실리므로 반드시 handler 안에서 동적 import 할 것.

const DEFAULT_PROXY_URL = "https://elizax-proxy.baldr0001.workers.dev";
const MAX_TOKENS_CAP = 2048;
const MODEL_NAME = "claude-sonnet-5";

/**
 * F17: AI 사용 원장에서 쓰는 기능 이름의 단일 원천.
 * 호출부(주로 ai.functions.ts)가 이 상수로 feature 를 넘긴다.
 */
export const AI_FEATURES = {
  PING: "연결 점검",
  TYPO_SCAN: "오탈자 검수",
  POOR_SWEEP: "부실 응답 스윕",
  SELF_CHECK: "본인 응답 점검",
  SINGLE_CHECK: "응답 품질 단건 점검",
  MISSING_FIELDS: "결측 항목 자동 채움",
  MERGE_SUGGEST: "표기 통일 후보 탐색",
  JOB_CATALOG_DRAFT: "직무분류 가안",
  DUTY_CHART_DRAFT: "업무분장 가안",
  JOB_DESCRIPTION_DRAFT: "직무기술서 초안",
} as const;

/** ai_calls 에 기록할 부가 정보. feature/target 을 안 넘기면 프롬프트 문구로 최선 추정한다. */
type CallMeta = { feature?: string | undefined; target?: string | undefined; actorId?: string | undefined };

/**
 * feature 를 안 넘긴 호출(직무분류·업무분장·직무기술서 초안 — 소유 파일이 달라 인자를
 * 추가하지 못한다) 을 시스템 프롬프트 문구로 구분한다.
 * ponytail: 문구 매칭 휴리스틱이라 세 화면의 프롬프트 문구가 바뀌면 분류가 깨진다.
 * 근본 해결은 해당 호출부가 feature 를 직접 넘기는 것 — 지금은 소유권 밖이라 못 고친다.
 */
function inferFeature(system: string): string {
  if (system.includes("직무분류 체계를 설계")) return AI_FEATURES.JOB_CATALOG_DRAFT;
  if (system.includes("조직 업무분장표 초안")) return AI_FEATURES.DUTY_CHART_DRAFT;
  if (system.includes("표준 직무기술서 초안")) return AI_FEATURES.JOB_DESCRIPTION_DRAFT;
  return "미지정 AI 호출";
}

/** 위 세 화면의 프롬프트가 대상 이름을 「」로 감싸거나 "직무: "로 적는 관례를 이용해 대상을 추정한다. */
function guessTarget(user: string): string | undefined {
  const bracket = user.match(/「([^」]{1,80})」/);
  if (bracket?.[1]) return bracket[1];
  const job = user.match(/직무:\s*([^\n,/]{1,80})/);
  if (job?.[1]) return job[1].trim();
  return undefined;
}

/** ai_calls 기록은 best-effort — 실패해도 본 기능(AI 호출 결과)에 영향을 주면 안 된다. */
async function recordAiCall(row: {
  feature: string;
  target?: string | undefined;
  status: "성공" | "실패";
  promptChars?: number | undefined;
  outputChars?: number | undefined;
  durationMs: number;
  errorMessage?: string | undefined;
  actorId?: string | undefined;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("ai_calls").insert({
      feature: row.feature,
      target: row.target ?? null,
      status: row.status,
      model: MODEL_NAME,
      prompt_chars: row.promptChars ?? null,
      output_chars: row.outputChars ?? null,
      duration_ms: row.durationMs,
      error_message: row.errorMessage?.slice(0, 2000) ?? null,
      actor_id: row.actorId ?? null,
    });
    if (error) console.warn("[llm.server] AI 호출 기록 실패(무시):", error.message);
  } catch (err) {
    console.warn("[llm.server] AI 호출 기록 실패(무시):", err);
  }
}

export function proxyUrl() {
  return process.env["ELIZAX_PROXY_URL"] ?? DEFAULT_PROXY_URL;
}

export function isProxyConfigured() {
  return Boolean(process.env["ELIZAX_PROXY_URL"]);
}

type MessagesResponse = {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
};

type BoundFetcher = { fetch: (input: string, init?: RequestInit) => Promise<Response> };

/**
 * CF Workers 배포에서는 같은 계정 workers.dev 워커끼리 일반 fetch 가 오류 1042 로 차단된다.
 * 서비스 바인딩(ELIZAX_PROXY, deploy.yml 에서 주입)이 있으면 그 fetch 를 쓰고,
 * 로컬 dev 등 바인딩이 없는 환경은 일반 fetch 로 폴백한다.
 */
function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  const g = globalThis as Record<string, unknown>;
  // nitro cloudflare 프리셋이 매 요청 globalThis.__env__ = env 를 수행한다. 우리 server.ts 스태시는 보조.
  const env = (g["__env__"] ?? g["__CF_ENV__"]) as Record<string, unknown> | undefined;
  const bound = env?.["ELIZAX_PROXY"] as BoundFetcher | undefined;
  return typeof bound?.fetch === "function" ? bound.fetch(url, init) : fetch(url, init);
}

/** 실제 HTTP 호출 (기록 없음) — callLLM/callLLMJson 이 각자의 단위로 기록을 감싼다. */
async function requestCompletion({
  system,
  user,
  maxTokens = 1500,
}: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  let res: Response;
  try {
    res = await proxyFetch(`${proxyUrl()}/api/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Worker 의 Origin 화이트리스트 통과용. 서버간 호출이라 브라우저가 붙여주지 않는다.
        // 운영 도메인(APP_URL)이 화이트리스트에 있어야 한다 — 미설정 시 로컬 개발 origin.
        origin: process.env["APP_URL"] ?? "http://localhost:8080",
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        max_tokens: Math.min(maxTokens, MAX_TOKENS_CAP),
        system,
        messages: [{ role: "user", content: user }],
        stream: false,
      }),
    });
  } catch (err) {
    throw new Error(
      `AI 프록시 호출 실패: 네트워크 오류 (${err instanceof Error ? err.message : "알 수 없음"})`,
    );
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`AI 프록시 호출 실패: HTTP ${res.status} ${raw.slice(0, 300)}`);
  }

  let json: MessagesResponse;
  try {
    json = JSON.parse(raw) as MessagesResponse;
  } catch {
    throw new Error(
      `AI 프록시 호출 실패: 응답을 JSON 으로 해석할 수 없습니다. ${raw.slice(0, 200)}`,
    );
  }
  if (json.error) throw new Error(`AI 프록시 호출 실패: ${json.error.message ?? "모델 오류"}`);

  const text = json.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("AI 프록시 호출 실패: 응답에 텍스트 블록이 없습니다.");
  return text;
}

export async function callLLM({
  system,
  user,
  maxTokens = 1500,
  feature,
  target,
  actorId,
}: {
  system: string;
  user: string;
  maxTokens?: number;
} & CallMeta): Promise<string> {
  const startedAt = Date.now();
  const meta = { feature: feature ?? inferFeature(system), target: target ?? guessTarget(user), actorId };
  try {
    const text = await requestCompletion({ system, user, maxTokens });
    await recordAiCall({
      ...meta,
      status: "성공",
      promptChars: system.length + user.length,
      outputChars: text.length,
      durationMs: Date.now() - startedAt,
    });
    return text;
  } catch (err) {
    await recordAiCall({
      ...meta,
      status: "실패",
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * AI 응답 형식 오류의 식별 이름.
 *
 * 호출자(예: 직무 가안 생성의 직렬 분할 재시도)는 "응답이 잘렸는지"를 판단해야 한다.
 * 화면 문구는 실무 표현으로 바뀔 수 있으므로 문구가 아니라 이 이름으로 식별한다.
 */
export const AI_FORMAT_ERROR = "AiResponseFormatError";

/** 응답 형식(잘림·형식 오류) 때문에 실패한 호출인지. 재시도 판단은 이 함수로만 한다. */
export function isAiFormatError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === AI_FORMAT_ERROR) return true;
  // 다른 모듈이 직접 던진 형식 오류도 같은 취급 — 문구 기반 판정을 이 한 곳에 모아 둔다.
  return /^AI 응답 .*실패/.test(err.message);
}

function formatError(message: string): Error {
  const err = new Error(message);
  err.name = AI_FORMAT_ERROR;
  return err;
}

/** 모델이 설명문을 덧붙여도 첫 괄호~마지막 괄호만 잘라 읽는다. */
export function parseJsonLoose<T>(text: string): T {
  const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
  const ends = [text.lastIndexOf("]"), text.lastIndexOf("}")];
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(...ends);
  if (start < 0 || end <= start) {
    throw formatError(
      `AI 응답 읽어들이기 실패: 결과 형식을 찾을 수 없습니다. ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (err) {
    throw formatError(
      `AI 응답 읽어들이기 실패: ${err instanceof Error ? err.message : "형식 오류"}`,
    );
  }
}

/**
 * callLLM 이 아니라 requestCompletion 을 직접 쓴다 — 호출 자체와 JSON 읽어들이기를
 * "가안 생성 한 건"이라는 하나의 단위로 기록하기 위해서다(callLLM 을 거치면 같은 호출이
 * 성공/실패로 두 번 잡힌다).
 */
export async function callLLMJson<T>(args: {
  system: string;
  user: string;
  maxTokens?: number;
} & CallMeta): Promise<T> {
  const { system, user, maxTokens = 1500, feature, target, actorId } = args;
  const startedAt = Date.now();
  const meta = { feature: feature ?? inferFeature(system), target: target ?? guessTarget(user), actorId };

  let text: string;
  try {
    text = await requestCompletion({ system, user, maxTokens });
  } catch (err) {
    await recordAiCall({
      ...meta,
      status: "실패",
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    const parsed = parseJsonLoose<T>(text);
    await recordAiCall({
      ...meta,
      status: "성공",
      promptChars: system.length + user.length,
      outputChars: text.length,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } catch (err) {
    await recordAiCall({
      ...meta,
      status: "실패",
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
