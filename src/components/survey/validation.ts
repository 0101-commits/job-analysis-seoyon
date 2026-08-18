// 조사 마법사 ④⑤단계 검증 유틸. 코어(위저드)가 단계 이동 게이트에 사용하고,
// TaskGrid 는 similarity/findSimilarPairs 를 중복 경고 배지에 재사용한다.
import type { SkillItem, TaskItem, TaskValidation } from "./types";

export const SIMILARITY_THRESHOLD = 0.8;

function bigrams(text: string): string[] {
  const t = text.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

/** 공백을 제거한 두 문자열의 bigram Dice 계수 (0~1). */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) {
    const na = a.replace(/\s+/g, "");
    const nb = b.replace(/\s+/g, "");
    return na.length > 0 && na === nb ? 1 : 0;
  }
  const pool = [...right];
  let hit = 0;
  for (const gram of left) {
    const i = pool.indexOf(gram);
    if (i >= 0) {
      pool.splice(i, 1);
      hit += 1;
    }
  }
  return (2 * hit) / (left.length + right.length);
}

/** 이름이 유사한 Task 쌍. ponytail: O(n²) 전수 비교 — Task 수가 수십 개를 넘으면 인덱싱 필요. */
export function findSimilarPairs(
  tasks: Pick<TaskItem, "id" | "name">[],
  threshold: number = SIMILARITY_THRESHOLD,
): { a: TaskItem["id"]; b: TaskItem["id"]; nameA: string; nameB: string }[] {
  const pairs: { a: string; b: string; nameA: string; nameB: string }[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const first = tasks[i];
    if (!first || first.name.trim() === "") continue;
    for (let j = i + 1; j < tasks.length; j += 1) {
      const second = tasks[j];
      if (!second || second.name.trim() === "") continue;
      if (similarity(first.name, second.name) >= threshold) {
        pairs.push({ a: first.id, b: second.id, nameA: first.name, nameB: second.name });
      }
    }
  }
  return pairs;
}

/** 중복 경고 배지를 붙일 Task id 집합. */
export function duplicateTaskIds(tasks: Pick<TaskItem, "id" | "name">[]): Set<string> {
  const ids = new Set<string>();
  for (const pair of findSimilarPairs(tasks)) {
    ids.add(pair.a);
    ids.add(pair.b);
  }
  return ids;
}

function label(task: TaskItem, index: number): string {
  return task.name.trim() === "" ? `${index + 1}번째 과업` : `'${task.name.trim()}'`;
}

export function validateTasks(tasks: TaskItem[]): TaskValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (tasks.length < 3) {
    errors.push("과업을 3개 이상 작성해야 제출할 수 있습니다(5~10개 권장)");
  }

  tasks.forEach((task, index) => {
    const name = label(task, index);
    if (task.name.trim() === "") {
      errors.push(`${index + 1}번째 과업의 이름을 「행위 + 목적」 한 문장으로 적어 주세요`);
    }
    if (task.activities.length === 0) {
      errors.push(`${name} 과업의 실제 수행 단계인 세부 활동을 1개 이상 추가해 주세요`);
    }
    task.activities.forEach((act, ai) => {
      if (act.name.trim() === "") {
        errors.push(`${name} 과업의 ${ai + 1}번째 세부 활동 이름을 적어 주세요`);
      }
    });
    if (task.activities.length === 1) {
      warnings.push(`${name} 과업의 세부 활동이 1개입니다 — 2~8개로 나눠 주세요 (권장)`);
    }
    if (task.importance === null) {
      errors.push(`${name} 과업의 중요도(1~5)를 골라 주세요`);
    }
    if (task.authority === null) {
      errors.push(`${name} 과업의 책임수준(D/R/O/S)을 골라 주세요`);
    }
    if (task.transferable === null) {
      errors.push(`${name} 과업의 이관 가능 여부(예/아니오)를 골라 주세요`);
    }
  });

  for (const pair of findSimilarPairs(tasks)) {
    warnings.push(
      `'${pair.nameA}'와 '${pair.nameB}'가 비슷해 보입니다 — 같은 일이라면 하나로 합쳐 주세요 (권장)`,
    );
  }
  if (tasks.length > 10) {
    warnings.push("과업이 10개를 넘으면 비슷한 것끼리 합쳐 주세요 (권장)");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function validateSkills(skills: SkillItem[]): TaskValidation {
  const errors: string[] = [];

  if (skills.length < 3) {
    errors.push("스킬을 3개 이상 작성해야 제출할 수 있습니다(5개 이상 권장)");
  }
  skills.forEach((skill, index) => {
    const name = skill.name.trim() === "" ? `${index + 1}번째 스킬` : `'${skill.name.trim()}'`;
    if (skill.name.trim() === "") {
      errors.push(`${index + 1}번째 스킬의 이름을 적어 주세요`);
    }
    if (skill.ksao === null) {
      errors.push(`${name}의 스킬 구분(지식/기술/태도)을 골라 주세요`);
    }
    if (skill.description.trim() === "") {
      errors.push(`${name}이 어떤 상황에서 쓰이는 능력인지 한 줄 설명을 적어 주세요`);
    }
  });

  return { ok: errors.length === 0, errors, warnings: [] };
}
