import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RosterDiffResult, RosterDiffRow, RosterExistingRow } from "@/lib/roster";

/**
 * Supabase Auth 최소 비밀번호 길이(6자) 미만이면 계정 생성이 통째로 실패한다.
 * 사번·생년월일이 비어 규칙 결과가 짧아진 경우에만 난수로 채운다(초기PW 는 저장·안내되므로 확인 가능).
 */
function ensureMinLength(password: string) {
  if (password.length >= 6) return password;
  const pad = String(Math.floor(1000 + Math.random() * 9000));
  return (password + pad).slice(0, Math.max(8, password.length + 4));
}

/** listUsers 는 페이지당 최대치가 있어 1페이지만 보면 기존 계정을 놓친다. 전 페이지를 훑어 이메일로 찾는다. */
async function findAuthUserByEmail(
  auth: {
    listUsers: (p: {
      page: number;
      perPage: number;
    }) => Promise<{ data: { users: { id: string; email?: string | undefined }[] } | null }>;
  },
  email: string,
) {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const { data } = await auth.listUsers({ page, perPage });
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

export const provisionAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ participantIds: z.array(z.string().uuid()).min(1).max(1000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderPasswordRule } = await import("@/lib/password-rule");

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("password_rule")
      .maybeSingle();
    const rule = settings?.password_rule ?? "{birth6}{empno_last4}";

    const { data: participants } = await supabaseAdmin
      .from("participants")
      .select("id, name, email, emp_no, birth_date, user_id, account_status")
      .in("id", data.participantIds);

    let created = 0;
    let updated = 0;
    const failures: { name: string; reason: string }[] = [];

    for (const p of participants ?? []) {
      if (!p.email) {
        failures.push({ name: p.name, reason: "이메일 없음" });
        continue;
      }
      const password = ensureMinLength(renderPasswordRule(rule, p));
      try {
        let userId = p.user_id as string | null;
        if (userId) {
          const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
          if (error) throw new Error(error.message);
          updated += 1;
        } else {
          const { data: createdUser, error } = await supabaseAdmin.auth.admin.createUser({
            email: p.email,
            password,
            email_confirm: true,
          });
          if (error || !createdUser.user) {
            const existing = await findAuthUserByEmail(supabaseAdmin.auth.admin, p.email);
            if (!existing) throw new Error(error?.message ?? "계정 생성 실패");
            await supabaseAdmin.auth.admin.updateUserById(existing.id, { password });
            userId = existing.id;
            updated += 1;
          } else {
            userId = createdUser.user.id;
            created += 1;
          }
        }

        await supabaseAdmin
          .from("user_roles")
          .upsert(
            { user_id: userId, role: "respondent" },
            { onConflict: "user_id,role", ignoreDuplicates: true },
          );

        // initial_password 는 초대 메일 {초기PW} 안내에 필요해 평문으로 남긴다.
        // 최초 로그인(must_change_password 소진) 이후 비우는 정리 작업은 이번 범위 밖.
        await supabaseAdmin
          .from("participants")
          .update({
            user_id: userId,
            initial_password: password,
            must_change_password: true,
            failed_login_count: 0,
            locked_until: null,
            invited_at: new Date().toISOString(),
            account_status: ["미발송", "초대발송"].includes(p.account_status)
              ? "초대발송"
              : p.account_status,
          })
          .eq("id", p.id);
      } catch (err) {
        failures.push({ name: p.name, reason: err instanceof Error ? err.message : "오류" });
      }
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "계정 일괄 생성",
      target_type: "participants",
      detail: { created, updated, failed: failures.length },
    });

    return { created, updated, failures };
  });

export const resetParticipantPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ participantId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderPasswordRule } = await import("@/lib/password-rule");

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("password_rule")
      .maybeSingle();
    const { data: p } = await supabaseAdmin
      .from("participants")
      .select("id, name, email, emp_no, birth_date, user_id")
      .eq("id", data.participantId)
      .maybeSingle();
    if (!p) throw new Error("참여자를 찾을 수 없습니다.");
    if (!p.user_id) throw new Error("아직 계정이 생성되지 않았습니다.");

    const password = ensureMinLength(
      renderPasswordRule(settings?.password_rule ?? "{birth6}{empno_last4}", p),
    );
    const { error } = await supabaseAdmin.auth.admin.updateUserById(p.user_id, { password });
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("participants")
      .update({
        initial_password: password,
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null,
      })
      .eq("id", p.id);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "비밀번호 초기화",
      target_type: "participant",
      target_id: p.id,
    });

    return { password };
  });

/* ───────────────── 참여자 CRUD (participants 쓰기는 service_role 전용) ─────────────────
 * 20260814160000_security_hardening.sql 이 authenticated 의 UPDATE/DELETE 를 회수했으므로
 * 명부 갱신·수정·삭제는 모두 이 파일의 서버 함수를 거쳐야 한다.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 이메일 형식 + system_settings.allowed_email_domains 화이트리스트. 빈 배열이면 도메인 제한 없음. */
async function assertEmailAllowed(admin: SupabaseClient, email: string) {
  if (!EMAIL_RE.test(email)) throw new Error("이메일 형식이 올바르지 않습니다.");
  const { data } = await admin
    .from("system_settings")
    .select("allowed_email_domains")
    .maybeSingle();
  const allowed = (
    (data as { allowed_email_domains?: string[] } | null)?.allowed_email_domains ?? []
  )
    .map((d) => d.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!allowed.includes(domain)) {
    throw new Error(`허용되지 않은 이메일 도메인입니다(@${domain}). 허용: ${allowed.join(", ")}`);
  }
}

/** 명부 항목 공통 스키마. 빈 문자열은 null 로 접어 DB 에 빈칸이 쌓이지 않게 한다. */
const optionalText = z
  .string()
  .trim()
  .max(200)
  .transform((v) => v || null)
  .nullable()
  .optional();

const rosterFields = {
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().max(200),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  org_text: optionalText,
  grade: optionalText,
  role_level: optionalText,
  orgUnitId: z.string().uuid().nullable().optional(),
};

/** 조직 선택값 검증: 다른 계열사 조직을 참여자에 붙이는 실수를 막는다. */
async function assertOrgUnitInCompany(admin: SupabaseClient, orgUnitId: string, companyId: string) {
  const { data } = await admin
    .from("org_units")
    .select("company_id")
    .eq("id", orgUnitId)
    .maybeSingle();
  if (!data) throw new Error("선택한 조직을 찾을 수 없습니다.");
  if (data.company_id !== companyId) throw new Error("다른 계열사의 조직은 지정할 수 없습니다.");
}

export const createParticipant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        emp_no: z.string().trim().min(1).max(40),
        ...rosterFields,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.email) await assertEmailAllowed(supabaseAdmin, data.email);

    // (company_id, emp_no) 유니크 제약이 있지만, DB 오류 문구 대신 읽을 수 있는 안내를 준다.
    const { data: dup } = await supabaseAdmin
      .from("participants")
      .select("id, name")
      .eq("company_id", data.companyId)
      .eq("emp_no", data.emp_no)
      .maybeSingle();
    if (dup) throw new Error(`같은 계열사에 사번 ${data.emp_no}(${dup.name})가 이미 있습니다.`);

    if (data.orgUnitId) await assertOrgUnitInCompany(supabaseAdmin, data.orgUnitId, data.companyId);

    const { data: created, error } = await supabaseAdmin
      .from("participants")
      .insert({
        company_id: data.companyId,
        emp_no: data.emp_no,
        name: data.name,
        email: data.email || null,
        birth_date: data.birth_date ?? null,
        org_text: data.org_text ?? null,
        grade: data.grade ?? null,
        role_level: data.role_level ?? null,
        org_unit_id: data.orgUnitId ?? null,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message ?? "참여자 등록 실패");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 추가",
      target_type: "participant",
      target_id: created.id,
      detail: { emp_no: data.emp_no, name: data.name },
    });
    return { id: created.id };
  });

export const updateParticipant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ participantId: z.string().uuid(), ...rosterFields }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("participants")
      .select(
        "id, company_id, emp_no, name, email, birth_date, org_text, grade, role_level, org_unit_id, user_id",
      )
      .eq("id", data.participantId)
      .maybeSingle();
    if (!before) throw new Error("참여자를 찾을 수 없습니다.");

    const email = data.email || null;
    const emailChanged = (before.email ?? null) !== email;
    if (email && emailChanged) await assertEmailAllowed(supabaseAdmin, email);
    if (data.orgUnitId) {
      await assertOrgUnitInCompany(supabaseAdmin, data.orgUnitId, before.company_id);
    }

    const patch = {
      name: data.name,
      email,
      birth_date: data.birth_date ?? null,
      org_text: data.org_text ?? null,
      grade: data.grade ?? null,
      role_level: data.role_level ?? null,
      // undefined 는 「보내지 않음」— 기존 조직 연결을 보존한다. null 은 명시적 해제.
      ...(data.orgUnitId !== undefined ? { org_unit_id: data.orgUnitId } : {}),
    };
    const { error } = await supabaseAdmin
      .from("participants")
      .update(patch)
      .eq("id", data.participantId);
    if (error) throw new Error(error.message);

    // 로그인 아이디는 auth.users.email 이라 명부만 바꾸면 본인이 못 들어온다.
    if (emailChanged && before.user_id && email) {
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(before.user_id, {
        email,
        email_confirm: true,
      });
      if (authError) {
        throw new Error(
          `명부는 수정했지만 로그인 계정 이메일 변경에 실패했습니다: ${authError.message}`,
        );
      }
    }

    const changed = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v),
    );
    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 수정",
      target_type: "participant",
      target_id: data.participantId,
      detail: { emp_no: before.emp_no, changed },
    });
    return { emailSynced: emailChanged && !!before.user_id };
  });

export const archiveParticipant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ participantId: z.string().uuid(), archived: z.boolean().default(true) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: p } = await supabaseAdmin
      .from("participants")
      .select("id, emp_no, name, user_id")
      .eq("id", data.participantId)
      .maybeSingle();
    if (!p) throw new Error("참여자를 찾을 수 없습니다.");

    await setArchived(supabaseAdmin, p, data.archived);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.archived ? "참여자 보관" : "참여자 보관 해제",
      target_type: "participant",
      target_id: p.id,
      detail: { emp_no: p.emp_no, name: p.name },
    });
    return { archived: data.archived };
  });

export const deleteParticipant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ participantId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: p } = await supabaseAdmin
      .from("participants")
      .select("id, emp_no, name, user_id, account_status")
      .eq("id", data.participantId)
      .maybeSingle();
    if (!p) throw new Error("참여자를 찾을 수 없습니다.");

    await removeParticipantRow(supabaseAdmin, p);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 삭제",
      target_type: "participant",
      target_id: p.id,
      detail: { emp_no: p.emp_no, name: p.name },
    });
    return { deleted: true };
  });

/** 명부 한 행. 대조(diffRoster)·반영(applyRoster)·일괄 반영(upsertParticipants)이 같은 모양을 쓴다. */
const rosterRowSchema = z.object({
  company_id: z.string().uuid(),
  emp_no: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().max(200).nullable(),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  org_text: z.string().trim().max(200).nullable(),
  grade: z.string().trim().max(200).nullable(),
  role_level: z.string().trim().max(200).nullable(),
});

/**
 * 소속 표기(org_text)가 조직명과 정확일치(trim)하면 org_unit_id 를 채운다.
 * 미매칭은 오류가 아니다 — 기존 연결을 건드리지 않고 그대로 둔다.
 * 일치하면 기존 연결을 덮는다(전보로 소속 표기가 바뀐 사람은 새 조직으로 옮겨야 한다).
 */
async function linkOrgUnitsByText(
  admin: SupabaseClient,
  rows: { id: string; company_id: string; org_text: string | null }[],
) {
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  if (companyIds.length === 0) return 0;
  const { data: units } = await admin
    .from("org_units")
    .select("id, company_id, name")
    .in("company_id", companyIds);
  const unitByKey = new Map((units ?? []).map((u) => [`${u.company_id}|${u.name.trim()}`, u.id]));

  const idsByUnit = new Map<string, string[]>();
  for (const row of rows) {
    const orgText = (row.org_text ?? "").trim();
    const unitId = orgText ? unitByKey.get(`${row.company_id}|${orgText}`) : undefined;
    if (!unitId) continue;
    const list = idsByUnit.get(unitId);
    if (list) list.push(row.id);
    else idsByUnit.set(unitId, [row.id]);
  }
  let matched = 0;
  for (const [unitId, ids] of idsByUnit) {
    const { error } = await admin
      .from("participants")
      .update({ org_unit_id: unitId })
      .in("id", ids);
    if (!error) matched += ids.length;
  }
  return matched;
}

/** 보관 처리 본체. 응답은 그대로 두고 로그인만 막는다. 10년(87600h) = 실질 영구 차단. */
async function setArchived(
  admin: SupabaseClient,
  p: { id: string; user_id: string | null },
  archived: boolean,
) {
  const { error } = await admin
    .from("participants")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", p.id);
  if (error) throw new Error(error.message);
  if (p.user_id) {
    await admin.auth.admin.updateUserById(p.user_id, {
      ban_duration: archived ? "87600h" : "none",
    });
  }
}

/**
 * 완전 삭제 본체. 응답이 한 건이라도 있으면 조사 결과를 지우는 일이라 거부한다.
 * 명부에 잘못 올린 사람을 되돌리는 경로에서만 쓴다.
 */
async function removeParticipantRow(
  admin: SupabaseClient,
  p: { id: string; name: string; emp_no: string; user_id: string | null; account_status: string },
) {
  const { count } = await admin
    .from("responses")
    .select("id", { count: "exact", head: true })
    .eq("participant_id", p.id);
  if ((count ?? 0) > 0) {
    throw new Error(
      `${p.name}(${p.emp_no})은 응답 ${count}건이 있어 삭제할 수 없습니다. 보관을 사용하세요.`,
    );
  }
  if (p.account_status !== "미발송") {
    throw new Error(
      `${p.name}(${p.emp_no})은 상태가 '${p.account_status}'입니다. 미발송 상태만 삭제할 수 있습니다.`,
    );
  }
  // 계정을 먼저 지운다. 순서를 뒤집으면 명부가 사라진 뒤 auth 계정만 떠돈다.
  if (p.user_id) {
    const { error: authError } = await admin.auth.admin.deleteUser(p.user_id);
    if (authError) throw new Error(`로그인 계정 삭제 실패: ${authError.message}`);
  }
  const { error } = await admin.from("participants").delete().eq("id", p.id);
  if (error) throw new Error(error.message);
}

/**
 * 명부 재업로드 반영. (company_id, emp_no) 유니크 제약을 onConflict 로 써서
 * 기등록자는 명부 항목만 갱신한다. payload 에 없는 열(user_id·account_status·
 * initial_password·tags·archived_at)은 ON CONFLICT DO UPDATE 대상이 아니라 그대로 남는다.
 *
 * 무엇이 달라졌는지 먼저 보고 항목별로 고르려면 diffRoster → applyRoster 를 쓴다.
 */
export const upsertParticipants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ rows: z.array(rosterRowSchema).min(1).max(5000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: upserted, error } = await supabaseAdmin
      .from("participants")
      .upsert(data.rows, { onConflict: "company_id,emp_no" })
      .select("id, company_id, org_text");
    if (error) throw new Error(error.message);

    const orgMatched = await linkOrgUnitsByText(supabaseAdmin, upserted ?? []);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "명부 반영",
      target_type: "participants",
      detail: { rows: data.rows.length, orgMatched },
    });
    return { count: data.rows.length, orgMatched };
  });

/* ═══════════ 명부 재업로드 대조 → 항목별 반영 (기획 F9) ═══════════
 *
 * 덮어쓰기 한 번으로 끝내지 않고 두 단계로 나눈다.
 *   diffRoster  — 아무것도 바꾸지 않고 분류만 돌려준다.
 *   applyRoster — 관리자가 고른 항목만, 고른 처리로만 반영한다.
 * 분류 규칙은 roster.ts 의 computeRosterDiff 한 곳에 있고 두 함수가 같이 쓴다.
 */

const EXISTING_DIFF_COLUMNS =
  "id, company_id, emp_no, name, email, birth_date, org_text, grade, role_level, archived_at";

/**
 * 대조 대상 전량 조회 + 분류.
 *
 * @param companyId 퇴사 후보를 찾을 계열사. null 이면 명부에 등장한 계열사 전체.
 *        올리지 않은 계열사 사람이 전원 퇴사 후보로 잡히지 않게 범위를 좁히는 값이다.
 */
async function runRosterDiff(
  admin: SupabaseClient,
  rows: RosterDiffRow[],
  companyId: string | null,
): Promise<RosterDiffResult> {
  const { fetchAll } = await import("@/lib/paginate");
  const { computeRosterDiff } = await import("@/lib/roster");

  const rowCompanies = [...new Set(rows.map((r) => r.company_id))];
  const scope = [...new Set(companyId ? [...rowCompanies, companyId] : rowCompanies)];
  // 500명을 넘으므로 한 페이지로는 부족하다. 한 명이라도 빠지면 그 사람이 퇴사 후보로 잡힌다.
  const existing = await fetchAll<RosterExistingRow>((from, to) =>
    admin
      .from("participants")
      .select(EXISTING_DIFF_COLUMNS)
      .in("company_id", scope)
      .order("id")
      .range(from, to),
  );
  return computeRosterDiff(rows, existing, companyId ? [companyId] : rowCompanies);
}

export const diffRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        rows: z.array(rosterRowSchema).min(1).max(5000),
        companyId: z.string().uuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<RosterDiffResult> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // 읽기만 한다 — 감사 로그는 실제로 반영하는 applyRoster 에서 남긴다.
    return runRosterDiff(supabaseAdmin, data.rows, data.companyId ?? null);
  });

/** 분류마다 허용되는 처리. 화면에서 고른 처리가 분류와 맞는지 서버에서 다시 본다. */
const ALLOWED_ACTIONS: Record<string, readonly string[]> = {
  신규: ["추가"],
  퇴사후보: ["보관", "삭제"],
  조직이동: ["갱신"],
  직무변경: ["갱신"],
  기타변경: ["갱신"],
};

/** 아직 없을 수 있는 백업 모듈(다른 담당이 같은 시점에 만든다). 있으면 그 함수를 쓴다. */
type BackupModule = {
  createBackup?: (
    admin: SupabaseClient,
    kind: string,
    note: string,
  ) => Promise<{ path?: string | null } | null | undefined>;
};

/**
 * 반영 직전 백업. 실패해도 반영을 막지는 않되, 「백업 없이 진행」을 감사 로그와 화면에 남긴다.
 * 모듈 자체가 아직 없을 수 있어 import.meta.glob 으로 찾는다 — 파일이 없으면 목록이 비고,
 * 파일이 생기면 그때부터 그대로 잡힌다(없다고 빌드가 깨지지 않는다).
 */
async function backupBeforeApply(admin: SupabaseClient, note: string) {
  try {
    const mods = import.meta.glob<BackupModule>("./backup.server.ts");
    const load = mods["./backup.server.ts"];
    if (!load) throw new Error("백업 기능이 아직 준비되지 않았습니다.");
    const mod = await load();
    if (!mod.createBackup) throw new Error("백업 함수를 찾을 수 없습니다.");
    const result = await mod.createBackup(admin, "반영전", note);
    return { path: result?.path ?? null, error: null as string | null };
  } catch (err) {
    return { path: null, error: err instanceof Error ? err.message : "백업 실패" };
  }
}

export const applyRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid().nullable().optional(),
        /** 대조에 쓴 명부 전체. 서버가 같은 규칙으로 다시 대조해 처리 내용을 확정한다. */
        rows: z.array(rosterRowSchema).min(1).max(5000),
        decisions: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(80),
              action: z.enum(["추가", "갱신", "보관", "삭제"]),
            }),
          )
          .min(1)
          .max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rosterRecheckReason } = await import("@/lib/roster");

    // 화면이 보낸 분류를 믿지 않고 같은 명부로 다시 대조한다 — 반영 내용과 화면에 보인 내용이
    // 어긋나지 않게, 그리고 재확인 사유를 서버가 직접 쓰게 하기 위해.
    const diff = await runRosterDiff(supabaseAdmin, data.rows, data.companyId ?? null);
    const itemByKey = new Map(diff.items.map((i) => [i.key, i]));

    const failures: { name: string; action: string; reason: string }[] = [];
    const upsertRows: RosterDiffRow[] = [];
    const idUpdates: { id: string; row: RosterDiffRow }[] = [];
    const archiveIds: string[] = [];
    const deleteIds: string[] = [];
    const rechecks: { participantId: string; reason: string }[] = [];
    const nameById = new Map<string, string>();

    for (const decision of data.decisions) {
      const item = itemByKey.get(decision.key);
      if (!item) {
        failures.push({
          name: "(알 수 없음)",
          action: decision.action,
          reason: "대조 결과에서 찾지 못했습니다. 명부를 다시 대조한 뒤 반영하세요.",
        });
        continue;
      }
      if (!(ALLOWED_ACTIONS[item.kind] ?? []).includes(decision.action)) {
        failures.push({
          name: item.name,
          action: decision.action,
          reason: `'${item.kind}' 항목에는 '${decision.action}' 처리를 할 수 없습니다.`,
        });
        continue;
      }
      const row = item.rowIndex !== null ? data.rows[item.rowIndex] : undefined;

      if (decision.action === "추가") {
        if (!row) {
          failures.push({
            name: item.name,
            action: decision.action,
            reason: "명부 행을 찾지 못했습니다.",
          });
          continue;
        }
        upsertRows.push(row);
        continue;
      }
      if (decision.action === "갱신") {
        if (!row || !item.participantId) {
          failures.push({
            name: item.name,
            action: decision.action,
            reason: "명부 행을 찾지 못했습니다.",
          });
          continue;
        }
        nameById.set(item.participantId, item.name);
        // 사번이 그대로면 (계열사, 사번) 유니크 제약으로 한 번에 처리한다.
        // 사번이 바뀐 사람은 그 키로 찾을 수 없어 id 로 직접 고쳐야 한다(안 그러면 새 사람이 생긴다).
        if (item.existingEmpNo === row.emp_no) upsertRows.push(row);
        else idUpdates.push({ id: item.participantId, row });
        if (item.kind === "조직이동" || item.kind === "직무변경") {
          rechecks.push({ participantId: item.participantId, reason: rosterRecheckReason(item) });
        }
        continue;
      }
      if (!item.participantId) {
        failures.push({
          name: item.name,
          action: decision.action,
          reason: "대상 참여자를 찾지 못했습니다.",
        });
        continue;
      }
      nameById.set(item.participantId, item.name);
      if (decision.action === "보관") archiveIds.push(item.participantId);
      else deleteIds.push(item.participantId);
    }

    const backup = await backupBeforeApply(
      supabaseAdmin,
      `명부 대조 반영 ${data.decisions.length}건 (추가·갱신 ${upsertRows.length + idUpdates.length} / 보관 ${archiveIds.length} / 삭제 ${deleteIds.length})`,
    );

    /* ── 추가·갱신 ── */
    let added = 0;
    let updated = 0;
    let orgMatched = 0;
    const createdIds: string[] = [];
    const linkTargets: { id: string; company_id: string; org_text: string | null }[] = [];

    if (upsertRows.length > 0) {
      const { data: upserted, error } = await supabaseAdmin
        .from("participants")
        .upsert(upsertRows, { onConflict: "company_id,emp_no" })
        .select("id, company_id, emp_no, org_text");
      if (error) {
        failures.push({
          name: `${upsertRows.length}건`,
          action: "추가·갱신",
          reason: error.message,
        });
      } else {
        linkTargets.push(...(upserted ?? []));
        // upsert 는 새로 넣은 건과 고친 건을 구분해 주지 않는다. 대조 때의 분류로 센다.
        const newKeys = new Set(
          diff.items
            .filter((i) => i.kind === "신규" && i.rowIndex !== null)
            .map((i) => `${i.company_id}|${i.emp_no}`),
        );
        for (const r of upserted ?? []) {
          if (newKeys.has(`${r.company_id}|${r.emp_no}`)) {
            added += 1;
            createdIds.push(r.id);
          } else {
            updated += 1;
          }
        }
      }
    }

    // ponytail: 사번이 바뀐 사람만 여기로 온다(재업로드당 보통 0~몇 건). 순차 처리로 충분하다.
    for (const u of idUpdates) {
      const { error } = await supabaseAdmin
        .from("participants")
        .update({
          emp_no: u.row.emp_no,
          name: u.row.name,
          email: u.row.email,
          birth_date: u.row.birth_date,
          org_text: u.row.org_text,
          grade: u.row.grade,
          role_level: u.row.role_level,
        })
        .eq("id", u.id);
      if (error) {
        failures.push({
          name: nameById.get(u.id) ?? u.row.name,
          action: "갱신",
          reason: error.message,
        });
        continue;
      }
      updated += 1;
      linkTargets.push({ id: u.id, company_id: u.row.company_id, org_text: u.row.org_text });
    }

    if (linkTargets.length > 0) {
      orgMatched = await linkOrgUnitsByText(supabaseAdmin, linkTargets);
    }

    /* ── 보관 · 삭제 ── */
    let archived = 0;
    let deleted = 0;
    const targetIds = [...archiveIds, ...deleteIds];
    if (targetIds.length > 0) {
      // ponytail: 대상이 1000명을 넘으면 .in() 이 버거워진다. 재업로드 한 번에 그만큼 나가는
      //           상황은 명부가 잘못 만들어진 경우이므로, 그때 나눠 보내도록 고친다.
      const { data: targets } = await supabaseAdmin
        .from("participants")
        .select("id, name, emp_no, user_id, account_status")
        .in("id", targetIds);
      const targetById = new Map((targets ?? []).map((t) => [t.id, t]));

      for (const id of archiveIds) {
        const t = targetById.get(id);
        if (!t) {
          failures.push({
            name: nameById.get(id) ?? "(알 수 없음)",
            action: "보관",
            reason: "참여자를 찾을 수 없습니다.",
          });
          continue;
        }
        try {
          // 응답은 지우지 않는다. 보관은 명단에서 내리고 로그인을 막는 처리다.
          await setArchived(supabaseAdmin, t, true);
          archived += 1;
        } catch (err) {
          failures.push({
            name: t.name,
            action: "보관",
            reason: err instanceof Error ? err.message : "보관 실패",
          });
        }
      }
      for (const id of deleteIds) {
        const t = targetById.get(id);
        if (!t) {
          failures.push({
            name: nameById.get(id) ?? "(알 수 없음)",
            action: "삭제",
            reason: "참여자를 찾을 수 없습니다.",
          });
          continue;
        }
        try {
          // 응답이 있으면 removeParticipantRow 가 거부한다 — 조사 결과는 어떤 경우에도 지우지 않는다.
          await removeParticipantRow(supabaseAdmin, t);
          deleted += 1;
        } catch (err) {
          failures.push({
            name: t.name,
            action: "삭제",
            reason: err instanceof Error ? err.message : "삭제 실패",
          });
        }
      }
    }

    /* ── 재확인 표시 (F10 연동) ── */
    let rechecked = 0;
    for (const r of rechecks) {
      const { data: touched, error } = await supabaseAdmin
        .from("responses")
        .update({
          recheck_required: true,
          recheck_reason: r.reason,
          recheck_notified_at: null,
          recheck_cleared_at: null,
        })
        .eq("participant_id", r.participantId)
        .select("id");
      if (error) {
        failures.push({
          name: nameById.get(r.participantId) ?? "(알 수 없음)",
          action: "재확인 표시",
          reason: error.message,
        });
        continue;
      }
      rechecked += touched?.length ?? 0;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "명부 대조 반영",
      target_type: "participants",
      detail: {
        added,
        updated,
        archived,
        deleted,
        rechecked,
        orgMatched,
        failed: failures.length,
        backup:
          backup.path ?? (backup.error ? `백업 없이 진행: ${backup.error}` : "백업 없이 진행"),
      },
    });

    return {
      added,
      updated,
      archived,
      deleted,
      rechecked,
      orgMatched,
      createdIds,
      failures,
      backup,
    };
  });

/**
 * org_unit_id 가 비어 있는 참여자의 org_text 를 같은 계열사 org_units.name 과
 * 정확일치(trim)로 대조해 일괄 연결한다. 결과 리포트에 미매칭 목록을 담아 준다.
 */
export const matchParticipantOrgUnits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ companyId: z.string().uuid().nullable().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { fetchAll } = await import("@/lib/paginate");

    type Target = {
      id: string;
      company_id: string;
      name: string;
      emp_no: string;
      org_text: string | null;
    };
    // 대상이 1000명을 넘을 수 있어 전량 조회한다.
    const targets = await fetchAll<Target>((from, to) => {
      let q = supabaseAdmin
        .from("participants")
        .select("id, company_id, name, emp_no, org_text")
        .is("org_unit_id", null)
        .order("id")
        .range(from, to);
      if (data.companyId) q = q.eq("company_id", data.companyId);
      return q;
    });

    const companyIds = [...new Set(targets.map((t) => t.company_id))];
    const { data: units } = companyIds.length
      ? await supabaseAdmin
          .from("org_units")
          .select("id, company_id, name")
          .in("company_id", companyIds)
      : { data: [] };
    const unitByKey = new Map((units ?? []).map((u) => [`${u.company_id}|${u.name.trim()}`, u.id]));

    const idsByUnit = new Map<string, string[]>();
    const unmatchedList: { name: string; emp_no: string; org_text: string | null }[] = [];
    for (const t of targets) {
      const orgText = (t.org_text ?? "").trim();
      const unitId = orgText ? unitByKey.get(`${t.company_id}|${orgText}`) : undefined;
      if (unitId) {
        const list = idsByUnit.get(unitId);
        if (list) list.push(t.id);
        else idsByUnit.set(unitId, [t.id]);
      } else {
        unmatchedList.push({ name: t.name, emp_no: t.emp_no, org_text: t.org_text });
      }
    }

    let matched = 0;
    for (const [unitId, ids] of idsByUnit) {
      const { error } = await supabaseAdmin
        .from("participants")
        .update({ org_unit_id: unitId })
        .in("id", ids);
      if (error) throw new Error(error.message);
      matched += ids.length;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 조직 일괄 매칭",
      target_type: "participants",
      detail: { matched, unmatched: unmatchedList.length, companyId: data.companyId ?? null },
    });

    // ponytail: 미매칭 목록은 300건까지만 내려보낸다. 그 이상은 화면에서 어차피 못 읽는다.
    return { matched, unmatched: unmatchedList.length, unmatchedList: unmatchedList.slice(0, 300) };
  });

/** 선택 참여자에게 태그를 붙이거나 뗀다. text[] 는 부분 갱신이 안 되므로 행별로 다시 쓴다. */
export const setParticipantTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        participantIds: z.array(z.string().uuid()).min(1).max(2000),
        tags: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
        mode: z.enum(["add", "remove"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows } = await supabaseAdmin
      .from("participants")
      .select("id, tags")
      .in("id", data.participantIds);

    let changed = 0;
    for (const row of rows ?? []) {
      const current = row.tags ?? [];
      const next =
        data.mode === "add"
          ? [...new Set([...current, ...data.tags])]
          : current.filter((t) => !data.tags.includes(t));
      if (next.length === current.length && next.every((t, i) => t === current[i])) continue;
      const { error } = await supabaseAdmin
        .from("participants")
        .update({ tags: next })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
      changed += 1;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.mode === "add" ? "태그 부여" : "태그 제거",
      target_type: "participants",
      detail: { tags: data.tags, changed },
    });
    return { changed };
  });

/** 선택 참여자에게 조직을 일괄 배정한다. 조직의 계열사와 다른 계열사 참여자가 섞이면 거부. */
export const assignParticipantOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        participantIds: z.array(z.string().uuid()).min(1).max(2000),
        orgUnitId: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: unit } = await supabaseAdmin
      .from("org_units")
      .select("company_id, name")
      .eq("id", data.orgUnitId)
      .maybeSingle();
    if (!unit) throw new Error("선택한 조직을 찾을 수 없습니다.");

    const { data: mismatch } = await supabaseAdmin
      .from("participants")
      .select("name, emp_no")
      .in("id", data.participantIds)
      .neq("company_id", unit.company_id)
      .limit(1);
    const outsider = mismatch?.[0];
    if (outsider) {
      throw new Error(
        `${outsider.name}(${outsider.emp_no})는 다른 계열사 소속이라 이 조직을 배정할 수 없습니다.`,
      );
    }

    const { data: updated, error } = await supabaseAdmin
      .from("participants")
      .update({ org_unit_id: data.orgUnitId })
      .in("id", data.participantIds)
      .select("id");
    if (error) throw new Error(error.message);
    const changed = updated?.length ?? 0;

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직 일괄 배정",
      target_type: "participants",
      detail: { orgUnitId: data.orgUnitId, orgName: unit.name, changed },
    });
    return { changed };
  });

export const sendMailBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(120),
        templateId: z.string().uuid(),
        filters: z.object({
          companyId: z.string().uuid().nullable().optional(),
          statuses: z.array(z.string()).optional(),
          participantIds: z.array(z.string().uuid()).optional(),
        }),
        scheduledAt: z.string().datetime().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processBatch, isSimulationMode } = await import("@/lib/mailer.server");

    const { data: batch, error } = await supabaseAdmin
      .from("mail_batches")
      .insert({
        name: data.name,
        template_id: data.templateId,
        company_id: data.filters.companyId ?? null,
        filters: data.filters,
        scheduled_at: data.scheduledAt ?? null,
        status: data.scheduledAt ? "예약" : "대기",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error || !batch) throw new Error(error?.message ?? "배치 생성 실패");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.scheduledAt ? "메일 예약" : "메일 발송",
      target_type: "mail_batch",
      target_id: batch.id,
    });

    if (data.scheduledAt) {
      return { batchId: batch.id, scheduled: true, simulated: isSimulationMode() };
    }
    const result = await processBatch(supabaseAdmin, batch.id, data.origin ?? null);
    return { batchId: batch.id, scheduled: false, ...result };
  });

export const resendMailLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ logId: z.string().uuid(), origin: z.string().url().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resendLog } = await import("@/lib/mailer.server");
    return resendLog(supabaseAdmin, data.logId, data.origin ?? null);
  });

export const triggerReminders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid().nullable().optional(),
        origin: z.string().url().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runReminders } = await import("@/lib/mailer.server");
    const results = await runReminders(supabaseAdmin, {
      force: true,
      companyId: data.companyId ?? null,
      origin: data.origin ?? null,
    });
    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "리마인더 수동 발송",
      detail: { results },
    });
    return { results };
  });

export const mailModeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    return { simulation: !process.env["RESEND_API_KEY"] };
  });
