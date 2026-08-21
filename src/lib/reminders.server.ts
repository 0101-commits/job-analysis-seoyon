// 독려 규칙 (기획 F4).
//
// "어떤 상태로 며칠 멈춰 있으면 누구에게 어떤 안내를 보낸다"를 규칙으로 저장해 두고
// 정기 실행기가 하루 한 번 돌린다. 발송 자체는 기존 발송 경로(mailer.server.processBatch)를
// 그대로 쓴다 — 발송 이력·상태 갱신·연습 모드 판정이 한 곳에만 있어야 한다.
//
// 중복 발송 방지: reminder_rule_runs(rule_id, run_date) 를 먼저 선점한 실행만 발송한다.
// 상한 초과분은 버리지 않고 '남긴 대상' 수로 기록한다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./paginate";

export const REMINDER_TRIGGERS = ["미로그인", "작성정체", "반려미수정", "마감임박"] as const;
export type ReminderTrigger = (typeof REMINDER_TRIGGERS)[number];

/** 규칙 종류별 설명 — 설정 화면에 그대로 나간다. */
export const TRIGGER_LABELS: Record<ReminderTrigger, string> = {
  미로그인: "안내를 받고도 한 번도 접속하지 않은 참여자",
  작성정체: "작성을 시작했는데 지정 일수만큼 손대지 않은 참여자",
  반려미수정: "보완 요청을 받고 지정 일수 동안 고치지 않은 참여자",
  마감임박: "제출 마감 며칠 전에 아직 제출하지 않은 참여자",
};

export type RuleRow = {
  id: string;
  company_id: string | null;
  name: string;
  trigger: string;
  days: number;
  template_id: string | null;
  enabled: boolean;
  daily_cap: number;
  last_run_at: string | null;
  last_sent_count: number | null;
};

const RULE_COLUMNS =
  "id, company_id, name, trigger, days, template_id, enabled, daily_cap, last_run_at, last_sent_count";

/** 이미 끝난 사람은 어떤 규칙에서도 독려 대상이 아니다. */
const DONE_STATUSES = ["제출", "승인"];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstToday(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function daysAgoIso(days: number, now = Date.now()) {
  return new Date(now - days * 86_400_000).toISOString();
}

/** 오늘(한국 시간)부터 마감일까지 남은 일수. 지났으면 음수. */
function daysLeft(deadline: string, today: string) {
  return Math.round(
    (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

type PersonRow = {
  id: string;
  name: string;
  company_id: string;
  wave_id: string | null;
  account_status: string;
  invited_at: string | null;
  last_seen_at: string | null;
};

/** 안내를 보낼 수 있는 사람(참여자 · 보관 아님 · 이메일 있음)만 모은다. */
async function loadPeople(admin: SupabaseClient, companyId: string | null) {
  return fetchAll<PersonRow>((from, to) => {
    let query = admin
      .from("participants")
      .select("id, name, company_id, wave_id, account_status, invited_at, last_seen_at")
      .eq("role", "respondent")
      .is("archived_at", null)
      .not("email", "is", null)
      .order("id")
      .range(from, to);
    if (companyId) query = query.eq("company_id", companyId);
    return query;
  });
}

export type RuleTargets = {
  participantIds: string[];
  /** 대상이 0명인 이유 등, 화면에 그대로 보여 줄 한 줄. */
  note: string | null;
};

/**
 * 이 규칙을 지금 돌리면 누가 대상인지.
 * 설정 화면의 미리보기와 실제 발송이 같은 함수를 쓴다 — 미리보기와 결과가 달라지면 안 된다.
 */
export async function collectRuleTargets(
  admin: SupabaseClient,
  rule: Pick<RuleRow, "company_id" | "trigger" | "days">,
): Promise<RuleTargets> {
  const people = await loadPeople(admin, rule.company_id);
  const byId = new Map(people.map((p) => [p.id, p]));
  const cutoff = daysAgoIso(rule.days);

  if (rule.trigger === "미로그인") {
    const targets = people.filter((p) => {
      if (p.account_status !== "초대발송") return false;
      // 진행 현황 화면과 같은 기준: 마지막 접속이 없으면 안내 발송일로 센다.
      const since = p.last_seen_at ?? p.invited_at;
      return since !== null && since <= cutoff;
    });
    const noInvite = people.filter(
      (p) => p.account_status === "초대발송" && !p.last_seen_at && !p.invited_at,
    ).length;
    return {
      participantIds: targets.map((p) => p.id),
      note:
        noInvite > 0
          ? `안내 발송일 기록이 없는 ${noInvite}명은 경과일을 셀 수 없어 대상에서 빠집니다.`
          : null,
    };
  }

  if (rule.trigger === "작성정체" || rule.trigger === "반려미수정") {
    const status = rule.trigger === "작성정체" ? "draft" : "rejected";
    const dateColumn = rule.trigger === "작성정체" ? "updated_at" : "reviewed_at";
    const rows = await fetchAll<{ participant_id: string; company_id: string }>((from, to) => {
      let query = admin
        .from("responses")
        .select("participant_id, company_id")
        .eq("status", status)
        .not(dateColumn, "is", null)
        .lte(dateColumn, cutoff)
        .order("id")
        .range(from, to);
      if (rule.company_id) query = query.eq("company_id", rule.company_id);
      return query;
    });
    const ids = [...new Set(rows.map((r) => r.participant_id))].filter((id) => {
      const person = byId.get(id);
      return person !== undefined && !DONE_STATUSES.includes(person.account_status);
    });
    return {
      participantIds: ids,
      note:
        ids.length === 0 && rows.length > 0
          ? "해당 응답의 작성자는 이미 제출했거나 안내를 보낼 이메일이 없습니다."
          : null,
    };
  }

  // 마감임박: 마감이 다가온 계열사 + 차수를 함께 본다.
  // 계열사 마감은 그 계열사 전원, 차수 마감은 그 차수에 속한 사람(participants.wave_id)만.
  // 며칠 전에 보낼지 (v4): 차수에 독려 안내 일자(reminder_days)가 설정돼 있으면 그 값이
  // 우선이고, 없는 차수는 이 규칙의 값(rule.days)을 따른다. 차수 일정이 있는 사람에게는
  // 계열사 기본값으로 겹쳐 보내지 않는다.
  const { listWaveDeadlinesForReminders } = await import("./wave.functions");
  const [{ data: settings }, waves] = await Promise.all([
    admin.from("survey_settings").select("company_id, deadline"),
    listWaveDeadlinesForReminders(admin),
  ]);
  const today = kstToday();

  const dueCompanies = ((settings ?? []) as { company_id: string; deadline: string | null }[])
    .filter((s) => {
      if (!s.deadline) return false;
      if (rule.company_id && s.company_id !== rule.company_id) return false;
      return daysLeft(s.deadline, today) === rule.days;
    })
    .map((s) => s.company_id);

  const dueWaveIds = waves
    .filter((w) => {
      if (rule.company_id && w.companyId !== rule.company_id) return false;
      const days = w.reminderDays.length > 0 ? w.reminderDays : [rule.days];
      return days.includes(daysLeft(w.deadline, today));
    })
    .map((w) => w.waveId);

  if (dueCompanies.length === 0 && dueWaveIds.length === 0) {
    return {
      participantIds: [],
      note: `오늘은 어느 계열사·차수도 독려를 보낼 시점(계열사는 마감 ${rule.days}일 전, 차수는 각자 설정한 일자)이 아닙니다.`,
    };
  }
  const waveById = new Map(waves.map((w) => [w.waveId, w]));
  const targets = people.filter((p) => {
    if (DONE_STATUSES.includes(p.account_status)) return false;
    // 차수에 독려 일정이 따로 있으면 그 일정만 따른다 — 계열사 기본값과 겹쳐 보내지 않는다.
    const wave = p.wave_id ? waveById.get(p.wave_id) : undefined;
    if (wave && wave.reminderDays.length > 0) return dueWaveIds.includes(wave.waveId);
    if (dueCompanies.includes(p.company_id)) return true;
    return p.wave_id !== null && dueWaveIds.includes(p.wave_id);
  });
  return { participantIds: targets.map((p) => p.id), note: null };
}

export type ReminderRuleRun = {
  ruleId: string;
  name: string;
  status: "성공" | "실패" | "건너뜀";
  sent: number;
  skipped: number;
  /** 건너뛴 이유 또는 상한 안내 — 화면에 그대로 보여 준다. */
  reason?: string;
  error?: string;
};

/** 하루 1회 선점. 이미 오늘 돌았으면 false. */
async function claimToday(admin: SupabaseClient, ruleId: string, runDate: string) {
  const { error } = await admin
    .from("reminder_rule_runs")
    .insert({ rule_id: ruleId, run_date: runDate });
  if (!error) return true;
  // 23505 = unique 위반. 다른 실행이 이미 오늘 자리를 잡았다.
  if ((error as { code?: string }).code === "23505") return false;
  throw new Error(error.message);
}

async function recordRun(
  admin: SupabaseClient,
  ruleId: string,
  runDate: string,
  sent: number,
  skipped: number,
) {
  await admin
    .from("reminder_rule_runs")
    .upsert(
      { rule_id: ruleId, run_date: runDate, sent_count: sent, skipped_count: skipped },
      { onConflict: "rule_id,run_date" },
    );
  await admin
    .from("reminder_rules")
    .update({ last_run_at: new Date().toISOString(), last_sent_count: sent })
    .eq("id", ruleId);
}

/**
 * 독려 규칙 실행.
 * - force 없음: 켜 둔 규칙 전부, 규칙당 하루 1회.
 * - force=true: 관리자가 화면에서 [지금 실행]한 경우. 하루 1회 가드를 넘기고 다시 보낸다.
 */
export async function runReminderRules(
  admin: SupabaseClient,
  opts: { force?: boolean; ruleId?: string; origin?: string | null } = {},
): Promise<ReminderRuleRun[]> {
  const { processBatch, dailyHeadroom } = await import("./mailer.server");

  let query = admin.from("reminder_rules").select(RULE_COLUMNS).order("created_at");
  if (opts.ruleId) query = query.eq("id", opts.ruleId);
  else query = query.eq("enabled", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rules = (data ?? []) as RuleRow[];

  const runDate = kstToday();
  // 전체 발송 상한(설정 화면의 '하루 최대 발송')을 규칙들이 나눠 쓴다.
  const headroom = await dailyHeadroom(admin);
  let budget = headroom.remaining;
  const results: ReminderRuleRun[] = [];

  for (const rule of rules) {
    if (!opts.force && !rule.enabled) continue;

    if (!opts.force) {
      let claimed = false;
      try {
        claimed = await claimToday(admin, rule.id, runDate);
      } catch (err) {
        results.push({
          ruleId: rule.id,
          name: rule.name,
          status: "실패",
          sent: 0,
          skipped: 0,
          error: err instanceof Error ? err.message : "알 수 없는 오류",
        });
        continue;
      }
      if (!claimed) {
        results.push({
          ruleId: rule.id,
          name: rule.name,
          status: "건너뜀",
          sent: 0,
          skipped: 0,
          reason: "오늘 이미 실행했습니다.",
        });
        continue;
      }
    }

    if (!rule.template_id) {
      await recordRun(admin, rule.id, runDate, 0, 0);
      results.push({
        ruleId: rule.id,
        name: rule.name,
        status: "건너뜀",
        sent: 0,
        skipped: 0,
        reason: "보낼 안내 문구를 아직 고르지 않았습니다.",
      });
      continue;
    }

    try {
      const { participantIds, note } = await collectRuleTargets(admin, rule);
      if (participantIds.length === 0) {
        await recordRun(admin, rule.id, runDate, 0, 0);
        results.push({
          ruleId: rule.id,
          name: rule.name,
          status: "건너뜀",
          sent: 0,
          skipped: 0,
          reason: note ?? "지금은 대상이 없습니다.",
        });
        continue;
      }

      const cap = Math.max(0, Math.min(rule.daily_cap, budget));
      const targets = participantIds.slice(0, cap);
      const skipped = participantIds.length - targets.length;

      if (targets.length === 0) {
        await recordRun(admin, rule.id, runDate, 0, skipped);
        results.push({
          ruleId: rule.id,
          name: rule.name,
          status: "건너뜀",
          sent: 0,
          skipped,
          reason: `오늘 발송 여유(${headroom.cap}통 중 ${headroom.sentToday}통 사용)를 다 써서 ${skipped}명을 남겼습니다.`,
        });
        continue;
      }

      const { data: batch, error: batchError } = await admin
        .from("mail_batches")
        .insert({
          name: `독려 안내 · ${rule.name} (${runDate})`,
          template_id: rule.template_id,
          company_id: rule.company_id,
          filters: {
            participantIds: targets,
            ...(rule.company_id ? { companyId: rule.company_id } : {}),
          } as never,
          status: "대기",
        })
        .select("id")
        .single();
      if (batchError || !batch) throw new Error(batchError?.message ?? "발송 준비 실패");

      const res = await processBatch(admin, batch.id, opts.origin ?? null);
      const processed = res.sent + res.simulatedCount;
      budget = Math.max(0, budget - processed);
      await recordRun(admin, rule.id, runDate, processed, skipped);

      results.push({
        ruleId: rule.id,
        name: rule.name,
        status: res.failed > 0 && processed === 0 ? "실패" : "성공",
        sent: processed,
        skipped,
        ...(skipped > 0
          ? { reason: `발송 상한을 넘어 ${skipped}명은 다음 실행으로 넘겼습니다.` }
          : {}),
        ...(res.failed > 0 ? { error: `${res.failed}명에게 보내지 못했습니다.` } : {}),
      });
    } catch (err) {
      results.push({
        ruleId: rule.id,
        name: rule.name,
        status: "실패",
        sent: 0,
        skipped: 0,
        error: err instanceof Error ? err.message : "알 수 없는 오류",
      });
    }
  }

  return results;
}

export type RuleRunLog = {
  rule_id: string;
  run_date: string;
  sent_count: number;
  skipped_count: number;
};

/** 규칙별 마지막 실행 결과. */
export async function lastRuleRuns(admin: SupabaseClient): Promise<RuleRunLog[]> {
  const { data, error } = await admin
    .from("reminder_rule_runs")
    .select("rule_id, run_date, sent_count, skipped_count")
    .order("run_date", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const out: RuleRunLog[] = [];
  for (const row of data ?? []) {
    if (seen.has(row.rule_id)) continue;
    seen.add(row.rule_id);
    out.push(row);
  }
  return out;
}
