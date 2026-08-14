export const PASSWORD_TOKENS = [
  { token: "{birth6}", label: "생년월일 6자리", example: "900312" },
  { token: "{empno}", label: "사번 전체", example: "20150908" },
  { token: "{empno_last4}", label: "사번 뒤 4자리", example: "0908" },
  { token: "{random4}", label: "임의 숫자 4자리", example: "8421" },
] as const;

export type PasswordSource = {
  emp_no?: string | null;
  birth_date?: string | null;
};

function birth6(birthDate?: string | null) {
  if (!birthDate) return "000101";
  const d = birthDate.slice(0, 10).replace(/-/g, "");
  return d.length >= 8 ? d.slice(2, 8) : d;
}

export function renderPasswordRule(rule: string, p: PasswordSource, randomSeed?: string) {
  const emp = (p.emp_no ?? "").trim();
  const rnd = randomSeed ?? String(Math.floor(1000 + Math.random() * 9000));
  return rule
    .replaceAll("{birth6}", birth6(p.birth_date))
    .replaceAll("{empno_last4}", emp.slice(-4) || "0000")
    .replaceAll("{empno}", emp || "00000000")
    .replaceAll("{random4}", rnd);
}

export function validatePasswordRule(rule: string): string | null {
  if (!rule.trim()) return "규칙을 입력해 주세요.";
  const unknown = rule.match(/\{[^}]*\}/g)?.filter(
    (t) => !PASSWORD_TOKENS.some((x) => x.token === t),
  );
  if (unknown?.length) return `알 수 없는 토큰: ${unknown.join(", ")}`;
  const sample = renderPasswordRule(rule, { emp_no: "20150908", birth_date: "1990-03-12" }, "8421");
  if (sample.length < 8) return "생성되는 비밀번호가 8자 이상이 되도록 구성해 주세요.";
  return null;
}
