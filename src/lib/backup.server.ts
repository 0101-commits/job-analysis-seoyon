// 자동 백업과 복구 (기획 F3).
//
// 파일은 비공개 Storage 버킷 'backups' 에, 목록은 public.backups 표에 남는다.
// 되돌리기는 "응답 데이터"만 대상으로 한다 — 참여자·계열사·조직도 같은 기준정보를 함께
// 되돌리면 그 사이에 만들어진 계정이 사라져 로그인이 깨진다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./paginate";

const BUCKET = "backups";

/**
 * 백업에 담는 표.
 * export.functions.ts 의 수동 시점 저장본(snapshotAll)과 같은 범위를 유지한다.
 * (그 목록은 export 쪽 내부 상수로 내보내지 않아 여기에 같은 값을 둔다. 한쪽을 늘리면
 *  다른 쪽도 함께 늘려야 한다.)
 */
const BACKUP_TABLES = [
  "companies",
  "user_roles",
  "system_settings",
  "survey_settings",
  "org_units",
  "job_catalog",
  "duty_charts",
  "example_library",
  "mail_templates",
  "mail_batches",
  "mail_logs",
  "responses",
  "response_tasks",
  "response_activities",
  "response_skills",
  "response_requirements",
  "review_comments",
  "ai_suggestions",
  "audit_logs",
] as const;

/** 초기 비밀번호·생년월일은 백업에도 담지 않는다(export.functions.ts 와 동일). */
const PARTICIPANT_COLUMNS =
  "id, user_id, company_id, emp_no, name, email, org_text, grade, role_level, role," +
  " account_status, invited_at, first_login_at, last_seen_at, must_change_password," +
  " failed_login_count, locked_until, created_at, updated_at";

/**
 * 되돌리기 대상 — 참여자가 쓴 응답과 그 검토 이력만.
 *
 * 포함:  responses, response_tasks, response_activities, response_skills,
 *        response_requirements, review_comments
 * 제외:  participants(계정), companies, org_units, job_catalog, user_roles,
 *        system_settings, survey_settings, mail_*, audit_logs
 *        — 되돌리면 계정·권한·설정이 과거로 돌아가 로그인과 발송 이력이 깨진다.
 *
 * 넣는 순서는 부모 → 자식(외래키 순서), 지우는 순서는 그 역순이다.
 */
const RESTORE_TABLES = [
  "responses",
  "response_tasks",
  "response_activities",
  "response_skills",
  "response_requirements",
  "review_comments",
] as const;

export type BackupKind = "자동" | "수동" | "반영전";

/** 파일 이름에는 영문만 쓴다 — 종류는 목록(backups.kind)에 그대로 남는다. */
const KIND_SLUG: Record<BackupKind, string> = {
  자동: "auto",
  수동: "manual",
  반영전: "prerestore",
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CHUNK = 500;

type Row = Record<string, unknown>;

/** 표 이름을 변수로 다루기 위한 최소 질의 인터페이스(생성 타입 폭주 회피). */
type LooseResult = { data: Row[] | null; error: { message: string } | null };
interface LooseQuery extends PromiseLike<LooseResult> {
  select(columns: string): LooseQuery;
  delete(): LooseQuery;
  upsert(rows: Row[], options?: { onConflict?: string }): LooseQuery;
  in(column: string, values: unknown[]): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  range(from: number, to: number): LooseQuery;
  limit(count: number): LooseQuery;
}
interface LooseDb {
  from(table: string): LooseQuery;
}

function loose(admin: SupabaseClient): LooseDb {
  return admin as unknown as LooseDb;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** 파일 경로는 한국 시간 기준으로 만든다 — 관리자가 보는 시각과 파일명이 같아야 한다. */
function backupPath(kind: BackupKind, now = Date.now()) {
  const k = new Date(now + KST_OFFSET_MS);
  const y = k.getUTCFullYear();
  const m = pad(k.getUTCMonth() + 1);
  const d = pad(k.getUTCDate());
  const hh = pad(k.getUTCHours());
  const mm = pad(k.getUTCMinutes());
  return `${y}/${m}/${y}${m}${d}-${hh}${mm}-${KIND_SLUG[kind]}.json`;
}

/**
 * 페이지를 이어 받으려면 안정된 정렬 키가 필요하다. 기본은 'id' 이고,
 * id 열이 없는 표만 여기에 예외로 적는다(없는 열로 정렬하면 조회 자체가 실패한다).
 */
const SORT_KEYS: Record<string, string> = { survey_settings: "company_id" };

async function readTable(db: LooseDb, table: string, columns = "*") {
  const sortKey = SORT_KEYS[table] ?? "id";
  return fetchAll<Row>((from, to) =>
    db.from(table).select(columns).order(sortKey, { ascending: true }).range(from, to),
  );
}

export type BackupFile = {
  schema_version: string;
  kind: string;
  generated_at: string;
  counts: Record<string, number>;
  tables: Record<string, Row[]>;
};

/** 전체 시점 저장본을 만들어 Storage 에 올리고 목록에 한 줄 남긴다. */
export async function createBackup(
  admin: SupabaseClient,
  kind: BackupKind,
  note?: string | null,
  createdBy?: string | null,
) {
  const db = loose(admin);
  const tables: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};

  // 참여자는 열을 골라 담는다(초기 비밀번호·생년월일 제외). 나머지 표는 전체 열.
  tables["participants"] = await readTable(db, "participants", PARTICIPANT_COLUMNS);
  counts["participants"] = tables["participants"].length;
  for (const table of BACKUP_TABLES) {
    const rows = await readTable(db, table);
    tables[table] = rows;
    counts[table] = rows.length;
  }

  const payload: BackupFile = {
    schema_version: "1.0",
    kind,
    generated_at: new Date().toISOString(),
    counts,
    tables,
  };
  const json = JSON.stringify(payload);
  const path = backupPath(kind);
  const sizeBytes = new TextEncoder().encode(json).length;

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, new Blob([json], { type: "application/json" }), {
      contentType: "application/json",
      upsert: true,
    });
  if (uploadError) throw new Error(`백업 파일을 저장하지 못했습니다: ${uploadError.message}`);

  const { error: rowError } = await admin.from("backups").upsert(
    {
      path,
      kind,
      row_counts: counts as never,
      size_bytes: sizeBytes,
      note: note ?? null,
      created_by: createdBy ?? null,
    },
    { onConflict: "path" },
  );
  if (rowError) throw new Error(`백업 목록에 기록하지 못했습니다: ${rowError.message}`);

  const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { path, counts, totalRows, sizeBytes };
}

export type BackupRow = {
  id: string;
  path: string;
  kind: string;
  note: string | null;
  size_bytes: number | null;
  row_counts: Record<string, number>;
  created_at: string;
  totalRows: number;
};

export async function listBackups(admin: SupabaseClient, limit = 50): Promise<BackupRow[]> {
  const { data, error } = await admin
    .from("backups")
    .select("id, path, kind, note, size_bytes, row_counts, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => {
    const counts = (r.row_counts ?? {}) as Record<string, number>;
    return {
      ...r,
      row_counts: counts,
      totalRows: Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0),
    };
  });
}

async function downloadBackup(admin: SupabaseClient, path: string): Promise<BackupFile> {
  const { data, error } = await admin.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error(`백업 파일을 읽지 못했습니다: ${error?.message ?? "파일이 없습니다"}`);
  }
  return JSON.parse(await data.text()) as BackupFile;
}

/** 두 행이 같은 내용인지 — 열 순서 차이는 무시한다. */
function sameRow(a: Row, b: Row) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

export type RestoreDiff = {
  table: string;
  label: string;
  /** 백업에만 있는 행 — 되돌리면 다시 살아난다. */
  restored: number;
  /** 지금만 있는 행 — 되돌리면 사라진다. */
  removed: number;
  /** 양쪽에 있지만 내용이 다른 행. */
  changed: number;
};

/** 되돌리기 대상 표의 사람이 읽는 이름. */
const TABLE_LABELS: Record<string, string> = {
  responses: "응답",
  response_tasks: "과업",
  response_activities: "세부 활동",
  response_skills: "필요 역량",
  response_requirements: "필요 요건",
  review_comments: "검토 의견",
};

export type RestoreResult = {
  dryRun: boolean;
  path: string;
  createdAt: string;
  diffs: RestoreDiff[];
  /** 실제 반영 때 먼저 만든 되돌리기 직전 백업 경로. */
  safetyPath?: string;
};

/**
 * 백업으로 되돌린다.
 *
 * - dryRun=true  : 아무것도 바꾸지 않고 표별 차이(살아남·사라짐·달라짐) 건수만 돌려준다.
 * - dryRun=false : 먼저 '반영전' 백업을 만들고, 응답 관련 표만 백업 상태로 맞춘다.
 *                  기준정보(참여자·계열사·조직도·설정)는 손대지 않는다(RESTORE_TABLES 주석 참고).
 */
export async function restoreBackup(
  admin: SupabaseClient,
  id: string,
  opts: { dryRun: boolean; actorId?: string | null },
): Promise<RestoreResult> {
  const { data: row, error } = await admin
    .from("backups")
    .select("id, path, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("백업을 찾을 수 없습니다.");

  const file = await downloadBackup(admin, row.path);
  const db = loose(admin);

  const diffs: RestoreDiff[] = [];
  const plans: { table: string; insert: Row[]; update: Row[]; deleteIds: unknown[] }[] = [];

  for (const table of RESTORE_TABLES) {
    const backupRows = file.tables[table] ?? [];
    const currentRows = await readTable(db, table);
    const backupById = new Map(backupRows.map((r) => [String(r["id"]), r]));
    const currentById = new Map(currentRows.map((r) => [String(r["id"]), r]));

    const insert: Row[] = [];
    const update: Row[] = [];
    for (const [key, backupRow] of backupById) {
      const current = currentById.get(key);
      if (!current) insert.push(backupRow);
      else if (!sameRow(backupRow, current)) update.push(backupRow);
    }
    const deleteIds = [...currentById.keys()].filter((key) => !backupById.has(key));

    diffs.push({
      table,
      label: TABLE_LABELS[table] ?? table,
      restored: insert.length,
      removed: deleteIds.length,
      changed: update.length,
    });
    plans.push({ table, insert, update, deleteIds });
  }

  if (opts.dryRun) {
    return { dryRun: true, path: row.path, createdAt: row.created_at, diffs };
  }

  // 되돌리기 자체를 되돌릴 수 있게, 반영 직전 상태를 먼저 파일로 남긴다.
  const safety = await createBackup(
    admin,
    "반영전",
    `되돌리기 직전 자동 저장 (${row.path})`,
    opts.actorId ?? null,
  );

  // 자식 → 부모 순으로 지우고, 부모 → 자식 순으로 넣는다.
  for (const plan of [...plans].reverse()) {
    for (let i = 0; i < plan.deleteIds.length; i += CHUNK) {
      const chunk = plan.deleteIds.slice(i, i + CHUNK);
      const { error: delError } = await db.from(plan.table).delete().in("id", chunk);
      if (delError) throw new Error(`${plan.table} 정리 실패: ${delError.message}`);
    }
  }
  for (const plan of plans) {
    const rows = [...plan.insert, ...plan.update];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error: upError } = await db.from(plan.table).upsert(chunk, { onConflict: "id" });
      if (upError) throw new Error(`${plan.table} 되돌리기 실패: ${upError.message}`);
    }
  }

  const { writeAudit } = await import("./guard.server");
  await writeAudit(admin, {
    actor_id: opts.actorId ?? null,
    action: "백업 되돌리기",
    target_type: "backups",
    target_id: id,
    detail: {
      백업파일: row.path,
      반영전백업: safety.path,
      대상: diffs.map((d) => ({
        표: d.label,
        살아남: d.restored,
        사라짐: d.removed,
        달라짐: d.changed,
      })),
    },
  });

  return {
    dryRun: false,
    path: row.path,
    createdAt: row.created_at,
    diffs,
    safetyPath: safety.path,
  };
}

/**
 * 보존 기간이 지난 백업을 지운다.
 * 파일과 목록을 함께 지운다 — 한쪽만 남으면 화면과 실제가 어긋난다.
 */
export async function deleteExpiredBackups(admin: SupabaseClient) {
  const { data: settings } = await admin
    .from("system_settings")
    .select("backup_retention_days")
    .maybeSingle();
  const retentionDays =
    (settings as { backup_retention_days?: number } | null)?.backup_retention_days ?? 30;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  const { data: old, error } = await admin
    .from("backups")
    .select("id, path")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = old ?? [];
  if (rows.length > 0) {
    // 파일을 먼저 지운다. 파일 삭제가 실패하면 목록도 남겨 다음 실행에서 다시 시도한다.
    const { error: fileError } = await admin.storage.from(BUCKET).remove(rows.map((r) => r.path));
    if (fileError) throw new Error(`오래된 백업 파일 삭제 실패: ${fileError.message}`);
    const { error: rowError } = await admin
      .from("backups")
      .delete()
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (rowError) throw new Error(`오래된 백업 목록 삭제 실패: ${rowError.message}`);
  }

  const { count } = await admin.from("backups").select("id", { count: "exact", head: true });
  return { deleted: rows.length, retentionDays, remaining: count ?? 0 };
}
