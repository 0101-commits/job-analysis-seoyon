/**
 * 계열사(co)·소속(org) 렌즈의 URL 파싱 (기획 v2 P2).
 *
 * 관리자 화면 전체를 좁히는 두 값 — 계열사와 소속 — 은 URL 이 유일한 원천이다.
 * localStorage·useState 처럼 두 번째 원천을 두면 같은 링크가 사람마다 다른 화면을 연다.
 * 화면마다 파싱·patch 를 따로 적으면 아홉 곳이 제각각 어긋나므로, 이 한 곳에서만 판다.
 */
export type LensSearch = { co?: string; org?: string };

/** patch 값 — 문자열이면 그 값으로 설정, null 이면 키를 지운다, 키가 없으면 손대지 않는다. */
export type LensPatch = { co?: string | null; org?: string | null };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** `?co=` `?org=` 만 뽑는다. 값이 없거나 문자열이 아니면 조용히 버린다. */
export function pickLens(search: Record<string, unknown>): LensSearch {
  const out: LensSearch = {};
  const co = nonEmpty(search["co"]);
  if (co) out.co = co;
  const org = nonEmpty(search["org"]);
  if (org) out.org = org;
  return out;
}

/** 현재 URL 검색값 위에 렌즈 patch 를 얹는다. 값이 없는 키는 URL 에 남기지 않는다. */
export function applyLensPatch(
  prev: Record<string, unknown>,
  patch: LensPatch,
): Record<string, unknown> {
  const next = { ...prev };
  for (const key of ["co", "org"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}
