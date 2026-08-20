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

/** AI 서버가 실제로 응답하는지 최소 호출로 확인한다(연결 점검 버튼). */
export const pingProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { callLLM, AI_FEATURES } = await import("@/lib/llm.server");
    const text = await callLLM({
      system: "연결 확인용 호출이다. 다른 말 없이 pong 만 출력한다.",
      user: "ping",
      maxTokens: 16,
      feature: AI_FEATURES.PING,
      actorId: context.userId,
    });
    return { ok: true, reply: text.trim().slice(0, 40) };
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
    const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

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
      feature: AI_FEATURES.TYPO_SCAN,
      target: data.responseId,
      actorId: context.userId,
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

/**
 * 부실 판정 기준 — 전체 스윕(detectPoorResponses)·단건 점검(checkResponseQuality)·
 * 참여자 셀프 점검(selfCheckMyResponse)이 같은 기준으로 판단해야 한다.
 * 세 곳에 따로 적어 두면 화면마다 다른 답이 나온다.
 */
const POOR_CRITERIA =
  "너는 직무조사 응답의 품질을 판정하는 심사자다. 부실 판정 기준: " +
  "①과업명이 명사 한 단어뿐이거나 「업무」「관리」처럼 내용이 없다 ②활동이 과업명과 사실상 같거나 서로 중복된다 " +
  "③직무 정의·미션이 비었거나 한 줄 상투어다 ④과업이 3개 미만이다 ⑤복사·붙여넣기로 보이는 반복 문구가 있다.";

export const detectPoorResponses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: optionalCompany }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

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
      system: `${POOR_CRITERIA} 기준에 걸리지 않는 응답은 결과에 포함하지 않는다.`,
      user:
        `${JSON.stringify(payload)}\n\n` +
        'JSON만 출력한다. 형식: [{"responseId":"...","issues":["근거 한 문장"],"rejectDraft":"응답자에게 보낼 반려 사유 초안(존댓말 2~3문장, 무엇을 어떻게 고쳐야 하는지 구체적으로)"}]',
      maxTokens: 2048,
      feature: AI_FEATURES.POOR_SWEEP,
      target: `스윕 ${responses.length}건${data.companyId ? "" : " (전사)"}`,
      actorId: context.userId,
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

/** 제출 전 셀프 AI 점검 결과 한 건 — 어떤 항목이 왜 부실해 보이고 어떻게 보완할지. */
export type SelfCheckFinding = { item: string; reason: string; suggestion: string };

/**
 * V15-2: 참여자가 제출 전에 본인 응답을 스스로 점검한다(게이트 아님 — 무시하고 제출 가능).
 * 관리자 가드가 아니라 본인 소유 검증 — responses 는 RLS 로 본인 것만 보이므로
 * 사용자 토큰 조회가 성공하면 소유가 확인된 것이다. 데이터 수집은 supabaseAdmin 으로 한다.
 * 부실 판정 기준은 detectPoorResponses 와 동일. 프롬프트에 이름·사번·이메일은 넣지 않는다.
 */
export const selfCheckMyResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: uuid }).parse(input))
  .handler(async ({ data, context }): Promise<{ findings: SelfCheckFinding[] }> => {
    const { data: own } = await context.supabase
      .from("responses")
      .select("id")
      .eq("id", data.responseId)
      .maybeSingle();
    if (!own) throw new Error("본인 응답만 점검할 수 있습니다.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

    const { response, taskRows, activityRows } = await collectResponseText(
      supabaseAdmin,
      data.responseId,
    );
    const payload = {
      jobName: response.job_name,
      definition: response.definition,
      mission: response.mission,
      tasks: taskRows.map((t) => ({
        name: t.name,
        activities: activityRows.filter((a) => a.task_id === t.id).map((a) => a.name),
      })),
    };

    const found = await callLLMJson<SelfCheckFinding[]>({
      system: `${POOR_CRITERIA} 기준에 걸리는 항목만 결과에 포함하고, 작성자 본인에게 직접 말하듯 존댓말로 보완 방법을 제안한다. 문제가 없으면 빈 배열을 반환한다.`,
      user:
        `${JSON.stringify(payload)}\n\n` +
        'JSON만 출력한다. 형식: [{"item":"항목(예: 과업 2, 직무 정의)","reason":"부실로 본 근거 한 문장","suggestion":"어떻게 보완하면 되는지 한두 문장"}]',
      maxTokens: 2048,
      feature: AI_FEATURES.SELF_CHECK,
      target: data.responseId,
      actorId: context.userId,
    });

    const findings = (Array.isArray(found) ? found : []).filter(
      (f) => typeof f?.item === "string" && typeof f?.reason === "string",
    );
    return { findings };
  });

/**
 * A2: 검토 화면에서 지금 보고 있는 응답 한 건만 점검한다.
 * 전체 스윕(detectPoorResponses)은 목록을 훑는 용도라 한 건을 판단하는 자리에서는 과하다.
 * 판정 기준·반려 초안 형식은 스윕과 동일하게 유지한다(POOR_CRITERIA).
 */
export const checkResponseQuality = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ responseId: uuid }).parse(input))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ issues: string[]; rejectDraft: string; suggestedStep: number }> => {
      const { requireAdmin } = await import("@/lib/guard.server");
      await requireAdmin(context.supabase, context.userId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

      const { response, taskRows, activityRows } = await collectResponseText(
        supabaseAdmin,
        data.responseId,
      );
      const payload = {
        jobName: response.job_name,
        definition: response.definition,
        mission: response.mission,
        tasks: taskRows.map((t) => ({
          name: t.name,
          activities: activityRows.filter((a) => a.task_id === t.id).map((a) => a.name),
        })),
      };

      const verdict = await callLLMJson<{
        issues?: string[];
        rejectDraft?: string;
        step?: number;
      }>({
        system: `${POOR_CRITERIA} 기준에 걸리는 항목만 근거로 적고, 걸리는 것이 없으면 issues 를 빈 배열로 둔다.`,
        user:
          `${JSON.stringify(payload)}\n\n` +
          'JSON만 출력한다. 형식: {"issues":["근거 한 문장"],"rejectDraft":"응답자에게 보낼 반려 사유 초안(존댓말 2~3문장, 무엇을 어떻게 고쳐야 하는지 구체적으로)","step":되돌릴 작성 단계 번호(3=정의·목적, 4=과업·활동, 5=스킬·요건)}',
        maxTokens: 1024,
        feature: AI_FEATURES.SINGLE_CHECK,
        target: data.responseId,
        actorId: context.userId,
      });

      const issues = Array.isArray(verdict?.issues)
        ? verdict.issues.filter((i): i is string => typeof i === "string")
        : [];
      const step = Number(verdict?.step);
      return {
        issues,
        rejectDraft: typeof verdict?.rejectDraft === "string" ? verdict.rejectDraft : "",
        // 단계를 못 받으면 과업·활동(4단계)로 되돌린다 — 부실 판정 대부분이 그 단계에서 생긴다.
        suggestedStep: Number.isInteger(step) && step >= 1 && step <= 6 ? step : 4,
      };
    },
  );

/**
 * A2: 관리자가 검토 화면에서 AI 제안 한 건을 수락·수정·거절한다.
 *
 * applySuggestion 은 '반영'만 할 수 있어 거절·수정이 없었고, 그래서 제안이 계속 남아
 * 승인 게이트를 막았다. 응답자 결정(decideMySuggestion)과 같은 반영 경로
 * (writeSuggestionValue)를 쓰되 소유자 검사 대신 관리자 가드를 적용한다.
 */
export const decideSuggestionAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        suggestionId: uuid,
        decision: z.enum(["수락", "수정", "거절"]),
        note: z.string().trim().max(2000).optional(),
        editedValue: z.string().trim().max(4000).optional(),
      })
      .refine((v) => v.decision !== "수정" || !!v.editedValue, {
        message: "수정 결정에는 수정한 내용이 필요합니다.",
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: s, error: loadError } = await supabaseAdmin
      .from("ai_suggestions")
      .select("id, response_id, target, suggested_value, ai_suggested_value, status")
      .eq("id", data.suggestionId)
      .maybeSingle();
    if (loadError) throw new Error(loadError.message);
    if (!s) throw new Error("제안을 찾을 수 없습니다.");
    if (!["제안", "요청중", "수락", "수정"].includes(s.status)) {
      throw new Error(`이미 처리된 제안입니다: ${s.status}`);
    }

    const now = new Date().toISOString();

    if (data.decision === "거절") {
      const { error } = await supabaseAdmin
        .from("ai_suggestions")
        .update({
          status: "거절",
          respondent_note: data.note ?? null,
          decided_by: context.userId,
          decided_at: now,
        })
        .eq("id", s.id);
      if (error) throw new Error(error.message);

      await writeAudit(supabaseAdmin, {
        actor_id: context.userId,
        action: "AI 제안 거절",
        target_type: "ai_suggestion",
        target_id: s.id,
        detail: { target: s.target },
      });
      return { applied: false as const, target: s.target };
    }

    const value = data.decision === "수정" ? data.editedValue!.trim() : s.suggested_value;
    await writeSuggestionValue(supabaseAdmin, { ...s, suggested_value: value });

    const { error } = await supabaseAdmin
      .from("ai_suggestions")
      .update({
        status: "확정",
        suggested_value: value,
        // 관리자가 고친 경우에도 AI 원문은 보존한다(무엇을 사람이 바꿨는지 남기기 위해).
        ai_suggested_value:
          data.decision === "수정"
            ? (s.ai_suggested_value ?? s.suggested_value)
            : s.ai_suggested_value,
        respondent_note: data.note ?? null,
        decided_by: context.userId,
        decided_at: now,
      })
      .eq("id", s.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.decision === "수정" ? "AI 제안 수정 반영" : "AI 제안 반영",
      target_type: "ai_suggestion",
      target_id: s.id,
      detail: { target: s.target },
    });

    return { applied: true as const, target: s.target };
  });

/**
 * A2: /admin/ai 일괄 점검 화면용 — 미결 AI 제안을 응답 단위로 묶어 준다.
 * 각 행에서 검토 화면(?response=)으로 넘어가 그 자리에서 판단하도록 만드는 것이 목적이다.
 */
export const listPendingSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: optionalCompany }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await supabaseAdmin
      .from("ai_suggestions")
      .select(
        "id, response_id, target, kind, route, status, created_at, responses(job_name, status, company_id, participants(name))",
      )
      .in("status", ["제안", "요청중"])
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    type Row = NonNullable<typeof rows>[number];
    const scoped = (rows ?? []).filter((r) => {
      const res = r.responses as { company_id?: string | null } | null;
      return !data.companyId || res?.company_id === data.companyId;
    });

    const groups = new Map<
      string,
      {
        responseId: string;
        name: string;
        jobName: string;
        responseStatus: string;
        kinds: Record<string, number>;
        total: number;
        latest: string;
      }
    >();
    for (const r of scoped as Row[]) {
      const res = r.responses as {
        job_name?: string | null;
        status?: string | null;
        participants?: { name?: string | null } | null;
      } | null;
      const key = r.response_id;
      const g = groups.get(key) ?? {
        responseId: key,
        name: res?.participants?.name ?? "이름 미등록",
        jobName: res?.job_name ?? "직무 미입력",
        responseStatus: res?.status ?? "-",
        kinds: {},
        total: 0,
        latest: r.created_at,
      };
      g.kinds[r.kind] = (g.kinds[r.kind] ?? 0) + 1;
      g.total += 1;
      if (Date.parse(r.created_at) > Date.parse(g.latest)) g.latest = r.created_at;
      groups.set(key, g);
    }

    return { groups: [...groups.values()].sort((a, b) => b.total - a.total) };
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
    const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

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
        feature: AI_FEATURES.MISSING_FIELDS,
        target: `${data.responseId}:skills`,
        actorId: context.userId,
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
        feature: AI_FEATURES.MISSING_FIELDS,
        target: `${data.responseId}:requirements`,
        actorId: context.userId,
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
    const { callLLMJson, AI_FEATURES } = await import("@/lib/llm.server");

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
      feature: AI_FEATURES.MERGE_SUGGEST,
      target: data.field,
      actorId: context.userId,
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

    await writeSuggestionValue(supabaseAdmin, s);

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

/**
 * 제안 값을 실제 응답 레코드에 쓴다. 관리자 반영(applySuggestion)과 응답자 수락
 * (decideMySuggestion)이 같은 경로를 쓰도록 분리했다 — 한쪽만 고쳐 반영 규칙이
 * 갈라지는 일을 막는다. 권한 검사는 호출자 책임이다.
 */
async function writeSuggestionValue(
  admin: Admin,
  s: { id: string; response_id: string; target: string; suggested_value: string },
) {
  const [table, id, field] = s.target.split(":");
  if (!table) throw new Error(`알 수 없는 반영 대상입니다: ${s.target}`);

  if (table === "response_skills" && id === "new") {
    // 신규 스킬 제안의 suggested_value 는 구조화 JSON 이다. 응답자 '수정'이 사람이 읽는
    // 문자열로 덮어쓰면 파싱이 깨지므로, 실패 시 크래시 대신 명확한 사유를 던진다.
    let draft: {
      name: string;
      ksao: string | null;
      hard_soft: string | null;
      description: string | null;
    };
    try {
      draft = JSON.parse(s.suggested_value);
    } catch {
      throw new Error(
        "이 스킬 제안은 자유 편집으로 수정할 수 없습니다. 수락 또는 거절만 선택하거나, 관리자가 직접 스킬을 추가하세요.",
      );
    }
    // 관리자(또는 응답자 검토)를 거쳐 반영된 값이므로 초안 표시를 달지 않는다 —
    // ai_draft 가 남으면 approveResponse 승인 게이트가 계속 막힌다.
    const { error } = await admin.from("response_skills").insert({
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
    const { error } = await admin
      .from("response_requirements")
      .upsert(row as never, { onConflict: "response_id" });
    if (error) throw new Error(error.message);
  } else {
    // 필드명이 런타임 값이라 제네릭 추론이 안 된다. 화이트리스트로 이미 검증했다.
    const patch: Record<string, unknown> = { [field]: s.suggested_value };
    if (table === "response_skills") patch["ai_draft"] = false;
    const { error } = await admin
      .from(table as "responses")
      .update(patch as never)
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  // 자식 테이블 반영은 responses.updated_at 트리거를 안 태운다. 부모를 밀어야
  // 참여자의 다음 저장(save_*_tx 낙관적 락)이 이 반영과의 충돌을 감지한다.
  if (table !== "responses") {
    const { touchResponse } = await import("@/lib/guard.server");
    await touchResponse(admin, s.response_id);
  }
}

/**
 * 응답자가 자기 응답의 AI 제안을 결정한다. 수락·수정은 그 자리에서 실제 응답에 반영한다
 * (예전에는 상태만 바꿔 관리자가 다시 반영해야 했고, 그 사이 응답자 화면에는 아무 변화가
 *  없어 '수락했는데 반영이 안 된다'로 보였다).
 * 거절은 값을 건드리지 않고 사유만 남긴다.
 */
export const decideMySuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        suggestionId: uuid,
        decision: z.enum(["수락", "수정", "거절"]),
        note: z.string().trim().max(2000).optional(),
        editedValue: z.string().trim().max(4000).optional(),
      })
      .refine((v) => v.decision !== "수정" || !!v.editedValue, {
        message: "수정 결정에는 수정한 내용이 필요합니다.",
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: s, error: loadError } = await supabaseAdmin
      .from("ai_suggestions")
      .select(
        "id, response_id, target, suggested_value, ai_suggested_value, status, responses(participant_id, participants(user_id))",
      )
      .eq("id", data.suggestionId)
      .maybeSingle();
    if (loadError) throw new Error(loadError.message);
    if (!s) throw new Error("제안을 찾을 수 없습니다.");

    // 본인 응답의 제안만 결정할 수 있다. RLS 를 우회하는 service_role 이므로 여기서 직접 본다.
    const owner = (s.responses as { participants?: { user_id: string | null } | null } | null)
      ?.participants?.user_id;
    if (!owner || owner !== context.userId) throw new Error("결정할 수 없는 제안입니다.");
    if (s.status !== "요청중") throw new Error(`이미 처리된 제안입니다: ${s.status}`);

    const now = new Date().toISOString();

    if (data.decision === "거절") {
      const { error } = await supabaseAdmin
        .from("ai_suggestions")
        .update({
          status: "거절",
          respondent_note: data.note ?? null,
          decided_by: context.userId,
          decided_at: now,
        })
        .eq("id", s.id);
      if (error) throw new Error(error.message);
      return { applied: false, target: s.target };
    }

    // 수정이면 응답자가 고친 값을 반영하고, AI 원문은 ai_suggested_value 에 보존한다.
    const value = data.decision === "수정" ? data.editedValue!.trim() : s.suggested_value;
    await writeSuggestionValue(supabaseAdmin, { ...s, suggested_value: value });

    const { error } = await supabaseAdmin
      .from("ai_suggestions")
      .update({
        status: "확정",
        suggested_value: value,
        ai_suggested_value:
          data.decision === "수정"
            ? (s.ai_suggested_value ?? s.suggested_value)
            : s.ai_suggested_value,
        respondent_note: data.note ?? null,
        decided_by: context.userId,
        decided_at: now,
      })
      .eq("id", s.id);
    if (error) throw new Error(error.message);

    return { applied: true, target: s.target };
  });

/* ─────────────────── F17: AI 사용 원장 ─────────────────── */

export type AiLedgerFeatureRow = {
  feature: string;
  total: number;
  success: number;
  failed: number;
  avgDurationMs: number | null;
  lastSuccessAt: string | null;
};

export type AiLedgerFailureRow = {
  id: string;
  feature: string;
  target: string | null;
  errorMessage: string | null;
  createdAt: string;
  /** 대상만 지정해 다시 생성할 수 있는 경우에만 채워진다. */
  retry: { kind: "jobCatalog" | "dutyChart"; value: string } | null;
};

export type AiLedgerAdoptionRow = {
  kind: string;
  pending: number;
  accepted: number;
  edited: number;
  rejected: number;
  total: number;
  acceptedRate: number | null;
};

export type AiLedger = {
  /** 이번 집계가 훑은 최근 호출 건수(집계 상한에 걸렸는지 판단용). */
  sampleSize: number;
  features: AiLedgerFeatureRow[];
  failures: AiLedgerFailureRow[];
  adoption: AiLedgerAdoptionRow[];
  involvement: { respondedWithAi: number; totalResponses: number; ratio: number | null };
};

// ponytail: 집계 함수 없이 최근 N건을 훑어 JS 로 합산한다 — 이 조사 규모에 충분한 가장
// 단순한 방법이다. 호출량이 훨씬 커지면(수만 건) SQL 집계로 옮길 것.
const LEDGER_CALL_LIMIT = 5000;
const LEDGER_FAILURE_LIMIT = 100;

export const getAiLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiLedger> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { AI_FEATURES } = await import("@/lib/llm.server");

    const [callsRes, failRes, suggestionsRes, appliedRes, totalRes] = await Promise.all([
      supabaseAdmin
        .from("ai_calls")
        .select("feature, status, duration_ms, created_at")
        .order("created_at", { ascending: false })
        .limit(LEDGER_CALL_LIMIT),
      supabaseAdmin
        .from("ai_calls")
        .select("id, feature, target, error_message, created_at")
        .eq("status", "실패")
        .order("created_at", { ascending: false })
        .limit(LEDGER_FAILURE_LIMIT),
      supabaseAdmin.from("ai_suggestions").select("kind, status, ai_suggested_value"),
      supabaseAdmin.from("ai_suggestions").select("response_id").eq("status", "확정"),
      supabaseAdmin.from("responses").select("id", { count: "exact", head: true }),
    ]);
    if (callsRes.error) throw new Error(`AI 호출 기록 조회 실패: ${callsRes.error.message}`);
    if (failRes.error) throw new Error(`AI 실패 목록 조회 실패: ${failRes.error.message}`);
    if (suggestionsRes.error) throw new Error(`AI 제안 조회 실패: ${suggestionsRes.error.message}`);
    if (appliedRes.error) throw new Error(`AI 반영 응답 조회 실패: ${appliedRes.error.message}`);
    if (totalRes.error) throw new Error(`전체 응답 수 조회 실패: ${totalRes.error.message}`);

    // 기능별 호출 수 / 성공·실패 / 평균 소요 시간 / 마지막 성공 시각
    const byFeature = new Map<
      string,
      {
        feature: string;
        total: number;
        success: number;
        failed: number;
        durations: number[];
        lastSuccessAt: string | null;
      }
    >();
    for (const c of callsRes.data ?? []) {
      const g = byFeature.get(c.feature) ?? {
        feature: c.feature,
        total: 0,
        success: 0,
        failed: 0,
        durations: [],
        lastSuccessAt: null,
      };
      g.total += 1;
      if (c.status === "성공") {
        g.success += 1;
        if (typeof c.duration_ms === "number") g.durations.push(c.duration_ms);
        if (!g.lastSuccessAt || Date.parse(c.created_at) > Date.parse(g.lastSuccessAt)) {
          g.lastSuccessAt = c.created_at;
        }
      } else {
        g.failed += 1;
      }
      byFeature.set(c.feature, g);
    }
    const features: AiLedgerFeatureRow[] = [...byFeature.values()]
      .map((g) => ({
        feature: g.feature,
        total: g.total,
        success: g.success,
        failed: g.failed,
        avgDurationMs: g.durations.length
          ? Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length)
          : null,
        lastSuccessAt: g.lastSuccessAt,
      }))
      .sort((a, b) => b.total - a.total);

    // 실패 목록의 재실행 힌트 — 직무분류 가안(직군명)·업무분장 가안(조직명→id 조회)만 대상 지정 재생성이 가능하다.
    const dutyTargets = [
      ...new Set(
        (failRes.data ?? [])
          .filter((r) => r.feature === AI_FEATURES.DUTY_CHART_DRAFT && r.target)
          .map((r) => r.target as string),
      ),
    ];
    const orgIdByName = new Map<string, string>();
    if (dutyTargets.length > 0) {
      const { data: orgs } = await supabaseAdmin
        .from("org_units")
        .select("id, name")
        .in("name", dutyTargets);
      // 같은 이름의 조직이 둘 이상이면 먼저 찾은 것으로 재실행한다 — 정밀 지정이 필요하면 업무분장 화면에서 직접.
      for (const o of orgs ?? []) if (!orgIdByName.has(o.name)) orgIdByName.set(o.name, o.id);
    }

    const failures: AiLedgerFailureRow[] = (failRes.data ?? []).map((r) => {
      let retry: AiLedgerFailureRow["retry"] = null;
      if (r.feature === AI_FEATURES.JOB_CATALOG_DRAFT && r.target) {
        retry = { kind: "jobCatalog", value: r.target };
      } else if (r.feature === AI_FEATURES.DUTY_CHART_DRAFT && r.target) {
        const orgId = orgIdByName.get(r.target);
        if (orgId) retry = { kind: "dutyChart", value: orgId };
      }
      return {
        id: r.id,
        feature: r.feature,
        target: r.target,
        errorMessage: r.error_message,
        createdAt: r.created_at,
        retry,
      };
    });

    // 제안 채택률 — 최종 상태만 남아 수락/수정을 구분 못 하므로, "수정"에서만 채워지는
    // ai_suggested_value 유무로 구분한다(수정 시 AI 원문을 보존, 수락 시엔 비어 있음).
    const adoptionMap = new Map<
      string,
      { kind: string; pending: number; accepted: number; edited: number; rejected: number }
    >();
    for (const s of suggestionsRes.data ?? []) {
      const g = adoptionMap.get(s.kind) ?? {
        kind: s.kind,
        pending: 0,
        accepted: 0,
        edited: 0,
        rejected: 0,
      };
      if (s.status === "거절") g.rejected += 1;
      else if (s.status === "확정") {
        if (s.ai_suggested_value) g.edited += 1;
        else g.accepted += 1;
      } else {
        g.pending += 1; // 제안 · 요청중
      }
      adoptionMap.set(s.kind, g);
    }
    const adoption: AiLedgerAdoptionRow[] = [...adoptionMap.values()].map((g) => {
      const decided = g.accepted + g.edited + g.rejected;
      return {
        ...g,
        total: g.pending + decided,
        acceptedRate: decided > 0 ? Math.round(((g.accepted + g.edited) / decided) * 100) : null,
      };
    });

    // 응답 대비 AI 개입 비중
    const respondedWithAi = new Set((appliedRes.data ?? []).map((r) => r.response_id)).size;
    const totalResponses = totalRes.count ?? 0;
    const involvement = {
      respondedWithAi,
      totalResponses,
      ratio: totalResponses > 0 ? Math.round((respondedWithAi / totalResponses) * 100) : null,
    };

    return { sampleSize: callsRes.data?.length ?? 0, features, failures, adoption, involvement };
  });
