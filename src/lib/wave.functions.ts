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
 * `listWaves`·`assignWave` 는 다른 담당(참여자 명부 화면)이 이 이름·시그니처로 그대로
 * 부른다 — 바꾸지 않는다.
 */

const uuid = z.string().uuid();
const KINDS = ["1차", "보완", "신규입사"] as const;
const DONE_STATUSES = ["제출", "승인"];

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다.")
  .nullable();

function normalizeReminderDays(days: number[]) {
  return [...new Set(days)].sort((a, b) => b - a);
}

export type Wave = {
  id: string;
  seq: number;
  name: string;
  kind: string;
  deadline: string | null;
  status: string;
  reminderDays: number[];
  note: string | null;
  assignedCount: number;
  submittedCount: number;
};

/** 참여자 명부 화면이 배정 대상을 고를 때 쓰는 목록 — 회차별 배정·제출 인원을 함께 낸다. */
export const listWaves = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: uuid }).parse(input))
  .handler(async ({ data, context }): Promise<Wave[]> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: waves, error: waveErr }, { data: people, error: peopleErr }] = await Promise.all(
      [
        supabaseAdmin
          .from("survey_waves")
          .select("id, seq, name, kind, deadline, status, reminder_days, note")
          .eq("company_id", data.companyId)
          .order("seq"),
        supabaseAdmin
          .from("participants")
          .select("wave_id, account_status")
          .eq("company_id", data.companyId)
          .eq("role", "respondent")
          .is("archived_at", null)
          .not("wave_id", "is", null),
      ],
    );
    if (waveErr) throw new Error(waveErr.message);
    if (peopleErr) throw new Error(peopleErr.message);

    const tally = new Map<string, { assigned: number; submitted: number }>();
    for (const p of people ?? []) {
      const key = p.wave_id as string;
      const t = tally.get(key) ?? { assigned: 0, submitted: 0 };
      t.assigned += 1;
      if (DONE_STATUSES.includes(p.account_status)) t.submitted += 1;
      tally.set(key, t);
    }

    return (waves ?? []).map((w) => ({
      id: w.id,
      seq: w.seq,
      name: w.name,
      kind: w.kind,
      deadline: w.deadline,
      status: w.status,
      reminderDays: w.reminder_days ?? [],
      note: w.note,
      assignedCount: tally.get(w.id)?.assigned ?? 0,
      submittedCount: tally.get(w.id)?.submitted ?? 0,
    }));
  });

/** 계열사 전체의 차수 요약 — 차수 관리 화면 머리말에 쓴다. */
export const waveStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: waves, error } = await supabaseAdmin
      .from("survey_waves")
      .select("status, deadline")
      .eq("company_id", data.companyId);
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
        reminderDays: z.array(z.number().int().min(0).max(60)).max(10).optional(),
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
        ...(data.reminderDays ? { reminder_days: normalizeReminderDays(data.reminderDays) } : {}),
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
        reminderDays: z.array(z.number().int().min(0).max(60)).max(10).optional(),
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
    if (data.reminderDays !== undefined) {
      patch["reminder_days"] = normalizeReminderDays(data.reminderDays);
    }
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
      .select("id, company_id, status")
      .eq("id", data.waveId)
      .maybeSingle();
    if (waveErr) throw new Error(waveErr.message);
    if (!targetWave) throw new Error("차수를 찾을 수 없습니다.");
    if (targetWave.status === "마감") throw new Error("마감된 차수에는 새로 배정할 수 없습니다.");

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

/* ─────────────────── 다른 담당 함수가 참고할 헬퍼 ─────────────────── */

export type WaveDeadline = {
  waveId: string;
  companyId: string;
  name: string;
  kind: string;
  deadline: string;
  reminderDays: number[];
};

/**
 * 마감이 지정된, 아직 마감되지 않은 차수의 마감·리마인더 목록.
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
    .select("id, company_id, name, kind, deadline, reminder_days")
    .neq("status", "마감")
    .not("deadline", "is", null);
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      id: string;
      company_id: string;
      name: string;
      kind: string;
      deadline: string | null;
      reminder_days: number[] | null;
    }[]
  )
    .filter((w): w is typeof w & { deadline: string } => w.deadline !== null)
    .map((w) => ({
      waveId: w.id,
      companyId: w.company_id,
      name: w.name,
      kind: w.kind,
      deadline: w.deadline,
      reminderDays: w.reminder_days ?? [],
    }));
}
