import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const DEFAULT_ROLE_LEVELS = ["담당", "선임", "책임", "리더"];
export const REMINDER_TARGETS = ["미접속", "미제출"] as const;

// 미리보기는 실제 참여자 대신 더미로만 만든다(생년월일·사번이 화면에 노출되지 않게).
const PREVIEW_SAMPLES = [
  { id: "sample-1", name: "홍*동", emp_no: "20150908", birth_date: "1990-03-12" },
  { id: "sample-2", name: "김**", emp_no: "20210114", birth_date: "1985-11-02" },
  { id: "sample-3", name: "이*", emp_no: "9902", birth_date: null },
];

const roleLevelsSchema = z.array(z.string().trim().min(1).max(20)).min(1).max(12);

/** 허용 도메인 표기 정규화: 앞의 @ 제거 + 소문자. 화면·서버가 같은 규칙을 쓴다. */
export const EMAIL_DOMAIN_RE = /^@?[a-z0-9.-]+\.[a-z]{2,}$/;

export function normalizeEmailDomain(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

const allowedDomainsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(30)
  .transform((list) => [...new Set(list.map(normalizeEmailDomain))])
  .refine(
    (list) => list.every((d) => EMAIL_DOMAIN_RE.test(d)),
    "이메일 도메인 형식이 올바르지 않습니다.",
  );

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: system }, { data: companies }, { data: surveys }] = await Promise.all([
      supabaseAdmin.from("system_settings").select("*").maybeSingle(),
      supabaseAdmin.from("companies").select("id, name, code").order("created_at"),
      // stale_days 는 types.ts 미갱신이라 열 이름을 나열하면 타입이 거부한다. '*' + 캐스팅으로 받는다.
      supabaseAdmin.from("survey_settings").select("*"),
    ]);

    return {
      passwordRule: system?.password_rule ?? "{birth6}{empno_last4}",
      roleLevels: system?.role_levels?.length ? system.role_levels : DEFAULT_ROLE_LEVELS,
      // types.ts 미갱신 컬럼 — 마이그레이션 20260818090000_v2_deploy.sql 참조.
      allowedEmailDomains:
        (system as { allowed_email_domains?: string[] } | null)?.allowed_email_domains ?? [],
      companies: companies ?? [],
      surveys: (surveys ?? []) as (NonNullable<typeof surveys>[number] & {
        stale_days?: number | null;
      })[],
    };
  });

/**
 * 명부 검증(validateRoster)에 넘길 허용 도메인만 조회한다.
 * 참여자 화면은 설정 전체가 필요 없어 이 함수만 쓰면 된다.
 */
export const getAllowedEmailDomains = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("system_settings")
      .select("allowed_email_domains")
      .maybeSingle();
    return {
      domains: (data as { allowed_email_domains?: string[] } | null)?.allowed_email_domains ?? [],
    };
  });

/**
 * 배포 준비 상태 보드. 환경변수명·내부 URL 은 돌려주지 않고 사람이 읽는 라벨만 만든다.
 * warn=true 는 운영 전에 손봐야 하는 폴백 상태.
 */
export const systemStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { isSimulationMode } = await import("@/lib/mailer.server");
    const { isProxyConfigured } = await import("@/lib/llm.server");

    const simulation = isSimulationMode();
    const from = process.env["RESEND_FROM"];
    const appUrl = process.env["APP_URL"];
    const aiDedicated = isProxyConfigured();

    const items: {
      key: string;
      label: string;
      value: string;
      note: string | null;
      warn: boolean;
    }[] = [
      {
        key: "mail",
        label: "메일 발송",
        value: simulation ? "테스트 모드" : "실발송",
        note: simulation ? "실제 메일이 나가지 않고 발송 기록만 남습니다." : null,
        warn: simulation,
      },
      {
        key: "from",
        label: "발신 주소",
        value: from ?? "기본값(테스트용) — 운영 설정 필요",
        note: from
          ? null
          : "운영 도메인 주소로 바꾸지 않으면 수신자가 스팸으로 분류할 수 있습니다.",
        warn: !from,
      },
      {
        key: "appUrl",
        label: "접속 URL",
        value: appUrl ?? "미설정 — 메일 링크가 잘못 나갈 수 있음",
        note: appUrl ? null : "초대·리마인더 메일의 링크가 실제 운영 주소를 가리키지 않습니다.",
        warn: !appUrl,
      },
      {
        key: "ai",
        label: "AI 연결",
        value: aiDedicated ? "전용 설정" : "기본 서버 폴백",
        note: aiDedicated
          ? null
          : "공용 기본 서버로 연결됩니다. 운영에서는 전용 설정을 권장합니다.",
        warn: !aiDedicated,
      },
    ];

    return { items };
  });

export const updateSystemSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        passwordRule: z.string().trim().min(1).max(120).optional(),
        roleLevels: roleLevelsSchema.optional(),
        allowedEmailDomains: allowedDomainsSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { validatePasswordRule } = await import("@/lib/password-rule");

    const patch: Record<string, unknown> = {};
    if (data.passwordRule !== undefined) {
      const invalid = validatePasswordRule(data.passwordRule);
      if (invalid) throw new Error(invalid);
      patch["password_rule"] = data.passwordRule;
    }
    if (data.roleLevels !== undefined) {
      const unique = [...new Set(data.roleLevels.map((v) => v.trim()))];
      if (unique.length !== data.roleLevels.length) throw new Error("중복된 역할단계가 있습니다.");
      patch["role_levels"] = unique;
    }
    if (data.allowedEmailDomains !== undefined) {
      // 빈 배열 = 도메인 제한 없음. 스키마에서 정규화·중복제거까지 끝난 값이다.
      patch["allowed_email_domains"] = data.allowedEmailDomains;
    }
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("system_settings")
      .update(patch as never)
      .eq("id", true);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "시스템 설정 변경",
      target_type: "system_settings",
      detail: patch,
    });
    return { ok: true };
  });

export const upsertSurveySetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        deadline: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜 형식이 올바르지 않습니다.")
          .nullable(),
        reminderDays: z.array(z.number().int().min(0).max(60)).max(10),
        reminderTarget: z.enum(REMINDER_TARGETS),
        reminderAuto: z.boolean(),
        staleDays: z.number().int().min(1).max(60).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const reminderDays = [...new Set(data.reminderDays)].sort((a, b) => b - a);
    const { error } = await supabaseAdmin.from("survey_settings").upsert(
      {
        company_id: data.companyId,
        deadline: data.deadline,
        reminder_days: reminderDays,
        reminder_target: data.reminderTarget,
        reminder_auto: data.reminderAuto,
        ...(data.staleDays !== undefined ? { stale_days: data.staleDays } : {}),
      } as never,
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조사 운영 설정 변경",
      target_type: "survey_settings",
      target_id: data.companyId,
      detail: {
        deadline: data.deadline,
        reminder_days: reminderDays,
        reminder_target: data.reminderTarget,
        reminder_auto: data.reminderAuto,
        stale_days: data.staleDays ?? null,
      },
    });
    return { ok: true };
  });

export const previewPasswordRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ rule: z.string().trim().min(1).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { renderPasswordRule, validatePasswordRule } = await import("@/lib/password-rule");

    const invalid = validatePasswordRule(data.rule);
    if (invalid) throw new Error(invalid);

    return {
      samples: PREVIEW_SAMPLES.map((p) => ({
        id: p.id,
        name: p.name,
        empNo: p.emp_no,
        password: renderPasswordRule(data.rule, p),
      })),
    };
  });

/* ─────────────────── 운영 판정값 (기획 D5) ─────────────────── */

/**
 * 화면 동작을 좌우하던 값들의 기본값.
 *
 * 지금까지 이 숫자들은 코드에 박혀 있어 운영 중에 바꿀 수 없었다. 전부 설정 화면에서
 * 바꾸도록 올리되(P9), DB(`system_settings.ops_values`)에 값이 없으면 이 표가 그대로
 * 현행 동작이 된다 — 구조 변경(SQL)을 적용하기 전에도 화면이 깨지지 않는다.
 *
 * 각 값이 원래 어디에 박혀 있었는지는 OPS_FIELD 주석(설정 화면)에 적어 둔다.
 */
export const DEFAULT_OPS = {
  /** 제출 후 이 일수를 넘겨 검토되지 않으면 '적체'로 본다. */
  reviewBacklogDays: 3,
  /** 반려 후 이 일수 동안 참여자가 손대지 않으면 정합성 점검에 올린다. */
  rejectStaleDays: 7,
  /** 참여자 작성 화면에서 한 번에 보여 줄 예시 개수. */
  exampleCount: 2,
  /** 메일 한 번에 보낼 최대 통수(발송량 가드). */
  mailBatchMax: 200,
  /** 직무 응답 수가 이 값 이상이면 '정상'. */
  jobCountOk: 5,
  /** 직무 응답 수가 이 값 이상이면 '심층검토', 미만이면 '인터뷰 필수'. */
  jobCountCaution: 2,
  /** 과업: 제출 가능 최소 개수 / 권장 범위. */
  taskMin: 3,
  taskRecommendMin: 5,
  taskRecommendMax: 10,
  /** 세부 활동(과업 1건당): 제출 가능 최소 개수 / 권장 범위. */
  activityMin: 1,
  activityRecommendMin: 2,
  activityRecommendMax: 8,
  /** 필요 역량: 제출 가능 최소 개수 / 권장 범위. */
  skillMin: 3,
  skillRecommendMin: 5,
  skillRecommendMax: 12,
} as const;

export type OpsKey = keyof typeof DEFAULT_OPS;
export type OpsValues = Record<OpsKey, number>;

/** 입력 가능 범위 — 화면 입력칸과 서버 검증이 같은 표를 쓴다. */
export const OPS_LIMITS: Record<OpsKey, { min: number; max: number }> = {
  reviewBacklogDays: { min: 1, max: 60 },
  rejectStaleDays: { min: 1, max: 60 },
  exampleCount: { min: 1, max: 6 },
  mailBatchMax: { min: 1, max: 5000 },
  jobCountOk: { min: 2, max: 50 },
  jobCountCaution: { min: 1, max: 49 },
  taskMin: { min: 1, max: 30 },
  taskRecommendMin: { min: 1, max: 30 },
  taskRecommendMax: { min: 1, max: 40 },
  activityMin: { min: 1, max: 20 },
  activityRecommendMin: { min: 1, max: 20 },
  activityRecommendMax: { min: 1, max: 30 },
  skillMin: { min: 1, max: 30 },
  skillRecommendMin: { min: 1, max: 30 },
  skillRecommendMax: { min: 1, max: 40 },
};

const OPS_KEYS = Object.keys(DEFAULT_OPS) as OpsKey[];

/**
 * 값들 사이의 앞뒤 관계 검증. 화면(저장 전 경고)과 서버(거부)가 같은 함수를 쓴다.
 * 문제가 없으면 null.
 */
export function validateOps(values: OpsValues): string | null {
  if (values.jobCountCaution >= values.jobCountOk) {
    return "응답 수 기준은 '심층검토'가 '정상'보다 작아야 합니다.";
  }
  const ranges: [string, number, number, number][] = [
    ["과업", values.taskMin, values.taskRecommendMin, values.taskRecommendMax],
    ["세부 활동", values.activityMin, values.activityRecommendMin, values.activityRecommendMax],
    ["필요 역량", values.skillMin, values.skillRecommendMin, values.skillRecommendMax],
  ];
  for (const [label, min, recMin, recMax] of ranges) {
    if (recMin > recMax) return `${label} 권장 범위의 최소가 최대보다 큽니다.`;
    if (min > recMin) return `${label}의 제출 최소 개수가 권장 최소보다 큽니다.`;
  }
  return null;
}

/** 저장된 값 + 기본값을 합쳐 항상 완전한 표를 만든다. */
function mergeOps(raw: unknown): OpsValues {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const out = {} as OpsValues;
  for (const key of OPS_KEYS) {
    const value = stored[key];
    const limit = OPS_LIMITS[key];
    out[key] =
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= limit.min &&
      value <= limit.max
        ? value
        : DEFAULT_OPS[key];
  }
  return out;
}

/**
 * 운영 판정값 조회.
 *
 * 참여자 작성 화면도 이 값(예시 개수·과업 최소/권장 개수)을 읽어야 하므로 관리자 가드를
 * 걸지 않는다 — 로그인 사용자면 볼 수 있다. 값 자체에 개인정보가 없고, 쓰기는
 * `updateOpsValues`(관리자 전용)만 할 수 있다.
 */
export const getOpsValues = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ values: OpsValues; stored: boolean }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // 열 이름을 지정하면 구조 변경 전에는 조회 자체가 실패하므로 '*' 로 받는다.
    const { data } = await supabaseAdmin.from("system_settings").select("*").maybeSingle();
    const raw = (data as { ops_values?: unknown } | null)?.ops_values;
    return { values: mergeOps(raw), stored: raw !== undefined && raw !== null };
  });

/** 구조 변경(ops_values 열)이 아직 적용되지 않은 DB 인지 판별. */
function isMissingOpsColumn(message: string) {
  return /ops_values/.test(message) && /(column|does not exist|schema)/i.test(message);
}

export const updateOpsValues = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const shape = Object.fromEntries(
      OPS_KEYS.map((key) => [
        key,
        z.number().int().min(OPS_LIMITS[key].min).max(OPS_LIMITS[key].max),
      ]),
    ) as { [K in OpsKey]: z.ZodNumber };
    return z.object(shape).parse(input);
  })
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const invalid = validateOps(data);
    if (invalid) throw new Error(invalid);

    const { error } = await supabaseAdmin
      .from("system_settings")
      .update({ ops_values: data } as never)
      .eq("id", true);
    if (error) {
      if (isMissingOpsColumn(error.message)) {
        throw new Error(
          "운영 판정값을 저장할 자리가 데이터베이스에 아직 없습니다. 구조 변경(system_settings.ops_values) 적용을 요청해 주세요. 그전까지는 기본값으로 동작합니다.",
        );
      }
      throw new Error(error.message);
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "운영 판정값 변경",
      target_type: "system_settings",
      detail: data,
    });
    return { ok: true };
  });

/**
 * 판정값을 바꿀 때 결과가 어떻게 달라지는지 보여 주기 위한 원천 수치 (기획 D5·P11).
 *
 * 임계값별로 서버를 다시 부르면 슬라이더를 움직일 때마다 왕복이 생기므로, 판정에 필요한
 * 경과일·개수 배열만 한 번 내려주고 몇 건이 걸리는지는 화면에서 센다.
 */
export type OpsImpact = {
  asOf: string;
  /** 미완료 참여자의 마지막 활동 경과일. null = 활동 기록 없음(항상 미진행). */
  idleDays: { companyId: string; days: number | null }[];
  /** 검토 대기(제출) 건의 대기일. */
  reviewWaits: number[];
  /** 반려 후 참여자가 손대지 않은 일수. */
  rejectIdleDays: number[];
  /** 직무별 응답 수(계열사+직무명 기준). */
  jobResponseCounts: number[];
  /** 안내 메일을 받을 수 있는 인원(활성 참여자 중 이메일 보유). */
  mailRecipients: number;
  /** 참여자 이메일의 도메인별 인원 — 허용 도메인을 좁힐 때 누가 걸리는지 보여 준다. */
  emailDomainCounts: { domain: string; count: number }[];
  /** 제출·승인된 응답의 과업 수. */
  taskCounts: number[];
  /** 과업 1건당 세부 활동 수. */
  activityCounts: number[];
  /** 응답 1건당 필요 역량 수. */
  skillCounts: number[];
};

/** 체이닝만 되면 되는 최소 질의 인터페이스(생성 타입 폭주 회피). */
interface LooseQuery extends PromiseLike<{ data: unknown[] | null }> {
  select(columns: string): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  is(column: string, value: unknown): LooseQuery;
  limit(count: number): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
}

const DONE_ACCOUNT_STATUSES = ["제출", "승인"];
/** 반려 직후 상태 트리거가 updated_at 을 밀므로 이 이내 갱신은 무응답으로 본다(대시보드와 동일 규칙). */
const REJECT_TOUCH_MS = 5 * 60 * 1000;

export const getOpsImpact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OpsImpact> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // 중첩 select 의 생성 타입이 지나치게 깊어 추론이 무너지므로 느슨한 인터페이스로 다룬다.
    const admin = supabaseAdmin as unknown as { from(table: string): LooseQuery };
    const q = <T>(builder: LooseQuery) => builder as PromiseLike<{ data: T[] | null }>;

    const [people, responses, rejects] = await Promise.all([
      q<{
        company_id: string;
        account_status: string;
        email: string | null;
        invited_at: string | null;
        last_seen_at: string | null;
      }>(
        admin
          .from("participants")
          .select("company_id, account_status, email, invited_at, last_seen_at")
          .eq("role", "respondent")
          .is("archived_at", null)
          .limit(5000),
      ),
      q<{
        id: string;
        company_id: string;
        job_name: string | null;
        status: string;
        submitted_at: string | null;
        updated_at: string;
        response_tasks: { id: string; response_activities: { id: string }[] | null }[] | null;
        response_skills: { id: string }[] | null;
      }>(
        admin
          .from("responses")
          .select(
            "id, company_id, job_name, status, submitted_at, updated_at," +
              " response_tasks(id, response_activities(id)), response_skills(id)",
          )
          .limit(5000),
      ),
      q<{ response_id: string; created_at: string }>(
        admin
          .from("review_comments")
          .select("response_id, created_at")
          .eq("kind", "reject")
          .order("created_at", { ascending: false })
          .limit(5000),
      ),
    ]);

    const now = Date.now();
    const days = (value: string | null) =>
      value ? Math.floor((now - new Date(value).getTime()) / 86_400_000) : null;

    const peopleRows = people.data ?? [];
    const idleDays = peopleRows
      .filter((p) => !DONE_ACCOUNT_STATUSES.includes(p.account_status))
      .map((p) => ({ companyId: p.company_id, days: days(p.last_seen_at ?? p.invited_at) }));
    const withEmail = peopleRows.filter((p) => (p.email ?? "").trim() !== "");
    const mailRecipients = withEmail.length;
    const domainTally = new Map<string, number>();
    for (const p of withEmail) {
      const domain = (p.email ?? "").split("@")[1]?.trim().toLowerCase();
      if (!domain) continue;
      domainTally.set(domain, (domainTally.get(domain) ?? 0) + 1);
    }
    const emailDomainCounts = [...domainTally.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);

    const responseRows = responses.data ?? [];
    const reviewWaits = responseRows
      .filter((r) => r.status === "submitted")
      .map((r) => days(r.submitted_at ?? r.updated_at) ?? 0);

    const lastReject = new Map<string, string>();
    for (const c of rejects.data ?? []) {
      if (!lastReject.has(c.response_id)) lastReject.set(c.response_id, c.created_at);
    }
    const rejectIdleDays: number[] = [];
    for (const r of responseRows) {
      if (r.status !== "rejected") continue;
      const at = lastReject.get(r.id);
      if (!at) continue;
      const rejectedMs = new Date(at).getTime();
      // 반려 후 참여자가 손댄 응답은 적체가 아니다.
      if (new Date(r.updated_at).getTime() > rejectedMs + REJECT_TOUCH_MS) continue;
      rejectIdleDays.push(Math.floor((now - rejectedMs) / 86_400_000));
    }

    const jobCounts = new Map<string, number>();
    for (const r of responseRows) {
      const key = `${r.company_id} ${r.job_name?.trim() || "(직무명 미기재)"}`;
      jobCounts.set(key, (jobCounts.get(key) ?? 0) + 1);
    }

    // 작성 분량은 제출 이후 응답만 본다 — 작성 중 응답은 아직 개수가 늘어나는 중이다.
    const written = responseRows.filter((r) => r.status !== "draft");
    const taskCounts = written.map((r) => (r.response_tasks ?? []).length);
    const activityCounts = written.flatMap((r) =>
      (r.response_tasks ?? []).map((t) => (t.response_activities ?? []).length),
    );
    const skillCounts = written.map((r) => (r.response_skills ?? []).length);

    return {
      asOf: new Date().toISOString(),
      idleDays,
      reviewWaits,
      rejectIdleDays,
      jobResponseCounts: [...jobCounts.values()],
      mailRecipients,
      emailDomainCounts,
      taskCounts,
      activityCounts,
      skillCounts,
    };
  });

/* ─────────────────── 감사 기록 열람 (보안 탭) ─────────────────── */

export type AuditRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

export const listAuditLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        /** 행위 이름 부분 일치. 비우면 전체. */
        action: z.string().trim().max(80).optional(),
        limit: z.number().int().min(10).max(300).default(50),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: AuditRow[]; actions: string[] }> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("audit_logs")
      .select("id, created_at, actor_id, actor_email, action, target_type, target_id, detail")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.action) query = query.ilike("action", `%${data.action}%`);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    // 행위자 표기는 이메일이 있으면 이메일, 없으면 계정 식별자 앞 8자리만 보여 준다.
    const list = (rows ?? []).map((r) => ({
      id: r.id,
      at: r.created_at,
      actor: r.actor_email ?? (r.actor_id ? `계정 ${r.actor_id.slice(0, 8)}` : "시스템"),
      action: r.action,
      target: [r.target_type, r.target_id ? r.target_id.slice(0, 8) : null]
        .filter(Boolean)
        .join(" "),
      detail: JSON.stringify(r.detail ?? {}),
    }));

    // 필터 후보는 최근 기록에 실제로 등장한 행위만 보여 준다.
    const { data: recent } = await supabaseAdmin
      .from("audit_logs")
      .select("action")
      .order("created_at", { ascending: false })
      .limit(500);
    const actions = [...new Set((recent ?? []).map((r) => r.action))].sort((a, b) =>
      a.localeCompare(b, "ko"),
    );

    return { rows: list, actions };
  });

/* ─────────────────── 백업 설정 (기획 F3) ─────────────────── */

/**
 * 백업 화면이 읽는 설정값. 실행 본체는 서버 전용 모듈(backup.server / reminders.server)에
 * 있고, 여기서는 관리자 권한 확인과 기록만 얹는다.
 * (v4: 정기 실행 현황·진행 리포트 화면은 기획 13에 따라 내렸다.)
 */

export type AutomationStatus = {
  retentionDays: number;
};

export const getAutomationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AutomationStatus> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: system } = await supabaseAdmin.from("system_settings").select("*").maybeSingle();
    const settings = (system ?? {}) as { backup_retention_days?: number };
    return { retentionDays: settings.backup_retention_days ?? 30 };
  });

export const updateAutomationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        backupRetentionDays: z.number().int().min(7).max(365).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const patch: Record<string, unknown> = {};
    if (data.backupRetentionDays !== undefined) {
      patch["backup_retention_days"] = data.backupRetentionDays;
    }
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("system_settings")
      .update(patch as never)
      .eq("id", true);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "운영 자동화 설정 변경",
      target_type: "system_settings",
      detail: patch,
    });
    return { ok: true };
  });

/* ── 백업 (F3) ── */

export const listBackupFiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listBackups } = await import("@/lib/backup.server");
    return { rows: await listBackups(supabaseAdmin) };
  });

export const createBackupNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ note: z.string().trim().max(200).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createBackup } = await import("@/lib/backup.server");

    const res = await createBackup(supabaseAdmin, "수동", data.note ?? null, context.userId);
    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "수동 백업",
      target_type: "backups",
      detail: { 파일: res.path, 건수: res.totalRows },
    });
    return { path: res.path, totalRows: res.totalRows, sizeBytes: res.sizeBytes };
  });

/** 되돌리기 전 차이만 계산한다 — 아무것도 바꾸지 않는다. */
export const previewBackupRestore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { restoreBackup } = await import("@/lib/backup.server");
    return restoreBackup(supabaseAdmin, data.id, { dryRun: true });
  });

export const applyBackupRestore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { restoreBackup } = await import("@/lib/backup.server");
    // 되돌리기 직전 백업과 감사 기록은 restoreBackup 안에서 함께 처리한다.
    return restoreBackup(supabaseAdmin, data.id, { dryRun: false, actorId: context.userId });
  });

/* ── 독려 규칙 (F4) ── */

export type ReminderRuleView = {
  id: string;
  companyId: string | null;
  name: string;
  trigger: string;
  days: number;
  templateId: string | null;
  enabled: boolean;
  dailyCap: number;
  /** 지금 이 규칙을 돌리면 몇 명이 대상인지. */
  targetCount: number;
  targetNote: string | null;
  lastRun: { at: string; sent: number | null; skipped: number | null } | null;
};

export const getReminderRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { collectRuleTargets, lastRuleRuns, REMINDER_TRIGGERS, TRIGGER_LABELS } =
      await import("@/lib/reminders.server");

    const [{ data: rules, error }, { data: templates }, { data: companies }, runs] =
      await Promise.all([
        supabaseAdmin
          .from("reminder_rules")
          .select(
            "id, company_id, name, trigger, days, template_id, enabled, daily_cap, last_run_at, last_sent_count",
          )
          .order("created_at"),
        supabaseAdmin.from("mail_templates").select("id, name, kind").order("created_at"),
        supabaseAdmin.from("companies").select("id, name").order("created_at"),
        lastRuleRuns(supabaseAdmin),
      ]);
    if (error) throw new Error(error.message);

    const views: ReminderRuleView[] = [];
    for (const rule of rules ?? []) {
      const targets = await collectRuleTargets(supabaseAdmin, {
        company_id: rule.company_id,
        trigger: rule.trigger,
        days: rule.days,
      });
      const run = runs.find((r) => r.rule_id === rule.id);
      views.push({
        id: rule.id,
        companyId: rule.company_id,
        name: rule.name,
        trigger: rule.trigger,
        days: rule.days,
        templateId: rule.template_id,
        enabled: rule.enabled,
        dailyCap: rule.daily_cap,
        targetCount: targets.participantIds.length,
        targetNote: targets.note,
        lastRun: rule.last_run_at
          ? {
              at: rule.last_run_at,
              sent: run?.sent_count ?? rule.last_sent_count ?? null,
              skipped: run?.skipped_count ?? null,
            }
          : null,
      });
    }

    return {
      rules: views,
      templates: templates ?? [],
      companies: companies ?? [],
      triggers: REMINDER_TRIGGERS.map((t) => ({ value: t, desc: TRIGGER_LABELS[t] })),
    };
  });

export const saveReminderRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(60),
        trigger: z.enum(["미로그인", "작성정체", "반려미수정", "마감임박"]),
        days: z.number().int().min(1).max(60),
        companyId: z.string().uuid().nullable(),
        templateId: z.string().uuid().nullable(),
        enabled: z.boolean(),
        dailyCap: z.number().int().min(1).max(2000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const row = {
      name: data.name,
      trigger: data.trigger,
      days: data.days,
      company_id: data.companyId,
      template_id: data.templateId,
      enabled: data.enabled,
      daily_cap: data.dailyCap,
    };
    const { error } = data.id
      ? await supabaseAdmin.from("reminder_rules").update(row).eq("id", data.id)
      : await supabaseAdmin.from("reminder_rules").insert(row);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.id ? "독려 규칙 수정" : "독려 규칙 추가",
      target_type: "reminder_rules",
      ...(data.id ? { target_id: data.id } : {}),
      detail: { 이름: data.name, 종류: data.trigger, 기준일: data.days, 사용: data.enabled },
    });
    return { ok: true };
  });

export const deleteReminderRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("reminder_rules")
      .select("name")
      .eq("id", data.id)
      .maybeSingle();
    const { error } = await supabaseAdmin.from("reminder_rules").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "독려 규칙 삭제",
      target_type: "reminder_rules",
      target_id: data.id,
      detail: { 이름: row?.name ?? "" },
    });
    return { ok: true };
  });

export const runReminderRuleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runReminderRules } = await import("@/lib/reminders.server");

    // force: 관리자가 직접 누른 실행이므로 하루 1회 가드를 넘긴다.
    const results = await runReminderRules(supabaseAdmin, { force: true, ruleId: data.id });
    const result = results[0];
    if (!result) throw new Error("규칙을 찾을 수 없습니다.");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "독려 규칙 수동 실행",
      target_type: "reminder_rules",
      target_id: data.id,
      detail: { 이름: result.name, 결과: result.status, 발송: result.sent, 남김: result.skipped },
    });
    return {
      status: result.status,
      sent: result.sent,
      skipped: result.skipped,
      reason: result.reason ?? null,
      error: result.error ?? null,
    };
  });

/* ─────────────────── 계열사 켜고 끄기 (기획 11) ─────────────────── */

/**
 * 계열사 운영 상태 변경. 중지하면 화면·집계·발송에서 빠지고 소속 참여자는
 * 로그인할 수 없게 되지만, 데이터는 지워지지 않는다.
 */
export const setCompanyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        status: z.enum(["active", "inactive"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin
      .from("companies")
      .update({ status: data.status })
      .eq("id", data.companyId)
      .select("name")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("계열사를 찾을 수 없습니다.");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.status === "active" ? "계열사 운영 재개" : "계열사 운영 중지",
      target_type: "companies",
      target_id: data.companyId,
      detail: { 이름: row.name, 상태: data.status === "active" ? "운영 중" : "중지" },
    });
    return { ok: true };
  });

/** 계열사를 중지하면 무엇이 영향을 받는지 — 끄기 전 확인 다이얼로그에 보여 준다. */
export const companyOffImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ companyId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ count: participants }, { count: waves }] = await Promise.all([
      supabaseAdmin
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("company_id", data.companyId)
        .is("archived_at", null),
      supabaseAdmin
        .from("survey_waves")
        .select("id", { count: "exact", head: true })
        .eq("company_id", data.companyId)
        .eq("status", "진행"),
    ]);

    return { participants: participants ?? 0, activeWaves: waves ?? 0 };
  });
