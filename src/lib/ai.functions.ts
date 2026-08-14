import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type Admin = SupabaseClient<Database>;

// target 표기 규칙: "테이블:id:필드"
//   - responses / response_tasks / response_activities / response_skills → id 는 해당 레코드 id
//   - response_requirements → 1:1 테이블이라 id 자리에 response_id 를 넣고 upsert 로 반영
//   - "response_skills:new" → suggested_value 가 JSON 인 신규 스킬 초안(자동 채움)
const APPLY_FIELDS: Record<string, string[]> = {
  responses: [
    "job_name",
    "job_group",
    "job_series",
    "definition",
    "mission",
    "missed_note",
    "pain_note",
  ],
  response_tasks: ["name", "improve_note"],
  response_activities: ["name"],
  response_skills: ["name", "description"],
  response_requirements: ["majors_required", "majors_preferred", "trainings", "proficiency"],
};

const uuid = z.string().uuid();
const optionalCompany = z.string().uuid().nullable().optional();

type TextItem = { target: string; label: string; text: string };

/** 응답 한 건의 텍스트 필드를 target 표기와 함께 모아온다. */
async function collectResponseText(db: Admin, responseId: string) {
  const { data: response } = await db
    .from("responses")
    .select("id, job_name, definition, mission, missed_note, pain_note")
    .eq("id", responseId)
    .maybeSingle();
  if (!response) throw new Error("응답을 찾을 수 없습니다.");

  const { data: tasks } = await db
    .from("response_tasks")
    .select("id, seq, name, improve_note")
    .eq("response_id", responseId)
    .order("seq");
  const taskRows = tasks ?? [];

  const { data: activities } = await db
    .from("response_activities")
    .select("id, task_id, seq, name")
    .in(
      "task_id",
      taskRows.map((t) => t.id),
    )
    .order("seq");
  const activityRows = activities ?? [];

  const { data: skills } = await db
    .from("response_skills")
    .select("id, name, ksao, hard_soft, description")
    .eq("response_id", responseId);
  const skillRows = skills ?? [];

  const r = response;
  const items: TextItem[] = [];
  const push = (target: string, label: string, text: string | null) => {
    if (text && text.trim().length > 1) items.push({ target, label, text });
  };

  push(`responses:${responseId}:job_name`, "직무명", r.job_name);
  push(`responses:${responseId}:definition`, "직무 정의", r.definition);
  push(`responses:${responseId}:mission`, "직무 미션", r.mission);
  push(`responses:${responseId}:missed_note`, "누락 업무 메모", r.missed_note);
  push(`responses:${responseId}:pain_note`, "애로사항", r.pain_note);
  for (const t of taskRows) {
    push(`response_tasks:${t.id}:name`, `과업 ${t.seq + 1}`, t.name);
    push(`response_tasks:${t.id}:improve_note`, `과업 ${t.seq + 1} 개선의견`, t.improve_note);
  }
  for (const a of activityRows) {
    const parent = taskRows.find((t) => t.id === a.task_id);
    push(
      `response_activities:${a.id}:name`,
      `과업 ${(parent?.seq ?? 0) + 1} 활동 ${a.seq + 1}`,
      a.name,
    );
  }
  for (const s of skillRows) {
    push(`response_skills:${s.id}:name`, "스킬명", s.name);
    push(`response_skills:${s.id}:description`, `스킬 설명(${s.name})`, s.description);
  }

  return { response: r, taskRows, activityRows, skillRows, items };
}

export const aiProxyStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { isProxyConfigured, proxyUrl } = await import("@/lib/llm.server");
    return { configured: isProxyConfigured(), url: proxyUrl() };
  });

export const listSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        responseId: uuid.optional(),
        status: z.string().optional(),
        kind: z.string().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("ai_suggestions")
      .select(
        "id, response_id, target, original_value, suggested_value, kind, route, status, respondent_note, decided_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.responseId) query = query.eq("response_id", data.responseId);
    if (data.status) query = query.eq("status", data.status);
    if (data.kind) query = query.eq("kind", data.kind);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const scanTypos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");

    const { items } = await collectResponseText(supabaseAdmin, data.responseId);
    if (items.length === 0) return { inserted: 0, suggestions: [] };

    const found = await callLLMJson<
      { target: string; original: string; suggested: string; reason: string }[]
    >({
      system:
        "너는 한국어 직무기술서를 교정하는 편집자다. 오탈자, 띄어쓰기 오류, 비문, 사내 용어 불일치(예: 「고객社」/「고객사」 혼용)만 지적한다. " +
        "내용을 새로 쓰거나 문장을 풍부하게 만들지 말고, 명백히 틀린 부분만 최소 수정한다. 문제가 없으면 빈 배열을 반환한다.",
      user:
        "다음 항목들을 검수하라. 각 항목은 target(식별자), label(항목명), text(원문)이다.\n" +
        `${JSON.stringify(items, null, 0)}\n\n` +
        'JSON만 출력한다. 형식: [{"target":"원문의 target 값 그대로","original":"고칠 원문 전체","suggested":"수정한 원문 전체","reason":"한 문장 사유"}]',
      maxTokens: 2048,
    });

    const byTarget = new Map(items.map((i) => [i.target, i]));
    const rows = (Array.isArray(found) ? found : [])
      .filter((f) => byTarget.has(f.target) && f.suggested && f.suggested !== f.original)
      .map((f) => ({
        response_id: data.responseId,
        target: f.target,
        original_value: byTarget.get(f.target)?.text ?? f.original,
        suggested_value: f.suggested,
        kind: "오타",
        route: "A",
        status: "제안",
      }));

    if (rows.length === 0) return { inserted: 0, suggestions: [] };

    const { data: inserted, error } = await supabaseAdmin
      .from("ai_suggestions")
      .insert(rows)
      .select("id, target, original_value, suggested_value, kind, route, status");
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 오탈자 검수",
      target_type: "response",
      target_id: data.responseId,
      detail: { count: rows.length },
    });

    return { inserted: rows.length, suggestions: inserted ?? [] };
  });

export const detectPoorResponses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: optionalCompany }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");

    let q = supabaseAdmin
      .from("responses")
      .select("id, job_name, definition, mission, participants(name)")
      .eq("status", "submitted")
      .order("submitted_at", { ascending: true })
      .limit(30);
    if (data.companyId) q = q.eq("company_id", data.companyId);
    const { data: responses, error } = await q;
    if (error) throw new Error(error.message);
    if (!responses || responses.length === 0) return { candidates: [], scanned: 0 };

    const ids = responses.map((r) => r.id);
    const { data: tasks } = await supabaseAdmin
      .from("response_tasks")
      .select("id, response_id, seq, name")
      .in("response_id", ids)
      .order("seq");
    const taskRows = tasks ?? [];
    const { data: activities } = await supabaseAdmin
      .from("response_activities")
      .select("task_id, name")
      .in(
        "task_id",
        taskRows.map((t) => t.id),
      );

    const payload = responses.map((r) => ({
      responseId: r.id,
      jobName: r.job_name,
      definition: r.definition,
      mission: r.mission,
      tasks: taskRows
        .filter((t) => t.response_id === r.id)
        .map((t) => ({
          name: t.name,
          activities: (activities ?? []).filter((a) => a.task_id === t.id).map((a) => a.name),
        })),
    }));

    const verdicts = await callLLMJson<
      { responseId: string; issues: string[]; rejectDraft: string }[]
    >({
      system:
        "너는 직무조사 응답의 품질을 판정하는 심사자다. 부실 판정 기준: " +
        "①과업명이 명사 한 단어뿐이거나 「업무」「관리」처럼 내용이 없다 ②활동이 과업명과 사실상 같거나 서로 중복된다 " +
        "③직무 정의·미션이 비었거나 한 줄 상투어다 ④과업이 3개 미만이다 ⑤복사·붙여넣기로 보이는 반복 문구가 있다. " +
        "기준에 걸리지 않는 응답은 결과에 포함하지 않는다.",
      user:
        `${JSON.stringify(payload)}\n\n` +
        'JSON만 출력한다. 형식: [{"responseId":"...","issues":["근거 한 문장"],"rejectDraft":"응답자에게 보낼 반려 사유 초안(존댓말 2~3문장, 무엇을 어떻게 고쳐야 하는지 구체적으로)"}]',
      maxTokens: 2048,
    });

    const byId = new Map(responses.map((r) => [r.id, r]));
    const candidates = (Array.isArray(verdicts) ? verdicts : [])
      .filter((v) => byId.has(v.responseId))
      .map((v) => {
        const r = byId.get(v.responseId)!;
        return {
          responseId: v.responseId,
          name: r.participants?.name ?? "",
          jobName: r.job_name ?? "",
          issues: Array.isArray(v.issues) ? v.issues : [],
          rejectDraft: v.rejectDraft ?? "",
        };
      });

    return { candidates, scanned: responses.length };
  });

export const draftMissingFields = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ responseId: uuid, target: z.enum(["skills", "requirements"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");

    const { response, taskRows, activityRows, skillRows } = await collectResponseText(
      supabaseAdmin,
      data.responseId,
    );
    const jobContext = {
      jobName: response.job_name,
      definition: response.definition,
      mission: response.mission,
      tasks: taskRows.map((t) => ({
        name: t.name,
        activities: activityRows.filter((a) => a.task_id === t.id).map((a) => a.name),
      })),
    };

    let rows: {
      response_id: string;
      target: string;
      original_value: string | null;
      suggested_value: string;
      kind: string;
      route: string;
      status: string;
    }[];

    if (data.target === "skills") {
      const drafts = await callLLMJson<
        { name: string; ksao: string; hard_soft: string; description: string }[]
      >({
        system:
          "너는 직무분석 컨설턴트다. 과업·활동 맥락에서 실제로 필요한 스킬만 도출한다. " +
          "스킬명은 도구 이름이 아니라 「무엇을 판단·수행할 수 있는 능력」으로 쓰고, 설명은 한 문장으로 적는다. 최대 5개.",
        user:
          `직무 맥락: ${JSON.stringify(jobContext)}\n` +
          `이미 등록된 스킬(중복 금지): ${JSON.stringify(skillRows.map((s) => s.name))}\n\n` +
          'JSON만 출력한다. 형식: [{"name":"스킬명","ksao":"K|S|A","hard_soft":"Hard|Soft","description":"한 문장 설명"}]',
        maxTokens: 1500,
      });

      rows = (Array.isArray(drafts) ? drafts : [])
        .filter((d) => d.name && !skillRows.some((s) => s.name === d.name))
        .map((d) => ({
          response_id: data.responseId,
          target: "response_skills:new",
          original_value: null,
          suggested_value: JSON.stringify({
            name: d.name,
            ksao: ["K", "S", "A"].includes(d.ksao) ? d.ksao : null,
            hard_soft: ["Hard", "Soft"].includes(d.hard_soft) ? d.hard_soft : null,
            description: d.description ?? null,
          }),
          kind: "자동채움",
          route: "B",
          status: "제안",
        }));
    } else {
      const { data: req } = await supabaseAdmin
        .from("response_requirements")
        .select("majors_required, majors_preferred, trainings, proficiency")
        .eq("response_id", data.responseId)
        .maybeSingle();
      const current = (req ?? {}) as Record<string, string | null>;
      const missing = APPLY_FIELDS["response_requirements"]!.filter(
        (f) => !current[f] || current[f]!.trim() === "",
      );
      if (missing.length === 0) return { inserted: 0, suggestions: [] };

      const drafts = await callLLMJson<Record<string, string>>({
        system:
          "너는 직무분석 컨설턴트다. 과업·활동 맥락에서 이 직무의 자격요건 초안을 작성한다. 추측이 과한 항목은 빈 문자열로 남긴다.",
        user:
          `직무 맥락: ${JSON.stringify(jobContext)}\n` +
          `작성할 항목: ${JSON.stringify(missing)}\n` +
          "항목 뜻 — majors_required: 필수 전공, majors_preferred: 우대 전공, trainings: 필요 교육·훈련, proficiency: 숙련까지 필요한 경력 수준\n\n" +
          'JSON만 출력한다. 형식: {"항목키":"초안 문장"}',
        maxTokens: 1200,
      });

      rows = missing
        .filter((f) => typeof drafts?.[f] === "string" && drafts[f]!.trim() !== "")
        .map((f) => ({
          response_id: data.responseId,
          // 1:1 테이블이므로 id 자리에 response_id 를 넣는다(applySuggestion 에서 upsert).
          target: `response_requirements:${data.responseId}:${f}`,
          original_value: current[f] ?? null,
          suggested_value: drafts[f]!.trim(),
          kind: "자동채움",
          route: "B",
          status: "제안",
        }));
    }

    if (rows.length === 0) return { inserted: 0, suggestions: [] };

    const { data: inserted, error } = await supabaseAdmin
      .from("ai_suggestions")
      .insert(rows)
      .select("id, target, original_value, suggested_value, kind, route, status");
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 결측 필드 초안 생성",
      target_type: "response",
      target_id: data.responseId,
      detail: { target: data.target, count: rows.length },
    });

    return { inserted: rows.length, suggestions: inserted ?? [] };
  });

export const suggestMerges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: optionalCompany,
        field: z.enum(["job_name", "skill_name"]).default("job_name"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");

    let names: string[] = [];
    if (data.field === "job_name") {
      let q = supabaseAdmin.from("responses").select("job_name").not("job_name", "is", null);
      if (data.companyId) q = q.eq("company_id", data.companyId);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      names = (rows ?? []).map((r) => r.job_name ?? "");
    } else {
      const responseIds = await scopedResponseIds(supabaseAdmin, data.companyId ?? null);
      let q = supabaseAdmin.from("response_skills").select("name");
      if (responseIds) q = q.in("response_id", responseIds);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      names = (rows ?? []).map((r) => r.name);
    }

    const distinct = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
    if (distinct.length < 2) return { clusters: [], distinct };

    const clusters = await callLLMJson<{ canonical: string; variants: string[] }[]>({
      system:
        "너는 마스터 데이터 정제 담당자다. 같은 대상을 가리키는 표기 변형(띄어쓰기·약어·한영 혼용·오탈자)만 한 묶음으로 만든다. " +
        "의미가 다른 항목은 절대 묶지 않는다. 묶을 것이 없으면 빈 배열을 반환한다.",
      user:
        `표기 목록: ${JSON.stringify(distinct)}\n\n` +
        'JSON만 출력한다. 형식: [{"canonical":"대표 표기(목록 안의 값)","variants":["같은 묶음의 다른 표기들"]}] — variants 는 2개 이상 묶인 경우에만 포함하고 canonical 도 variants 에 넣는다.',
      maxTokens: 2048,
    });

    const valid = (Array.isArray(clusters) ? clusters : [])
      .map((c) => ({
        canonical: c.canonical,
        variants: (c.variants ?? []).filter((v) => distinct.includes(v)),
      }))
      .filter((c) => c.variants.length >= 2 && distinct.includes(c.canonical));

    return { clusters: valid, distinct };
  });

async function scopedResponseIds(admin: Admin, companyId: string | null) {
  if (!companyId) return null;
  const { data } = await admin.from("responses").select("id").eq("company_id", companyId);
  return (data ?? []).map((r) => r.id);
}

export const applyMerge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        field: z.enum(["job_name", "skill_name"]),
        from: z.array(z.string().trim().min(1)).min(1).max(100),
        to: z.string().trim().min(1).max(200),
        companyId: optionalCompany,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const targets = data.from.filter((v) => v !== data.to);
    if (targets.length === 0) return { updated: 0 };

    let updated = 0;
    if (data.field === "job_name") {
      let q = supabaseAdmin.from("responses").update({ job_name: data.to }).in("job_name", targets);
      if (data.companyId) q = q.eq("company_id", data.companyId);
      const { data: rows, error } = await q.select("id");
      if (error) throw new Error(error.message);
      updated = rows?.length ?? 0;
    } else {
      const responseIds = await scopedResponseIds(supabaseAdmin, data.companyId ?? null);
      let q = supabaseAdmin.from("response_skills").update({ name: data.to }).in("name", targets);
      if (responseIds) q = q.in("response_id", responseIds);
      const { data: rows, error } = await q.select("id");
      if (error) throw new Error(error.message);
      updated = rows?.length ?? 0;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 표기 병합 적용",
      target_type: data.field,
      detail: { from: targets, to: data.to, updated },
    });

    return { updated };
  });

export const requestReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ suggestionIds: z.array(uuid).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 응답자 검토는 route B(자동채움·부실보완) 전용이다. route A(오탈자) 건은 관리자가 직접 반영한다.
    const { data: rows, error } = await supabaseAdmin
      .from("ai_suggestions")
      .update({ status: "요청중" })
      .in("id", data.suggestionIds)
      .eq("route", "B")
      .eq("status", "제안")
      .select("id");
    if (error) throw new Error(error.message);

    const requested = rows?.length ?? 0;
    const skipped = data.suggestionIds.length - requested;

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 제안 응답자 검토 요청",
      detail: { count: requested, skipped },
    });
    return { requested, skipped };
  });

/** 응답에 남은 AI 초안 표시를 관리자가 일괄 확정한다(승인 게이트 해제용). */
export const confirmAiDrafts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: skills, error: skillError } = await supabaseAdmin
      .from("response_skills")
      .update({ ai_draft: false })
      .eq("response_id", data.responseId)
      .eq("ai_draft", true)
      .select("id");
    if (skillError) throw new Error(skillError.message);

    const { data: reqs, error: reqError } = await supabaseAdmin
      .from("response_requirements")
      .update({ ai_draft: false })
      .eq("response_id", data.responseId)
      .eq("ai_draft", true)
      .select("id");
    if (reqError) throw new Error(reqError.message);

    const confirmed = (skills?.length ?? 0) + (reqs?.length ?? 0);
    if (confirmed === 0) return { confirmed: 0 };

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 초안 일괄 확정",
      target_type: "response",
      target_id: data.responseId,
      detail: { skills: skills?.length ?? 0, requirements: reqs?.length ?? 0 },
    });

    return { confirmed };
  });

export const applySuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ suggestionId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: s, error: loadError } = await supabaseAdmin
      .from("ai_suggestions")
      .select("id, response_id, target, suggested_value, status")
      .eq("id", data.suggestionId)
      .maybeSingle();
    if (loadError) throw new Error(loadError.message);
    if (!s) throw new Error("제안을 찾을 수 없습니다.");
    if (!["제안", "수락", "수정"].includes(s.status)) {
      throw new Error(`반영할 수 없는 상태입니다: ${s.status}`);
    }

    const [table, id, field] = s.target.split(":");
    if (!table) throw new Error(`알 수 없는 반영 대상입니다: ${s.target}`);

    if (table === "response_skills" && id === "new") {
      const draft = JSON.parse(s.suggested_value) as {
        name: string;
        ksao: string | null;
        hard_soft: string | null;
        description: string | null;
      };
      // 관리자(또는 응답자 검토)를 거쳐 반영된 값이므로 초안 표시를 달지 않는다 —
      // ai_draft 가 남으면 approveResponse 승인 게이트가 계속 막힌다.
      const { error } = await supabaseAdmin.from("response_skills").insert({
        response_id: s.response_id,
        name: draft.name,
        ksao: draft.ksao,
        hard_soft: draft.hard_soft,
        description: draft.description,
        ai_draft: false,
      });
      if (error) throw new Error(error.message);
    } else if (!id || !field || !APPLY_FIELDS[table]?.includes(field)) {
      throw new Error(`반영이 허용되지 않은 필드입니다: ${s.target}`);
    } else if (table === "response_requirements") {
      // 1:1 테이블이므로 id 자리에 들어온 response_id 로 upsert 한다.
      const row = { response_id: id, [field]: s.suggested_value, ai_draft: false };
      const { error } = await supabaseAdmin
        .from("response_requirements")
        .upsert(row as never, { onConflict: "response_id" });
      if (error) throw new Error(error.message);
    } else {
      // 필드명이 런타임 값이라 제네릭 추론이 안 된다. 화이트리스트로 이미 검증했다.
      const patch: Record<string, unknown> = { [field]: s.suggested_value };
      if (table === "response_skills") patch["ai_draft"] = false;
      const { error } = await supabaseAdmin
        .from(table as "responses")
        .update(patch as never)
        .eq("id", id);
      if (error) throw new Error(error.message);
    }

    const { error: markError } = await supabaseAdmin
      .from("ai_suggestions")
      .update({ status: "확정", decided_by: context.userId, decided_at: new Date().toISOString() })
      .eq("id", s.id);
    if (markError) throw new Error(markError.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "AI 제안 반영",
      target_type: "ai_suggestion",
      target_id: s.id,
      detail: { target: s.target },
    });

    return { applied: true, target: s.target };
  });
