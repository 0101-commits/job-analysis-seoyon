import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
  auth: { listUsers: (p: { page: number; perPage: number }) => Promise<{ data: { users: { id: string; email?: string | undefined }[] } | null }> },
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

        await supabaseAdmin.from("user_roles").upsert(
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
  const { data } = await admin.from("system_settings").select("allowed_email_domains").maybeSingle();
  const allowed = ((data as { allowed_email_domains?: string[] } | null)?.allowed_email_domains ?? [])
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
};

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
      .select("id, emp_no, name, email, birth_date, org_text, grade, role_level, user_id")
      .eq("id", data.participantId)
      .maybeSingle();
    if (!before) throw new Error("참여자를 찾을 수 없습니다.");

    const email = data.email || null;
    const emailChanged = (before.email ?? null) !== email;
    if (email && emailChanged) await assertEmailAllowed(supabaseAdmin, email);

    const patch = {
      name: data.name,
      email,
      birth_date: data.birth_date ?? null,
      org_text: data.org_text ?? null,
      grade: data.grade ?? null,
      role_level: data.role_level ?? null,
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
        throw new Error(`명부는 수정했지만 로그인 계정 이메일 변경에 실패했습니다: ${authError.message}`);
      }
    }

    const changed = Object.fromEntries(
      Object.entries(patch).filter(
        ([k, v]) => (before as Record<string, unknown>)[k] !== v,
      ),
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

    const { error } = await supabaseAdmin
      .from("participants")
      .update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", p.id);
    if (error) throw new Error(error.message);

    // 보관은 응답 이력을 남기는 대신 로그인만 막는다. 10년(87600h) = 실질 영구 차단.
    if (p.user_id) {
      await supabaseAdmin.auth.admin.updateUserById(p.user_id, {
        ban_duration: data.archived ? "87600h" : "none",
      });
    }

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

    // 응답이 한 건이라도 있으면 완전 삭제는 조사 결과를 지우는 일이다. 보관으로만 처리한다.
    const { count } = await supabaseAdmin
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("participant_id", p.id);
    if ((count ?? 0) > 0) {
      throw new Error(`${p.name}(${p.emp_no})은 응답 ${count}건이 있어 삭제할 수 없습니다. 보관을 사용하세요.`);
    }
    if (p.account_status !== "미발송") {
      throw new Error(
        `${p.name}(${p.emp_no})은 상태가 '${p.account_status}'입니다. 미발송 상태만 삭제할 수 있습니다.`,
      );
    }

    // 계정을 먼저 지운다. 순서를 뒤집으면 명부가 사라진 뒤 auth 계정만 떠돈다.
    if (p.user_id) {
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(p.user_id);
      if (authError) throw new Error(`로그인 계정 삭제 실패: ${authError.message}`);
    }
    const { error } = await supabaseAdmin.from("participants").delete().eq("id", p.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "참여자 삭제",
      target_type: "participant",
      target_id: p.id,
      detail: { emp_no: p.emp_no, name: p.name },
    });
    return { deleted: true };
  });

/**
 * 명부 재업로드 반영. (company_id, emp_no) 유니크 제약을 onConflict 로 써서
 * 기등록자는 명부 항목만 갱신한다. payload 에 없는 열(user_id·account_status·
 * initial_password·tags·archived_at)은 ON CONFLICT DO UPDATE 대상이 아니라 그대로 남는다.
 */
export const upsertParticipants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        rows: z
          .array(
            z.object({
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

    const { error } = await supabaseAdmin
      .from("participants")
      .upsert(data.rows, { onConflict: "company_id,emp_no" });
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "명부 반영",
      target_type: "participants",
      detail: { rows: data.rows.length },
    });
    return { count: data.rows.length };
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
      const { error } = await supabaseAdmin.from("participants").update({ tags: next }).eq("id", row.id);
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
    z
      .object({ logId: z.string().uuid(), origin: z.string().url().optional() })
      .parse(input),
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
