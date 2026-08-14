export const MAIL_VARIABLES = [
  { token: "{이름}", desc: "참여자 성명" },
  { token: "{회사}", desc: "계열사명" },
  { token: "{소속}", desc: "소속 조직" },
  { token: "{ID}", desc: "로그인 아이디(이메일)" },
  { token: "{초기PW}", desc: "초기 비밀번호" },
  { token: "{마감일}", desc: "조사 제출 마감일" },
  { token: "{접속링크}", desc: "시스템 접속 주소" },
] as const;

export type MailVars = Record<string, string>;

export function renderMailText(text: string, vars: MailVars) {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    text,
  );
}

export function buildMailVars(input: {
  name?: string | null;
  company?: string | null;
  org?: string | null;
  email?: string | null;
  initialPassword?: string | null;
  deadline?: string | null;
  link: string;
}): MailVars {
  return {
    이름: input.name ?? "",
    회사: input.company ?? "",
    소속: input.org ?? "",
    ID: input.email ?? "",
    초기PW: input.initialPassword ?? "(발급 후 안내)",
    마감일: input.deadline ? input.deadline.slice(0, 10) : "미정",
    접속링크: input.link,
  };
}
