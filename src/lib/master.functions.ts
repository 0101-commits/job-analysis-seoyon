// P5 마스터 데이터 업로드(조직도 / 직무 카탈로그 / 업무분장표).
// 파싱은 클라이언트(roster.ts 의 parseRosterFile)가 담당하고, 여기서는 검증 → 반영만 한다.
// 반영은 회사 스코프 delete 후 insert(replace) 이며, 삭제 직전 스냅샷을 감사 로그 detail 에 남겨 롤백 지점으로 쓴다.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { similarity } from "@/components/survey/validation";

/**
 * participants.org_unit_id 는 마이그레이션(20260818090000_v2_deploy.sql)에만 있고
 * 생성형 types.ts 에는 아직 없다. 컬럼 이름을 문자열로 넘기려면 스키마 제네릭을 벗겨야 한다.
 * ponytail: types.ts 재생성 시 이 캐스팅을 지울 것.
 */
function untyped(admin: unknown) {
  return admin as SupabaseClient;
}

export const ORG_FIELDS = [
  { key: "company", label: "회사", required: true },
  { key: "parent", label: "상위조직", required: false },
  { key: "name", label: "조직명", required: true },
  { key: "level", label: "레벨", required: false },
  { key: "sort", label: "정렬", required: false },
] as const;

export const JOB_FIELDS = [
  { key: "job_group", label: "직군", required: true },
  { key: "job_series", label: "직렬", required: true },
  { key: "job_name", label: "직무", required: true },
  { key: "definition", label: "정의", required: false },
  { key: "companies", label: "적용회사", required: false },
] as const;

export const MAPPING_THRESHOLD = 0.6;

export type RowIssue = { rowNo: number; errors: string[] };

export type UploadReport = {
  ok: boolean;
  total: number;
  valid: number;
  issues: RowIssue[];
  applied: number;
  /** 조직도 전체교체 후 참여자 조직 연결을 되살린 건수 / 되살리지 못한 건수. */
  relinked?: number;
  unmatched?: number;
};

/** 개별 편집(추가·수정·이동·삭제) 결과. ok=false 면 message 가 거부 사유다. */
export type EditResult = { ok: boolean; message: string };

export function orgTemplateCsv() {
  return (
    "﻿" +
    ORG_FIELDS.map((f) => f.label).join(",") +
    "\n" +
    ["서연", "", "경영기획본부", "본부", "1"].join(",") +
    "\n" +
    ["서연", "경영기획본부", "기획팀", "팀", "1"].join(",") +
    "\n"
  );
}

export function jobCatalogTemplateCsv() {
  return (
    "﻿" +
    JOB_FIELDS.map((f) => f.label).join(",") +
    "\n" +
    ["경영지원", "기획", "사업기획", "전사 사업계획 수립 및 실적 관리", "서연;서연이화"].join(",") +
    "\n"
  );
}

type IssueBag = Map<number, string[]>;

function addIssue(bag: IssueBag, rowNo: number, message: string) {
  const list = bag.get(rowNo);
  if (list) list.push(message);
  else bag.set(rowNo, [message]);
}

function toIssues(bag: IssueBag): RowIssue[] {
  return [...bag.entries()]
    .map(([rowNo, errors]) => ({ rowNo, errors }))
    .sort((a, b) => a.rowNo - b.rowNo);
}

/* ─────────────────────────── 조직도 ─────────────────────────── */

type OrgInput = { company: string; parent: string; name: string; level: string; sort: string };

type OrgPrep = {
  rowNo: number;
  key: string;
  parentKey: string | null;
  parentName: string;
  row: { company_id: string; name: string; level: string | null; sort: number };
};

/** 조직도 행 검증 + 위상 정렬. levels[i] 는 같은 깊이라 한 번에 insert 할 수 있다. */
export function validateOrgRows(
  rows: OrgInput[],
  companies: { id: string; name: string }[],
): { issues: RowIssue[]; levels: OrgPrep[][] } {
  const companyByName = new Map(companies.map((c) => [c.name, c.id]));
  const bag: IssueBag = new Map();
  const preps: OrgPrep[] = [];
  const seen = new Map<string, number>();

  rows.forEach((raw, index) => {
    const rowNo = index + 2;
    const company = raw.company.trim();
    const name = raw.name.trim();
    const parent = raw.parent.trim();
    const companyId = companyByName.get(company);

    if (!company) addIssue(bag, rowNo, "회사 누락");
    else if (!companyId) addIssue(bag, rowNo, `등록되지 않은 계열사: ${company}`);
    if (!name) addIssue(bag, rowNo, "조직명 누락");

    let sort = 0;
    const sortRaw = raw.sort.trim();
    if (sortRaw) {
      const parsed = Number(sortRaw);
      if (!Number.isInteger(parsed)) addIssue(bag, rowNo, "정렬 값은 정수여야 합니다");
      else sort = parsed;
    }
    if (parent && parent === name) addIssue(bag, rowNo, "상위조직이 자기 자신입니다");

    if (!companyId || !name) return;

    const key = `${companyId}|${name}`;
    const dup = seen.get(key);
    if (dup !== undefined) {
      addIssue(bag, rowNo, `파일 내 조직명 중복 (${dup}행)`);
      return;
    }
    seen.set(key, rowNo);
    preps.push({
      rowNo,
      key,
      parentKey: parent ? `${companyId}|${parent}` : null,
      parentName: parent,
      row: { company_id: companyId, name, level: raw.level.trim() || null, sort },
    });
  });

  const linked: OrgPrep[] = [];
  for (const prep of preps) {
    if (prep.parentKey && !seen.has(prep.parentKey)) {
      addIssue(bag, prep.rowNo, `상위조직을 찾을 수 없습니다: ${prep.parentName}`);
    } else {
      linked.push(prep);
    }
  }

  const levels: OrgPrep[][] = [];
  const resolved = new Set<string>();
  let pool = linked;
  while (pool.length > 0) {
    const ready = pool.filter((p) => !p.parentKey || resolved.has(p.parentKey));
    if (ready.length === 0) {
      for (const p of pool)
        addIssue(bag, p.rowNo, "상위조직을 해석할 수 없습니다 (순환 참조 또는 상위 행 오류)");
      break;
    }
    const readyRows = new Set(ready.map((p) => p.rowNo));
    for (const p of ready) resolved.add(p.key);
    levels.push(ready);
    pool = pool.filter((p) => !readyRows.has(p.rowNo));
  }

  return { issues: toIssues(bag), levels };
}

export const uploadOrgUnits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        confirm: z.boolean(),
        rows: z
          .array(
            z.object({
              company: z.string().max(200),
              parent: z.string().max(200),
              name: z.string().max(200),
              level: z.string().max(50),
              sort: z.string().max(20),
            }),
          )
          .min(1)
          .max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<UploadReport> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: companies } = await supabaseAdmin.from("companies").select("id, name");
    const { issues, levels } = validateOrgRows(data.rows, companies ?? []);
    const valid = data.rows.length - issues.length;

    if (issues.length > 0 || !data.confirm) {
      return { ok: issues.length === 0, total: data.rows.length, valid, issues, applied: 0 };
    }

    const companyIds = [...new Set(levels.flat().map((p) => p.row.company_id))];
    // ponytail: 스냅샷을 감사 로그 detail 에 통째로 넣는다. 조직 수가 수천 건을 넘으면 별도 저장소 필요.
    const { data: snapshot } = await supabaseAdmin
      .from("org_units")
      .select("*")
      .in("company_id", companyIds);

    // 전체교체는 org_units 를 지우므로 participants.org_unit_id 가 ON DELETE SET NULL 로 끊긴다.
    // 지우기 전에 (참여자 → 조직명) 을 떠 두고, 새로 넣은 조직에서 같은 이름을 찾아 다시 연결한다.
    const loose = untyped(supabaseAdmin);
    const { data: oldLinks } = await loose
      .from("participants")
      .select("id, company_id, org_unit_id")
      .in("company_id", companyIds)
      .not("org_unit_id", "is", null);
    const oldNameById = new Map((snapshot ?? []).map((unit) => [unit.id, unit.name]));

    const { error: delError } = await supabaseAdmin
      .from("org_units")
      .delete()
      .in("company_id", companyIds);
    if (delError) throw new Error(delError.message);

    const idByKey = new Map<string, string>();
    let applied = 0;
    for (const level of levels) {
      const payload = level.map((p) => ({
        ...p.row,
        parent_id: p.parentKey ? (idByKey.get(p.parentKey) ?? null) : null,
      }));
      const { data: inserted, error } = await supabaseAdmin
        .from("org_units")
        .insert(payload)
        .select("id, company_id, name");
      if (error) throw new Error(error.message);
      for (const row of inserted ?? []) idByKey.set(`${row.company_id}|${row.name}`, row.id);
      applied += inserted?.length ?? 0;
    }

    const idsByNewUnit = new Map<string, string[]>();
    let unmatched = 0;
    for (const link of (oldLinks ?? []) as {
      id: string;
      company_id: string;
      org_unit_id: string;
    }[]) {
      const name = oldNameById.get(link.org_unit_id);
      const newUnitId = name ? idByKey.get(`${link.company_id}|${name}`) : undefined;
      if (!newUnitId) {
        unmatched += 1;
        continue;
      }
      const list = idsByNewUnit.get(newUnitId);
      if (list) list.push(link.id);
      else idsByNewUnit.set(newUnitId, [link.id]);
    }
    let relinked = 0;
    for (const [newUnitId, participantIds] of idsByNewUnit) {
      const { error } = await loose
        .from("participants")
        .update({ org_unit_id: newUnitId })
        .in("id", participantIds);
      if (error) unmatched += participantIds.length;
      else relinked += participantIds.length;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직도 업로드",
      target_type: "org_units",
      detail: { companyIds, applied, relinked, unmatched, snapshot: snapshot ?? [] },
    });

    return { ok: true, total: data.rows.length, valid, issues: [], applied, relinked, unmatched };
  });

/* ───────────────────── 조직도 개별 편집 (추가·이름·이동·삭제) ───────────────────── */

const orgName = z.string().trim().min(1).max(200);

/** 같은 계열사 안에서 조직명이 겹치면 이름 기준 재연결·업로드 검증이 깨진다. */
async function orgNameTaken(
  admin: SupabaseClient,
  companyId: string,
  name: string,
  skipId?: string,
) {
  let query = admin.from("org_units").select("id").eq("company_id", companyId).eq("name", name);
  if (skipId) query = query.neq("id", skipId);
  const { data } = await query.limit(1);
  return (data ?? []).length > 0;
}

export const createOrgUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        parentId: z.string().uuid().nullable(),
        name: orgName,
        level: z.string().trim().max(50).default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (await orgNameTaken(untyped(supabaseAdmin), data.companyId, data.name)) {
      return { ok: false, message: `같은 계열사에 「${data.name}」 조직이 이미 있습니다.` };
    }
    if (data.parentId) {
      const { data: parent } = await supabaseAdmin
        .from("org_units")
        .select("company_id")
        .eq("id", data.parentId)
        .maybeSingle();
      if (!parent) return { ok: false, message: "상위 조직을 찾을 수 없습니다." };
      if (parent.company_id !== data.companyId) {
        return { ok: false, message: "다른 계열사 조직을 상위로 지정할 수 없습니다." };
      }
    }

    const { error } = await supabaseAdmin.from("org_units").insert({
      company_id: data.companyId,
      parent_id: data.parentId,
      name: data.name,
      level: data.level || null,
      sort: 0,
    });
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직 추가",
      target_type: "org_units",
      detail: { companyId: data.companyId, parentId: data.parentId, name: data.name },
    });
    return { ok: true, message: `「${data.name}」 조직을 추가했습니다.` };
  });

export const renameOrgUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: orgName,
        level: z.string().trim().max(50).default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: unit } = await supabaseAdmin
      .from("org_units")
      .select("company_id, name")
      .eq("id", data.id)
      .maybeSingle();
    if (!unit) return { ok: false, message: "조직을 찾을 수 없습니다." };
    if (await orgNameTaken(untyped(supabaseAdmin), unit.company_id, data.name, data.id)) {
      return { ok: false, message: `같은 계열사에 「${data.name}」 조직이 이미 있습니다.` };
    }

    const { error } = await supabaseAdmin
      .from("org_units")
      .update({ name: data.name, level: data.level || null })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직명 변경",
      target_type: "org_units",
      target_id: data.id,
      detail: { before: unit.name, after: data.name },
    });
    return { ok: true, message: `「${unit.name}」 → 「${data.name}」 으로 바꿨습니다.` };
  });

export const moveOrgUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.parentId === data.id) {
      return { ok: false, message: "자기 자신을 상위 조직으로 지정할 수 없습니다." };
    }
    const { data: unit } = await supabaseAdmin
      .from("org_units")
      .select("company_id, name")
      .eq("id", data.id)
      .maybeSingle();
    if (!unit) return { ok: false, message: "조직을 찾을 수 없습니다." };

    if (data.parentId) {
      const { data: siblings } = await supabaseAdmin
        .from("org_units")
        .select("id, parent_id, company_id")
        .eq("company_id", unit.company_id);
      const rows = siblings ?? [];
      if (!rows.some((row) => row.id === data.parentId)) {
        return { ok: false, message: "같은 계열사 안의 조직으로만 옮길 수 있습니다." };
      }
      // 새 상위의 조상을 거슬러 올라가 자기 자신이 나오면 순환이다.
      const parentOf = new Map(rows.map((row) => [row.id, row.parent_id]));
      const visited = new Set<string>();
      let cursor: string | null = data.parentId;
      while (cursor) {
        if (cursor === data.id) {
          return {
            ok: false,
            message: "자신의 하위 조직을 상위로 지정할 수 없습니다 (순환 참조).",
          };
        }
        if (visited.has(cursor)) break;
        visited.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
    }

    const { error } = await supabaseAdmin
      .from("org_units")
      .update({ parent_id: data.parentId })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직 이동",
      target_type: "org_units",
      target_id: data.id,
      detail: { name: unit.name, parentId: data.parentId },
    });
    return { ok: true, message: `「${unit.name}」 조직을 옮겼습니다.` };
  });

export const deleteOrgUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: unit } = await supabaseAdmin
      .from("org_units")
      .select("name")
      .eq("id", data.id)
      .maybeSingle();
    if (!unit) return { ok: false, message: "조직을 찾을 수 없습니다." };

    const [children, members] = await Promise.all([
      supabaseAdmin
        .from("org_units")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", data.id),
      untyped(supabaseAdmin)
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("org_unit_id", data.id),
    ]);
    const childCount = children.count ?? 0;
    const memberCount = members.count ?? 0;
    if (childCount > 0 || memberCount > 0) {
      return {
        ok: false,
        message: `하위 조직 ${childCount}개 / 배정 인원 ${memberCount}명이 있어 삭제할 수 없습니다.`,
      };
    }

    const { error } = await supabaseAdmin.from("org_units").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "조직 삭제",
      target_type: "org_units",
      target_id: data.id,
      detail: { name: unit.name },
    });
    return { ok: true, message: `「${unit.name}」 조직을 삭제했습니다.` };
  });

/* ───────────────────────── 직무 카탈로그 ───────────────────────── */

type JobInput = {
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string;
  companies: string;
};

type JobPrep = {
  rowNo: number;
  row: {
    job_group: string;
    job_series: string;
    job_name: string;
    definition: string | null;
    company_ids: string[];
  };
};

export function validateJobRows(
  rows: JobInput[],
  companies: { id: string; name: string }[],
): { issues: RowIssue[]; ready: JobPrep[] } {
  const companyByName = new Map(companies.map((c) => [c.name, c.id]));
  const bag: IssueBag = new Map();
  const ready: JobPrep[] = [];
  const seen = new Map<string, number>();

  rows.forEach((raw, index) => {
    const rowNo = index + 2;
    const jobGroup = raw.job_group.trim();
    const jobSeries = raw.job_series.trim();
    const jobName = raw.job_name.trim();

    if (!jobGroup) addIssue(bag, rowNo, "직군 누락");
    if (!jobSeries) addIssue(bag, rowNo, "직렬 누락");
    if (!jobName) addIssue(bag, rowNo, "직무 누락");

    const companyIds: string[] = [];
    for (const token of raw.companies.split(/[;,]/)) {
      const name = token.trim();
      if (!name) continue;
      const id = companyByName.get(name);
      if (!id) addIssue(bag, rowNo, `등록되지 않은 계열사: ${name}`);
      else if (!companyIds.includes(id)) companyIds.push(id);
    }

    if (!jobGroup || !jobSeries || !jobName) return;

    const key = `${jobGroup}|${jobSeries}|${jobName}`;
    const dup = seen.get(key);
    if (dup !== undefined) {
      addIssue(bag, rowNo, `파일 내 직군·직렬·직무 중복 (${dup}행)`);
      return;
    }
    seen.set(key, rowNo);
    ready.push({
      rowNo,
      row: {
        job_group: jobGroup,
        job_series: jobSeries,
        job_name: jobName,
        definition: raw.definition.trim() || null,
        company_ids: companyIds,
      },
    });
  });

  return { issues: toIssues(bag), ready };
}

export const uploadJobCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        confirm: z.boolean(),
        /** 자동 백업 버전 라벨 구분용. ai_draft=AI 가안 반영, 그 외=파일 업로드. */
        source: z.enum(["upload", "ai_draft"]).default("upload"),
        rows: z
          .array(
            z.object({
              job_group: z.string().max(200),
              job_series: z.string().max(200),
              job_name: z.string().max(200),
              definition: z.string().max(2000),
              companies: z.string().max(500),
            }),
          )
          .min(1)
          .max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<UploadReport> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: companies } = await supabaseAdmin.from("companies").select("id, name");
    const { issues, ready } = validateJobRows(data.rows, companies ?? []);
    const valid = data.rows.length - issues.length;

    if (issues.length > 0 || !data.confirm) {
      return { ok: issues.length === 0, total: data.rows.length, valid, issues, applied: 0 };
    }

    // 업로드 파일에 적용회사가 있으면 그 계열사에 걸린 행만 교체한다(타 계열사 카탈로그 보존).
    // 적용회사가 하나도 없으면 계열사 공통 카탈로그를 올린 것으로 보고 전체를 교체한다.
    const companyIds = [...new Set(ready.flatMap((p) => p.row.company_ids))];
    const scoped = companyIds.length > 0;

    const snapshotQuery = supabaseAdmin.from("job_catalog").select("*");
    const { data: snapshot } = scoped
      ? await snapshotQuery.overlaps("company_ids", companyIds)
      : await snapshotQuery;

    // V6: 교체 직전 자동 버전 저장. 복원 시 전체를 되살릴 수 있게 스코프와 무관하게 전체 스냅샷을 담는다.
    const { data: fullSnapshot } = scoped
      ? await supabaseAdmin.from("job_catalog").select("*")
      : { data: snapshot };
    if (fullSnapshot && fullSnapshot.length > 0) {
      await untyped(supabaseAdmin)
        .from("job_catalog_versions")
        .insert({
          label: autoVersionLabel(data.source === "ai_draft" ? "AI 가안 반영 전" : "업로드 교체 전"),
          note: scoped ? "계열사 범위 교체 전 전체 스냅샷" : null,
          rows: fullSnapshot,
          created_by: context.userId,
        });
    }

    const deleteQuery = supabaseAdmin.from("job_catalog").delete();
    const { error: delError } = scoped
      ? await deleteQuery.overlaps("company_ids", companyIds)
      : await deleteQuery.not("id", "is", null);
    if (delError) throw new Error(delError.message);

    // (job_group, job_series, job_name) 이 UNIQUE 라, 타 계열사 행과 이름이 겹치면 insert 가 깨진다.
    const { data: inserted, error } = await supabaseAdmin
      .from("job_catalog")
      .upsert(
        ready.map((p) => p.row),
        { onConflict: "job_group,job_series,job_name" },
      )
      .select("id");
    if (error) throw new Error(error.message);
    const applied = inserted?.length ?? ready.length;

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무 카탈로그 업로드",
      target_type: "job_catalog",
      detail: { applied, scope: scoped ? companyIds : "all", snapshot: snapshot ?? [] },
    });

    return { ok: true, total: data.rows.length, valid, issues: [], applied };
  });

/* ─────────────────── 직무분류표 개별 편집 (행 추가·수정·삭제) ─────────────────── */

export const upsertJobCatalogRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().default(null),
        job_group: z.string().trim().min(1).max(200),
        job_series: z.string().trim().min(1).max(200),
        job_name: z.string().trim().min(1).max(200),
        definition: z.string().trim().max(2000).default(""),
        companyIds: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const row = {
      job_group: data.job_group,
      job_series: data.job_series,
      job_name: data.job_name,
      definition: data.definition || null,
      company_ids: data.companyIds,
    };
    const { error } = data.id
      ? await supabaseAdmin.from("job_catalog").update(row).eq("id", data.id)
      : await supabaseAdmin.from("job_catalog").insert(row);
    if (error) {
      if (error.code === "23505") {
        return { ok: false, message: "같은 직군·직렬·직무가 이미 있습니다." };
      }
      throw new Error(error.message);
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: data.id ? "직무분류표 수정" : "직무분류표 행 추가",
      target_type: "job_catalog",
      ...(data.id ? { target_id: data.id } : {}),
      detail: row,
    });
    return {
      ok: true,
      message: `「${data.job_name}」 을(를) ${data.id ? "수정" : "추가"}했습니다.`,
    };
  });

export const deleteJobCatalogRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("job_catalog")
      .select("job_group, job_series, job_name")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: false, message: "직무를 찾을 수 없습니다." };

    const { error } = await supabaseAdmin.from("job_catalog").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류표 행 삭제",
      target_type: "job_catalog",
      target_id: data.id,
      detail: row,
    });
    return { ok: true, message: `「${row.job_name}」 을(를) 삭제했습니다.` };
  });

/* ─────────────────── 직무분류 버전 관리 (V6) ─────────────────── */

/** "접두어 · 08-18 14:02" 형태의 자동 라벨 (KST 기준). */
function autoVersionLabel(prefix: string) {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix} · ${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
}

type CatalogRowLike = {
  job_group?: string;
  job_series?: string;
  job_name?: string;
  definition?: string | null;
};

function catalogKey(row: CatalogRowLike) {
  return `${row.job_group ?? ""} / ${row.job_series ?? ""} / ${row.job_name ?? ""}`;
}

export type CatalogVersion = {
  id: string;
  label: string;
  note: string | null;
  createdAt: string;
  rowCount: number;
};

export const listCatalogVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CatalogVersion[]> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data, error } = await untyped(supabaseAdmin)
      .from("job_catalog_versions")
      .select("id, label, note, rows, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    return ((data ?? []) as { id: string; label: string; note: string | null; rows: unknown; created_at: string }[]).map(
      (v) => ({
        id: v.id,
        label: v.label,
        note: v.note,
        createdAt: v.created_at,
        rowCount: Array.isArray(v.rows) ? v.rows.length : 0,
      }),
    );
  });

export const saveCatalogVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ label: z.string().trim().max(200).default("") }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows } = await supabaseAdmin.from("job_catalog").select("*");
    if (!rows || rows.length === 0) {
      return { ok: false, message: "저장할 직무분류가 없습니다." };
    }
    const label = data.label || autoVersionLabel("수동 저장");
    const { error } = await untyped(supabaseAdmin)
      .from("job_catalog_versions")
      .insert({ label, rows, created_by: context.userId });
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류 버전 저장",
      target_type: "job_catalog_versions",
      detail: { label, rowCount: rows.length },
    });
    return { ok: true, message: `「${label}」 버전으로 ${rows.length}행을 저장했습니다.` };
  });

export const deleteCatalogVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const loose = untyped(supabaseAdmin);

    const { data: version } = await loose
      .from("job_catalog_versions")
      .select("label")
      .eq("id", data.id)
      .maybeSingle();
    if (!version) return { ok: false, message: "버전을 찾을 수 없습니다." };

    const { error } = await loose.from("job_catalog_versions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류 버전 삭제",
      target_type: "job_catalog_versions",
      target_id: data.id,
      detail: { label: version.label },
    });
    return { ok: true, message: `「${version.label}」 버전을 삭제했습니다.` };
  });

export type CatalogDiff = {
  aLabel: string;
  bLabel: string;
  /** 선택 버전에만 있는 직무 (기준에서 사라짐). */
  onlyA: string[];
  /** 기준에만 있는 직무 (버전 이후 추가됨). */
  onlyB: string[];
  /** 정의가 달라진 직무. a=선택 버전 정의, b=기준 정의. */
  changed: { key: string; a: string; b: string }[];
};

export const diffCatalogVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ id: z.string().uuid(), againstId: z.string().uuid().nullable().default(null) })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CatalogDiff> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const loose = untyped(supabaseAdmin);

    async function loadVersion(id: string) {
      const { data: version } = await loose
        .from("job_catalog_versions")
        .select("label, rows")
        .eq("id", id)
        .maybeSingle();
      if (!version) throw new Error("버전을 찾을 수 없습니다.");
      return {
        label: version.label as string,
        rows: (Array.isArray(version.rows) ? version.rows : []) as CatalogRowLike[],
      };
    }

    const a = await loadVersion(data.id);
    const b = data.againstId
      ? await loadVersion(data.againstId)
      : {
          label: "현재",
          rows: ((await supabaseAdmin.from("job_catalog").select("*")).data ??
            []) as CatalogRowLike[],
        };

    const mapA = new Map(a.rows.map((row) => [catalogKey(row), row]));
    const mapB = new Map(b.rows.map((row) => [catalogKey(row), row]));

    const onlyA = [...mapA.keys()].filter((key) => !mapB.has(key)).sort();
    const onlyB = [...mapB.keys()].filter((key) => !mapA.has(key)).sort();
    const changed: CatalogDiff["changed"] = [];
    for (const [key, rowA] of mapA) {
      const rowB = mapB.get(key);
      if (!rowB) continue;
      const defA = (rowA.definition ?? "").trim();
      const defB = (rowB.definition ?? "").trim();
      if (defA !== defB) changed.push({ key, a: defA, b: defB });
    }
    changed.sort((x, y) => x.key.localeCompare(y.key));

    return { aLabel: a.label, bLabel: b.label, onlyA, onlyB, changed };
  });

export const restoreCatalogVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<EditResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const loose = untyped(supabaseAdmin);

    const { data: version } = await loose
      .from("job_catalog_versions")
      .select("label, rows")
      .eq("id", data.id)
      .maybeSingle();
    if (!version) return { ok: false, message: "버전을 찾을 수 없습니다." };
    const rows = (Array.isArray(version.rows) ? version.rows : []) as Record<string, unknown>[];
    if (rows.length === 0) return { ok: false, message: "버전에 저장된 행이 없습니다." };

    // 복원 직전 현재 상태를 자동 백업 버전으로 남긴다 (복원 자체도 되돌릴 수 있게).
    const { data: current } = await supabaseAdmin.from("job_catalog").select("*");
    if (current && current.length > 0) {
      await loose.from("job_catalog_versions").insert({
        label: autoVersionLabel("복원 전 자동 백업"),
        rows: current,
        created_by: context.userId,
      });
    }

    const { error: delError } = await supabaseAdmin
      .from("job_catalog")
      .delete()
      .not("id", "is", null);
    if (delError) throw new Error(delError.message);

    const { error: insError } = await loose.from("job_catalog").insert(rows);
    if (insError) throw new Error(insError.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류 버전 복원",
      target_type: "job_catalog_versions",
      target_id: data.id,
      detail: { label: version.label, restored: rows.length, backedUp: current?.length ?? 0 },
    });
    return {
      ok: true,
      message: `「${version.label}」 버전(${rows.length}행)으로 복원했습니다. 복원 전 상태는 자동 백업으로 저장했습니다.`,
    };
  });

/* ─────────────────── 직무분류표 AI 가안 ─────────────────── */

export type JobDraftRow = {
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string;
};

const JOB_GROUP_COUNT = 7;

const COMPANY_BRIEF =
  "대상 회사는 자동차 부품 제조사다. 주력 제품은 내장재(도어트림·시트·범퍼)이며 " +
  "연구개발부터 금형·사출·조립 생산까지 수행한다.";

/** 상위 n개 항목을 "값(건수)" 문자열로. 개인 식별정보는 애초에 수집하지 않는다. */
function topCounts(values: (string | null)[], limit: number) {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => `${value}(${count})`)
    .join(", ");
}

/** AI 오류 원문은 콘솔에만 남기고, 사용자에게는 조치 가능한 문구로 바꾼다. */
function friendlyAiError(err: unknown, tag = "draftJobCatalog"): Error {
  console.error(`[${tag}]`, err);
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("파싱 실패")) {
    return new Error("AI 응답이 중간에 끊겼습니다 — 실패한 직군만 다시 생성해 주세요");
  }
  if (message.includes("429") || message.includes("네트워크")) {
    return new Error("AI 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.");
  }
  return new Error("AI 가안 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.");
}

export const draftJobCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        /** 지정 시 해당 직군만 재생성한다(부분 실패 복구용). */
        groups: z.array(z.string().trim().min(1).max(100)).max(JOB_GROUP_COUNT).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: JobDraftRow[]; failedGroups: string[] }> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");

    // 프롬프트에는 조직명·직급 같은 집계값만 넣는다. 이름·사번·이메일은 조회조차 하지 않는다.
    const [{ data: units }, { data: people }, { data: responses }] = await Promise.all([
      supabaseAdmin.from("org_units").select("name, level").order("sort").limit(500),
      supabaseAdmin.from("participants").select("org_text, grade").limit(3000),
      supabaseAdmin.from("responses").select("job_group, job_series, job_name").limit(2000),
    ]);

    const orgList = (units ?? [])
      .map((unit) => (unit.level ? `${unit.name}(${unit.level})` : unit.name))
      .join(", ");
    const orgTexts = topCounts(
      (people ?? []).map((p) => p.org_text),
      50,
    );
    const grades = topCounts(
      (people ?? []).map((p) => p.grade),
      20,
    );
    const existing = [
      ...new Set(
        (responses ?? [])
          .map((r) => [r.job_group, r.job_series, r.job_name].filter(Boolean).join(" / "))
          .filter((s) => s !== ""),
      ),
    ]
      .slice(0, 80)
      .join(", ");

    const companyContext =
      `${COMPANY_BRIEF}\n` +
      `[조직도] ${orgList || "없음"}\n` +
      `[참여자 소속 표기 분포] ${orgTexts || "없음"}\n` +
      `[직급 분포] ${grades || "없음"}\n` +
      `[기존 응답의 직무 표기] ${existing || "없음"}`;

    const system =
      "너는 자동차 부품 제조사의 직무분석 컨설턴트다. 한국 제조업 인사 실무 용어로 직무분류 체계를 설계한다. " +
      "설명이나 머리말 없이 JSON 만 출력한다.";

    let skeleton: { job_group: string; job_series: string[] }[];
    try {
      skeleton = await callLLMJson<{ job_group: string; job_series: string[] }[]>({
        system,
        user:
          `${companyContext}\n\n` +
          `직군 → 직렬 2계층 골격을 만들어라. 직군은 정확히 ${JOB_GROUP_COUNT}개다. ` +
          "가안은 경영지원 / 영업 / 구매 / 연구개발 / 생산 / 품질 / 생산기술 이며, " +
          `위 조직 데이터에 맞게 이름을 조정해도 되지만 개수는 ${JOB_GROUP_COUNT}개를 유지한다. ` +
          "각 직군의 직렬은 3~6개다.\n" +
          'JSON 형식: [{"job_group":"직군명","job_series":["직렬1","직렬2"]}]',
        maxTokens: 1200,
      });
    } catch (err) {
      throw friendlyAiError(err);
    }

    let groups = (Array.isArray(skeleton) ? skeleton : [])
      .map((g) => ({
        job_group: String(g?.job_group ?? "").trim(),
        job_series: (Array.isArray(g?.job_series) ? g.job_series : [])
          .map((s) => String(s ?? "").trim())
          .filter((s) => s !== ""),
      }))
      .filter((g) => g.job_group !== "" && g.job_series.length > 0)
      .slice(0, JOB_GROUP_COUNT);
    if (groups.length === 0) throw new Error("AI 가안 생성 실패: 직군 골격을 받지 못했습니다.");

    // 부분 재생성: 요청된 직군만 남긴다. 골격에서 이름이 사라진 직군은 실패 목록으로 돌려준다.
    const failedGroups: string[] = [];
    if (data.groups && data.groups.length > 0) {
      const wanted = new Set(data.groups);
      const filtered = groups.filter((g) => wanted.has(g.job_group));
      failedGroups.push(...data.groups.filter((name) => !filtered.some((g) => g.job_group === name)));
      groups = filtered;
    }

    // 직군별 호출에는 전체 조직 나열 대신 3줄 요약만 붙인다(토큰 절약 + 응답 잘림 방지).
    const briefContext =
      `${COMPANY_BRIEF}\n` +
      `[조직 규모] 조직 ${(units ?? []).length}개, 참여자 소속 상위: ${orgTexts.split(", ").slice(0, 8).join(", ") || "없음"}\n` +
      `[직급 분포] ${grades || "없음"}`;

    type DetailItem = { job_series: string; job_name: string; definition: string };
    const detailUser = (groupName: string, series: string[]) =>
      `${briefContext}\n\n` +
      `「${groupName}」 직군의 직무를 채워라. 직렬은 ${series.join(", ")} 이다. ` +
      "직렬마다 직무 2~5개, 각 직무에 정의를 한 문장(40자 내외)으로 붙인다.\n" +
      'JSON 형식: [{"job_series":"직렬명","job_name":"직무명","definition":"정의 한 문장"}]';

    // max_tokens 2048 안에 전체 직무를 다 담을 수 없어 직군 단위로 나눠 병렬 호출한다.
    // 파싱 실패(응답 잘림)면 그 직군을 직렬 단위로 쪼개 1회 자동 재시도한다.
    const settled = await Promise.allSettled(
      groups.map(async (group) => {
        let items: DetailItem[];
        try {
          const parsed = await callLLMJson<DetailItem[]>({
            system,
            user: detailUser(group.job_group, group.job_series),
            maxTokens: 2048,
          });
          items = Array.isArray(parsed) ? parsed : [];
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (!message.includes("파싱 실패")) throw err;
          const parts = await Promise.all(
            group.job_series.map((series) =>
              callLLMJson<DetailItem[]>({
                system,
                user: detailUser(group.job_group, [series]),
                maxTokens: 2048,
              }),
            ),
          );
          items = parts.flatMap((p) => (Array.isArray(p) ? p : []));
        }
        return { group: group.job_group, items };
      }),
    );

    const details: { group: string; items: DetailItem[] }[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        details.push(result.value);
      } else {
        console.error(`[draftJobCatalog] 직군 「${groups[index]!.job_group}」 실패:`, result.reason);
        failedGroups.push(groups[index]!.job_group);
      }
    });

    const rows: JobDraftRow[] = [];
    const seen = new Set<string>();
    for (const detail of details) {
      for (const item of detail.items) {
        const row = {
          job_group: detail.group,
          job_series: String(item?.job_series ?? "").trim(),
          job_name: String(item?.job_name ?? "").trim(),
          definition: String(item?.definition ?? "").trim(),
        };
        if (!row.job_series || !row.job_name) continue;
        const key = `${row.job_group}|${row.job_series}|${row.job_name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
    if (rows.length === 0) {
      const firstFailure = settled.find((s) => s.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw friendlyAiError(firstFailure?.reason ?? new Error("직무를 받지 못했습니다."));
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류표 AI 가안 생성",
      target_type: "job_catalog",
      detail: {
        groups: groups.map((g) => g.job_group),
        rows: rows.length,
        failedGroups,
        ...(data.groups?.length ? { requested: data.groups } : {}),
      },
    });

    return { rows, failedGroups };
  });

/* ───────────────────────── 업무분장표 ───────────────────────── */

export const uploadDutyChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        confirm: z.boolean(),
        companyId: z.string().uuid(),
        orgName: z.string().trim().min(1).max(200),
        rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<UploadReport> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const bag: IssueBag = new Map();
    data.rows.forEach((row, index) => {
      if (Object.values(row).every((v) => v.trim() === "")) addIssue(bag, index + 2, "빈 행");
    });
    const issues = toIssues(bag);
    const valid = data.rows.length - issues.length;

    if (issues.length > 0 || !data.confirm) {
      return { ok: issues.length === 0, total: data.rows.length, valid, issues, applied: 0 };
    }

    const { data: snapshot } = await supabaseAdmin
      .from("duty_charts")
      .select("*")
      .eq("company_id", data.companyId)
      .eq("org_name", data.orgName);

    const { error: delError } = await supabaseAdmin
      .from("duty_charts")
      .delete()
      .eq("company_id", data.companyId)
      .eq("org_name", data.orgName);
    if (delError) throw new Error(delError.message);

    const { error } = await supabaseAdmin.from("duty_charts").insert({
      company_id: data.companyId,
      org_name: data.orgName,
      rows: data.rows,
    });
    if (error) throw new Error(error.message);

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "업무분장표 업로드",
      target_type: "duty_charts",
      detail: {
        companyId: data.companyId,
        orgName: data.orgName,
        applied: data.rows.length,
        snapshot: snapshot ?? [],
      },
    });

    return { ok: true, total: data.rows.length, valid, issues: [], applied: data.rows.length };
  });

export type DutyChartSummary = {
  id: string;
  companyId: string;
  companyName: string;
  orgName: string;
  uploadedAt: string;
  columns: string[];
  rowCount: number;
  preview: Record<string, string>[];
};

export const listDutyCharts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DutyChartSummary[]> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data } = await supabaseAdmin
      .from("duty_charts")
      .select("id, company_id, org_name, uploaded_at, rows, companies(name)")
      .order("uploaded_at", { ascending: false });

    return (data ?? []).map((chart) => {
      const rows = (Array.isArray(chart.rows) ? chart.rows : []) as Record<string, string>[];
      const first = rows[0];
      return {
        id: chart.id,
        companyId: chart.company_id,
        companyName: chart.companies?.name ?? "",
        orgName: chart.org_name,
        uploadedAt: chart.uploaded_at,
        columns: first ? Object.keys(first) : [],
        rowCount: rows.length,
        preview: rows.slice(0, 5),
      };
    });
  });

/* ─────────────────── 업무분장표 AI 가안 (V8) ─────────────────── */

export type DutyDraftRow = { main: string; detail: string };

export type DutyDraftChart = {
  orgId: string;
  orgName: string;
  companyId: string;
  companyName: string;
  memberCount: number;
  rows: DutyDraftRow[];
};

export type DutyDraftResult = {
  charts: DutyDraftChart[];
  failedOrgs: { orgId: string; orgName: string }[];
  /** 대상 상한(DUTY_ORG_LIMIT)에 걸려 이번 호출에서 빠진 조직 수. */
  skippedOrgs: number;
};

/** 한 번에 초안을 만드는 조직 수 상한 — LLM 병렬 호출 폭을 묶는다. */
export const DUTY_ORG_LIMIT = 40;

export const draftDutyCharts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        /** 지정 시 해당 조직만 재생성한다(부분 실패 복구용). */
        orgIds: z.array(z.string().uuid()).max(DUTY_ORG_LIMIT).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<DutyDraftResult> => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLMJson } = await import("@/lib/llm.server");
    const loose = untyped(supabaseAdmin);

    // 프롬프트에는 조직명·직급·과업명 집계만 넣는다. 이름·사번·이메일은 조회조차 하지 않는다.
    const [{ data: units }, { data: companies }, { data: people }, { data: catalog }] =
      await Promise.all([
        supabaseAdmin.from("org_units").select("id, company_id, name, level").limit(1000),
        supabaseAdmin.from("companies").select("id, name"),
        loose
          .from("participants")
          .select("id, org_unit_id, grade")
          .is("archived_at", null)
          .not("org_unit_id", "is", null)
          .limit(5000),
        supabaseAdmin.from("job_catalog").select("job_group, job_series").limit(500),
      ]);

    const peopleRows = (people ?? []) as {
      id: string;
      org_unit_id: string;
      grade: string | null;
    }[];
    const membersByOrg = new Map<string, (string | null)[]>();
    for (const p of peopleRows) {
      const list = membersByOrg.get(p.org_unit_id);
      if (list) list.push(p.grade);
      else membersByOrg.set(p.org_unit_id, [p.grade]);
    }

    // 제출된 응답의 과업명을 조직 단위로 모은다 (과업 → 응답 → 참여자 → 조직).
    const orgByParticipant = new Map(peopleRows.map((p) => [p.id, p.org_unit_id]));
    const [{ data: responses }, { data: tasks }] = await Promise.all([
      supabaseAdmin
        .from("responses")
        .select("id, participant_id")
        .in("status", ["submitted", "approved"])
        .limit(3000),
      supabaseAdmin.from("response_tasks").select("response_id, name").limit(10000),
    ]);
    const orgByResponse = new Map<string, string>();
    for (const r of responses ?? []) {
      const orgId = orgByParticipant.get(r.participant_id);
      if (orgId) orgByResponse.set(r.id, orgId);
    }
    const tasksByOrg = new Map<string, (string | null)[]>();
    for (const t of tasks ?? []) {
      const orgId = orgByResponse.get(t.response_id);
      if (!orgId) continue;
      const list = tasksByOrg.get(orgId);
      if (list) list.push(t.name);
      else tasksByOrg.set(orgId, [t.name]);
    }

    // 대상 = 인원이 배정된 조직 전체. 상한 초과 시 배정 인원 많은 순으로 자른다.
    let targets = (
      (units ?? []) as { id: string; company_id: string; name: string; level: string | null }[]
    )
      .filter((u) => (membersByOrg.get(u.id)?.length ?? 0) > 0)
      .sort(
        (a, b) => (membersByOrg.get(b.id)?.length ?? 0) - (membersByOrg.get(a.id)?.length ?? 0),
      );
    if (data.orgIds && data.orgIds.length > 0) {
      const wanted = new Set(data.orgIds);
      targets = targets.filter((u) => wanted.has(u.id));
    }
    const skippedOrgs = Math.max(0, targets.length - DUTY_ORG_LIMIT);
    targets = targets.slice(0, DUTY_ORG_LIMIT);
    if (targets.length === 0) {
      throw new Error("인원이 배정된 조직이 없습니다. 조직도와 참여자 배정을 먼저 확인하세요.");
    }

    const companyName = new Map((companies ?? []).map((c) => [c.id, c.name]));
    const catalogBrief = [...new Set((catalog ?? []).map((c) => `${c.job_group}>${c.job_series}`))]
      .join(", ")
      .slice(0, 400);

    const system =
      "너는 자동차 부품 제조사의 조직 컨설턴트다. 한국 제조업 인사 실무 용어로 조직 업무분장표 초안을 만든다. " +
      "설명이나 머리말 없이 JSON 만 출력한다.";

    type DutyItem = { main: string; details: string[] };
    const settled = await Promise.allSettled(
      targets.map(async (org) => {
        const items = await callLLMJson<DutyItem[]>({
          system,
          user:
            `${COMPANY_BRIEF}\n[직무분류 체계] ${catalogBrief || "없음"}\n\n` +
            `「${org.name}」${org.level ? `(${org.level})` : ""} 조직의 업무분장표 초안을 만들어라.\n` +
            `[구성원 직급 분포] ${topCounts(membersByOrg.get(org.id) ?? [], 10) || "없음"}\n` +
            `[구성원이 제출한 과업] ${topCounts(tasksByOrg.get(org.id) ?? [], 30) || "없음"}\n` +
            "주요 업무 3~6개, 각 주요 업무마다 세부 업무 2~4개. " +
            "제출된 과업이 있으면 우선 반영하고, 부족한 부분만 일반적인 제조사 실무로 보완한다.\n" +
            'JSON 형식: [{"main":"주요 업무","details":["세부 업무1","세부 업무2"]}]',
          maxTokens: 1500,
        });
        const rows: DutyDraftRow[] = [];
        for (const item of Array.isArray(items) ? items : []) {
          const main = String(item?.main ?? "").trim();
          if (!main) continue;
          const details = (Array.isArray(item?.details) ? item.details : [])
            .map((d) => String(d ?? "").trim())
            .filter((d) => d !== "");
          if (details.length === 0) rows.push({ main, detail: "" });
          for (const detail of details) rows.push({ main, detail });
        }
        if (rows.length === 0) throw new Error("AI 응답 파싱 실패: 업무 항목이 비어 있습니다.");
        return {
          orgId: org.id,
          orgName: org.name,
          companyId: org.company_id,
          companyName: companyName.get(org.company_id) ?? "",
          memberCount: membersByOrg.get(org.id)?.length ?? 0,
          rows,
        } satisfies DutyDraftChart;
      }),
    );

    const charts: DutyDraftChart[] = [];
    const failedOrgs: { orgId: string; orgName: string }[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        charts.push(result.value);
      } else {
        console.error(`[draftDutyCharts] 조직 「${targets[index]!.name}」 실패:`, result.reason);
        failedOrgs.push({ orgId: targets[index]!.id, orgName: targets[index]!.name });
      }
    });
    if (charts.length === 0) {
      const firstFailure = settled.find((s) => s.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw friendlyAiError(
        firstFailure?.reason ?? new Error("업무분장 초안을 받지 못했습니다."),
        "draftDutyCharts",
      );
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "업무분장 AI 가안 생성",
      target_type: "duty_charts",
      detail: {
        orgs: charts.map((c) => c.orgName),
        failedOrgs: failedOrgs.map((f) => f.orgName),
        skippedOrgs,
        ...(data.orgIds?.length ? { requested: data.orgIds.length } : {}),
      },
    });

    return { charts, failedOrgs, skippedOrgs };
  });

/* ─────────────────── 기존 응답 ↔ 카탈로그 매핑 제안 ─────────────────── */

export type MappingSuggestion = {
  responseId: string;
  participantName: string;
  current: { job_group: string; job_series: string; job_name: string };
  suggested: { job_group: string; job_series: string; job_name: string };
  score: number;
};

function bestMatch(
  current: { job_group: string; job_series: string; job_name: string },
  catalog: { job_group: string; job_series: string; job_name: string }[],
) {
  let best: { entry: (typeof catalog)[number]; score: number } | null = null;
  for (const entry of catalog) {
    const parts: [string, string, number][] = [
      [current.job_group, entry.job_group, 0.2],
      [current.job_series, entry.job_series, 0.3],
      [current.job_name, entry.job_name, 0.5],
    ];
    const used = parts.filter(([a]) => a.trim() !== "");
    if (used.length === 0) return null;
    const weight = used.reduce((sum, [, , w]) => sum + w, 0);
    const score = used.reduce((sum, [a, b, w]) => sum + w * similarity(a, b), 0) / weight;
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

export const suggestResponseMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MappingSuggestion[]> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: catalog }, { data: responses }] = await Promise.all([
      supabaseAdmin.from("job_catalog").select("job_group, job_series, job_name"),
      supabaseAdmin
        .from("responses")
        .select("id, job_group, job_series, job_name, participants(name)")
        .limit(2000),
    ]);
    if (!catalog || catalog.length === 0) return [];

    const suggestions: MappingSuggestion[] = [];
    // ponytail: 응답 × 카탈로그 전수 비교(O(n·m)). 수천 건을 넘으면 인덱싱 필요.
    for (const response of responses ?? []) {
      const current = {
        job_group: response.job_group ?? "",
        job_series: response.job_series ?? "",
        job_name: response.job_name ?? "",
      };
      const best = bestMatch(current, catalog);
      if (!best || best.score < MAPPING_THRESHOLD) continue;
      const suggested = {
        job_group: best.entry.job_group,
        job_series: best.entry.job_series,
        job_name: best.entry.job_name,
      };
      if (
        current.job_group === suggested.job_group &&
        current.job_series === suggested.job_series &&
        current.job_name === suggested.job_name
      ) {
        continue;
      }
      suggestions.push({
        responseId: response.id,
        participantName: response.participants?.name ?? "",
        current,
        suggested,
        score: Math.round(best.score * 100) / 100,
      });
    }

    return suggestions.sort((a, b) => b.score - a.score).slice(0, 500);
  });

export const applyResponseMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        items: z
          .array(
            z.object({
              responseId: z.string().uuid(),
              job_group: z.string().trim().max(200),
              job_series: z.string().trim().max(200),
              job_name: z.string().trim().max(200),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin, writeAudit } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const failures: { responseId: string; reason: string }[] = [];
    let updated = 0;
    // ponytail: 건별 UPDATE. 500건 상한이라 그대로 두되, 더 커지면 upsert 배치로.
    for (const item of data.items) {
      const { error } = await supabaseAdmin
        .from("responses")
        .update({
          job_group: item.job_group,
          job_series: item.job_series,
          job_name: item.job_name,
        })
        .eq("id", item.responseId);
      if (error) failures.push({ responseId: item.responseId, reason: error.message });
      else updated += 1;
    }

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "응답 직무 매핑 적용",
      target_type: "responses",
      detail: { updated, failed: failures.length, items: data.items },
    });

    return { updated, failures };
  });

/* ─────────────── 변경 전 영향 미리보기 (V14-①) ─────────────── */

const IMPACT_KINDS = [
  "org_rename",
  "org_move",
  "org_delete",
  "catalog_row_update",
  "catalog_row_delete",
  "catalog_restore",
  "role_level_delete",
] as const;

export type ImpactKind = (typeof IMPACT_KINDS)[number];

/** count=0 이면 summary 도 빈 문자열이라 UI 가 요약을 생략한다 (catalog_restore 만 교체 요약을 항상 담는다). */
export type ImpactPreview = { count: number; summary: string; samples: string[] };

const SAMPLE_LIMIT = 50;

function personLabel(p: { name?: string | null; emp_no?: string | null } | null) {
  return `${p?.name ?? "?"}(${p?.emp_no ?? "-"})`;
}

export const previewImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        kind: z.enum(IMPACT_KINDS),
        /** org/catalog 계열은 uuid, role_level_delete 는 역할단계 명칭 문자열. */
        id: z.string().trim().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<ImpactPreview> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const loose = untyped(supabaseAdmin);
    const none: ImpactPreview = { count: 0, summary: "", samples: [] };

    if (data.kind === "org_rename" || data.kind === "org_move" || data.kind === "org_delete") {
      const { data: unit } = await supabaseAdmin
        .from("org_units")
        .select("id, name, company_id")
        .eq("id", data.id)
        .maybeSingle();
      if (!unit) return none;

      // 하위 조직까지 포함해 배정 참여자를 센다.
      const { data: all } = await supabaseAdmin
        .from("org_units")
        .select("id, parent_id")
        .eq("company_id", unit.company_id);
      const byParent = new Map<string, string[]>();
      for (const row of all ?? []) {
        if (!row.parent_id) continue;
        const list = byParent.get(row.parent_id);
        if (list) list.push(row.id);
        else byParent.set(row.parent_id, [row.id]);
      }
      const ids: string[] = [];
      const queue = [unit.id];
      while (queue.length > 0) {
        const cursor = queue.pop()!;
        ids.push(cursor);
        queue.push(...(byParent.get(cursor) ?? []));
      }

      const { data: members, count } = await loose
        .from("participants")
        .select("name, emp_no", { count: "exact" })
        .in("org_unit_id", ids)
        .limit(SAMPLE_LIMIT);
      const n = count ?? 0;
      if (n === 0) return none;
      const verb =
        data.kind === "org_rename"
          ? "소속 표시가 바뀝니다"
          : data.kind === "org_move"
            ? "소속 경로가 바뀝니다"
            : "조직 연결이 영향을 받습니다";
      return {
        count: n,
        summary: `이 조직(하위 포함)에 배정된 참여자 ${n}명의 ${verb}.`,
        samples: ((members ?? []) as { name: string | null; emp_no: string | null }[]).map(
          personLabel,
        ),
      };
    }

    if (data.kind === "catalog_row_update" || data.kind === "catalog_row_delete") {
      const { data: row } = await supabaseAdmin
        .from("job_catalog")
        .select("job_name")
        .eq("id", data.id)
        .maybeSingle();
      if (!row) return none;

      const { data: hits, count } = await supabaseAdmin
        .from("responses")
        .select("participants(name, emp_no)", { count: "exact" })
        .eq("job_name", row.job_name)
        .limit(SAMPLE_LIMIT);
      const n = count ?? 0;
      if (n === 0) return none;
      return {
        count: n,
        summary:
          data.kind === "catalog_row_delete"
            ? `「${row.job_name}」 직무로 제출된 응답 ${n}건이 분류 없는 상태가 됩니다.`
            : `「${row.job_name}」 직무로 제출된 응답 ${n}건의 직무 표기와 어긋날 수 있습니다.`,
        samples: (hits ?? []).map((h) => personLabel(h.participants)),
      };
    }

    if (data.kind === "catalog_restore") {
      const { data: version } = await loose
        .from("job_catalog_versions")
        .select("label, rows")
        .eq("id", data.id)
        .maybeSingle();
      if (!version) return none;
      const verRows = (Array.isArray(version.rows) ? version.rows : []) as CatalogRowLike[];
      const verNames = new Set(verRows.map((r) => String(r.job_name ?? "")).filter(Boolean));

      const { data: current } = await supabaseAdmin.from("job_catalog").select("job_name");
      const removed = [
        ...new Set((current ?? []).map((c) => c.job_name).filter((name) => !verNames.has(name))),
      ];

      let n = 0;
      let samples: string[] = [];
      if (removed.length > 0) {
        const { data: hits, count } = await supabaseAdmin
          .from("responses")
          .select("job_name, participants(name, emp_no)", { count: "exact" })
          .in("job_name", removed)
          .limit(SAMPLE_LIMIT);
        n = count ?? 0;
        samples = (hits ?? []).map((h) => `${personLabel(h.participants)} · ${h.job_name}`);
      }
      const base = `현재 직무분류 ${(current ?? []).length}행이 「${version.label}」 버전 ${verRows.length}행으로 교체됩니다.`;
      return {
        count: n,
        summary:
          n > 0 ? `${base} 버전에 없는 직무로 제출된 응답 ${n}건이 영향을 받습니다.` : base,
        samples,
      };
    }

    // role_level_delete — settings UI 연결은 범위 밖이지만 함수는 여기서 export 한다.
    const { data: hits, count } = await loose
      .from("participants")
      .select("name, emp_no", { count: "exact" })
      .eq("role_level", data.id)
      .limit(SAMPLE_LIMIT);
    const n = count ?? 0;
    if (n === 0) return none;
    return {
      count: n,
      summary: `역할단계 「${data.id}」 를 쓰는 참여자 ${n}명이 영향을 받습니다.`,
      samples: ((hits ?? []) as { name: string | null; emp_no: string | null }[]).map(personLabel),
    };
  });

/* ───────────────────────────── 현황 ───────────────────────────── */

const UPLOAD_ACTIONS = ["조직도 업로드", "직무 카탈로그 업로드", "업무분장표 업로드"] as const;

export type MasterStatus = {
  orgUnits: number;
  jobCatalog: number;
  dutyCharts: number;
  responses: number;
  lastUploads: { action: string; at: string }[];
};

export const getMasterStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MasterStatus> => {
    const { requireAdmin } = await import("@/lib/guard.server");
    await requireAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [orgUnits, jobCatalog, dutyCharts, responses, logs] = await Promise.all([
      supabaseAdmin.from("org_units").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("job_catalog").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("duty_charts").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("responses").select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("audit_logs")
        .select("action, created_at")
        .in("action", [...UPLOAD_ACTIONS])
        .order("created_at", { ascending: false })
        .limit(60),
    ]);

    const lastUploads: { action: string; at: string }[] = [];
    for (const action of UPLOAD_ACTIONS) {
      const hit = (logs.data ?? []).find((log) => log.action === action);
      if (hit) lastUploads.push({ action, at: hit.created_at });
    }

    return {
      orgUnits: orgUnits.count ?? 0,
      jobCatalog: jobCatalog.count ?? 0,
      dutyCharts: dutyCharts.count ?? 0,
      responses: responses.count ?? 0,
      lastUploads,
    };
  });
