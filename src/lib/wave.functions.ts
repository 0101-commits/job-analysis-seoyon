import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * F8 조사 차수 (기획안 v3.0).
 *
 * 계열사별 마감이 하나뿐이면 보완 조사(미응답자·신규 입사자·조직 변경자)를 하려고 마감을
 * 다시 열 때마다 1차 집계가 섞였다. survey_waves 로 회차를 나누고 participants.wave_id /
 * responses.wave_id 로 각자 어느 회차 소속인지를 못박아 이 문제를 없앤다.
 *
 * `listWaves`·`assignWave` 는 다른 담당(참여자 명부 화면)이 이 이름으로 그대로 부른다.
 * v5부터 `listWaves`/`waveStats` 의 companyId 는 null 을 받아 전 계열사를 한 번에 내고
 * (전사 모드), 보관(archived_at) 축이 붙었다 — 보관 차수는 목록·발송·배정에서 빠진다.
 */

const uuid = z.string().uuid();
const KINDS = ["1차", "보완", "신규입사"] as const;
const DONE_STATUSES = ["제출", "승인"];

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다.")
  .nullable();

export type Wave = {
  id: string;
  seq: number;
  name: string;
  kind: string;
  deadline: string | null;
  status: string;
  note: string | null;
  /** 차수가 속한 계열사 (v5 전사 모드). seq 는 계열사 안에서만 유일하다. */
  companyId: string;
  companyName: string;
  /** 보관 시각. null 이면 운영 중. 보관된 차수는 발송·배정 대상에서 빠진다 (v5). */
  archivedAt: string | null;
  assignedCount: number;
  submittedCount: number;
  /** 배정자의 계정 상태 분포 (v4 차수 허브 화면용). 예: { 미발송: 3, 작성중: 12 } */
  statusCounts: Record<string, number>;
  /** 이 차수로 마지막 발송(mail_batches.wave_id)을 만든 시각. 없으면 null. */
  lastSentAt: string | null;
};

/**
 * 참여자 명부 화면이 배정 대상을 고를 때 쓰는 목록 — 회차별 배정·제출 인원을 함께 낸다.
 * companyId 가 null 이면 전 계열사를 한 번에 낸다 (v5 전사 모드). 기본은 보관 차수를
 * 숨기고, includeArchived 를 켜면 보관 차수까지 낸다 (차수 관리 화면의 보관함 전용).
 */
export const listWaves = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ companyId: uuid.nullable(), includeArchived: z.boolean().optional() })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<Wave[]> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let waveQuery = supabaseAdmin
      .from("survey_waves")
      .select("id, seq, name, kind, deadline, status, note, company_id, archived_at")
      .order("seq");
    if (data.companyId) waveQuery = waveQuery.eq("company_id", data.companyId);
    if (!data.includeArchived) waveQuery = waveQuery.is("archived_at", null);

    let peopleQuery = supabaseAdmin
      .from("participants")
      .select("wave_id, account_status")
      .eq("role", "respondent")
      .is("archived_at", null)
      .not("wave_id", "is", null);
    if (data.companyId) peopleQuery = peopleQuery.eq("company_id", data.companyId);

    // 차수별 마지막 발송 시각 (v4). 최신순이라 차수마다 처음 만난 행이 마지막 발송이다.
    let batchQuery = supabaseAdmin
      .from("mail_batches")
      .select("wave_id, created_at")
      .not("wave_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.companyId) batchQuery = batchQuery.eq("company_id", data.companyId);

    const [
      { data: waves, error: waveErr },
      { data: people, error: peopleErr },
      { data: batches },
      { data: companies, error: coErr },
    ] = await Promise.all([
      waveQuery,
      peopleQuery,
      batchQuery,
      supabaseAdmin.from("companies").select("id, name"),
    ]);
    if (waveErr) throw new Error(waveErr.message);
    if (peopleErr) throw new Error(peopleErr.message);
    if (coErr) throw new Error(coErr.message);
    const companyName = new Map((companies ?? []).map((c) => [c.id, c.name]));

    const tally = new Map<
      string,
      { assigned: number; submitted: number; byStatus: Record<string, number> }
    >();
    for (const p of people ?? []) {
      const key = p.wave_id as string;
      const t = tally.get(key) ?? { assigned: 0, submitted: 0, byStatus: {} };
      t.assigned += 1;
      if (DONE_STATUSES.includes(p.account_status)) t.submitted += 1;
      t.byStatus[p.account_status] = (t.byStatus[p.account_status] ?? 0) + 1;
      tally.set(key, t);
    }

    const lastSent = new Map<string, string>();
    for (const b of batches ?? []) {
      const key = b.wave_id as string;
      if (!lastSent.has(key)) lastSent.set(key, b.created_at);
    }

    return (waves ?? []).map((w) => ({
      id: w.id,
      seq: w.seq,
      name: w.name,
      kind: w.kind,
      deadline: w.deadline,
      status: w.status,
      note: w.note,
      companyId: w.company_id,
      companyName: companyName.get(w.company_id) ?? "",
      archivedAt: w.archived_at,
      assignedCount: tally.get(w.id)?.assigned ?? 0,
      submittedCount: tally.get(w.id)?.submitted ?? 0,
      statusCounts: tally.get(w.id)?.byStatus ?? {},
      lastSentAt: lastSent.get(w.id) ?? null,
    }));
  });

/** 차수 요약 — 차수 관리 화면 머리말에 쓴다. companyId 가 null 이면 전 계열사 합계. */
export const waveStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: uuid.nullable() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 보관된 차수는 요약에서도 뺀다 — 화면 머리말은 운영 중인 차수의 현황이다.
    let query = supabaseAdmin
      .from("survey_waves")
      .select("status, deadline")
      .is("archived_at", null);
    if (data.companyId) query = query.eq("company_id", data.companyId);
    const { data: waves, error } = await query;
    if (error) throw new Error(error.message);

    const rows = waves ?? [];
    const upcoming = rows
      .filter((w) => w.status !== "마감" && w.deadline)
      .map((w) => w.deadline as string)
      .sort();

    return {
      total: rows.length,
      preparing: rows.filter((w) => w.status === "준비").length,
      active: rows.filter((w) => w.status === "진행").length,
      closed: rows.filter((w) => w.status === "마감").length,
      nextDeadline: upcoming[0] ?? null,
    };
  });

export const createWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: uuid,
        name: z.string().trim().min(1).max(60),
        kind: z.enum(KINDS),
        deadline: dateStr.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: last, error: lastErr } = await supabaseAdmin
      .from("survey_waves")
      .select("seq")
      .eq("company_id", data.companyId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) throw new Error(lastErr.message);
    const seq = (last?.seq ?? 0) + 1;

    const { data: created, error } = await supabaseAdmin
      .from("survey_waves")
      .insert({
        company_id: data.companyId,
        seq,
        name: data.name,
        kind: data.kind,
        deadline: data.deadline ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 생성",
      target_type: "survey_waves",
      target_id: created.id,
      detail: { companyId: data.companyId, name: data.name, kind: data.kind, seq },
    });
    return { id: created.id, seq };
  });

export const updateWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: uuid,
        name: z.string().trim().min(1).max(60).optional(),
        kind: z.enum(KINDS).optional(),
        deadline: dateStr.optional(),
        note: z.string().trim().max(300).nullable().optional(),
        // '마감' 전환은 closeWave 전용 — 되돌릴 수 없는 행동이라 별도 확인 절차로 분리한다.
        status: z.enum(["준비", "진행"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: findErr } = await supabaseAdmin
      .from("survey_waves")
      .select("status")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new Error("차수를 찾을 수 없습니다.");
    if (existing.status === "마감") throw new Error("마감된 차수는 수정할 수 없습니다.");

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch["name"] = data.name;
    if (data.kind !== undefined) patch["kind"] = data.kind;
    if (data.deadline !== undefined) patch["deadline"] = data.deadline;
    if (data.note !== undefined) patch["note"] = data.note;
    if (data.status !== undefined) patch["status"] = data.status;
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("survey_waves")
      .update(patch as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 수정",
      target_type: "survey_waves",
      target_id: data.id,
      detail: patch,
    });
    return { ok: true };
  });

/** 마감은 되돌릴 수 없는 확정 행동이라 일반 수정과 분리한다. */
export const closeWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("survey_waves")
      .update({ status: "마감" })
      .eq("id", data.id)
      .neq("status", "마감");
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 마감",
      target_type: "survey_waves",
      target_id: data.id,
    });
    return { ok: true };
  });

/**
 * 참여자를 차수에 배정한다. 참여자 명부 화면(다른 담당)이 일괄 배정 UI에서 그대로 부른다 —
 * 이름·입력·반환 모양을 바꾸지 않는다.
 *
 * 1차 확정본 보호: 참여자의 기존 응답이 이미 마감(status='마감')된 차수에 속해 있으면 그
 * 응답은 새 차수로 옮기지 않는다(참여자의 wave_id 자체는 옮겨도, 마감 차수에 남긴 응답은
 * 그대로 그 차수의 기록으로 둔다). 보완 차수는 참여자가 새로 작성하는 응답부터 채워진다.
 */
export const assignWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        participantIds: z.array(uuid).min(1).max(2000),
        waveId: uuid,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: targetWave, error: waveErr } = await supabaseAdmin
      .from("survey_waves")
      .select("id, company_id, status, archived_at")
      .eq("id", data.waveId)
      .maybeSingle();
    if (waveErr) throw new Error(waveErr.message);
    if (!targetWave) throw new Error("차수를 찾을 수 없습니다.");
    if (targetWave.status === "마감") throw new Error("마감된 차수에는 새로 배정할 수 없습니다.");
    if (targetWave.archived_at) {
      throw new Error("보관된 차수에는 배정할 수 없습니다. 먼저 보관을 해제해 주세요.");
    }

    const { data: parts, error: partErr } = await supabaseAdmin
      .from("participants")
      .select("id, company_id")
      .in("id", data.participantIds);
    if (partErr) throw new Error(partErr.message);
    if ((parts ?? []).length !== data.participantIds.length) {
      throw new Error("존재하지 않는 참여자가 포함되어 있습니다.");
    }
    const mismatched = (parts ?? []).filter((p) => p.company_id !== targetWave.company_id);
    if (mismatched.length > 0) {
      throw new Error(
        `선택한 참여자 중 ${mismatched.length}명이 다른 계열사 소속이라 이 차수에 배정할 수 없습니다.`,
      );
    }

    const { error: updPartErr } = await supabaseAdmin
      .from("participants")
      .update({ wave_id: data.waveId })
      .in("id", data.participantIds);
    if (updPartErr) throw new Error(updPartErr.message);

    // 마감된 차수에 남은 응답은 옮기지 않는다 — 그 차수를 만든 wave 목록을 미리 구해 둔다.
    const { data: closedWaves, error: closedErr } = await supabaseAdmin
      .from("survey_waves")
      .select("id")
      .eq("status", "마감");
    if (closedErr) throw new Error(closedErr.message);
    const closedIds = new Set((closedWaves ?? []).map((w) => w.id));

    const { data: existingResponses, error: respFindErr } = await supabaseAdmin
      .from("responses")
      .select("id, wave_id")
      .in("participant_id", data.participantIds);
    if (respFindErr) throw new Error(respFindErr.message);

    const movableIds = (existingResponses ?? [])
      .filter((r) => !r.wave_id || !closedIds.has(r.wave_id))
      .map((r) => r.id);
    const protectedResponses = (existingResponses ?? []).length - movableIds.length;

    if (movableIds.length > 0) {
      const { error: updRespErr } = await supabaseAdmin
        .from("responses")
        .update({ wave_id: data.waveId })
        .in("id", movableIds);
      if (updRespErr) throw new Error(updRespErr.message);
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 차수 배정",
      target_type: "survey_waves",
      target_id: data.waveId,
      detail: { participantCount: data.participantIds.length, protectedResponses },
    });

    return { updated: data.participantIds.length, protectedResponses };
  });

/**
 * 차수 보관 (v5). 삭제와 달리 되돌릴 수 있다 — 목록·발송·배정 대상에서만 빠지고
 * 데이터는 그대로 남는다. 진행 중 차수도 보관할 수 있다(확인은 UI 몫).
 */
export const archiveWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("survey_waves")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 보관",
      target_type: "survey_waves",
      target_id: data.id,
    });
    return { ok: true };
  });

export const unarchiveWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("survey_waves")
      .update({ archived_at: null })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 보관 해제",
      target_type: "survey_waves",
      target_id: data.id,
    });
    return { ok: true };
  });

/**
 * 삭제 전 영향 집계 (v5). FK 가 전부 ON DELETE SET NULL 이라 데이터 자체는 남지만,
 * 이 차수에 귀속됐던 이력(누가 배정됐고 어떤 발송·제출의 기준이었는지)은 사라진다 —
 * 그 규모를 확인 다이얼로그가 보여 주기 위한 조회다.
 */
export const waveDeleteImpact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [parts, resps, batches] = await Promise.all([
      supabaseAdmin
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("wave_id", data.id),
      supabaseAdmin
        .from("responses")
        .select("id", { count: "exact", head: true })
        .eq("wave_id", data.id),
      supabaseAdmin
        .from("mail_batches")
        .select("id", { count: "exact", head: true })
        .eq("wave_id", data.id),
    ]);
    if (parts.error) throw new Error(parts.error.message);
    if (resps.error) throw new Error(resps.error.message);
    if (batches.error) throw new Error(batches.error.message);

    return {
      participants: parts.count ?? 0,
      responses: resps.count ?? 0,
      mailBatches: batches.count ?? 0,
    };
  });

/**
 * 차수 삭제. v6부터 보관 여부와 무관하게 바로 지울 수 있다 — 실수 방지는 UI 의
 * 영향 규모(waveDeleteImpact) 확인 다이얼로그가 맡는다. FK 는 SET NULL 이라
 * 참여자·응답·발송 데이터는 남지만 차수 귀속이 풀린다.
 */
export const deleteWave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: findErr } = await supabaseAdmin
      .from("survey_waves")
      .select("name, seq, company_id")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new Error("차수를 찾을 수 없습니다.");

    const { error } = await supabaseAdmin.from("survey_waves").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 차수 삭제",
      target_type: "survey_waves",
      target_id: data.id,
      detail: { name: existing.name, seq: existing.seq, companyId: existing.company_id },
    });
    return { ok: true };
  });

/* ─────────────────── 다른 담당 함수가 참고할 헬퍼 ─────────────────── */

export type WaveDeadline = {
  waveId: string;
  companyId: string;
  name: string;
  kind: string;
  deadline: string;
};

/**
 * 마감이 지정된, 아직 마감되지 않은 차수의 마감 목록.
 * 며칠 전에 독려할지는 계열사 설정(D-n)만 쓴다 — 차수 reminder_days 는 v6에서
 * 폐지됐다(컬럼만 잔존).
 *
 * mailer.server.ts 의 `runReminders` 는 지금 survey_settings(계열사 단위 마감)만 순회한다.
 * 차수별 마감도 독려 대상이 되려면 그 함수가 이 헬퍼도 함께 돌며, 대상을 회사 전체가 아니라
 * `participants.wave_id = waveId` 인 사람으로 좁혀야 한다 — 이 파일은 그 함수를 고치지
 * 않으므로(담당 분리) 여기서는 조회만 제공한다. `admin` 은 호출 쪽(서버 전용 코드)이
 * service_role 클라이언트를 그대로 넘긴다.
 */
export async function listWaveDeadlinesForReminders(
  admin: SupabaseClient,
): Promise<WaveDeadline[]> {
  const { data, error } = await admin
    .from("survey_waves")
    .select("id, company_id, name, kind, deadline")
    .neq("status", "마감")
    // 보관된 차수는 발송 대상에서 빠진다 (v5)
    .is("archived_at", null)
    .not("deadline", "is", null);
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      id: string;
      company_id: string;
      name: string;
      kind: string;
      deadline: string | null;
    }[]
  )
    .filter((w): w is typeof w & { deadline: string } => w.deadline !== null)
    .map((w) => ({
      waveId: w.id,
      companyId: w.company_id,
      name: w.name,
      kind: w.kind,
      deadline: w.deadline,
    }));
}
