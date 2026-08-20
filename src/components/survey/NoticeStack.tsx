// 참여자 알림 단일 영역. 재확인·문의답변·정보정정 세 배너가 각자 조건에 따라 뜨는데,
// 따로따로 아무 데나 두면 화면마다 다른 순서로 겹쳐 보인다. 홈과 마법사 상단 모두
// 이 컴포넌트 하나만 두고, 우선순위(할 일이 있는 것 → 읽을 것 → 참고할 것) 순으로 쌓는다.
import { RecheckBanner } from "@/components/survey/RecheckBanner";
import { InquiryAnswerBanner } from "@/components/survey/InquiryAnswerBanner";
import { InfoChangeBanner } from "@/components/survey/InfoChangeBanner";

export function NoticeStack() {
  return (
    <div className="space-y-3">
      {/* ① 조치가 필요한 것 — 확인하지 않으면 계속 남는다. */}
      <RecheckBanner />
      {/* ② 내게 온 새 소식 — 확인하면 사라진다. */}
      <InquiryAnswerBanner />
      {/* ③ 참고 — 닫으면 다음 변경 전까지 다시 뜨지 않는다. */}
      <InfoChangeBanner />
    </div>
  );
}

export default NoticeStack;
