// 정기 실행기 (기획 F2).
//
// Cloudflare 무료 플랜은 계정당 cron 5개 상한을 이미 채웠다. 그래서 실행 경로를 HTTP 로 열고
// (POST /api/cron — server.ts) GitHub Actions 가 정해진 시각에 두드린다
// (.github/workflows/cron.yml). CF cron 이 등록된 환경에서는 server.ts 의 scheduled() 도
// 같은 함수를 부르므로 어느 쪽으로 들어와도 결과가 같다.
//
// 어떤 경로로 들어왔든 실행 사실은 cron_runs 에 남긴다 — "한 번도 안 돌았다"와 "돌았는데
// 실패했다"를 화면에서 구분할 수 있어야 한다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const CRON_JOBS = ["scheduled-mail", "reminders", "backup", "report", "cleanup"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

/** 화면에 그대로 나가는 이름. 작업 코드는 표에 노출하지 않는다. */
export const CRON_JOB_LABELS: Record<CronJob, { label: string; desc: string }> = {
  "scheduled-mail": {
    label: "예약 안내 발송",
    desc: "발송 시각이 지난 예약 안내를 보냅니다.",
  },
  reminders: {
    label: "독려 안내",
    desc: "독려 규칙과 계열사 마감 D-N 안내를 보냅니다.",
  },
  backup: {
    label: "자동 백업",
    desc: "응답과 설정 전체를 파일 한 개로 저장합니다.",
  },
  report: {
    label: "진행 리포트",
    desc: "지정한 요일에 진행 현황을 메일로 보냅니다.",
  },
  cleanup: {
    label: "오래된 백업 정리",
    desc: "보존 기간이 지난 백업 파일과 목록을 함께 지웁니다.",
  },
};

export type CronStatus = "성공" | "실패" | "건너뜀";
export type CronOutcome = { status: CronStatus; detail: Record<string, unknown>; error?: string };
export type CronResult = CronOutcome & { job: string; durationMs: number };

export function isCronJob(job: string): job is CronJob {
  return (CRON_JOBS as readonly string[]).includes(job);
}

function message(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류";
}

const JOB_RUNNERS: Record<CronJob, (admin: SupabaseClient) => Promise<CronOutcome>> = {
  "scheduled-mail": async (admin) => {
    const { runScheduledBatches } = await import("./mailer.server");
    const results = await runScheduledBatches(admin, null);
    if (results.length === 0) {
      return {
        status: "건너뜀",
        detail: { 건수: 0, 설명: "보낼 시각이 된 예약 안내가 없습니다." },
      };
    }
    const sent = results.reduce((sum, r) => sum + (r.sent ?? 0), 0);
    const broken = results.filter((r) => r.error);
    const detail = { 건수: results.length, 발송: sent, 실패: broken.length };
    if (broken.length === 0) return { status: "성공", detail };
    return { status: "실패", detail, error: broken.map((r) => r.error).join(" / ") };
  },

  reminders: async (admin) => {
    const { runReminderRules } = await import("./reminders.server");
    const { runReminders } = await import("./mailer.server");

    // 규칙 기반(F4)과 계열사 마감 D-N(기존 자동 독려)은 서로 독립이다. 한쪽이 터져도
    // 나머지는 보내고, 실패는 결과에 남긴다.
    const problems: string[] = [];
    let ruleSent = 0;
    let ruleSkipped = 0;
    let ruleCount = 0;
    try {
      const runs = await runReminderRules(admin, {});
      ruleCount = runs.length;
      ruleSent = runs.reduce((sum, r) => sum + r.sent, 0);
      ruleSkipped = runs.reduce((sum, r) => sum + r.skipped, 0);
      for (const r of runs) if (r.error) problems.push(`${r.name}: ${r.error}`);
    } catch (err) {
      problems.push(`독려 규칙: ${message(err)}`);
    }

    let deadlineSent = 0;
    try {
      const res = await runReminders(admin, { origin: null });
      deadlineSent = res.reduce((sum, r) => sum + r.sent, 0);
    } catch (err) {
      problems.push(`마감 안내: ${message(err)}`);
    }

    const detail = {
      건수: ruleSent + deadlineSent,
      규칙: ruleCount,
      "규칙 발송": ruleSent,
      "상한으로 남긴 대상": ruleSkipped,
      "마감 안내 발송": deadlineSent,
    };
    if (problems.length > 0) return { status: "실패", detail, error: problems.join(" / ") };
    if (ruleSent + deadlineSent === 0) {
      return { status: "건너뜀", detail: { ...detail, 설명: "오늘 보낼 대상이 없습니다." } };
    }
    return { status: "성공", detail };
  },

  backup: async (admin) => {
    const { createBackup } = await import("./backup.server");
    const res = await createBackup(admin, "자동");
    return {
      status: "성공",
      detail: {
        건수: res.totalRows,
        파일: res.path,
        용량: `${Math.round(res.sizeBytes / 1024)}KB`,
      },
    };
  },

  report: async (admin) => {
    const { sendProgressReport } = await import("./report.server");
    return sendProgressReport(admin);
  },

  cleanup: async (admin) => {
    const { deleteExpiredBackups } = await import("./backup.server");
    const res = await deleteExpiredBackups(admin);
    return {
      status: "성공",
      detail: { 건수: res.deleted, 보존기간: `${res.retentionDays}일`, 남은: res.remaining },
    };
  },
};

/**
 * 작업 하나를 실행하고 결과를 cron_runs 에 남긴다.
 * 던지지 않는다 — 실패도 결과값으로 돌려주므로 호출자가 나머지 작업을 계속할 수 있다.
 */
export async function runCronJob(job: string): Promise<CronResult> {
  const startedAt = new Date();
  let outcome: CronOutcome;

  if (!isCronJob(job)) {
    outcome = { status: "실패", detail: {}, error: `모르는 작업 이름입니다: ${job}` };
  } else {
    try {
      outcome = await JOB_RUNNERS[job](supabaseAdmin);
    } catch (err) {
      outcome = { status: "실패", detail: {}, error: message(err) };
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // 기록이 실패해도 실행 결과는 돌려준다. 여기서 던지면 뒤 작업까지 멈춘다.
  try {
    const { error } = await supabaseAdmin.from("cron_runs").insert({
      job,
      status: outcome.status,
      detail: outcome.detail as never,
      error_message: outcome.error ?? null,
      duration_ms: durationMs,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
    });
    if (error) console.error("정기 실행 기록 실패", error.message);
  } catch (err) {
    console.error("정기 실행 기록 실패", err);
  }

  return { job, durationMs, ...outcome };
}

/** 여러 작업을 순서대로 실행한다. 하나가 실패해도 나머지는 계속 돈다. */
export async function runAllCronJobs(jobs?: string[]): Promise<CronResult[]> {
  const list = jobs?.length ? jobs : [...CRON_JOBS];
  const results: CronResult[] = [];
  for (const job of list) results.push(await runCronJob(job));
  return results;
}
