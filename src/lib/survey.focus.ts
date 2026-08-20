/**
 * 작성 화면 딥링크 규약 (기획 C8·P6).
 *
 *   /survey?step=<단계>&focus=<필드키>
 *
 * 홈에서 반려 사유·정정 이력을 보여줄 때 "몇 단계"만 넘기면 참여자가 그 단계 안에서
 * 다시 항목을 찾아야 한다. `focus` 로 항목까지 실어 보내면 작성 화면이 그 입력칸을
 * 하이라이트한 채 열 수 있다.
 *
 * 필드키는 DB 컬럼명을 그대로 쓴다 — 반려·정정 기록에 남는 이름과 같아야
 * 중간에 변환표를 두지 않는다. 목록·라벨·단계 매핑의 단일 원천이 이 파일이다.
 *
 * 링크를 만드는 쪽: `focusSearch()`
 * 링크를 받는 쪽(작성 화면): `validateSearch` 에서 `isFocusField()` 로 통과시킨다.
 */

/** 작성 6단계 이름 — 홈의 진행 표시와 작성 화면이 같은 말을 쓰기 위한 단일 원천. */
export const SURVEY_STEP_LABELS = [
  "기본정보",
  "직무 확인",
  "정의·목적",
  "과업 작성",
  "스킬·요건",
  "마무리",
] as const;

/** 필드키 → 사람이 읽는 라벨 + 그 항목이 있는 단계. */
export const FOCUS_FIELDS = {
  name: { label: "성명", step: 1 },
  emp_no: { label: "사번", step: 1 },
  email: { label: "이메일", step: 1 },
  birth_date: { label: "생년월일", step: 1 },
  company: { label: "회사", step: 1 },
  org_text: { label: "소속", step: 1 },
  grade: { label: "직급", step: 1 },
  role_level: { label: "역할단계", step: 1 },
  job_group: { label: "직군", step: 2 },
  job_series: { label: "직렬", step: 2 },
  job_name: { label: "직무", step: 2 },
  definition: { label: "직무 정의", step: 3 },
  mission: { label: "직무 목적", step: 3 },
  tasks: { label: "과업", step: 4 },
  skills: { label: "필요 역량", step: 5 },
  requirements: { label: "자격요건", step: 5 },
  pain_note: { label: "애로사항", step: 6 },
  missed_note: { label: "못 담은 측면", step: 6 },
} as const satisfies Record<string, { label: string; step: number }>;

export type FocusField = keyof typeof FOCUS_FIELDS;

export function isFocusField(key: string): key is FocusField {
  return Object.hasOwn(FOCUS_FIELDS, key);
}

/** 모르는 키는 키 자체를 보여 준다 — 라벨이 없다고 화면에서 사라지면 더 나쁘다. */
export function focusLabel(key: string): string {
  return isFocusField(key) ? FOCUS_FIELDS[key].label : key;
}

export function focusStep(key: string): number | null {
  return isFocusField(key) ? FOCUS_FIELDS[key].step : null;
}

/** 작성 화면 링크의 search 값. 단계를 못 찾으면 fallback(반려 단계 등)을 쓴다. */
export function focusSearch(
  key: string | null,
  fallbackStep = 1,
): { step: number; focus?: string } {
  const step = (key ? focusStep(key) : null) ?? fallbackStep;
  return key && isFocusField(key) ? { step, focus: key } : { step };
}

/**
 * 반려 사유 본문에서 언급된 항목을 뽑아낸다.
 *
 * review_comments 에는 단계만 있고 항목 컬럼이 없다. 관리자가 사유에 쓴 항목 이름을
 * 그대로 찾아 딥링크로 바꾸는 방식이다. 긴 라벨을 먼저 지워 "직무 정의" 가 "직무" 로
 * 잘리지 않게 한다.
 *
 * ponytail: 라벨 문자열 일치 휴리스틱. review_comments 에 field 컬럼이 생기면
 *           그 값을 그대로 쓰고 이 함수는 버린다.
 */
export function findFocusFields(text: string): FocusField[] {
  if (!text) return [];
  const keys = (Object.keys(FOCUS_FIELDS) as FocusField[]).sort(
    (a, b) => FOCUS_FIELDS[b].label.length - FOCUS_FIELDS[a].label.length,
  );
  let rest = text;
  const found: FocusField[] = [];
  for (const key of keys) {
    const { label } = FOCUS_FIELDS[key];
    if (!rest.includes(label)) continue;
    found.push(key);
    rest = rest.split(label).join(" ");
  }
  return found.sort((a, b) => FOCUS_FIELDS[a].step - FOCUS_FIELDS[b].step);
}
