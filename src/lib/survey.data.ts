// 조사 마법사 데이터 계층 — respondent 본인 데이터는 RLS 로 보호되므로 클라이언트에서 직접 CRUD 한다.
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { CUSTOM } from "@/components/survey/RequirementsForm";
import type {
  Authority,
  Education,
  ExampleRow,
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

/** responses 본문 필드 부분 저장 (단계 이동 시 current_step 도 함께 갱신) */
export async function saveResponseFields(
  responseId: string,
  patch: Database["public"]["Tables"]["responses"]["Update"],
) {
  const { error } = await supabase.from("responses").update(patch).eq("id", responseId);
  if (error) throw error;
}

/** id 목록에 없는 행을 지운다. 목록이 비면 전체 삭제. */
function notIn(ids: string[]) {
  return `(${ids.join(",")})`;
}

export async function saveTasks(responseId: string, tasks: TaskItem[]) {
  const taskIds = tasks.map((t) => t.id);

  // 1. 삭제분 정리 (활동은 FK cascade 로 함께 사라진다)
  const deleteTasks = supabase.from("response_tasks").delete().eq("response_id", responseId);
  const { error: delError } = await (taskIds.length
    ? deleteTasks.not("id", "in", notIn(taskIds))
    : deleteTasks);
  if (delError) throw delError;

  if (!tasks.length) return;

  // 2. 과업 upsert (seq = 화면 순서)
  const { error: taskError } = await supabase.from("response_tasks").upsert(
    tasks.map((t, i) => ({
      id: t.id,
      response_id: responseId,
      seq: i,
      name: t.name,
      importance: t.importance,
      authority: t.authority,
      transferable: t.transferable,
      is_key: t.isKey,
      improve_type: t.improveType,
      improve_note: t.improveNote || null,
    })),
  );
  if (taskError) throw taskError;

  // 3. 활동 upsert + 삭제분 정리
  const activityIds = tasks.flatMap((t) => t.activities.map((a) => a.id));
  const deleteActivities = supabase.from("response_activities").delete().in("task_id", taskIds);
  const { error: actDelError } = await (activityIds.length
    ? deleteActivities.not("id", "in", notIn(activityIds))
    : deleteActivities);
  if (actDelError) throw actDelError;

  const activityRows = tasks.flatMap((t) =>
    t.activities.map((a, i) => ({ id: a.id, task_id: t.id, seq: i, name: a.name })),
  );
  if (activityRows.length) {
    const { error: actError } = await supabase.from("response_activities").upsert(activityRows);
    if (actError) throw actError;
  }
}

export async function saveSkills(responseId: string, skills: SkillItem[]) {
  const ids = skills.map((s) => s.id);
  const del = supabase.from("response_skills").delete().eq("response_id", responseId);
  const { error: delError } = await (ids.length ? del.not("id", "in", notIn(ids)) : del);
  if (delError) throw delError;

  if (!skills.length) return;

  // 삭제된 과업을 가리키는 고아 참조 제거 — 저장 시점의 실제 과업 id 만 남긴다.
  const { data: taskRows, error: taskError } = await supabase
    .from("response_tasks")
    .select("id")
    .eq("response_id", responseId);
  if (taskError) throw taskError;
  const liveTaskIds = new Set((taskRows ?? []).map((t) => t.id));

  const { error } = await supabase.from("response_skills").upsert(
    skills.map((s) => ({
      id: s.id,
      response_id: responseId,
      name: s.name,
      ksao: s.ksao,
      hard_soft: s.hardSoft,
      description: s.description || null,
      related_task_ids: s.relatedTaskIds.filter((id) => liveTaskIds.has(id)),
    })),
  );
  if (error) throw error;
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
export async function getExamples(): Promise<ExampleRow[]> {
  const { data, error } = await supabase
    .from("example_library")
    .select("category, field, good_example, bad_example, note")
    .order("category", { ascending: true })
    .order("sort", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ExampleRow[];
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

/** 반려 배너용 최신 반려 코멘트 */
export async function getLatestReject(responseId: string) {
  const { data, error } = await supabase
    .from("review_comments")
    .select("body, created_at")
    .eq("response_id", responseId)
    .eq("kind", "reject")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}
