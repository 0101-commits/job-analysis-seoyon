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

/* ─────────────────── 직무분류표 AI 가안 ─────────────────── */

export type JobDraftRow = {
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string;
};

const JOB_GROUP_COUNT = 7;

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

export const draftJobCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: JobDraftRow[] }> => {
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
      "대상 회사는 자동차 부품 제조사다. 주력 제품은 내장재(도어트림·시트·범퍼)이며 " +
      "연구개발부터 금형·사출·조립 생산까지 수행한다.\n" +
      `[조직도] ${orgList || "없음"}\n` +
      `[참여자 소속 표기 분포] ${orgTexts || "없음"}\n` +
      `[직급 분포] ${grades || "없음"}\n` +
      `[기존 응답의 직무 표기] ${existing || "없음"}`;

    const system =
      "너는 자동차 부품 제조사의 직무분석 컨설턴트다. 한국 제조업 인사 실무 용어로 직무분류 체계를 설계한다. " +
      "설명이나 머리말 없이 JSON 만 출력한다.";

    const skeleton = await callLLMJson<{ job_group: string; job_series: string[] }[]>({
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

    const groups = (Array.isArray(skeleton) ? skeleton : [])
      .map((g) => ({
        job_group: String(g?.job_group ?? "").trim(),
        job_series: (Array.isArray(g?.job_series) ? g.job_series : [])
          .map((s) => String(s ?? "").trim())
          .filter((s) => s !== ""),
      }))
      .filter((g) => g.job_group !== "" && g.job_series.length > 0)
      .slice(0, JOB_GROUP_COUNT);
    if (groups.length === 0) throw new Error("AI 가안 생성 실패: 직군 골격을 받지 못했습니다.");

    // max_tokens 2048 안에 전체 직무를 다 담을 수 없어 직군 단위로 나눠 병렬 호출한다.
    const details = await Promise.all(
      groups.map(async (group) => {
        const items = await callLLMJson<
          { job_series: string; job_name: string; definition: string }[]
        >({
          system,
          user:
            `${companyContext}\n\n` +
            `「${group.job_group}」 직군의 직무를 채워라. 직렬은 ${group.job_series.join(", ")} 이다. ` +
            "직렬마다 직무 2~5개, 각 직무에 정의를 한 문장(40자 내외)으로 붙인다.\n" +
            'JSON 형식: [{"job_series":"직렬명","job_name":"직무명","definition":"정의 한 문장"}]',
          maxTokens: 2048,
        });
        return { group: group.job_group, items: Array.isArray(items) ? items : [] };
      }),
    );

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
    if (rows.length === 0) throw new Error("AI 가안 생성 실패: 직무를 받지 못했습니다.");

    await writeAudit(supabaseAdmin, {
      actor_id: context.userId,
      action: "직무분류표 AI 가안 생성",
      target_type: "job_catalog",
      detail: { groups: groups.map((g) => g.job_group), rows: rows.length },
    });

    return { rows };
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
