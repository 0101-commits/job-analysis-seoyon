// 조사 마법사 공용 타입 계약 — TaskGrid/SkillGrid/RequirementsForm(그리드 에이전트)과
// 마법사 코어(위저드 에이전트)가 공유한다. 양쪽 합의 없이 변경 금지.

export type Authority = "D" | "R" | "O" | "S";
export type Ksao = "K" | "S" | "A";
export type HardSoft = "Hard" | "Soft";
export type ImproveType = "삭제" | "통폐합" | "빈도감소" | "하위자위양" | "타부서이관" | "강화";
export type Education = "중졸이하" | "고졸" | "전문대졸" | "학사" | "석사급" | "박사급이상" | "기준없음";

export interface ActivityItem {
  id: string; // DB uuid 또는 임시 id(신규는 crypto.randomUUID())
  name: string;
}

export interface TaskItem {
  id: string;
  name: string; // "행위+목적" 한 문장
  importance: number | null; // 1~5
  authority: Authority | null;
  transferable: boolean | null;
  isKey: boolean; // 주요 Task (최대 5)
  improveType: ImproveType | null;
  improveNote: string;
  activities: ActivityItem[]; // 2~8 권장
}

export interface SkillItem {
  id: string;
  name: string;
  ksao: Ksao | null;
  hardSoft: HardSoft | null;
  description: string;
  relatedTaskIds: string[]; // TaskItem.id 참조
  isGeneral?: boolean; // 특정 과업과 무관한 직무 공통 스킬
}

export interface LicenseItem {
  name: string;
  kind: "필수" | "우대";
  grade: string; // 등급/급수 자유
}

export interface LanguageItem {
  language: string;
  level: string; // 기초 회화 / 업무 문서 / 협상 가능 / 공인점수
}

export interface RequirementsValue {
  education: Education | null;
  majorsRequired: string;
  majorsPreferred: string;
  licenses: LicenseItem[];
  languages: LanguageItem[];
  trainings: string;
  proficiency: string; // 6개월↓/1년↓/2년↓/3년↓/5년↓/직접입력
}

export interface ExampleRow {
  category: string;
  field: "definition" | "mission" | "task" | "activity" | "skill";
  good_example: string;
  bad_example: string | null;
  note: string | null;
}

export interface TaskGridProps {
  value: TaskItem[];
  onChange: (next: TaskItem[]) => void;
  examples: ExampleRow[]; // field==='task'|'activity' 만 전달됨
  disabled?: boolean;
  /** 과업 삭제 직전 확인. false 를 반환하면 삭제를 취소한다(연결된 스킬 경고용). */
  confirmRemove?: (task: TaskItem) => boolean;
}

export interface SkillGridProps {
  value: SkillItem[];
  onChange: (next: SkillItem[]) => void;
  tasks: Pick<TaskItem, "id" | "name">[];
  examples: ExampleRow[]; // field==='skill'
  disabled?: boolean;
}

export interface RequirementsFormProps {
  value: RequirementsValue;
  onChange: (next: RequirementsValue) => void;
  disabled?: boolean;
}

// 검증 유틸 계약 (그리드 에이전트가 구현·export, 코어가 단계 이동 게이트에 사용)
export interface TaskValidation {
  ok: boolean;
  errors: string[]; // 한국어 메시지
  warnings: string[]; // 유사 중복 등 소프트 경고
}
