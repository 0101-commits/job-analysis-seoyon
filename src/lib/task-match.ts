// 과업명 대조 규칙 (기획 F11·F14).
//
// 업무분장 대조와 직무 중복 진단이 같은 규칙을 써야 한다 — 한쪽에서 「같다」고 본 과업을
// 다른 쪽에서 다르게 보면 관리자가 두 화면의 숫자를 못 믿는다. 그래서 규칙만 여기 모았다.
//
// 서버 전용 import 를 두지 않는다 — `node scripts/check-task-match.mjs` 가 이 파일을 그대로 불러
// 규칙을 점검한다.
import { similarity } from "@/components/survey/validation";

/**
 * 유사 판정 기준 (0~1, 공백 제거 bigram Dice 계수).
 *
 *   1.00        정규화 후 완전히 같다 → 「정확 일치」
 *   0.70 이상   표현만 다를 가능성이 크다 → 「유사(확인 필요)」 — 사람이 판단하게 남긴다
 *   0.70 미만   다른 일로 본다 → 「누락 후보」
 *
 * 0.7 은 과업명이 보통 4~12자로 짧아 0.8(응답 안 중복 검사 기준)이면 어미 차이만으로도
 * 떨어져 나가기 때문에 한 단 낮췄다. 자동으로 같다고 단정하지 않으므로 느슨한 쪽이 안전하다.
 */
export const DUTY_SIMILAR_THRESHOLD = 0.7;

/**
 * 과업명 대조용 정규화.
 * 괄호와 그 안의 부연, 공백·구두점, 끝에 붙은 조사·어미를 떼어
 * 「영업 실적 관리(월간)」 과 「영업실적관리」 를 같은 것으로 본다.
 */
export function normalizeTaskName(name: string) {
  return name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[\s.,~/|:;'"·]/g, "")
    .replace(/(을|를|이|가|은|는|의|에|와|과|및|등|하기|한다|합니다|업무)$/u, "")
    .toLowerCase();
}

/** 업무분장표에서 과업명 열을 찾는 이름 규칙 — 업로드 파일의 열 이름은 회사마다 다르다. */
const DUTY_TASK_HEADER =
  /주요\s*업무|과업|담당\s*업무|업무\s*명|업무\s*내용|직무\s*내용|수행\s*업무/;

/** 업무분장표 행에서 과업명만 뽑는다. 같은 과업이 여러 줄에 걸쳐 있으면 한 번만 센다. */
export function extractDutyTasks(rows: Record<string, string>[]): string[] {
  const headers = Object.keys(rows[0] ?? {});
  const key =
    headers.find((h) => DUTY_TASK_HEADER.test(h)) ??
    headers.find((h) => rows.some((r) => (r[h] ?? "").trim() !== ""));
  if (!key) return [];
  const seen = new Map<string, string>();
  for (const row of rows) {
    const name = (row[key] ?? "").trim();
    if (name === "") continue;
    const norm = normalizeTaskName(name);
    if (norm === "" || seen.has(norm)) continue;
    seen.set(norm, name);
  }
  return [...seen.values()];
}

/** 응답에 적힌 과업 하나 — 누가 썼는지까지 들고 다녀야 화면에서 근거를 보여 줄 수 있다. */
export type TaskRef = { name: string; who: string };

export type DutyPair = { dutyTask: string; responseTask: string; who: string; score: number };

export type DutyMatchResult = {
  matched: DutyPair[];
  /** 표현이 비슷하지만 같다고 단정하지 않은 것. */
  similar: DutyPair[];
  /** 분장에는 있는데 응답에서 찾지 못한 과업. */
  missing: string[];
  /** 응답에만 있고 분장에 없는 과업. */
  extra: TaskRef[];
};

/**
 * 분장 과업과 응답 과업을 맞춘다.
 * respByNorm 은 정규화 키 → 대표 응답 과업. 정확 일치를 먼저 보고, 없으면 가장 비슷한 것을 찾는다.
 *
 * 한 응답 과업이 분장의 두 줄을 함께 받을 수 있다(분장이 같은 일을 잘게 나눠 적은 경우).
 * 그때 그 과업은 「분장 미반영」 이 아니고, 받은 분장 줄은 「유사(확인 필요)」 로 남아 사람이 본다.
 */
export function classifyDutyTasks(
  dutyTasks: string[],
  respByNorm: Map<string, TaskRef>,
): DutyMatchResult {
  const matched: DutyPair[] = [];
  const similar: DutyPair[] = [];
  const missing: string[] = [];
  const paired = new Set<string>();

  for (const duty of dutyTasks) {
    const norm = normalizeTaskName(duty);
    const exact = respByNorm.get(norm);
    if (exact) {
      matched.push({ dutyTask: duty, responseTask: exact.name, who: exact.who, score: 1 });
      paired.add(norm);
      continue;
    }
    let best: { key: string; hit: TaskRef; score: number } | null = null;
    for (const [key, hit] of respByNorm) {
      const score = similarity(norm, key);
      if (!best || score > best.score) best = { key, hit, score };
    }
    if (best && best.score >= DUTY_SIMILAR_THRESHOLD) {
      similar.push({
        dutyTask: duty,
        responseTask: best.hit.name,
        who: best.hit.who,
        score: best.score,
      });
      paired.add(best.key);
    } else {
      missing.push(duty);
    }
  }

  const extra = [...respByNorm.entries()].filter(([key]) => !paired.has(key)).map(([, hit]) => hit);

  return { matched, similar, missing, extra };
}

/**
 * 두 직무의 과업 겹침 (F14). 분모는 과업이 적은 쪽이라 포함 관계(한쪽이 다른 쪽에 다 들어감)를
 * 잘 잡는다. 교집합은 정규화 완전일치로만 센다 — 근거는 diagnoseJobCatalog 주석 참고.
 */
export function taskOverlap(
  a: Map<string, string>,
  b: Map<string, string>,
): { ratio: number; shared: string[] } {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return { ratio: 0, shared: [] };
  const shared: string[] = [];
  for (const [key, name] of small) {
    if (large.has(key)) shared.push(name);
  }
  return { ratio: shared.length / small.size, shared };
}
