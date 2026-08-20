/**
 * 화면에 노출되는 용어의 단일 원천 (기획 D1).
 *
 * 코드 식별자(테이블·컬럼·함수명)는 그대로 두고 **사람에게 보이는 문자열만** 여기서 관리한다.
 * 용어 지적이 반복된 이유는 한 번 고쳐도 다음 화면에서 되살아났기 때문이므로,
 * 새 문구를 지을 때는 먼저 이 파일에 있는지 확인하고 없으면 여기에 추가한다.
 *
 * 검사: `node scripts/check-ui-terms.mjs`
 */

/** 화면에서 쓰지 않는 말 → 대신 쓰는 말. 검사 스크립트가 이 표를 그대로 읽는다. */
export const BANNED_TERMS: Record<string, string> = {
  "검토 큐": "검토 대기",
  큐: "대기 목록",
  커버리지: "응답 충실도",
  스냅샷: "시점 저장본",
  마이그레이션: "구조 변경",
  롤업: "합계",
  엔티티: "항목",
  레코드: "건",
  로우: "행",
  페이로드: "보낼 내용",
  밸리데이션: "입력 확인",
  파싱: "읽어들이기",
  싱크: "맞추기",
  프로비저닝: "계정 생성",
  디폴트: "기본값",
  옵티미스틱: "동시 수정 방지",
  트랜잭션: "한 번에 저장",
  스키마: "항목 구성",
};

/** 확정 용어. 같은 뜻을 두 가지로 부르지 않기 위한 목록. */
export const TERMS = {
  survey: "업무조사",
  respondent: "참여자",
  admin: "관리자",
  jobGroup: "직군",
  jobSeries: "직렬",
  job: "직무",
  task: "과업",
  activity: "세부 활동",
  skill: "필요 역량",
  reviewQueue: "검토 대기",
  reject: "반려",
  approve: "승인",
  correct: "정정",
  orgUnit: "소속",
  roleLevel: "역할단계",
  deadline: "제출 마감",
  reminder: "독려 안내",
  roster: "참여자 명부",
  jobCatalog: "직무 분류",
  dutyChart: "업무분장",
  masterData: "기준정보",
  suggestion: "AI 제안",
  integrity: "정합성 점검",
  impact: "변경 영향",
} as const;

/**
 * 참여자에게 보이는 진행 상태 문구.
 * 관리자는 상태를 관리 대상으로 보고, 참여자는 자기 일로 본다 — 어휘를 분리한다 (기획 D2).
 */
export const STATUS_FOR_RESPONDENT: Record<string, string> = {
  미발송: "안내를 기다리는 중이에요",
  초대발송: "작성을 시작할 수 있어요",
  미접속: "작성을 시작할 수 있어요",
  작성중: "작성하고 있어요",
  제출: "관리자가 확인하고 있어요",
  반려: "보완이 필요해요",
  승인: "작성이 끝났어요",
};

/** 상태별 한 줄 설명 — 배지 옆 도움말·호버에 쓴다. */
export const STATUS_HELP: Record<string, string> = {
  미발송: "아직 안내 메일을 보내지 않은 참여자입니다.",
  초대발송: "안내 메일은 갔지만 아직 로그인하지 않았습니다.",
  미접속: "계정은 있지만 한 번도 접속하지 않았습니다.",
  작성중: "작성을 시작했고 아직 제출하지 않았습니다.",
  제출: "제출을 마쳤고 검토를 기다립니다.",
  반려: "보완 요청을 보냈고 참여자의 수정을 기다립니다.",
  승인: "검토가 끝나 확정된 응답입니다.",
};

/** 판단 항목의 정의 — 참여자 화면에서 라벨 옆 물음표에 그대로 붙는다 (기획 C2). */
export const FIELD_DEFINITIONS: Record<string, string> = {
  중요도:
    "이 과업이 직무 전체에서 차지하는 비중입니다. 자주 하는 일이 아니라 못 하면 직무가 성립하지 않는 일에 높은 값을 주세요.",
  책임수준:
    "그 과업의 결과에 대해 본인이 지는 책임의 크기입니다. 혼자 판단해 끝내는 일은 높고, 확인만 하는 일은 낮습니다.",
  이관가능:
    "다른 사람이나 다른 조직이 대신할 수 있는 일인지입니다. 표준화·자동화 여지를 보기 위한 항목이며 평가와 무관합니다.",
  과업: "직무를 이루는 일의 묶음입니다. 보통 5~10개이며, 한 문장으로 이름 붙일 수 있는 크기가 적당합니다.",
  "세부 활동": "과업을 실제로 수행하는 단계입니다. 과업 하나에 2~8개 정도로 적어 주세요.",
  "필요 역량":
    "이 직무를 제대로 하기 위해 알아야 하거나 할 수 있어야 하는 것입니다. 사람의 성격보다 업무에 필요한 능력을 적어 주세요.",
  직군: "가장 큰 분류입니다. 예: 경영지원, 생산, 연구개발.",
  직렬: "직군 안의 중간 분류입니다. 예: 경영지원 안의 인사, 총무.",
  직무: "실제로 담당하는 업무 단위입니다. 예: 인사기획, 급여운영.",
  역할단계: "조직 안에서 맡는 역할의 단계입니다. 직급과 별개로 실제 수행 범위를 나타냅니다.",
};

/**
 * 앞 낱말의 받침에 맞는 조사를 고른다.
 *
 * 항목 이름을 문장에 끼워 넣는 문구가 많은데("「마감일 설정」이 아직"), 이름이 데이터에서
 * 오므로 조사를 고정하면 "「메일 실발송 모드」이"처럼 틀린 말이 나온다.
 *
 *   josa("마감일 설정", "이/가") → "이"
 *   josa("메일 실발송 모드", "이/가") → "가"
 */
export function josa(word: string, pair: "이/가" | "을/를" | "은/는" | "과/와" | "으로/로") {
  const [withBatchim, withoutBatchim] = pair.split("/") as [string, string];
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절이 아니면(숫자·영문·기호) 받침 없는 쪽을 쓴다 — 읽을 때 더 자연스럽다.
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return withoutBatchim;
  const batchim = (code - 0xac00) % 28;
  // '로/으로'는 ㄹ 받침도 받침 없는 쪽을 따른다.
  if (pair === "으로/로" && batchim === 8) return withoutBatchim;
  return batchim === 0 ? withoutBatchim : withBatchim;
}

/** 이름과 조사를 붙여 돌려준다. `withJosa("마감일 설정", "이/가")` → "마감일 설정이" */
export function withJosa(word: string, pair: Parameters<typeof josa>[1]) {
  return `${word}${josa(word, pair)}`;
}

/** 자주 쓰는 안내 문구 — 같은 상황에 같은 말을 쓰기 위해 모아 둔다. */
export const COPY = {
  saveOk: "저장했습니다",
  saving: "저장 중",
  saveFailed: "저장하지 못했습니다",
  saveRetry: "지금 저장",
  requiredMissing: "아직 채우지 않은 항목이 있습니다",
  notApplicable: "해당 없음",
  notApplicableReason: "해당 없는 이유 (선택)",
  showExample: "예시 보기",
  exampleStandard: "인사팀 표준 예시",
  exampleOwn: "같은 직군의 작성 예시",
  simulationMode: "지금은 실제로 발송되지 않는 연습 모드입니다",
} as const;
