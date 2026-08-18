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
    res = await fetch(`${proxyUrl()}/api/messages`, {
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

/** 모델이 설명문을 덧붙여도 첫 괄호~마지막 괄호만 잘라 파싱한다. */
export function parseJsonLoose<T>(text: string): T {
  const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
  const ends = [text.lastIndexOf("]"), text.lastIndexOf("}")];
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(...ends);
  if (start < 0 || end <= start) {
    throw new Error(`AI 응답 파싱 실패: JSON 을 찾을 수 없습니다. ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (err) {
    throw new Error(`AI 응답 파싱 실패: ${err instanceof Error ? err.message : "형식 오류"}`);
  }
}

export async function callLLMJson<T>(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  return parseJsonLoose<T>(await callLLM(args));
}
