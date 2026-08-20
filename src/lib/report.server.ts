// 진행 리포트 자동 발송 (기획 F5).
//
// 지정한 요일에 관리자에게 "지금 어디까지 왔는지"를 메일로 보낸다.
// 집계 기준은 관리자 대시보드(dashboard.functions.ts)와 같은 원천 표를 그대로 쓴다.
// 대시보드 함수는 로그인 문맥이 필요한 서버함수라서 정기 실행에서는 부를 수 없어,
// 같은 표를 같은 기준으로 다시 센다(기준이 갈리지 않게 판정 규칙을 주석으로 못 박아 둔다).

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./paginate";
import type { CronOutcome } from "./cron.server";

/** 대시보드와 동일: 이 상태면 참여자 몫은 끝난 것으로 본다. */
const DONE_STATUSES = ["제출", "승인"];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const NAME_LIMIT = 15;

function kstNow(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS);
}

function kstToday(now = Date.now()) {
  return kstNow(now).toISOString().slice(0, 10);
}

function formatDate(iso: string) {
  const [, month, day] = iso.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

export const WEEKDAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

type Settings = {
  report_enabled?: boolean;
  report_weekday?: number;
  report_recipients?: string[];
};

export type ReportBody = { subject: string; body: string; totals: Record<string, number> };

/** 메일 본문을 만든다. 화면 미리보기와 실제 발송이 같은 함수를 쓴다. */
export async function buildProgressReport(admin: SupabaseClient): Promise<ReportBody> {
  const today = kstToday();
  const [{ data: companies }, { data: settings }, people, responses] = await Promise.all([
    admin.from("companies").select("id, name").order("created_at"),
    admin.from("survey_settings").select("company_id, deadline"),
    fetchAll<{ id: string; name: string; company_id: string; account_status: string }>((from, to) =>
      admin
        .from("participants")
        .select("id, name, company_id, account_status")
        .eq("role", "respondent")
        .is("archived_at", null)
        .order("id")
        .range(from, to),
    ),
    fetchAll<{
      id: string;
      company_id: string;
      status: string;
      submitted_at: string | null;
      reviewed_at: string | null;
    }>((from, to) =>
      admin
        .from("responses")
        .select("id, company_id, status, submitted_at, reviewed_at")
        .order("id")
        .range(from, to),
    ),
  ]);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const twoWeeksAgo = Date.now() - 14 * 86_400_000;
  const submittedThisWeek = responses.filter(
    (r) => r.submitted_at && Date.parse(r.submitted_at) >= weekAgo,
  ).length;
  const submittedLastWeek = responses.filter(
    (r) =>
      r.submitted_at &&
      Date.parse(r.submitted_at) >= twoWeeksAgo &&
      Date.parse(r.submitted_at) < weekAgo,
  ).length;

  // 검토 적체: 제출됐지만 아직 승인·반려되지 않은 응답.
  const waiting = responses.filter((r) => r.status === "submitted" && !r.reviewed_at);
  const oldestWaitDays = waiting.reduce((max, r) => {
    if (!r.submitted_at) return max;
    const days = Math.floor((Date.now() - Date.parse(r.submitted_at)) / 86_400_000);
    return Math.max(max, days);
  }, 0);

  const lines: string[] = [`${formatDate(today)} 기준 업무조사 진행 현황입니다.`, ""];
  let totalPeople = 0;
  let totalDone = 0;

  for (const company of companies ?? []) {
    const members = people.filter((p) => p.company_id === company.id);
    if (members.length === 0) continue;
    const done = members.filter((p) => DONE_STATUSES.includes(p.account_status));
    const rate = Math.round((done.length / members.length) * 1000) / 10;
    totalPeople += members.length;
    totalDone += done.length;

    const deadline = ((settings ?? []) as { company_id: string; deadline: string | null }[]).find(
      (s) => s.company_id === company.id,
    )?.deadline;
    const dday = deadline
      ? Math.round(
          (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
        )
      : null;

    lines.push(`■ ${company.name}`);
    lines.push(`  응답률 ${rate}% (${members.length}명 중 ${done.length}명 제출)`);
    if (dday === null) lines.push("  제출 마감: 아직 정하지 않았습니다.");
    else if (dday > 0) lines.push(`  제출 마감: ${deadline} (${dday}일 남음)`);
    else if (dday === 0) lines.push(`  제출 마감: ${deadline} (오늘)`);
    else lines.push(`  제출 마감: ${deadline} (${Math.abs(dday)}일 지남)`);

    const pending = members.filter((p) => !DONE_STATUSES.includes(p.account_status));
    if (pending.length === 0) {
      lines.push("  미제출: 없습니다.");
    } else {
      const names = pending
        .slice(0, NAME_LIMIT)
        .map((p) => p.name)
        .join(", ");
      const more = pending.length > NAME_LIMIT ? ` 외 ${pending.length - NAME_LIMIT}명` : "";
      lines.push(`  미제출 ${pending.length}명: ${names}${more}`);
    }
    lines.push("");
  }

  const diff = submittedThisWeek - submittedLastWeek;
  const diffText =
    diff > 0 ? `${diff}건 늘었습니다` : diff < 0 ? `${Math.abs(diff)}건 줄었습니다` : "같습니다";
  lines.push("■ 전체");
  lines.push(
    `  응답률 ${totalPeople > 0 ? Math.round((totalDone / totalPeople) * 1000) / 10 : 0}% (${totalPeople}명 중 ${totalDone}명 제출)`,
  );
  lines.push(
    `  최근 7일 제출 ${submittedThisWeek}건 — 그 전 7일(${submittedLastWeek}건) 대비 ${diffText}.`,
  );
  lines.push(
    waiting.length === 0
      ? "  검토 대기: 없습니다."
      : `  검토 대기 ${waiting.length}건 (가장 오래 기다린 건 ${oldestWaitDays}일)`,
  );

  return {
    subject: `[업무조사] 진행 리포트 (${formatDate(today)} 기준)`,
    body: lines.join("\n"),
    totals: {
      참여자: totalPeople,
      제출: totalDone,
      "검토 대기": waiting.length,
      "최근 7일 제출": submittedThisWeek,
    },
  };
}

/**
 * 리포트 발송.
 * - 자동(정기 실행): 켜져 있고, 오늘이 지정 요일이고, 수신자가 있을 때만 보낸다.
 * - force=true: 관리자가 화면에서 [지금 보내기]를 누른 경우 — 요일 조건을 넘긴다.
 */
export async function sendProgressReport(
  admin: SupabaseClient,
  opts: { force?: boolean } = {},
): Promise<CronOutcome> {
  const { data } = await admin.from("system_settings").select("*").maybeSingle();
  const settings = (data ?? {}) as Settings;
  const recipients = (settings.report_recipients ?? []).filter((v) => v.trim() !== "");
  const weekday = settings.report_weekday ?? 1;

  if (!opts.force && !settings.report_enabled) {
    return { status: "건너뜀", detail: { 설명: "진행 리포트 자동 발송이 꺼져 있습니다." } };
  }
  if (!opts.force) {
    const todayWeekday = kstNow().getUTCDay();
    if (todayWeekday !== weekday) {
      return {
        status: "건너뜀",
        detail: { 설명: `보내는 날이 ${WEEKDAY_NAMES[weekday]}이라 오늘은 보내지 않았습니다.` },
      };
    }
  }
  if (recipients.length === 0) {
    return { status: "건너뜀", detail: { 설명: "받을 사람을 아직 정하지 않았습니다." } };
  }

  const { sendMail, isSimulationMode } = await import("./mailer.server");
  const report = await buildProgressReport(admin);

  if (isSimulationMode()) {
    return {
      status: "건너뜀",
      detail: {
        설명: "지금은 실제로 발송되지 않는 연습 모드입니다.",
        받을사람: recipients.length,
        ...report.totals,
      },
    };
  }

  let sent = 0;
  const failures: string[] = [];
  for (const to of recipients) {
    try {
      await sendMail(to, report.subject, report.body);
      sent += 1;
    } catch (err) {
      failures.push(`${to}: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    }
  }

  const detail = { 건수: sent, 받을사람: recipients.length, ...report.totals };
  if (failures.length > 0) {
    return {
      status: sent > 0 ? "성공" : "실패",
      detail: { ...detail, 실패: failures.length },
      error: failures.join(" / "),
    };
  }
  return { status: "성공", detail };
}
