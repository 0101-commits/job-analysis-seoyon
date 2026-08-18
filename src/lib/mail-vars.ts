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

/** 메일 본문 이미지 저장소(공개 읽기 버킷). */
export const MAIL_ASSET_BUCKET = "mail-assets";

export const MAX_IMAGE_WIDTH = 600;
export const DEFAULT_IMAGE_WIDTH = 480;

/** `{이미지:파일경로|폭}` — 경로에 `|`, `{`, `}` 는 쓸 수 없다(업로드 시 파일명을 안전화한다). */
const IMAGE_TOKEN = /\{이미지:([^|{}]+)\|(\d{1,4})\}/g;

export function imageToken(path: string, width: number) {
  return `{이미지:${path}|${clampImageWidth(width)}}`;
}

export function clampImageWidth(width: number) {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_IMAGE_WIDTH;
  return Math.min(Math.round(width), MAX_IMAGE_WIDTH);
}

/** 이미지 토큰의 유일한 파서. HTML 변환과 평문 폴백이 모두 이 함수를 거친다. */
export function replaceImageTokens(text: string, render: (path: string, width: number) => string) {
  return text.replace(IMAGE_TOKEN, (_match, path: string, width: string) =>
    render(path.trim(), clampImageWidth(Number(width))),
  );
}

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
