// 조사 마법사 데이터 계층 — respondent 본인 데이터는 RLS 로 보호되므로 클라이언트에서 직접 CRUD 한다.
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { CUSTOM } from "@/components/survey/RequirementsForm";
import type { ExampleLibRow } from "@/components/survey/TaskGrid";
import type {
  Authority,
  Education,
  HardSoft,
  ImproveType,
  Ksao,
  LanguageItem,
  LicenseItem,
  RequirementsValue,
  SkillItem,
  TaskItem,
} from "@/components/survey/types";

export type ResponseRow = Database["public"]["Tables"]["responses"]["Row"];
export type ResponseStatus = "draft" | "submitted" | "rejected" | "approved";

export interface MyParticipant {
  id: string;
  company_id: string;
  name: string;
  emp_no: string;
  email: string | null;
  org_text: string | null;
  grade: string | null;
  role_level: string | null;
  company_name: string | null;
}

export const EMPTY_REQUIREMENTS: RequirementsValue = {
  education: null,
  majorsRequired: "",
  majorsPreferred: "",
  licenses: [],
  languages: [],
  trainings: "",
  proficiency: "",
};

export const COVERAGE_OPTIONS = [
  { value: "0-25", label: "0~25% — 실제 직무의 일부만 담겼다" },
  { value: "26-50", label: "26~50% — 절반 이하로 반영되었다" },
  { value: "51-75", label: "51~75% — 대체로 반영되었다" },
  { value: "76-100", label: "76~100% — 실제 직무를 충분히 반영한다" },
] as const;

/** 로그인한 사용자의 participants 행 */
export async function getMyParticipant(): Promise<MyParticipant | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from("participants")
    .select("id, company_id, name, emp_no, email, org_text, grade, role_level, companies(name)")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { companies, ...rest } = data;
  return { ...rest, company_name: companies?.name ?? null };
}

/** 본인 응답 행을 조회하고 없으면 생성한다. */
export async function getOrCreateResponse(participant: {
  id: string;
  company_id: string;
}): Promise<ResponseRow> {
  const { data: existing, error: selectError } = await supabase
    .from("responses")
    .select("*")
    .eq("participant_id", participant.id)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("responses")
    .insert({ participant_id: participant.id, company_id: participant.company_id })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return created;
}

export interface FullResponse {
  tasks: TaskItem[];
  skills: SkillItem[];
  requirements: RequirementsValue;
}

/** 과업·활동·스킬·자격요건을 한 번에 읽어 types.ts 형태로 매핑한다. */
export async function loadFull(responseId: string): Promise<FullResponse> {
  const [taskRes, skillRes, reqRes] = await Promise.all([
    supabase
      .from("response_tasks")
      .select("*, response_activities(id, name, seq)")
      .eq("response_id", responseId)
      .order("seq", { ascending: true }),
    // ponytail: response_skills 에 seq 컬럼이 없다 — id 정렬로 조회 순서만 고정한다.
    //           작성 순서를 그대로 살리려면 seq 컬럼 추가가 정공법.
    supabase.from("response_skills").select("*").eq("response_id", responseId).order("id"),
    supabase.from("response_requirements").select("*").eq("response_id", responseId).maybeSingle(),
  ]);
  if (taskRes.error) throw taskRes.error;
  if (skillRes.error) throw skillRes.error;
  if (reqRes.error) throw reqRes.error;

  const tasks: TaskItem[] = (taskRes.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    importance: row.importance,
    authority: row.authority as Authority | null,
    transferable: row.transferable,
    isKey: row.is_key,
    improveType: row.improve_type as ImproveType | null,
    improveNote: row.improve_note ?? "",
    activities: [...(row.response_activities ?? [])]
      .sort((a, b) => a.seq - b.seq)
      .map((a) => ({ id: a.id, name: a.name })),
  }));

  const skills: SkillItem[] = (skillRes.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    ksao: row.ksao as Ksao | null,
    hardSoft: row.hard_soft as HardSoft | null,
    description: row.description ?? "",
    relatedTaskIds: row.related_task_ids ?? [],
    isGeneral: row.is_general,
  }));

  const r = reqRes.data;
  const requirements: RequirementsValue = r
    ? {
        education: r.education as Education | null,
        majorsRequired: r.majors_required ?? "",
        majorsPreferred: r.majors_preferred ?? "",
        licenses: (r.licenses as unknown as LicenseItem[]) ?? [],
        languages: (r.languages as unknown as LanguageItem[]) ?? [],
        trainings: r.trainings ?? "",
        proficiency: r.proficiency ?? "",
      }
    : EMPTY_REQUIREMENTS;

  return { tasks, skills, requirements };
}

/**
 * 낙관적 락 충돌 — 마지막으로 읽은 뒤 관리자가 같은 응답을 고쳤다.
 * 저장 RPC 는 P0002 로, responses 조건부 UPDATE 는 0행 갱신으로 나타난다.
 */
export class ConflictError extends Error {
  constructor() {
    super("관리자가 이 응답을 수정했습니다.");
    this.name = "ConflictError";
  }
}

export function isConflict(err: unknown): boolean {
  if (err instanceof ConflictError) return true;
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P0002";
}

/**
 * responses 본문 필드 부분 저장 (단계 이동 시 current_step 도 함께 갱신).
 * expected 를 주면 그 시점 이후 바뀌지 않았을 때만 저장한다. 반환값 = 새 updated_at.
 */
export async function saveResponseFields(
  responseId: string,
  patch: Database["public"]["Tables"]["responses"]["Update"],
  expected?: string | null,
): Promise<string> {
  const update = supabase.from("responses").update(patch).eq("id", responseId);
  const { data, error } = await (expected ? update.eq("updated_at", expected) : update)
    .select("updated_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ConflictError();
  return data.updated_at;
}

/**
 * 과업·활동 전체 교체. delete→insert 를 서버 트랜잭션(save_tasks_tx)에서 한 번에 처리하므로
 * 중간에 끊겨도 반쯤 지워진 상태가 남지 않는다. 반환값 = 새 updated_at.
 * 활동 id 는 서버가 새로 발급한다(화면 순서만 seq 로 보존).
 */
export async function saveTasks(
  responseId: string,
  tasks: TaskItem[],
  expected?: string | null,
): Promise<string> {
  const payload = tasks.map((t, i) => ({
    id: t.id,
    seq: i,
    name: t.name,
    importance: t.importance,
    authority: t.authority,
    transferable: t.transferable,
    is_key: t.isKey,
    improve_type: t.improveType,
    improve_note: t.improveNote || null,
    activities: t.activities.map((a, ai) => ({ seq: ai, name: a.name })),
  }));

  const { data, error } = await supabase.rpc("save_tasks_tx", {
    _response_id: responseId,
    _tasks: payload as unknown as Json,
    _expected: expected ?? null,
  });
  if (error) throw error;
  return data;
}

/** 스킬 전체 교체(save_skills_tx). 고아 과업 참조는 서버가 걸러낸다. 반환값 = 새 updated_at. */
export async function saveSkills(
  responseId: string,
  skills: SkillItem[],
  expected?: string | null,
): Promise<string> {
  const payload = skills.map((s) => ({
    id: s.id,
    name: s.name,
    ksao: s.ksao,
    hard_soft: s.hardSoft,
    description: s.description || null,
    related_task_ids: s.relatedTaskIds,
    is_general: s.isGeneral ?? false,
  }));

  const { data, error } = await supabase.rpc("save_skills_tx", {
    _response_id: responseId,
    _skills: payload as unknown as Json,
    _expected: expected ?? null,
  });
  if (error) throw error;
  return data;
}

export async function saveRequirements(responseId: string, value: RequirementsValue) {
  // "직접 입력"은 Select 표식일 뿐 실제 값이 아니다 — 옆 칸을 안 채웠으면 빈 값으로 저장한다.
  const dropMarker = (raw: string) => (raw.trim() === CUSTOM ? "" : raw.trim());
  const languages = value.languages.map((l) => ({ ...l, level: dropMarker(l.level) }));

  const { error } = await supabase.from("response_requirements").upsert(
    {
      response_id: responseId,
      education: value.education,
      majors_required: value.majorsRequired || null,
      majors_preferred: value.majorsPreferred || null,
      licenses: value.licenses as unknown as Json,
      languages: languages as unknown as Json,
      trainings: value.trainings || null,
      proficiency: dropMarker(value.proficiency) || null,
    },
    { onConflict: "response_id" },
  );
  if (error) throw error;
}

export async function submit(
  responseId: string,
  final: { coverage: string | null; missedNote: string; painNote: string },
) {
  const { error } = await supabase
    .from("responses")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      coverage_pct: final.coverage,
      missed_note: final.missedNote || null,
      pain_note: final.painNote || null,
      current_step: 6,
    })
    .eq("id", responseId);
  if (error) throw error;
}

/** 작성 예시 라이브러리 전체 (건수가 작아 한 번에 읽는다) */
export async function getExamples(): Promise<ExampleLibRow[]> {
  const { data, error } = await supabase
    .from("example_library")
    // ponytail: is_common·job_group_key 가 아직 생성 타입(integrations/supabase/types.ts)에 없어
    //           컬럼을 나열하면 타입 오류가 난다 — 작은 표라 * 로 읽고 캐스팅한다.
    //           타입 재생성 후 컬럼 나열로 되돌리는 것이 정공법.
    .select("*")
    .order("category", { ascending: true })
    .order("sort", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ExampleLibRow[];
}

/**
 * 같은 계열사의 다른 응답에서 직군/직렬/직무 후보를 모은다.
 * SECURITY DEFINER RPC(job_suggestions) — 표기 문자열만 반환하므로 개인정보 없음.
 */
export async function getJobSuggestions(companyId: string) {
  const { data, error } = await supabase.rpc("job_suggestions", { _company_id: companyId });
  if (error) return { groups: [], series: [], names: [] };

  const uniq = (values: (string | null)[]) =>
    [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort();
  return {
    groups: uniq((data ?? []).map((r) => r.job_group)),
    series: uniq((data ?? []).map((r) => r.job_series)),
    names: uniq((data ?? []).map((r) => r.job_name)),
  };
}

/** 반려 이력 전체 (최신순). 배너·홈 카드가 모두 이 한 벌을 쓴다. */
export async function getRejectHistory(responseId: string) {
  const { data, error } = await supabase
    .from("review_comments")
    .select("id, body, step, created_at")
    .eq("response_id", responseId)
    .eq("kind", "reject")
    .order("created_at", { ascending: false });
  if (error) return [];
  return data ?? [];
}

export type RejectComment = Awaited<ReturnType<typeof getRejectHistory>>[number];

/** 반려 배너용 최신 반려 코멘트 (되돌릴 단계 포함) */
export async function getLatestReject(responseId: string) {
  const { data, error } = await supabase
    .from("review_comments")
    .select("body, step, created_at")
    .eq("response_id", responseId)
    .eq("kind", "reject")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

/** 정정 요청 대상 인사정보 항목. applicable=false 는 관리자가 이 화면에서 바로 반영할 수 없다. */
export const INFO_FIELDS = [
  { key: "name", label: "성명", applicable: true },
  { key: "emp_no", label: "사번", applicable: false },
  { key: "email", label: "이메일", applicable: true },
  { key: "company", label: "회사", applicable: false },
  { key: "org_text", label: "소속", applicable: true },
  { key: "grade", label: "직급", applicable: true },
  { key: "role_level", label: "역할단계", applicable: true },
] as const;

export type InfoFieldKey = (typeof INFO_FIELDS)[number]["key"];

export function infoFieldLabel(key: string) {
  return INFO_FIELDS.find((f) => f.key === key)?.label ?? key;
}

export interface InfoChangeField {
  field: string;
  current: string;
  requested: string;
}

/** 인사정보 정정 요청 등록. 본인 여부는 RLS(insert own request)가 검증한다. */
export async function createInfoChangeRequest(
  participantId: string,
  fields: InfoChangeField[],
  note: string,
) {
  const { error } = await supabase.from("info_change_requests").insert({
    participant_id: participantId,
    fields: fields as unknown as Json,
    note: note.trim() || null,
  });
  if (error) throw error;
}

/** 본인이 낸 정정 요청 목록 (최신순) */
export async function getMyInfoRequests(participantId: string) {
  const { data, error } = await supabase
    .from("info_change_requests")
    .select("id, fields, note, status, admin_note, created_at, handled_at")
    .eq("participant_id", participantId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return data ?? [];
}

export type MyInfoRequest = Awaited<ReturnType<typeof getMyInfoRequests>>[number];
