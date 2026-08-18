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
  .refine((list) => list.every((d) => EMAIL_DOMAIN_RE.test(d)), "이메일 도메인 형식이 올바르지 않습니다.");

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
      surveys: (surveys ?? []) as ((NonNullable<typeof surveys>)[number] & {
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

    const items: { key: string; label: string; value: string; note: string | null; warn: boolean }[] =
      [
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
          note: from ? null : "운영 도메인 주소로 바꾸지 않으면 수신자가 스팸으로 분류할 수 있습니다.",
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
          note: aiDedicated ? null : "공용 기본 서버로 연결됩니다. 운영에서는 전용 설정을 권장합니다.",
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
