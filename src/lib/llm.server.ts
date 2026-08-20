// elizax-proxy(Cloudflare Worker) 경유 Anthropic Messages 호출. 서버 전용 모듈.
// 라우트/*.functions.ts 는 클라이언트 번들에 실리므로 반드시 handler 안에서 동적 import 할 것.

const DEFAULT_PROXY_URL = "https://elizax-proxy.baldr0001.workers.dev";
const MAX_TOKENS_CAP = 2048;

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

export async function callLLM({
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
        model: "claude-sonnet-5",
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

export async function callLLMJson<T>(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  return parseJsonLoose<T>(await callLLM(args));
}
