// 조사 마법사 ④⑤단계 검증 유틸. 코어(위저드)가 단계 이동 게이트에 사용하고,
// TaskGrid 는 similarity/findSimilarPairs 를 중복 경고 배지에 재사용한다.
import type { RequirementsValue, SkillItem, TaskItem, TaskValidation } from "./types";

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

/**
 * 진행 체크리스트 한 줄 (기획 C3).
 *
 * 제출 버튼을 눌러야 미완 항목을 알려 주던 흐름을 뒤집는다 — 작성 중에도 무엇이 남았는지
 * 옆에 항상 띄우고, 누르면 그 자리로 데려간다. 그래서 항목마다 `anchor`(문서 요소 id)를 갖는다.
 *
 * `required=false` 는 제출을 막지 않는 권장 항목이라 남은 개수에 세지 않는다.
 * 값이 없는 필드를 optional 로 두지 않고 빈 문자열로 채운다(호출부의 undefined 분기 제거).
 */
export interface ChecklistEntry {
  id: string;
  step: number;
  label: string;
  /** 무엇이 비었는지 한 줄. 채울 것이 없으면 빈 문자열. */
  hint: string;
  done: boolean;
  required: boolean;
  /** 스크롤해 갈 요소 id. 빈 문자열이면 단계 이동만 한다. */
  anchor: string;
}

export interface ChecklistInput {
  jobGroup: string;
  jobSeries: string;
  jobName: string;
  definition: string;
  mission: string;
  tasks: TaskItem[];
  skills: SkillItem[];
  coverage: string | null;
  requirements: RequirementsValue;
}

/** 과업 한 건에서 아직 안 채운 항목 이름들. */
function missingInTask(task: TaskItem): string[] {
  const missing: string[] = [];
  if (task.name.trim() === "") missing.push("과업명");
  if (task.activities.length === 0) missing.push("세부 활동");
  else if (task.activities.some((a) => a.name.trim() === "")) missing.push("빈 세부 활동");
  if (task.importance === null) missing.push("중요도");
  if (task.authority === null) missing.push("책임수준");
  if (task.transferable === null) missing.push("이관 가능");
  return missing;
}

function missingInSkill(skill: SkillItem): string[] {
  const missing: string[] = [];
  if (skill.name.trim() === "") missing.push("역량 이름");
  if (skill.ksao === null) missing.push("구분");
  if (skill.description.trim() === "") missing.push("한 줄 설명");
  return missing;
}

export function buildChecklist(input: ChecklistInput): ChecklistEntry[] {
  const entries: ChecklistEntry[] = [];
  const add = (e: ChecklistEntry) => entries.push(e);

  add({
    id: "info",
    step: 1,
    label: "인사정보 확인",
    hint: "",
    done: true,
    required: false,
    anchor: "",
  });

  const jobs: [string, string, string][] = [
    ["job_group", "직군", input.jobGroup],
    ["job_series", "직렬", input.jobSeries],
    ["job_name", "직무", input.jobName],
  ];
  for (const [key, label, value] of jobs) {
    add({
      id: key,
      step: 2,
      label,
      hint: value.trim() === "" ? "아직 비어 있습니다 (권장)" : "",
      done: value.trim() !== "",
      required: false,
      anchor: `field-${key}`,
    });
  }

  add({
    id: "definition",
    step: 3,
    label: "직무 정의",
    hint: input.definition.trim() === "" ? "두세 문장으로 적어 주세요" : "",
    done: input.definition.trim() !== "",
    required: true,
    anchor: "field-definition",
  });
  add({
    id: "mission",
    step: 3,
    label: "직무 목적",
    hint: input.mission.trim() === "" ? "한두 문장으로 적어 주세요" : "",
    done: input.mission.trim() !== "",
    required: true,
    anchor: "field-mission",
  });

  add({
    id: "task-count",
    step: 4,
    label: `과업 3개 이상 (현재 ${input.tasks.length}개)`,
    hint: input.tasks.length < 3 ? "5~10개를 권장합니다" : "",
    done: input.tasks.length >= 3,
    required: true,
    anchor: "field-tasks",
  });
  input.tasks.forEach((task, i) => {
    const missing = missingInTask(task);
    add({
      id: `task-${task.id}`,
      step: 4,
      label: `${i + 1}. ${task.name.trim() || "이름 없는 과업"}`,
      hint: missing.join(" · "),
      done: missing.length === 0,
      required: true,
      anchor: `task-${task.id}`,
    });
  });

  add({
    id: "skill-count",
    step: 5,
    label: `필요 역량 3개 이상 (현재 ${input.skills.length}개)`,
    hint: input.skills.length < 3 ? "5개 이상을 권장합니다" : "",
    done: input.skills.length >= 3,
    required: true,
    anchor: "field-skills",
  });
  input.skills.forEach((skill, i) => {
    const missing = missingInSkill(skill);
    add({
      id: `skill-${skill.id}`,
      step: 5,
      label: `${i + 1}. ${skill.name.trim() || "이름 없는 역량"}`,
      hint: missing.join(" · "),
      done: missing.length === 0,
      required: true,
      anchor: `skill-${skill.id}`,
    });
  });

  // 자격요건은 제출을 막지 않는다. 다만 「해당 없음」도 고르지 않은 칸은 비어 있는 것과
  // 판단이 끝난 것을 구분할 수 없으므로 권장 항목으로 한 줄 남긴다.
  const req = input.requirements;
  add({
    id: "requirements",
    step: 5,
    label: "자격요건",
    hint:
      req.education === null && req.licenses.length === 0 && req.licensesNa === null
        ? "학력·자격증 기준을 고르거나 「해당 없음」을 골라 주세요 (권장)"
        : "",
    done: req.education !== null || req.licenses.length > 0 || req.licensesNa !== null,
    required: false,
    anchor: "field-requirements",
  });

  add({
    id: "coverage",
    step: 6,
    label: "내 일을 어느 정도 담았는지",
    hint: input.coverage ? "" : "고르지 않으면 제출할 수 없습니다",
    done: !!input.coverage,
    required: true,
    anchor: "field-coverage",
  });

  return entries;
}

export function validateSkills(skills: SkillItem[]): TaskValidation {
  const errors: string[] = [];

  if (skills.length < 3) {
    errors.push("필요 역량을 3개 이상 작성해야 제출할 수 있습니다(5개 이상 권장)");
  }
  skills.forEach((skill, index) => {
    const name = skill.name.trim() === "" ? `${index + 1}번째 필요 역량` : `'${skill.name.trim()}'`;
    if (skill.name.trim() === "") {
      errors.push(`${index + 1}번째 필요 역량의 이름을 적어 주세요`);
    }
    if (skill.ksao === null) {
      errors.push(`${name}의 구분(지식/기술/태도)을 골라 주세요`);
    }
    if (skill.description.trim() === "") {
      errors.push(`${name}이 어떤 상황에서 쓰이는 능력인지 한 줄 설명을 적어 주세요`);
    }
  });

  return { ok: errors.length === 0, errors, warnings: [] };
}
