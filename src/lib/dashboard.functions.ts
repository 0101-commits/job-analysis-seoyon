// v2.1 관리자 대시보드 집계: 조직 트리 현황(getOrgOverview) + 정합성 점검(checkIntegrity)
// + 개시 준비 점검(getLaunchReadiness). 롤업 계산은 클라이언트(admin/index.tsx)가 담당하고
// 여기서는 원천 행만 service_role 로 모아 준다(participants RLS·types.ts 미갱신 컬럼 회피).
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ROLE_LEVELS } from "@/lib/settings.functions";

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
      admin.from("companies").select("id, name").order("created_at"),
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
          "id, name, emp_no, company_id, org_unit_id, org_text, account_status, role, invited_at, last_seen_at",
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
      settings: ((settings ?? []) as {
        company_id: string;
        deadline: string | null;
        stale_days: number | null;
      }[]).map((s) => ({ ...s, stale_days: s.stale_days ?? 7 })),
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
    const badRoleLevels = ((people ?? []) as {
      name: string;
      emp_no: string;
      role_level: string;
    }[]).filter((p) => p.role_level.trim() !== "" && !roleLevels.has(p.role_level.trim()));

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

    const [orgUnits, jobCatalog, participants, { data: settings }, testLogs] = await Promise.all([
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
    ];

    return {
      ready: items.every((i) => i.ok),
      items: items.map((i) => ({ ...i, hint: i.ok ? null : i.hint })),
    };
  });
