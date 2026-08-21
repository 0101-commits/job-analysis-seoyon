import { withJosa } from "@/lib/glossary";
import type { SheetSpec } from "@/lib/xlsx";
import * as XLSX from "xlsx";

export const ROSTER_COLUMNS = [
  "회사",
  "성명",
  "사번",
  "이메일",
  "생년월일(YYMMDD)",
  "소속",
  "직급",
  "역할단계",
] as const;

export type RosterRaw = Record<string, string>;

export type RosterRow = {
  rowNo: number;
  raw: RosterRaw;
  errors: string[];
  parsed: {
    company: string;
    company_id: string | null;
    name: string;
    emp_no: string;
    email: string | null;
    birth_date: string | null;
    org_text: string | null;
    grade: string | null;
    role_level: string | null;
  };
};

/**
 * 명부 템플릿(엑셀 2시트) — 시트1 「입력」에 헤더+예시 1행, 시트2 「작성 안내」에 열별 안내.
 */
export function rosterTemplateSheets(): SheetSpec[] {
  return [
    {
      name: "입력",
      rows: [
        [...ROSTER_COLUMNS],
        [
          "서연",
          "홍길동",
          "20150908",
          "gildong.hong@seoyon.example",
          "900312",
          "경영기획본부 / 기획팀",
          "차장",
          "책임",
        ],
      ],
      colWidths: [10, 10, 12, 30, 16, 26, 8, 10],
    },
    {
      name: "작성 안내",
      rows: [
        ["항목", "필수 여부", "형식", "예시", "자주 하는 실수"],
        [
          "회사",
          "필수",
          "시스템에 등록된 계열사 이름 그대로",
          "서연",
          "약칭이나 다른 표기로 적으면 「등록되지 않은 계열사」 오류가 납니다",
        ],
        ["성명", "필수", "실명", "홍길동", "이름 뒤에 직급을 붙여 적지 않습니다"],
        [
          "사번",
          "필수",
          "사내 사번 그대로",
          "20150908",
          "같은 계열사 안에서 중복되거나 이미 등록된 사번이면 올릴 수 없습니다",
        ],
        [
          "이메일",
          "필수",
          "실제 수신 가능한 회사 메일",
          "gildong.hong@seoyon.example",
          "오타·퇴사자 메일 주의. 허용 도메인이 설정돼 있으면 그 도메인만 통과합니다",
        ],
        [
          "생년월일(YYMMDD)",
          "선택",
          "YYMMDD 6자리 (YYYYMMDD 8자리도 가능)",
          "900101",
          "숫자가 6자리도 8자리도 아니면 형식 오류가 납니다",
        ],
        [
          "소속",
          "선택",
          "본부/팀을 「/」로 구분해 한 칸에",
          "경영기획본부 / 기획팀",
          "조직도와 다른 이름으로 적으면 조직 연결이 자동으로 되지 않을 수 있습니다",
        ],
        ["직급", "선택", "회사에서 쓰는 직급 명칭", "차장", "비워 두어도 됩니다"],
        ["역할단계", "선택", "회사에서 쓰는 역할단계 명칭", "책임", "비워 두어도 됩니다"],
      ],
      colWidths: [18, 10, 34, 30, 48],
    },
  ];
}

export async function parseRosterFile(file: File): Promise<RosterRaw[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false, codepage: 65001 });
  // 2시트 템플릿(입력 + 작성 안내)을 그대로 올려도 안내 시트를 데이터로 오인하지 않도록
  // 「입력」 시트가 있으면 그것을, 없으면 첫 시트를 읽는다.
  const sheetName = wb.SheetNames.includes("입력") ? "입력" : wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  const json = XLSX.utils.sheet_to_json<RosterRaw>(sheet, { defval: "", raw: false });
  return json.map((row) => {
    const clean: RosterRaw = {};
    for (const [k, v] of Object.entries(row)) clean[String(k).trim()] = String(v ?? "").trim();
    return clean;
  });
}

function normalizeBirth(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (digits.length === 6) {
    const yy = Number(digits.slice(0, 2));
    const century = yy > 30 ? 1900 : 2000;
    return `${century + yy}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * @param allowedDomains 허용 이메일 도메인. 빈 배열이면 도메인 검사를 건너뛴다(= 제한 없음).
 */
export function validateRoster(
  rows: RosterRaw[],
  companies: { id: string; name: string }[],
  existing: { emp_no: string; email: string | null }[],
  allowedDomains: string[] = [],
): RosterRow[] {
  const allowed = new Set(
    allowedDomains.map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
  );
  const seenEmp = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const existingEmp = new Set(existing.map((e) => e.emp_no.trim()));
  const existingEmail = new Set(
    existing.filter((e) => e.email).map((e) => (e.email as string).toLowerCase()),
  );

  return rows.map((raw, index) => {
    const rowNo = index + 2;
    const errors: string[] = [];
    const companyName = raw["회사"] ?? "";
    const company = companies.find((c) => c.name === companyName);
    const name = raw["성명"] ?? "";
    const emp_no = raw["사번"] ?? "";
    const emailRaw = raw["이메일"] ?? "";
    const birthRaw = raw["생년월일(YYMMDD)"] ?? raw["생년월일"] ?? "";

    if (!companyName) errors.push("회사 누락");
    else if (!company) errors.push(`등록되지 않은 계열사: ${companyName}`);
    if (!name) errors.push("성명 누락");
    if (!emp_no) errors.push("사번 누락");
    if (!emailRaw) errors.push("이메일 누락");
    else if (!EMAIL_RE.test(emailRaw)) errors.push("이메일 형식 오류");
    else if (allowed.size > 0) {
      const domain = emailRaw.slice(emailRaw.lastIndexOf("@") + 1).toLowerCase();
      if (!allowed.has(domain)) errors.push(`허용되지 않은 이메일 도메인(@${domain})`);
    }

    const birth_date = birthRaw ? normalizeBirth(birthRaw) : null;
    if (birthRaw && !birth_date) errors.push("생년월일 형식 오류 (YYMMDD)");

    if (emp_no) {
      if (seenEmp.has(emp_no)) errors.push(`파일 내 사번 중복 (${seenEmp.get(emp_no)}행)`);
      else seenEmp.set(emp_no, rowNo);
      if (existingEmp.has(emp_no)) errors.push("이미 등록된 사번");
    }
    const emailKey = emailRaw.toLowerCase();
    if (emailKey) {
      if (seenEmail.has(emailKey))
        errors.push(`파일 내 이메일 중복 (${seenEmail.get(emailKey)}행)`);
      else seenEmail.set(emailKey, rowNo);
      if (existingEmail.has(emailKey)) errors.push("이미 등록된 이메일");
    }

    return {
      rowNo,
      raw,
      errors,
      parsed: {
        company: companyName,
        company_id: company?.id ?? null,
        name,
        emp_no,
        email: emailRaw || null,
        birth_date,
        org_text: raw["소속"] || null,
        grade: raw["직급"] || null,
        role_level: raw["역할단계"] || null,
      },
    };
  });
}

/* ═══════════════════ 명부 재업로드 대조 (기획 F9) ═══════════════════
 *
 * 조사 기간이 3~4주라 그 사이에 입사·퇴사·전보가 반드시 생긴다. 새 명부를 그냥 덮어쓰면
 * 무엇이 달라졌는지 관리자가 눈으로 찾아야 하므로, 반영 전에 아래 분류로 먼저 보여 준다.
 * 이 파일의 함수는 DB 를 모르는 순수 함수다 — 조회는 admin.functions.ts 가 하고
 * 대조·분류만 여기서 한다(같은 규칙을 대조와 반영 두 곳에서 똑같이 쓰기 위해).
 */

/** 대조에 넣는 명부 한 행. validateRoster 를 통과한 parsed 값과 같은 모양이다. */
export type RosterDiffRow = {
  company_id: string;
  emp_no: string;
  name: string;
  email: string | null;
  birth_date: string | null;
  org_text: string | null;
  grade: string | null;
  role_level: string | null;
};

/** 대조 상대 — 이미 등록된 참여자. */
export type RosterExistingRow = RosterDiffRow & {
  id: string;
  archived_at: string | null;
};

export type RosterDiffKind =
  "신규" | "퇴사후보" | "조직이동" | "직무변경" | "기타변경" | "변경없음";

export type RosterChange = { field: string; label: string; before: string; after: string };

export type RosterDiffItem = {
  /** 반영 요청이 처리 대상을 지목하는 값. 같은 명부를 다시 대조하면 같은 값이 나온다. */
  key: string;
  kind: RosterDiffKind;
  name: string;
  emp_no: string;
  company_id: string;
  /** 명부 행의 위치. 반영 시 서버가 이 위치의 행을 그대로 쓴다. 퇴사 후보는 null. */
  rowIndex: number | null;
  /** 이미 등록된 사람이면 그 id. 신규는 null. */
  participantId: string | null;
  /** 짝이 맞은 참여자의 현재 사번 — 사번이 바뀐 경우 반영 경로가 달라진다. */
  existingEmpNo: string | null;
  /** 보관된 참여자와 짝이 맞았다. 화면에 표시만 하고 보관 해제는 자동으로 하지 않는다. */
  archived: boolean;
  changes: RosterChange[];
};

export type RosterDiffResult = {
  items: RosterDiffItem[];
  /** 「변경 없음」은 목록에 담지 않고 여기 건수로만 센다 — 수백 건이 화면을 덮지 않게. */
  summary: Record<RosterDiffKind, number>;
};

/** 명부와 DB 를 나란히 놓고 비교하는 항목. 라벨은 화면에 그대로 나간다. */
const DIFF_FIELDS = [
  { field: "name", label: "성명" },
  { field: "email", label: "이메일" },
  { field: "birth_date", label: "생년월일" },
  { field: "org_text", label: "소속" },
  { field: "grade", label: "직급" },
  { field: "role_level", label: "역할단계" },
] as const;

function norm(value: string | null | undefined) {
  return (value ?? "").trim();
}

/**
 * 대조 키 규칙 — 이 순서로 같은 사람인지 판정한다.
 *
 *  1) 계열사 + 사번. DB 의 (company_id, emp_no) 유니크 제약과 같은 키이므로 이것이 기본이다.
 *  2) 1) 로 못 찾았고 이메일이 있으면 계열사 + 이메일(소문자). 사번을 다시 발급받은 사람을
 *     「신규 + 퇴사 후보」 두 건으로 쪼개지 않기 위한 보조 키다.
 *
 * 계열사가 다르면 사번이 같아도 다른 사람으로 본다 — 서연·서연이화 두 곳에서 사번이 겹칠 수 있다.
 */
function empKey(companyId: string, empNo: string) {
  return `E|${companyId}|${norm(empNo)}`;
}

function mailKey(companyId: string, email: string | null) {
  const mail = norm(email).toLowerCase();
  return mail ? `M|${companyId}|${mail}` : "";
}

/**
 * 명부(rows)와 기등록자(existing)를 대조해 분류만 돌려준다. 아무것도 반영하지 않는다.
 *
 * @param leaverCompanyIds 퇴사 후보를 찾을 계열사. 비우면 명부에 등장한 계열사 전체.
 *        올리지 않은 계열사 사람이 전원 퇴사 후보로 잡히는 사고를 막는 안전장치다.
 */
export function computeRosterDiff(
  rows: RosterDiffRow[],
  existing: RosterExistingRow[],
  leaverCompanyIds?: string[] | null,
): RosterDiffResult {
  const byEmp = new Map<string, RosterExistingRow>();
  const byMail = new Map<string, RosterExistingRow>();
  for (const e of existing) {
    byEmp.set(empKey(e.company_id, e.emp_no), e);
    const mk = mailKey(e.company_id, e.email);
    // 같은 이메일이 여러 사람에게 있으면 먼저 나온 사람만 보조 키로 쓴다(보조 키는 참고용).
    if (mk && !byMail.has(mk)) byMail.set(mk, e);
  }

  const leaverScope = new Set(
    leaverCompanyIds && leaverCompanyIds.length > 0
      ? leaverCompanyIds
      : rows.map((r) => r.company_id),
  );

  const items: RosterDiffItem[] = [];
  const matched = new Set<string>();
  const summary: Record<RosterDiffKind, number> = {
    신규: 0,
    퇴사후보: 0,
    조직이동: 0,
    직무변경: 0,
    기타변경: 0,
    변경없음: 0,
  };

  rows.forEach((row, rowIndex) => {
    const mk = mailKey(row.company_id, row.email);
    const hit = byEmp.get(empKey(row.company_id, row.emp_no)) ?? (mk ? byMail.get(mk) : undefined);
    if (hit) matched.add(hit.id);

    const changes: RosterChange[] = [];
    if (hit) {
      if (norm(hit.emp_no) !== norm(row.emp_no)) {
        changes.push({
          field: "emp_no",
          label: "사번",
          before: norm(hit.emp_no),
          after: norm(row.emp_no),
        });
      }
      for (const f of DIFF_FIELDS) {
        const before = norm(hit[f.field]);
        const after = norm(row[f.field]);
        if (before !== after) changes.push({ field: f.field, label: f.label, before, after });
      }
    }

    // 한 사람에게 두 가지가 같이 바뀔 수 있어(예: 소속 + 직급) 대표 분류를 하나만 고른다.
    // 재확인이 필요한 쪽을 먼저 잡고, 바뀐 항목 전체는 changes 로 함께 보여 준다.
    const kind: RosterDiffKind = !hit
      ? "신규"
      : changes.length === 0
        ? "변경없음"
        : changes.some((c) => c.field === "org_text")
          ? "조직이동"
          : // 명부에는 직무 열이 없다. 직무의 범위를 정하는 값은 역할단계뿐이라 이것을 직무 변경으로 본다.
            changes.some((c) => c.field === "role_level")
            ? "직무변경"
            : "기타변경";

    summary[kind] += 1;
    if (kind === "변경없음") return;

    items.push({
      key: `r${rowIndex}`,
      kind,
      name: row.name,
      emp_no: row.emp_no,
      company_id: row.company_id,
      rowIndex,
      participantId: hit?.id ?? null,
      existingEmpNo: hit ? norm(hit.emp_no) : null,
      archived: !!hit?.archived_at,
      changes,
    });
  });

  for (const e of existing) {
    if (matched.has(e.id) || e.archived_at) continue;
    if (!leaverScope.has(e.company_id)) continue;
    summary["퇴사후보"] += 1;
    items.push({
      key: `p${e.id}`,
      kind: "퇴사후보",
      name: e.name,
      emp_no: e.emp_no,
      company_id: e.company_id,
      rowIndex: null,
      participantId: e.id,
      existingEmpNo: norm(e.emp_no),
      archived: false,
      changes: [],
    });
  }

  return { items, summary };
}

/** 재확인 안내에 그대로 쓰는 한 줄. 참여자가 읽는 문장이라 「무엇이 바뀌었고 무엇을 하면 되는지」로 쓴다. */
export function rosterRecheckReason(item: RosterDiffItem): string {
  const shown = item.changes.filter((c) => c.field === "org_text" || c.field === "role_level");
  const parts = (shown.length > 0 ? shown : item.changes).map(
    (c) =>
      `${withJosa(c.label, "이/가")} '${c.before || "비어 있음"}'에서 '${c.after || "비어 있음"}'으로 바뀌었습니다`,
  );
  return `${parts.join(", ")}. 바뀐 내용을 기준으로 작성한 응답을 다시 확인해 주세요.`;
}
