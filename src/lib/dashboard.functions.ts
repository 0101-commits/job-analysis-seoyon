// v2.1 관리자 대시보드 집계: 조직 트리 현황(getOrgOverview) + 정합성 점검(checkIntegrity)
// + 개시 준비 점검(getLaunchReadiness). 롤업 계산은 클라이언트(admin/index.tsx)가 담당하고
// 여기서는 원천 행만 service_role 로 모아 준다(participants RLS·types.ts 미갱신 컬럼 회피).
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ROLE_LEVELS } from "@/lib/settings.functions";
import { fetchAll } from "./paginate";

/**
 * participants.org_unit_id / survey_settings.stale_days / example_library.job_group_key 는
 * 마이그레이션에만 있고 생성형 types.ts 에는 아직 없다(master.functions.ts 와 같은 사정).
 * ponytail: types.ts 재생성 시 이 캐스팅을 지울 것.
 */
function untyped(admin: unknown) {
  return admin as SupabaseClient;
}

/* ───────────────────────── 조직별 현황 원천 데이터 ───────────────────────── */

export type OverviewParticipant = {
  id: string;
  name: string;
  emp_no: string;
  company_id: string;
  org_unit_id: string | null;
  org_text: string | null;
  account_status: string;
  role: string;
  invited_at: string | null;
  last_seen_at: string | null;
  /** F8 조사 차수. 이 사람이 지금 속한 차수 — 차수 필터의 판정 기준. */
  wave_id: string | null;
};

export type OverviewUnit = {
  id: string;
  company_id: string;
  parent_id: string | null;
  name: string;
  level: string | null;
  sort: number;
};

export type OrgOverview = {
  companies: { id: string; name: string }[];
  units: OverviewUnit[];
  participants: OverviewParticipant[];
  /** stale_days 미설정 계열사는 기본 7일. */
  settings: { company_id: string; deadline: string | null; stale_days: number }[];
};

export const getOrgOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OrgOverview> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = untyped(supabaseAdmin);

    const [{ data: companies }, { data: units }, { data: settings }] = await Promise.all([
      // v4: 운영 중(active) 계열사만 — 중지된 계열사는 화면에서 빠진다 (companies.ts 참조).
      admin.from("companies").select("id, name").eq("status", "active").order("created_at"),
      admin.from("org_units").select("id, company_id, parent_id, name, level, sort"),
      admin.from("survey_settings").select("company_id, deadline, stale_days"),
    ]);

    // 전사 스코프는 1000행을 넘을 수 있어 페이지를 이어 받는다. 보관자는 집계에서 제외.
    const participants: OverviewParticipant[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await admin
        .from("participants")
        .select(
          "id, name, emp_no, company_id, org_unit_id, org_text, account_status, role, invited_at, last_seen_at, wave_id",
        )
        .is("archived_at", null)
        .order("id")
        .range(from, from + page - 1);
      if (error) throw new Error(error.message);
      participants.push(...((data ?? []) as OverviewParticipant[]));
      if ((data ?? []).length < page) break;
    }

    return {
      companies: companies ?? [],
      units: (units ?? []) as OverviewUnit[],
      participants,
      settings: (
        (settings ?? []) as {
          company_id: string;
          deadline: string | null;
          stale_days: number | null;
        }[]
      ).map((s) => ({ ...s, stale_days: s.stale_days ?? 7 })),
    };
  });

/* ───────────────────────── 정합성 점검 (V14-②) ───────────────────────── */

export type IntegrityCheck = {
  key: string;
  label: string;
  count: number;
  /** 화면에 보여줄 표본(최대 20건). count 가 더 크면 「외 n건」으로 안내한다. */
  items: string[];
  link: string;
  linkLabel: string;
};

export type IntegrityReport = { total: number; checks: IntegrityCheck[] };

const SAMPLE_LIMIT = 20;
/** 반려 직후 status 변경 트리거가 updated_at 을 살짝 올리므로, 이 이내 갱신은 무응답으로 본다. */
const REJECT_TOUCH_MS = 5 * 60 * 1000;
const REJECT_STALE_MS = 7 * 86_400_000;

export const checkIntegrity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<IntegrityReport> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = untyped(supabaseAdmin);

    const [
      { data: unassigned },
      { data: responses },
      { data: catalog },
      { data: system },
      { data: examples },
      { data: rejects },
      { data: people },
    ] = await Promise.all([
      admin
        .from("participants")
        .select("name, emp_no")
        .eq("role", "respondent")
        .is("archived_at", null)
        .is("org_unit_id", null)
        .order("emp_no")
        .limit(2000),
      admin
        .from("responses")
        .select("id, participant_id, job_group, job_name, status, updated_at, participants(name)")
        .neq("status", "draft")
        .limit(5000),
      admin.from("job_catalog").select("job_name"),
      admin.from("system_settings").select("role_levels").maybeSingle(),
      admin.from("example_library").select("job_group_key"),
      admin
        .from("review_comments")
        .select("response_id, created_at")
        .eq("kind", "reject")
        .order("created_at", { ascending: false })
        .limit(5000),
      admin
        .from("participants")
        .select("name, emp_no, role_level")
        .is("archived_at", null)
        .not("role_level", "is", null)
        .limit(5000),
    ]);

    type ResponseRow = {
      id: string;
      participant_id: string;
      job_group: string | null;
      job_name: string | null;
      status: string;
      updated_at: string;
      participants: { name: string } | null;
    };
    // to-one 관계(participants)는 런타임에 객체로 오지만 untyped 추론은 배열로 본다.
    const responseRows = (responses ?? []) as unknown as ResponseRow[];

    // ⑴ 조직 미배정
    const unassignedRows = (unassigned ?? []) as { name: string; emp_no: string }[];

    // ⑵ 직무분류표에 없는 직무명
    const catalogNames = new Set(
      ((catalog ?? []) as { job_name: string }[]).map((c) => c.job_name.trim()),
    );
    const unknownJobs = responseRows.filter((r) => {
      const name = (r.job_name ?? "").trim();
      return name !== "" && !catalogNames.has(name);
    });

    // ⑶ 현행 역할단계 목록에 없는 role_level
    const roleLevels = new Set(
      ((system as { role_levels?: string[] } | null)?.role_levels?.length
        ? (system as { role_levels: string[] }).role_levels
        : DEFAULT_ROLE_LEVELS
      ).map((v) => v.trim()),
    );
    const badRoleLevels = (
      (people ?? []) as {
        name: string;
        emp_no: string;
        role_level: string;
      }[]
    ).filter((p) => p.role_level.trim() !== "" && !roleLevels.has(p.role_level.trim()));

    // ⑷ 예시 직군(job_group_key)과 매칭되지 않는 직군 응답
    const exampleKeys = new Set(
      ((examples ?? []) as { job_group_key: string | null }[])
        .map((e) => (e.job_group_key ?? "").trim())
        .filter((k) => k !== ""),
    );
    const unmatchedGroups = responseRows.filter((r) => {
      const group = (r.job_group ?? "").trim();
      return group !== "" && !exampleKeys.has(group);
    });

    // ⑸ 반려 후 7일 무응답: 마지막 reject 이후 updated_at 이 안 움직인 rejected 응답
    const lastRejectByResponse = new Map<string, string>();
    for (const c of (rejects ?? []) as { response_id: string; created_at: string }[]) {
      if (!lastRejectByResponse.has(c.response_id)) {
        lastRejectByResponse.set(c.response_id, c.created_at);
      }
    }
    const now = Date.now();
    const stalledRejects = responseRows.filter((r) => {
      if (r.status !== "rejected") return false;
      const rejectedAt = lastRejectByResponse.get(r.id);
      if (!rejectedAt) return false;
      const rejectedMs = new Date(rejectedAt).getTime();
      return (
        now - rejectedMs >= REJECT_STALE_MS &&
        new Date(r.updated_at).getTime() <= rejectedMs + REJECT_TOUCH_MS
      );
    });

    const person = (p: { name: string; emp_no: string }) => `${p.name}(${p.emp_no})`;
    const checks: IntegrityCheck[] = [
      {
        key: "unassigned",
        label: "조직 미배정 참여자",
        count: unassignedRows.length,
        items: unassignedRows.slice(0, SAMPLE_LIMIT).map(person),
        link: "/admin/participants",
        linkLabel: "참여자 관리에서 배정",
      },
      {
        key: "unknownJob",
        label: "직무분류표에 없는 직무명 응답",
        count: unknownJobs.length,
        items: unknownJobs
          .slice(0, SAMPLE_LIMIT)
          .map((r) => `${r.participants?.name ?? "?"} — ${r.job_name}`),
        link: "/admin/master",
        linkLabel: "마스터 관리에서 매핑",
      },
      {
        key: "badRoleLevel",
        label: "현행 역할단계에 없는 참여자",
        count: badRoleLevels.length,
        items: badRoleLevels.slice(0, SAMPLE_LIMIT).map((p) => `${person(p)} — ${p.role_level}`),
        link: "/admin/settings",
        linkLabel: "설정에서 역할단계 확인",
      },
      {
        key: "unmatchedExample",
        label: "예시 직군과 매칭되지 않는 직군 응답",
        count: unmatchedGroups.length,
        items: unmatchedGroups
          .slice(0, SAMPLE_LIMIT)
          .map((r) => `${r.participants?.name ?? "?"} — ${r.job_group}`),
        link: "/admin/master",
        linkLabel: "마스터 관리에서 확인",
      },
      {
        key: "stalledReject",
        label: "반려 후 7일 무응답",
        count: stalledRejects.length,
        items: stalledRejects.slice(0, SAMPLE_LIMIT).map((r) => r.participants?.name ?? "?"),
        link: "/admin/review",
        linkLabel: "검토 화면에서 확인",
      },
    ];

    return { total: checks.reduce((sum, c) => sum + c.count, 0), checks };
  });

/* ───────────────────────── 개시 준비 점검 (V15-8) ───────────────────────── */

export type ReadinessItem = { key: string; label: string; ok: boolean; hint: string | null };

export const getLaunchReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ready: boolean; items: ReadinessItem[] }> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { isSimulationMode } = await import("@/lib/mailer.server");
    const admin = untyped(supabaseAdmin);

    const [orgUnits, jobCatalog, participants, { data: settings }, testLogs, lastCron, lastBackup] =
      await Promise.all([
        admin.from("org_units").select("id", { count: "exact", head: true }),
        admin.from("job_catalog").select("id", { count: "exact", head: true }),
        admin
          .from("participants")
          .select("id", { count: "exact", head: true })
          .is("archived_at", null),
        admin.from("survey_settings").select("deadline"),
        // 테스트 발송은 배치 없이 to_name='테스트 발송' 으로 기록된다(mail.functions.ts).
        admin
          .from("mail_logs")
          .select("id", { count: "exact", head: true })
          .eq("to_name", "테스트 발송"),
        // F2 스케줄 실행 이력·F3 자동 백업 — 이 화면은 읽기만 한다(채우는 쪽은 다른 담당).
        admin
          .from("cron_runs")
          .select("job, status, started_at")
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from("backups")
          .select("id, created_at")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const hasDeadline = ((settings ?? []) as { deadline: string | null }[]).some(
      (s) => s.deadline !== null,
    );
    const simulation = isSimulationMode();

    const items: ReadinessItem[] = [
      {
        key: "org",
        label: "조직도 등록",
        ok: (orgUnits.count ?? 0) > 0,
        hint: "마스터 관리에서 조직도를 업로드하세요.",
      },
      {
        key: "jobs",
        label: "직무분류표 등록",
        ok: (jobCatalog.count ?? 0) > 0,
        hint: "마스터 관리에서 직무분류표를 업로드하세요.",
      },
      {
        key: "deadline",
        label: "마감일 설정",
        ok: hasDeadline,
        hint: "설정에서 계열사별 마감일을 지정하세요.",
      },
      {
        key: "mail",
        label: "메일 실발송 모드",
        ok: !simulation,
        hint: "RESEND 키가 없어 테스트 모드입니다. 실발송 설정이 필요합니다.",
      },
      {
        key: "roster",
        label: "참여자 업로드",
        ok: (participants.count ?? 0) > 0,
        hint: "참여자 관리에서 명부를 업로드하세요.",
      },
      {
        key: "testMail",
        label: "테스트 발송 이력",
        ok: (testLogs.count ?? 0) > 0,
        hint: "메일 화면에서 본인에게 테스트 발송을 해 보세요.",
      },
      {
        key: "cronRun",
        label: "정기 실행 최근 성공",
        ok: lastCron.data?.status === "성공",
        hint:
          lastCron.data === null
            ? "기록 없음 — 아직 정기 작업이 실행된 적이 없습니다."
            : `최근 실행이 '${lastCron.data.status}'로 끝났습니다(${lastCron.data.job}, ${lastCron.data.started_at}).`,
      },
      {
        key: "backup",
        label: "자동 백업 최근 성공",
        ok: lastBackup.data !== null,
        hint: "기록 없음 — 아직 자동 백업이 실행된 적이 없습니다.",
      },
    ];

    return {
      ready: items.every((i) => i.ok),
      items: items.map((i) => ({ ...i, hint: i.ok ? null : i.hint })),
    };
  });

/* ───────────────────── 알림 카드의 근거 원천 (기획 B2·B8) ───────────────────── */

/**
 * SignalCard 는 신호·근거·행동 셋을 다 채워야 렌더된다. 근거에 들어갈 「기준 시점」과
 * 「모수」를 화면이 스스로 만들 수 없으므로, 판단에 필요한 원천 행을 여기서 모아 준다.
 * 조직·회사 스코프 계산은 참여자 행을 이미 들고 있는 화면이 담당한다(getOrgOverview 와 같은 분업).
 */
export type SignalResponse = {
  id: string;
  participant_id: string;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
};

export type DashboardSignals = {
  /** 이 집계의 기준 시점(ISO). 카드마다 「기준 …」으로 표시한다. */
  asOf: string;
  responses: SignalResponse[];
  /**
   * 미확정 AI 초안이 남아 승인이 막힌 제출 응답 id.
   * 판정 조건은 approveResponse 의 게이트 1(response_skills/requirements.ai_draft)과 같다.
   */
  aiBlockedResponseIds: string[];
  /** 발송 실패 로그 — 최근 것부터. */
  failedMails: { id: string; participant_id: string | null; sent_at: string }[];
  /** 제출 → 검토 처리(승인·반려) 평균 소요일. 처리 이력이 없으면 null. */
  reviewTurnaroundDays: number | null;
  /** F6 문의함 — 아직 답변하지 않은 문의(status='접수'). */
  openInquiries: { id: string; participant_id: string; category: string; created_at: string }[];
  /** F10 변경 재확인 — 참여자가 아직 확인 처리하지 않은 응답. */
  recheckResponses: { id: string; participant_id: string }[];
};

export const getDashboardSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DashboardSignals> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = untyped(supabaseAdmin);

    const [
      responses,
      draftSkills,
      draftRequirements,
      failedMails,
      openInquiries,
      recheckResponses,
    ] = await Promise.all([
      fetchAll<SignalResponse>((from, to) =>
        admin
          .from("responses")
          .select("id, participant_id, status, submitted_at, reviewed_at")
          .order("id")
          .range(from, to),
      ),
      fetchAll<{ response_id: string }>((from, to) =>
        admin
          .from("response_skills")
          .select("response_id")
          .eq("ai_draft", true)
          .order("response_id")
          .range(from, to),
      ),
      fetchAll<{ response_id: string }>((from, to) =>
        admin
          .from("response_requirements")
          .select("response_id")
          .eq("ai_draft", true)
          .order("response_id")
          .range(from, to),
      ),
      fetchAll<{ id: string; participant_id: string | null; sent_at: string }>((from, to) =>
        admin
          .from("mail_logs")
          .select("id, participant_id, sent_at")
          .eq("status", "실패")
          .order("sent_at", { ascending: false })
          .order("id")
          .range(from, to),
      ),
      fetchAll<{ id: string; participant_id: string; category: string; created_at: string }>(
        (from, to) =>
          admin
            .from("inquiries")
            .select("id, participant_id, category, created_at")
            .eq("status", "접수")
            .order("created_at", { ascending: false })
            .order("id")
            .range(from, to),
      ),
      fetchAll<{ id: string; participant_id: string }>((from, to) =>
        admin
          .from("responses")
          .select("id, participant_id")
          .eq("recheck_required", true)
          .order("id")
          .range(from, to),
      ),
    ]);

    // 승인 게이트는 제출 상태에서만 의미가 있다. 초안·반려 건의 AI 초안은 아직 막는 것이 없다.
    const submittedIds = new Set(
      responses.filter((r) => r.status === "submitted").map((r) => r.id),
    );
    const aiBlocked = new Set<string>();
    for (const row of [...draftSkills, ...draftRequirements]) {
      if (submittedIds.has(row.response_id)) aiBlocked.add(row.response_id);
    }

    // 평균 검토 소요일 — 「이 건이 오래 걸렸다」를 말하려면 비교 기준이 있어야 한다.
    let elapsedSum = 0;
    let elapsedCount = 0;
    for (const r of responses) {
      if (!r.submitted_at || !r.reviewed_at) continue;
      const days = (Date.parse(r.reviewed_at) - Date.parse(r.submitted_at)) / 86_400_000;
      if (days < 0) continue;
      elapsedSum += days;
      elapsedCount += 1;
    }

    return {
      asOf: new Date().toISOString(),
      responses,
      aiBlockedResponseIds: [...aiBlocked],
      failedMails,
      reviewTurnaroundDays:
        elapsedCount > 0 ? Math.round((elapsedSum / elapsedCount) * 10) / 10 : null,
      openInquiries,
      recheckResponses,
    };
  });

/* ───────────────── 화면별 경고 묶음 (v6 G4 — 메뉴 배지·상단 경고) ───────────────── */

/**
 * 「확인할 일」을 대시보드 카드 대신 각 화면 상단 경고와 메뉴 배지로 보낸다.
 * 화면(ScreenAlert)과 메뉴(AdminShell)가 같은 쿼리를 공유하므로 여기서 한 번만 센다.
 * count 가 0인 항목은 아예 돌려주지 않는다 — 받는 쪽은 "있으면 그린다"만 하면 된다.
 */
export type ScreenSignalItem = {
  key: string;
  label: string;
  count: number;
  href: string;
  /** critical 은 발송 실패처럼 방치하면 사람이 조사에서 빠지는 것. 나머지는 attention. */
  tone: "attention" | "critical";
};

export type ScreenSignals = {
  asOf: string;
  review: ScreenSignalItem[];
  ai: ScreenSignalItem[];
  mail: ScreenSignalItem[];
  participants: ScreenSignalItem[];
};

/** 아직 작성을 시작하지 않은 계정 상태 — index.tsx 의 NOT_STARTED 와 같은 정의. */
const SIGNAL_NOT_STARTED = ["미발송", "초대발송", "미접속"];

export const screenSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ScreenSignals> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = untyped(supabaseAdmin);

    const [
      people,
      settings,
      submitted,
      draftSkills,
      draftRequirements,
      failed,
      inquiries,
      rechecks,
    ] = await Promise.all([
      fetchAll<{
        company_id: string;
        account_status: string;
        invited_at: string | null;
        last_seen_at: string | null;
        mail_bounced_at: string | null;
      }>((from, to) =>
        admin
          .from("participants")
          .select("company_id, account_status, invited_at, last_seen_at, mail_bounced_at")
          .eq("role", "respondent")
          .is("archived_at", null)
          .order("id")
          .range(from, to),
      ),
      admin.from("survey_settings").select("company_id, stale_days"),
      // 검토 적체·AI 게이트의 모수 — 제출 상태 응답만.
      fetchAll<{
        id: string;
        submitted_at: string | null;
        participants: { company_id: string } | null;
      }>(async (from, to) => {
        const { data, error } = await admin
          .from("responses")
          .select("id, submitted_at, participants(company_id)")
          .eq("status", "submitted")
          .order("id")
          .range(from, to);
        // to-one 관계는 런타임에 객체로 오지만 untyped 추론은 배열로 본다.
        return {
          data: (data ?? []) as unknown as {
            id: string;
            submitted_at: string | null;
            participants: { company_id: string } | null;
          }[],
          error,
        };
      }),
      fetchAll<{ response_id: string }>((from, to) =>
        admin
          .from("response_skills")
          .select("response_id")
          .eq("ai_draft", true)
          .order("response_id")
          .range(from, to),
      ),
      fetchAll<{ response_id: string }>((from, to) =>
        admin
          .from("response_requirements")
          .select("response_id")
          .eq("ai_draft", true)
          .order("response_id")
          .range(from, to),
      ),
      admin.from("mail_logs").select("id", { count: "exact", head: true }).eq("status", "실패"),
      admin.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "접수"),
      admin
        .from("responses")
        .select("id", { count: "exact", head: true })
        .eq("recheck_required", true),
    ]);

    const staleDaysBy = new Map(
      ((settings.data ?? []) as { company_id: string; stale_days: number | null }[]).map((s) => [
        s.company_id,
        s.stale_days ?? 7,
      ]),
    );
    const now = Date.now();
    const daysOld = (value: string | null) =>
      value === null ? null : Math.floor((now - new Date(value).getTime()) / 86_400_000);

    // ⑴ 미착수 정체 — 안내는 받았는데 기준일 이상 움직임이 없는 사람.
    const stalledNotStarted = people.filter((p) => {
      if (!SIGNAL_NOT_STARTED.includes(p.account_status)) return false;
      const elapsed = daysOld(p.last_seen_at ?? p.invited_at);
      return elapsed !== null && elapsed >= (staleDaysBy.get(p.company_id) ?? 7);
    }).length;

    // ⑵ 메일 반송 — 주소를 고치기 전에는 어떤 안내도 닿지 않는다.
    const bounced = people.filter((p) => p.mail_bounced_at !== null).length;

    // ⑶ 검토 적체 — 제출 후 그 계열사 기준일이 지나도록 판정이 없는 응답.
    const backlog = submitted.filter((r) => {
      const elapsed = daysOld(r.submitted_at);
      const limit = staleDaysBy.get(r.participants?.company_id ?? "") ?? 7;
      return elapsed !== null && elapsed >= limit;
    }).length;

    // ⑷ 미확정 AI 제안 — 승인 게이트에 걸린 제출 응답만 (approveResponse 게이트 1과 같은 판정).
    const submittedIds = new Set(submitted.map((r) => r.id));
    const aiBlocked = new Set<string>();
    for (const row of [...draftSkills, ...draftRequirements]) {
      if (submittedIds.has(row.response_id)) aiBlocked.add(row.response_id);
    }

    const item = (
      key: string,
      label: string,
      count: number,
      href: string,
      tone: ScreenSignalItem["tone"] = "attention",
    ): ScreenSignalItem[] => (count > 0 ? [{ key, label, count, href, tone }] : []);

    return {
      asOf: new Date().toISOString(),
      review: [
        ...item("backlog", "기준일을 넘긴 검토 대기", backlog, "/admin/review?status=submitted"),
        ...item(
          "inquiry",
          "답변을 기다리는 문의",
          inquiries.count ?? 0,
          "/admin/review?tab=inquiry",
        ),
      ],
      ai: [...item("aiDraft", "승인을 막고 있는 미확정 AI 제안", aiBlocked.size, "/admin/ai")],
      mail: [
        ...item("failed", "발송 실패", failed.count ?? 0, "/admin/mail?tab=history", "critical"),
        ...item("bounced", "메일 반송 참여자", bounced, "/admin/participants"),
      ],
      participants: [
        ...item(
          "stalled",
          "안내 후 움직임이 없는 미착수",
          stalledNotStarted,
          "/admin/participants?status=초대발송,미접속",
        ),
        ...item(
          "recheck",
          "변경 재확인 대기",
          rechecks.count ?? 0,
          "/admin/participants?recheck=1",
        ),
      ],
    };
  });
