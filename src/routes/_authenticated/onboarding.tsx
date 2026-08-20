import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  Layers,
  ListChecks,
  Target,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_DEFINITIONS } from "@/lib/glossary";
import { getMyParticipant, getOrCreateResponse, saveResponseFields } from "@/lib/survey.data";

export const Route = createFileRoute("/_authenticated/onboarding")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "조사 안내 | 서연 그룹 업무조사" },
      { name: "description", content: "업무조사 작성 전 목적과 작성 방법을 안내합니다." },
      { property: "og:title", content: "조사 안내 | 서연 그룹 업무조사" },
      { property: "og:description", content: "업무조사 작성 전 목적과 작성 방법을 안내합니다." },
    ],
  }),
  component: OnboardingPage,
});

/**
 * 안내 5장 (기획 H2).
 *
 * 대부분이 업무조사를 처음 하는 사람이라는 전제로 쓴다 (P12) — 각 장은 원칙 한 줄로
 * 시작하고 예시는 그 뒤에 붙인다. 영어 용어(Task·Activity·Skill)는 쓰지 않고
 * 확정된 실무 용어(과업·세부 활동·필요 역량)만 쓴다.
 *
 * `takeaway` 는 그 장에서 배운 것을 한 문장으로 되짚는다. 다섯 문장만 읽어도
 * 조사를 시작할 수 있는 수준이어야 한다.
 */
const SLIDES = [
  {
    icon: Target,
    title: "이 조사는 왜 하나요",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          여러분이 작성한 내용으로 <strong className="text-foreground">표준 직무기술서</strong>를
          만듭니다. 각 직무가 실제로 어떤 일을 하는지 현업의 언어로 정리하는 것이 목적입니다.
        </p>
        <p className="rounded-lg border border-primary/30 bg-primary-soft/40 p-4 text-foreground">
          이 조사는 <strong>인사평가와 무관</strong>합니다. 작성 내용으로 어떠한 불이익도 발생하지
          않으며, 개인의 성과를 판단하는 자료로 사용되지 않습니다.
        </p>
      </div>
    ),
    takeaway: "직무를 정리하기 위한 조사이고, 인사평가와는 관계가 없습니다.",
  },
  {
    icon: UserRound,
    title: "'직무'와 '나'를 구분해 주세요",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p className="rounded-lg border bg-secondary p-4 text-foreground">
          이 조사의 관심은 귀하가 아니라 <strong>'직무' 자체</strong>에 있습니다. 본인의
          경력·학력이 아니라
          <strong> 그 직무를 수행하는 데 필요한 요건</strong>을 적어 주세요.
        </p>
        <ul className="space-y-2">
          <li>
            <span className="font-semibold text-destructive">이렇게 쓰지 마세요</span> — "나는 15년
            경력에 석사 학위가 있다"
          </li>
          <li>
            <span className="font-semibold text-success">이렇게 써 주세요</span> — "이 직무를
            맡으려면 학사 이상, 관련 실무 3년 정도가 필요하다"
          </li>
        </ul>
        <p>
          후임자가 이 직무를 이어받는다고 상상하면 쉽습니다. 그 사람에게 무엇을 알려 줘야 할지를
          적으면 됩니다.
        </p>
      </div>
    ),
    takeaway: "내 이력이 아니라, 이 자리를 맡는 사람에게 필요한 것을 적습니다.",
  },
  {
    icon: Layers,
    title: "용어를 먼저 맞춥니다",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p className="text-foreground">
          조사 내내 같은 말을 씁니다. 네 가지만 알면 됩니다 — 직무의 위치를 나타내는{" "}
          <strong>직군·직렬·직무</strong>, 그리고 일을 적는 단위인{" "}
          <strong>과업 · 세부 활동 · 필요 역량</strong>입니다.
        </p>
        <div className="rounded-lg border bg-secondary p-4">
          <p className="text-xs font-semibold text-muted-foreground">
            큰 분류부터 좁혀 갑니다 — 직군 &gt; 직렬 &gt; 직무
          </p>
          <p className="mt-2 text-sm text-foreground">사무관리 &gt; 인사 &gt; 인사기획</p>
          <p className="mt-1 text-sm text-foreground">생산기술 &gt; 생산관리 &gt; 공정관리</p>
        </div>
        <dl className="space-y-3">
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">과업</dt>
            <dd className="mt-1">{FIELD_DEFINITIONS["과업"]}</dd>
            <dd className="mt-2 text-foreground">
              예 — "월간 인건비 실적을 집계·분석하여 경영회의 보고자료를 작성한다"
            </dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">세부 활동</dt>
            <dd className="mt-1">{FIELD_DEFINITIONS["세부 활동"]}</dd>
            <dd className="mt-2 text-foreground">
              예 — "부서별 인건비 마감 자료를 취합하여 계정별로 분류한다"
            </dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">필요 역량</dt>
            <dd className="mt-1">{FIELD_DEFINITIONS["필요 역량"]}</dd>
            <dd className="mt-2 text-foreground">
              예 — "노동관계법령 해석 — 근로기준법을 사안에 적용해 인사 리스크를 판단할 수 있다"
            </dd>
          </div>
        </dl>
      </div>
    ),
    takeaway: "과업은 일의 묶음, 세부 활동은 그 일의 단계, 필요 역량은 그 일에 필요한 능력입니다.",
  },
  {
    icon: ClipboardList,
    title: "어디까지 적나요",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p className="rounded-lg border border-primary/30 bg-primary-soft/40 p-4 text-foreground">
          최근 수년간 해왔고 <strong>앞으로도 계속할 일상 업무</strong>만 적어 주세요.
        </p>
        <ul className="space-y-2">
          <li>
            <span className="font-semibold text-success">포함</span> — 매월/매주 반복되는 업무, 연
            단위로 돌아오는 정기 업무, 상시 대응 업무
          </li>
          <li>
            <span className="font-semibold text-destructive">제외</span> — 올해만 하는 일시적
            프로젝트, 임시 조직 파견 업무, 일회성 지원 업무
          </li>
        </ul>
        <p>지금은 하지 않지만 이 직무라면 당연히 해야 하는 업무가 있다면 함께 적어 주셔도 좋습니다.</p>
      </div>
    ),
    takeaway: "앞으로도 계속할 일상 업무만 적고, 한 번으로 끝나는 일은 뺍니다.",
  },
  {
    icon: ListChecks,
    title: "이렇게 진행됩니다",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p className="text-foreground">
          6단계를 순서대로 지나갑니다. 앞 단계를 마치면 다음 단계가 열립니다.
        </p>
        <ol className="space-y-2">
          {["기본정보", "직무 확인", "정의·목적", "과업 작성", "스킬·요건", "마무리"].map(
            (label, i) => (
              <li key={label} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <span className="text-foreground">{label}</span>
              </li>
            ),
          )}
        </ol>
        <ul className="space-y-1">
          <li>· 예상 소요 시간은 약 20분입니다.</li>
          <li>· 입력 내용은 자동으로 저장됩니다.</li>
          <li>· 중간에 나가셔도 다음에 이어서 작성할 수 있습니다.</li>
          <li>· 이 안내는 홈에서 언제든 다시 열어볼 수 있습니다.</li>
        </ul>
      </div>
    ),
    takeaway: "총 6단계이고 자동 저장되므로, 중간에 나가도 이어서 할 수 있습니다.",
  },
];

function OnboardingPage() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [starting, setStarting] = useState(false);

  const { data: response } = useQuery({
    queryKey: ["my-response"],
    queryFn: async () => {
      const participant = await getMyParticipant();
      if (!participant) return null;
      return getOrCreateResponse(participant);
    },
  });

  const slide = SLIDES[index] as (typeof SLIDES)[number];
  const Icon = slide.icon;
  const isLast = index === SLIDES.length - 1;
  /** 이미 안내를 마친 사람이 다시 열어본 경우 — 저장할 것 없이 작성 화면으로만 돌려보낸다. */
  const alreadyDone = response?.onboarding_done === true;

  async function handleStart() {
    if (alreadyDone) {
      navigate({ to: "/survey" });
      return;
    }
    if (!response) {
      toast.error("응답 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    setStarting(true);
    try {
      await saveResponseFields(response.id, { onboarding_done: true });
      navigate({ to: "/survey", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장 중 오류가 발생했습니다.");
      setStarting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-secondary px-4 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
        <div className="text-center">
          <p className="text-xs font-medium text-primary">HCG 컨설팅</p>
          <h1 className="mt-1 text-lg font-bold sm:text-xl">서연 그룹 업무조사 안내</h1>
          <Link
            to="/home"
            className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            홈으로 돌아가기
          </Link>
        </div>

        <section className="mt-6 flex flex-1 flex-col rounded-xl border bg-card p-5 shadow-sm sm:p-8">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft">
              <Icon className="size-5 text-primary" />
            </span>
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {index + 1} / {SLIDES.length}
              </p>
              <h2 className="text-base font-bold sm:text-lg">{slide.title}</h2>
            </div>
          </div>

          <div className="mt-6 flex-1">{slide.body}</div>

          <div className="mt-6 rounded-lg border-l-4 border-primary bg-primary-soft/30 px-4 py-3">
            <p className="text-xs font-semibold text-primary">이 장의 요점</p>
            <p className="mt-1 text-sm font-medium">{slide.takeaway}</p>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2">
            {SLIDES.map((s, i) => (
              <button
                key={s.title}
                type="button"
                aria-label={`${i + 1}번째 안내로 이동`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
                className={`h-2 rounded-full transition-all ${
                  i === index ? "w-6 bg-primary" : "w-2 bg-border hover:bg-muted-foreground/40"
                }`}
              />
            ))}
          </div>

          <div className="mt-6 flex gap-3">
            <Button
              variant="outline"
              className="h-11 flex-1"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
            >
              <ArrowLeft className="size-4" />
              이전
            </Button>
            {isLast ? (
              <Button className="h-11 flex-1" onClick={handleStart} disabled={starting}>
                {alreadyDone ? "작성 화면으로" : starting ? "준비 중..." : "시작하기"}
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button className="h-11 flex-1" onClick={() => setIndex((i) => i + 1)}>
                다음
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
