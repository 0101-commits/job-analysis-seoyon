import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { fetchAll } from "./paginate";

/** 직무별 응답 수 집계에 포함되는 상태 (초안·반려는 제외) */
const COUNTED_STATUSES = ["submitted", "approved"];

/** 관리자가 직접 정정할 수 있는 텍스트 필드 화이트리스트 */
const CORRECTABLE = {
  responses: [
    "job_group",
    "job_series",
    "job_name",
    "definition",
    "mission",
    "missed_note",
    "pain_note",
  ],
  response_tasks: ["name", "improve_note"],
  response_activities: ["name"],
  response_skills: ["name", "description"],
  response_requirements: ["majors_required", "majors_preferred", "trainings", "proficiency"],
} as const;

type CorrectableTable = keyof typeof CORRECTABLE;

const queueInput = z.object({
  companyId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "submitted", "rejected", "approved"]).nullable().optional(),
  jobName: z.string().trim().max(120).optional(),
  /** risk = 점검 결과가 나쁜 순, submitted = 제출 순(최근 먼저). 기본은 risk. */
  sort: z.enum(["risk", "submitted"]).optional(),
});

/* ── F16 점검 결과 (규칙 기반) ───────────────────────────────────
 *
 * 응답 500건을 컨설턴트 한 명이 본다. 제출 순으로 쌓이면 부실한 건이 목록 뒤에 묻히므로,
 * 규칙으로 위험도를 매겨 목록 정렬과 일괄 승인 후보 판정에 함께 쓴다.
 * AI 판정(ai.functions.ts)과 달리 여기 규칙은 결정적이라 같은 응답이면 항상 같은 답이 나온다.
 */

/** 등급 경계. 배지·일괄 승인 후보 판정이 같은 값을 본다. */
export const QUALITY_GOOD = 80;
export const QUALITY_FAIR = 60;

export type QualityGrade = "주의" | "보통" | "양호";

/** 점검하지 않은 응답은 등급이 없다(=모르는 것을 안다고 하지 않는다). */
export function qualityGrade(score: number | null | undefined): QualityGrade | null {
  if (score === null || score === undefined) return null;
  return score >= QUALITY_GOOD ? "양호" : score >= QUALITY_FAIR ? "보통" : "주의";
}

/** quality_flags(jsonb) 를 화면에서 쓸 문자열 배열로 되돌린다. */
export function qualityFlags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string") : [];
}

/** 비교용 정규화 — 띄어쓰기·문장부호 차이로 다른 문장처럼 보이는 것을 막는다. */
function normText(value: string) {
  return value.replace(/[\s.,·、()[\]{}「」『』"'`~!?:;/\\|+\-–—*]/g, "").toLowerCase();
}

function bigrams(value: string) {
  const out = new Set<string>();
  for (let i = 0; i + 1 < value.length; i++) out.add(value.slice(i, i + 2));
  return out;
}

/** 두 글자 묶음 겹침 비율(0~1). 어절 순서가 바뀌어도 베낀 문장을 잡아낸다. */
function overlap(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 예시 문구를 그대로 옮겼다고 볼 기준. 손으로 조금 고친 것까지 잡되 우연한 유사는 넘긴다. */
const PASTE_LIMIT = 0.75;
/** 같은 문장 반복으로 볼 기준. 예시 판정보다 엄격하게 본다. */
const DUP_LIMIT = 0.85;

export interface QualityInput {
  definition: string | null;
  mission: string | null;
  tasks: { name: string; activities: string[] }[];
  skillCount: number;
  requirementsEmpty: boolean;
}

/** 항목 종류별 예시 문구의 글자 묶음. 매번 다시 만들지 않도록 한 번 계산해 넘긴다. */
export type ExampleIndex = Record<string, Set<string>[]>;

function avgLength(values: string[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + normText(v).length, 0) / values.length;
}

/**
 * 한 응답의 점검 점수(0~100)와 주의 사유를 계산한다.
 * 사유 문구는 화면에 그대로 뜨므로 "무엇이 왜 위험한지"를 수치와 함께 적는다.
 */
export function scoreOne(
  input: QualityInput,
  examples: ExampleIndex,
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 100;
  const deduct = (points: number, reason: string) => {
    score -= points;
    flags.push(reason);
  };

  const taskNames = input.tasks.map((t) => t.name).filter((n) => n.trim().length > 0);
  const activityNames = input.tasks.flatMap((t) => t.activities).filter((n) => n.trim().length > 0);

  // 과업 수
  if (taskNames.length === 0) {
    deduct(60, "과업이 하나도 없습니다 — 내용 없는 제출입니다.");
  } else if (taskNames.length < 3) {
    deduct(20, `과업이 ${taskNames.length}개뿐입니다 (3개 이상 필요).`);
  } else if (taskNames.length > 12) {
    deduct(10, `과업이 ${taskNames.length}개로 너무 잘게 쪼개져 있습니다 (12개 이하 권장).`);
  }

  // 과업당 활동 수
  const thin = input.tasks.filter(
    (t) => t.name.trim().length > 0 && t.activities.filter((a) => a.trim()).length < 2,
  ).length;
  if (thin > 0) {
    deduct(
      Math.min(20, thin * 5),
      `세부 활동이 2개 미만인 과업이 ${thin}개입니다 (과업마다 2개 이상 필요).`,
    );
  }

  // 이름 길이 — 「보고서 작성」처럼 명사만 남긴 응답을 잡는다.
  const taskAvg = avgLength(taskNames);
  if (taskNames.length > 0 && taskAvg < 12) {
    deduct(
      15,
      `과업명이 평균 ${Math.round(taskAvg)}자로 짧습니다 (행위와 목적이 드러나야 합니다).`,
    );
  }
  const actAvg = avgLength(activityNames);
  if (activityNames.length > 0 && actAvg < 10) {
    deduct(10, `세부 활동명이 평균 ${Math.round(actAvg)}자로 짧습니다.`);
  }

  // 같은 문장 반복
  const all = [...taskNames, ...activityNames];
  const grams = all.map((v) => bigrams(normText(v)));
  let dup = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < i; j++) {
      if (overlap(grams[i]!, grams[j]!) >= DUP_LIMIT) {
        dup++;
        break;
      }
    }
  }
  if (all.length >= 4 && dup / all.length >= 0.2) {
    deduct(15, `과업·활동 ${all.length}개 중 ${dup}개가 다른 항목과 거의 같은 문장입니다.`);
  }

  // 예시 문구 그대로 붙여쓰기
  const pasted: string[] = [];
  const checkPaste = (field: string, values: string[]) => {
    const pool = examples[field] ?? [];
    if (pool.length === 0) return;
    for (const value of values) {
      const norm = normText(value);
      if (norm.length < 10) continue;
      const g = bigrams(norm);
      if (pool.some((p) => overlap(g, p) >= PASTE_LIMIT)) pasted.push(value);
    }
  };
  checkPaste("definition", input.definition ? [input.definition] : []);
  checkPaste("mission", input.mission ? [input.mission] : []);
  checkPaste("task", taskNames);
  checkPaste("activity", activityNames);
  if (pasted.length > 0) {
    deduct(
      Math.min(25, pasted.length * 10),
      `작성 예시 문구를 그대로 옮긴 항목이 ${pasted.length}개입니다 (예: ${pasted[0]!.slice(0, 20)}…).`,
    );
  }

  // 역량·자격요건
  if (input.skillCount === 0) {
    deduct(12, "필요 역량이 하나도 없습니다.");
  } else if (input.skillCount < 3) {
    deduct(8, `필요 역량이 ${input.skillCount}개뿐입니다 (3개 이상 권장).`);
  }
  if (input.requirementsEmpty) deduct(10, "자격요건이 전부 비어 있습니다.");

  // 정의·목적
  const defLen = normText(input.definition ?? "").length;
  if (defLen === 0) deduct(12, "직무 정의가 비어 있습니다.");
  else if (defLen < 20) deduct(8, `직무 정의가 ${defLen}자로 한 문장이 되지 않습니다.`);
  const misLen = normText(input.mission ?? "").length;
  if (misLen === 0) deduct(12, "직무 목적이 비어 있습니다.");
  else if (misLen < 20) deduct(8, `직무 목적이 ${misLen}자로 한 문장이 되지 않습니다.`);

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags };
}

/** 직무명 → 응답 수 (제출·승인 기준). 회사 스코프가 있으면 그 안에서만 센다. */
async function jobCounts(
  admin: SupabaseClient<Database>,
  companyId: string | null,
): Promise<Record<string, number>> {
  // 1인 응답 직무 표시(신뢰도 배지)에 쓰이므로 1000행 상한에 잘리면 안 된다. 전량 조회한다.
  const rows = await fetchAll<{ job_name: string | null }>((from, to) => {
    let q = admin
      .from("responses")
      .select("job_name")
      .in("status", COUNTED_STATUSES)
      .range(from, to);
    if (companyId) q = q.eq("company_id", companyId);
    return q;
  });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.job_name) counts[row.job_name] = (counts[row.job_name] ?? 0) + 1;
  }
  return counts;
}

/** 검수 큐 목록 쿼리 한 페이지. 반환 타입이 QueueRow 추론의 원천이기도 하다. */
function queuePage(
  admin: SupabaseClient<Database>,
  filters: z.infer<typeof queueInput>,
  from: number,
  to: number,
) {
  let q = admin
    .from("responses")
    .select(
      "id, job_group, job_series, job_name, status, submitted_at, updated_at, company_id, quality_score, quality_flags, quality_checked_at, companies(name), participants(name, emp_no, org_text, grade, role_level, account_status)",
    )
    // submitted_at 은 중복될 수 있다. id 를 덧붙여야 페이지 경계에서 행이 새거나 겹치지 않는다.
    .order("submitted_at", { ascending: false })
    .order("id")
    .range(from, to);
  if (filters.companyId) q = q.eq("company_id", filters.companyId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.jobName) q = q.ilike("job_name", `%${filters.jobName}%`);
  return q;
}

type QueueRow = NonNullable<Awaited<ReturnType<typeof queuePage>>["data"]>[number];

export const listReviewQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => queueInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const companyId = data.companyId ?? null;

    const rows = await fetchAll<QueueRow>((from, to) =>
      queuePage(supabaseAdmin, { ...data, companyId }, from, to),
    );

    const counts = await jobCounts(supabaseAdmin, companyId);

    const withQuality = rows.map((r) => ({
      ...r,
      jobCount: r.job_name ? (counts[r.job_name] ?? 0) : 0,
      grade: qualityGrade(r.quality_score),
      flags: qualityFlags(r.quality_flags),
    }));

    // 기본은 위험 높은 순. 점검하지 않은 건은 위험을 모르므로 점검된 건 뒤에 두고,
    // 같은 점수끼리는 오래 기다린 건을 먼저 보여준다.
    if ((data.sort ?? "risk") === "risk") {
      withQuality.sort((a, b) => {
        const sa = a.quality_score ?? Number.POSITIVE_INFINITY;
        const sb = b.quality_score ?? Number.POSITIVE_INFINITY;
        if (sa !== sb) return sa - sb;
        return Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? "") || 0;
      });
    }

    const unchecked = withQuality.filter((r) => r.quality_checked_at === null).length;

    return {
      rows: withQuality,
      /** 아직 점검하지 않은 건수 — 화면에서 "점검 실행" 을 권할 근거. */
      unchecked,
    };
  });

export const getResponseDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin
      .from("responses")
      .select(
        "*, companies(name), participants(id, name, emp_no, email, org_text, grade, role_level, account_status), response_tasks(*, response_activities(*)), response_skills(*), response_requirements(*), review_comments(*)",
      )
      .eq("id", data.responseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("응답을 찾을 수 없습니다.");

    // 중첩 임베드는 정렬을 보장하지 않으므로 여기서 맞춘다.
    const tasks = [...row.response_tasks]
      .sort((a, b) => a.seq - b.seq)
      .map((t) => ({
        ...t,
        response_activities: [...t.response_activities].sort((a, b) => a.seq - b.seq),
      }));
    const comments = [...row.review_comments].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );

    const counts = await jobCounts(supabaseAdmin, row.company_id);
    const aiDraftSkills = row.response_skills.filter((s) => s.ai_draft).length;

    return {
      response: {
        ...row,
        response_tasks: tasks,
        review_comments: comments,
      },
      quality: {
        score: row.quality_score,
        grade: qualityGrade(row.quality_score),
        flags: qualityFlags(row.quality_flags),
        checkedAt: row.quality_checked_at,
      },
      aiDraft: {
        skills: aiDraftSkills,
        requirements: row.response_requirements?.ai_draft ?? false,
        any: aiDraftSkills > 0 || (row.response_requirements?.ai_draft ?? false),
      },
      jobCount: row.job_name ? (counts[row.job_name] ?? 0) : 0,
    };
  });

/** V15-1 재제출 스냅샷 — 목록(seq, created_at)을 반환하고, seq 를 주면 그 시점 payload 도 함께 반환. */
export const getSubmissionSnapshots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ responseId: z.string().uuid(), seq: z.number().int().min(1).optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // ponytail: submission_snapshots 가 생성 types.ts 에 아직 없어 untyped 캐스팅 — 재생성 시 제거.
    const db = supabaseAdmin as unknown as { from: (t: string) => any };

    const { data: list, error } = await db
      .from("submission_snapshots")
      .select("seq, created_at")
      .eq("response_id", data.responseId)
      .order("seq");
    if (error) throw new Error(error.message);

    let payload: Json | null = null;
    if (data.seq !== undefined) {
      const { data: row, error: payloadError } = await db
        .from("submission_snapshots")
        .select("payload")
        .eq("response_id", data.responseId)
        .eq("seq", data.seq)
        .maybeSingle();
      if (payloadError) throw new Error(payloadError.message);
      payload = (row?.payload ?? null) as Json | null;
    }

    return { list: (list ?? []) as { seq: number; created_at: string }[], payload };
  });

/** 승인 대상 한 건의 요약 — 게이트 판정에 필요한 최소 정보. */
interface ApprovalRow {
  id: string;
  participant_id: string;
  company_id: string;
  job_name: string | null;
  status: string;
}

type GateResult = { ok: true; jobCount: number } | { ok: false; reason: string; jobCount: number };

/**
 * 승인 게이트 — 개별 승인과 일괄 승인이 반드시 같은 판정을 쓴다.
 * 게이트를 두 곳에 적으면 일괄 승인이 개별 승인보다 느슨해져 게이트 자체가 무의미해진다.
 *
 * ① 확정되지 않은 AI 초안이 남아 있으면 막는다.
 * ② 내용 없는 제출(과업 0건)은 막는다.
 */
async function approvalGate(
  admin: SupabaseClient<Database>,
  row: ApprovalRow,
  counts: Record<string, number>,
): Promise<GateResult> {
  const jobCount = row.job_name ? (counts[row.job_name] ?? 0) : 0;

  const { count: draftSkills } = await admin
    .from("response_skills")
    .select("id", { count: "exact", head: true })
    .eq("response_id", row.id)
    .eq("ai_draft", true);
  const { data: req } = await admin
    .from("response_requirements")
    .select("ai_draft")
    .eq("response_id", row.id)
    .maybeSingle();
  if ((draftSkills ?? 0) > 0 || req?.ai_draft) {
    return {
      ok: false,
      jobCount,
      reason:
        "확정되지 않은 AI 초안 항목이 남아 있습니다. 응답자 확인 또는 정정 후 승인할 수 있습니다.",
    };
  }

  const { count: taskCount } = await admin
    .from("response_tasks")
    .select("id", { count: "exact", head: true })
    .eq("response_id", row.id);
  if ((taskCount ?? 0) === 0) {
    return {
      ok: false,
      jobCount,
      reason: "과업이 하나도 없는 제출입니다. 반려해 다시 작성받아야 합니다.",
    };
  }

  return { ok: true, jobCount };
}

export const approveResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, company_id, job_name, status")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!row) throw new Error("응답을 찾을 수 없습니다.");
    if (row.status === "draft") throw new Error("아직 제출되지 않은 응답입니다.");

    const counts = await jobCounts(supabaseAdmin, row.company_id);
    const gate = await approvalGate(supabaseAdmin, row, counts);
    if (!gate.ok) {
      return { ok: false as const, reason: gate.reason };
    }
    await markApproved(supabaseAdmin, row, context.userId, gate.jobCount, false);

    return { ok: true as const, reason: null };
  });

/** 승인 확정 — 개별 승인과 일괄 승인이 같은 기록(상태·참여자 상태·감사 이력)을 남긴다. */
async function markApproved(
  admin: SupabaseClient<Database>,
  row: ApprovalRow,
  userId: string,
  jobCount: number,
  bulk: boolean,
) {
  const { writeAudit } = await import("@/lib/guard.server");
  const { error } = await admin
    .from("responses")
    .update({
      status: "approved",
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);

  await admin.from("participants").update({ account_status: "승인" }).eq("id", row.participant_id);

  await writeAudit(admin, {
    actor_id: userId,
    action: "응답 승인",
    target_type: "response",
    target_id: row.id,
    detail: { job_name: row.job_name, job_count: jobCount, ...(bulk ? { bulk: true } : {}) },
  });
}

export const rejectResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
        step: z.number().int().min(1).max(6).nullable().optional(),
        comment: z.string().trim().min(1, "반려 사유를 입력하세요.").max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, job_name, status")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!row) throw new Error("응답을 찾을 수 없습니다.");
    if (row.status === "draft") throw new Error("아직 제출되지 않은 응답입니다.");

    const { error: commentError } = await supabaseAdmin.from("review_comments").insert({
      response_id: row.id,
      author_id: context.userId,
      step: data.step ?? null,
      body: data.comment,
      kind: "reject",
    });
    if (commentError) throw new Error(commentError.message);

    const { error } = await supabaseAdmin
      .from("responses")
      .update({
        status: "rejected",
        ...(data.step ? { current_step: data.step } : {}),
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("participants")
      .update({ account_status: "반려" })
      .eq("id", row.participant_id);

    // TODO(P1 메일 인프라 연동): 반려 시 응답자에게 사유 메일 발송 — 이번 범위 밖.

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 반려",
      target_type: "response",
      target_id: row.id,
      detail: { step: data.step ?? null, job_name: row.job_name },
    });

    return { ok: true };
  });

export const correctField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: z.string().uuid(),
        table: z.enum([
          "responses",
          "response_tasks",
          "response_activities",
          "response_skills",
          "response_requirements",
        ]),
        id: z.string().uuid(),
        field: z.string().min(1).max(60),
        value: z.string().max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit, touchResponse } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const table = data.table as CorrectableTable;
    if (!(CORRECTABLE[table] as readonly string[]).includes(data.field)) {
      throw new Error("정정할 수 없는 항목입니다.");
    }

    // 테이블명이 런타임 값이라 제네릭 타입 추론이 불가능하다. 이 함수 안에서만 스키마 타입을 벗긴다.
    const db = supabaseAdmin as unknown as {
      from: (t: string) => any;
    };

    // 대상 행이 정말 이 응답에 속하는지 확인 (다른 응답 데이터 오염 방지)
    if (table === "responses") {
      if (data.id !== data.responseId) throw new Error("대상 응답이 일치하지 않습니다.");
    } else if (table === "response_activities") {
      const { data: act } = await supabaseAdmin
        .from("response_activities")
        .select("task_id")
        .eq("id", data.id)
        .maybeSingle();
      const { data: task } = act
        ? await supabaseAdmin
            .from("response_tasks")
            .select("response_id")
            .eq("id", act.task_id)
            .maybeSingle()
        : { data: null };
      if (!task || task.response_id !== data.responseId) {
        throw new Error("대상 응답이 일치하지 않습니다.");
      }
    } else {
      const { data: owner } = await db
        .from(table)
        .select("response_id")
        .eq("id", data.id)
        .maybeSingle();
      if (!owner || owner.response_id !== data.responseId) {
        throw new Error("대상 응답이 일치하지 않습니다.");
      }
    }

    const { data: before } = await db
      .from(table)
      .select(data.field)
      .eq("id", data.id)
      .maybeSingle();
    const previous: string = before?.[data.field] ?? "";
    if (previous === data.value) return { ok: true, changed: false };

    // 이력 먼저 남기고 수정한다 (수정 성공 후 이력 실패 시 근거가 사라지는 것을 피함).
    const { error: logError } = await supabaseAdmin.from("review_comments").insert({
      response_id: data.responseId,
      author_id: context.userId,
      body: `[정정] ${table}.${data.field}\n이전: ${previous || "(비어 있음)"}\n이후: ${data.value || "(비어 있음)"}`,
      kind: "correction",
    });
    if (logError) throw new Error(logError.message);

    // 관리자가 손본 값은 더 이상 AI 초안이 아니다(승인 게이트 통과 조건).
    const patch: Record<string, unknown> = { [data.field]: data.value };
    if (table === "response_skills" || table === "response_requirements") {
      patch["ai_draft"] = false;
    }

    const { error } = await db.from(table).update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);

    // 자식 테이블 정정은 responses.updated_at 트리거를 안 태운다. 부모를 밀어야
    // 참여자의 다음 저장(save_*_tx 낙관적 락)이 이 정정과의 충돌을 감지한다.
    if (table !== "responses") await touchResponse(supabaseAdmin, data.responseId);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 필드 정정",
      target_type: table,
      target_id: data.id,
      detail: { response_id: data.responseId, field: data.field },
    });

    return { ok: true, changed: true };
  });

/** 정정 요청을 관리자가 participants 에 바로 반영할 수 있는 컬럼. 사번·회사는 반영 대상이 아니다. */
const APPLICABLE_INFO_FIELDS = ["name", "email", "org_text", "grade", "role_level"] as const;

interface InfoChangeField {
  field: string;
  current: string;
  requested: string;
}

export const listInfoRequests = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["요청", "처리완료", "반려"]).nullable().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = supabaseAdmin
      .from("info_change_requests")
      .select(
        "id, fields, note, status, admin_note, handled_at, created_at, participants(id, name, emp_no, companies(name))",
      )
      .order("created_at", { ascending: false });
    if (data.status) q = q.eq("status", data.status);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const { count } = await supabaseAdmin
      .from("info_change_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "요청");

    return { rows: rows ?? [], pending: count ?? 0 };
  });

export const handleInfoRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum(["처리완료", "반려"]),
        adminNote: z.string().trim().max(2000).optional(),
        apply: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("info_change_requests")
      .select("id, participant_id, fields, status")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("정정 요청을 찾을 수 없습니다.");
    if (row.status !== "요청") throw new Error("이미 처리된 요청입니다.");

    const applied: string[] = [];
    if (data.apply && data.action === "처리완료") {
      const fields = (row.fields ?? []) as unknown as InfoChangeField[];
      const patch: Record<string, string> = {};
      for (const f of Array.isArray(fields) ? fields : []) {
        if (!(APPLICABLE_INFO_FIELDS as readonly string[]).includes(f.field)) continue;
        // 빈 값 요청은 반영하지 않는다 — 성명처럼 NOT NULL 인 칸을 지워 버릴 수 있다.
        const value = (f.requested ?? "").trim();
        if (!value) continue;
        if (f.field === "email" && !z.string().email().safeParse(value).success) {
          throw new Error("요청된 이메일 형식이 올바르지 않습니다.");
        }
        patch[f.field] = value;
        applied.push(f.field);
      }
      if (applied.length > 0) {
        const { error } = await supabaseAdmin
          .from("participants")
          .update(patch as Database["public"]["Tables"]["participants"]["Update"])
          .eq("id", row.participant_id);
        if (error) throw new Error(error.message);
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from("info_change_requests")
      .update({
        status: data.action,
        admin_note: data.adminNote?.trim() || null,
        handled_by: context.userId,
        handled_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: `정보 정정 요청 ${data.action}`,
      target_type: "info_change_request",
      target_id: row.id,
      detail: { participant_id: row.participant_id, applied },
    });

    return { ok: true, applied };
  });

/* ── F16 점검 실행 · 일괄 승인 ───────────────────────────────── */

/** 자식 테이블 전량 조회. id 를 100개씩 끊어 넘긴다(긴 in() 주소로 요청이 깨지는 것을 피함). */
async function fetchChunked<T>(
  ids: string[],
  page: (
    slice: string[],
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    out.push(...(await fetchAll<T>((from, to) => page(slice, from, to))));
  }
  return out;
}

/** 작성 예시 문구를 항목 종류별로 모아 글자 묶음으로 만든다(붙여쓰기 판정용). */
async function loadExampleIndex(admin: SupabaseClient<Database>): Promise<ExampleIndex> {
  const { data } = await admin.from("example_library").select("field, good_example");
  const index: ExampleIndex = {};
  for (const row of data ?? []) {
    const norm = normText(row.good_example);
    if (norm.length < 10) continue;
    (index[row.field] ??= []).push(bigrams(norm));
  }
  return index;
}

/**
 * 규칙 점검을 돌려 responses.quality_score / quality_flags / quality_checked_at 을 채운다.
 * 응답자 경로에서는 이 값을 손댈 수 없다(guard_response_update 트리거).
 *
 * 대상: responseIds 를 주면 그 건들, 없으면 (회사 범위의) 작성중이 아닌 응답 전체.
 */
export const scoreResponses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseIds: z.array(z.string().uuid()).max(1000).optional(),
        companyId: z.string().uuid().nullable().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const targets = data.responseIds ?? null;
    const responses = await fetchAll<{
      id: string;
      definition: string | null;
      mission: string | null;
    }>((from, to) => {
      let q = supabaseAdmin
        .from("responses")
        .select("id, definition, mission")
        .neq("status", "draft")
        .order("id")
        .range(from, to);
      if (targets) q = q.in("id", targets);
      else if (data.companyId) q = q.eq("company_id", data.companyId);
      return q;
    });
    if (responses.length === 0) return { checked: 0, summary: { 주의: 0, 보통: 0, 양호: 0 } };

    const ids = responses.map((r) => r.id);
    const tasks = await fetchChunked<{ id: string; response_id: string; name: string }>(
      ids,
      (slice, from, to) =>
        supabaseAdmin
          .from("response_tasks")
          .select("id, response_id, name")
          .in("response_id", slice)
          .order("id")
          .range(from, to),
    );
    const activities = await fetchChunked<{ task_id: string; name: string }>(
      tasks.map((t) => t.id),
      (slice, from, to) =>
        supabaseAdmin
          .from("response_activities")
          .select("task_id, name")
          .in("task_id", slice)
          .order("id")
          .range(from, to),
    );
    const skills = await fetchChunked<{ response_id: string }>(ids, (slice, from, to) =>
      supabaseAdmin
        .from("response_skills")
        .select("response_id")
        .in("response_id", slice)
        .order("id")
        .range(from, to),
    );
    const requirements = await fetchChunked<{
      response_id: string;
      education: string | null;
      proficiency: string | null;
      majors_required: string | null;
      majors_preferred: string | null;
      trainings: string | null;
      licenses: Json;
      languages: Json;
    }>(ids, (slice, from, to) =>
      supabaseAdmin
        .from("response_requirements")
        .select(
          "response_id, education, proficiency, majors_required, majors_preferred, trainings, licenses, languages",
        )
        .in("response_id", slice)
        .order("response_id")
        .range(from, to),
    );

    const actByTask = new Map<string, string[]>();
    for (const a of activities) {
      const list = actByTask.get(a.task_id) ?? [];
      list.push(a.name);
      actByTask.set(a.task_id, list);
    }
    const tasksByResponse = new Map<string, { name: string; activities: string[] }[]>();
    for (const t of tasks) {
      const list = tasksByResponse.get(t.response_id) ?? [];
      list.push({ name: t.name, activities: actByTask.get(t.id) ?? [] });
      tasksByResponse.set(t.response_id, list);
    }
    const skillCount = new Map<string, number>();
    for (const s of skills) skillCount.set(s.response_id, (skillCount.get(s.response_id) ?? 0) + 1);
    const reqByResponse = new Map(requirements.map((q) => [q.response_id, q]));

    const examples = await loadExampleIndex(supabaseAdmin);
    const checkedAt = new Date().toISOString();
    const summary = { 주의: 0, 보통: 0, 양호: 0 };

    const results = responses.map((r) => {
      const req = reqByResponse.get(r.id);
      const requirementsEmpty =
        !req ||
        (!req.education?.trim() &&
          !req.proficiency?.trim() &&
          !req.majors_required?.trim() &&
          !req.majors_preferred?.trim() &&
          !req.trainings?.trim() &&
          (Array.isArray(req.licenses) ? req.licenses.length === 0 : true) &&
          (Array.isArray(req.languages) ? req.languages.length === 0 : true));

      const { score, flags } = scoreOne(
        {
          definition: r.definition,
          mission: r.mission,
          tasks: tasksByResponse.get(r.id) ?? [],
          skillCount: skillCount.get(r.id) ?? 0,
          requirementsEmpty,
        },
        examples,
      );
      const grade = qualityGrade(score);
      if (grade) summary[grade] += 1;
      return { id: r.id, score, flags };
    });

    // 행마다 사유가 달라 한 번에 묶어 쓸 수 없다. 20건씩 나눠 쓴다.
    for (let i = 0; i < results.length; i += 20) {
      await Promise.all(
        results.slice(i, i + 20).map((r) =>
          supabaseAdmin
            .from("responses")
            .update({
              quality_score: r.score,
              quality_flags: r.flags as unknown as Json,
              quality_checked_at: checkedAt,
            })
            .eq("id", r.id),
        ),
      );
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 점검 실행",
      detail: { count: results.length, company_id: data.companyId ?? null, ...summary },
    });

    return { checked: results.length, summary };
  });

/**
 * 양호 등급 여러 건을 한 번에 승인한다.
 * 게이트는 건마다 개별 승인과 똑같이 적용하고, 걸린 건은 승인하지 않고 사유를 돌려준다.
 */
export const bulkApproveResponses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ responseIds: z.array(z.string().uuid()).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await supabaseAdmin
      .from("responses")
      .select("id, participant_id, company_id, job_name, status, participants(name)")
      .in("id", data.responseIds);
    if (error) throw new Error(error.message);

    // 회사별 직무 응답 수는 한 번만 센다(건마다 전량 조회하면 500건에서 못 쓴다).
    const countsByCompany = new Map<string, Record<string, number>>();
    const approved: string[] = [];
    const skipped: { responseId: string; name: string; jobName: string; reason: string }[] = [];

    for (const row of rows ?? []) {
      const name = row.participants?.name ?? "";
      const jobName = row.job_name ?? "직무 미입력";
      if (row.status === "draft") {
        skipped.push({
          responseId: row.id,
          name,
          jobName,
          reason: "아직 제출되지 않은 응답입니다.",
        });
        continue;
      }
      if (row.status === "approved") {
        skipped.push({ responseId: row.id, name, jobName, reason: "이미 승인된 응답입니다." });
        continue;
      }
      let counts = countsByCompany.get(row.company_id);
      if (!counts) {
        counts = await jobCounts(supabaseAdmin, row.company_id);
        countsByCompany.set(row.company_id, counts);
      }
      const gate = await approvalGate(supabaseAdmin, row, counts);
      if (!gate.ok) {
        skipped.push({ responseId: row.id, name, jobName, reason: gate.reason });
        continue;
      }
      await markApproved(supabaseAdmin, row, context.userId, gate.jobCount, true);
      approved.push(row.id);
    }

    return { approved, skipped };
  });
