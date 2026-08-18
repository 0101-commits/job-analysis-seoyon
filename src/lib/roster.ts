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

export function rosterTemplateCsv() {
  const header = ROSTER_COLUMNS.join(",");
  const sample = ["서연", "홍길동", "20150908", "gildong.hong@seoyon.example", "900312", "경영기획본부 / 기획팀", "차장", "책임"].join(",");
  return "﻿" + header + "\n" + sample + "\n";
}

export async function parseRosterFile(file: File): Promise<RosterRaw[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false, codepage: 65001 });
  const sheetName = wb.SheetNames[0];
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
      if (seenEmail.has(emailKey)) errors.push(`파일 내 이메일 중복 (${seenEmail.get(emailKey)}행)`);
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
