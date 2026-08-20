// 조사 마법사 데이터 계층 — respondent 본인 데이터는 RLS 로 보호되므로 클라이언트에서 직접 CRUD 한다.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { CUSTOM } from "@/components/survey/RequirementsForm";
import type { ExampleLibRow } from "@/components/survey/ExamplePopover";
import type {
  Authority,
  Education,
  HardSoft,
  ImproveType,
  Ksao,
  LanguageItem,
  LicenseItem,
  NotApplicable,
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
  licensesNa: null,
  languagesNa: null,
};

/**
 * 「해당 없음」 표식은 기존 jsonb 배열의 원소로 저장한다 (기획 C5).
 * 표식이 들어 있으면 그 목록은 비어 있는 것으로 읽는다 — 새 컬럼 없이 판단 여부만 구분한다.
 */
function splitNotApplicable<T>(raw: unknown): { mark: NotApplicable | null; items: T[] } {
  const arr = Array.isArray(raw) ? raw : [];
  const mark = arr.find(
    (x) => typeof x === "object" && x !== null && (x as { na?: unknown }).na === true,
  ) as { reason?: unknown } | undefined;
  if (!mark) return { mark: null, items: arr as T[] };
  return { mark: { na: true, reason: String(mark.reason ?? "") }, items: [] };
}

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
  const lic = splitNotApplicable<LicenseItem>(r?.licenses);
  const lang = splitNotApplicable<LanguageItem>(r?.languages);
  const requirements: RequirementsValue = r
    ? {
        education: r.education as Education | null,
        majorsRequired: r.majors_required ?? "",
        majorsPreferred: r.majors_preferred ?? "",
        licenses: lic.items,
        languages: lang.items,
        trainings: r.trainings ?? "",
        proficiency: r.proficiency ?? "",
        licensesNa: lic.mark,
        languagesNa: lang.mark,
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
    // 주요 과업 별표 UI 폐지 — 컬럼은 존치하되 더 이상 저장하지 않는다(기존 값도 재저장 시 초기화).
    is_key: false,
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
  // 「해당 없음」이면 목록 대신 표식 하나만 저장한다 (기획 C5).
  const licenseJson = value.licensesNa ? [value.licensesNa] : value.licenses;
  const languageJson = value.languagesNa ? [value.languagesNa] : languages;

  const { error } = await supabase.from("response_requirements").upsert(
    {
      response_id: responseId,
      education: value.education,
      majors_required: value.majorsRequired || null,
      majors_preferred: value.majorsPreferred || null,
      licenses: licenseJson as unknown as Json,
      languages: languageJson as unknown as Json,
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

  // V15-1: 제출 시점 스냅샷 — 서버 RPC 가 응답 전체를 캡처한다. 부가 기능이므로
  // 실패해도 제출 자체는 성공으로 둔다(재제출 변경분 하이라이트만 빠진다).
  // ponytail: snapshot_submission 이 생성 types.ts 에 아직 없어 untyped 캐스팅 — 재생성 시 제거.
  const { error: snapError } = await (supabase as unknown as SupabaseClient).rpc(
    "snapshot_submission",
    { _response_id: responseId },
  );
  if (snapError) console.error("snapshot_submission 실패:", snapError.message);
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

// ---------- 관리자 변경 인지 배너 (V14-③) ----------

/** 관리자가 내 정보를 바꾼 이벤트 하나 — at 은 audit_logs.created_at, fields 는 바뀐 필드 키. */
export interface InfoChangeEvent {
  at: string;
  fields: string[];
}

/** 배너에 관련된 audit_logs.action 값 (guard.server writeAudit 호출부에서 실측). */
const INFO_CHANGE_ACTIONS = ["참여자 수정", "정보 정정 요청 처리완료", "응답 필드 정정"];

/** 배너 노출 대상 기간 — 이보다 오래된 변경은 처음 접속한 사용자에게도 보여 주지 않는다. */
const INFO_CHANGE_LOOKBACK_MS = 30 * 86_400_000;

/**
 * 본인 participant 를 대상으로 한 최근 관리자 변경 이력.
 * audit_logs 는 RLS 상 응답자가 직접 읽을 수 없어 서버함수에서 supabaseAdmin 으로 읽되,
 * 대상 participant/response id 는 사용자 토큰 클라이언트(RLS)로 찾으므로 본인 것만 나온다.
 */
export const getMyInfoChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<InfoChangeEvent[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: participant }, { data: response }] = await Promise.all([
      context.supabase.from("participants").select("id").limit(1).maybeSingle(),
      context.supabase.from("responses").select("id").limit(1).maybeSingle(),
    ]);
    if (!participant) return [];

    // 세 기록 방식의 대상 표기가 제각각이다:
    //  참여자 수정 → target_id=participant / 정정요청 처리 → detail.participant_id / correctField → detail.response_id
    const ors = [
      `target_id.eq.${participant.id}`,
      `detail->>participant_id.eq.${participant.id}`,
      ...(response ? [`detail->>response_id.eq.${response.id}`] : []),
    ].join(",");

    const { data: logs, error } = await supabaseAdmin
      .from("audit_logs")
      .select("action, target_type, detail, created_at")
      .in("action", INFO_CHANGE_ACTIONS)
      .or(ors)
      .gte("created_at", new Date(Date.now() - INFO_CHANGE_LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return [];

    const events: InfoChangeEvent[] = [];
    for (const log of logs ?? []) {
      const detail = (log.detail ?? {}) as Record<string, unknown>;
      let fields: string[] = [];
      if (log.action === "참여자 수정") {
        fields = Object.keys((detail["changed"] as Record<string, unknown> | undefined) ?? {});
      } else if (log.action === "정보 정정 요청 처리완료") {
        fields = Array.isArray(detail["applied"]) ? (detail["applied"] as string[]) : [];
      } else if (log.action === "응답 필드 정정" && log.target_type === "responses") {
        // 과업·스킬 같은 응답 본문 정정은 충돌 다이얼로그가 다루므로 기본정보성 필드만 배너 대상.
        fields = typeof detail["field"] === "string" ? [detail["field"] as string] : [];
      }
      if (fields.length > 0) events.push({ at: log.created_at, fields });
    }
    return events;
  });

// ---------- 업무분장 사전 주입 (V8) ----------

/** 업무분장표에서 뽑은 과업 후보 하나 — 주요업무 1건 + 그에 딸린 세부업무들. */
export interface DutyTaskCandidate {
  task: string;
  activities: string[];
}

/**
 * 본인 소속 조직의 업무분장표 행을 과업 후보로 변환해 준다.
 * duty_charts·org_units 는 로그인 사용자 전원 조회 가능(RLS)이라 사용자 토큰으로 읽는다 —
 * participants 는 RLS 로 본인 행만 나오므로 남의 조직 분장은 애초에 조회되지 않는다.
 * ponytail: participants.org_unit_id 가 생성 types.ts 에 없어 untyped 캐스팅 — 재생성 시 제거.
 */
export const getMyDutyCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DutyTaskCandidate[]> => {
    const db = context.supabase as unknown as SupabaseClient;

    const { data: p } = await db
      .from("participants")
      .select("company_id, org_unit_id, org_text")
      .limit(1)
      .maybeSingle();
    if (!p) return [];

    let orgName = ((p.org_text as string | null) ?? "").trim();
    if (p.org_unit_id) {
      const { data: unit } = await db
        .from("org_units")
        .select("name")
        .eq("id", p.org_unit_id)
        .maybeSingle();
      if (unit?.name) orgName = (unit.name as string).trim();
    }
    if (!orgName) return [];

    const { data: charts } = await db
      .from("duty_charts")
      .select("rows")
      .eq("company_id", p.company_id)
      .eq("org_name", orgName)
      .order("uploaded_at", { ascending: false })
      .limit(1);
    const rows = (Array.isArray(charts?.[0]?.rows) ? charts[0].rows : []) as Record<
      string,
      string
    >[];
    if (rows.length === 0) return [];

    // 업로드 엑셀의 열 이름은 자유 형식 — 첫 행 헤더에서 주요업무/세부업무 열을 이름으로 찾는다.
    const keys = Object.keys(rows[0] ?? {});
    const taskKey =
      keys.find((k) => k.includes("주요업무")) ?? keys.find((k) => k.includes("과업")) ?? keys[0];
    const actKey = keys.find((k) => k.includes("세부"));
    if (!taskKey) return [];

    // 병합 셀 유래의 빈 주요업무 칸은 직전 과업의 세부업무 연속으로 본다.
    const byTask = new Map<string, string[]>();
    let current = "";
    for (const row of rows) {
      const task = (row[taskKey] ?? "").trim();
      if (task) current = task;
      if (!current) continue;
      if (!byTask.has(current)) byTask.set(current, []);
      const act = actKey ? (row[actKey] ?? "").trim() : "";
      if (act && !byTask.get(current)!.includes(act)) byTask.get(current)!.push(act);
    }

    return [...byTask.entries()].map(([task, activities]) => ({ task, activities }));
  });
