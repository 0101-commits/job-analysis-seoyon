import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ClipboardList, Layers, ListChecks, Target, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
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

const SLIDES = [
  {
    icon: Target,
    title: "이 조사는 왜 하나요",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          여러분이 작성한 내용으로 <strong className="text-foreground">표준 직무기술서</strong>를 만듭니다.
          각 직무가 실제로 어떤 일을 하는지 현업의 언어로 정리하는 것이 목적입니다.
        </p>
        <p className="rounded-lg border border-primary/30 bg-primary-soft/40 p-4 text-foreground">
          이 조사는 <strong>인사평가와 무관</strong>합니다. 작성 내용으로 어떠한 불이익도 발생하지 않으며,
          개인의 성과를 판단하는 자료로 사용되지 않습니다.
        </p>
      </div>
    ),
  },
  {
    icon: UserRound,
    title: "'직무'와 '나'를 구분해 주세요",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p className="rounded-lg border bg-secondary p-4 text-foreground">
          이 조사의 관심은 귀하가 아니라 <strong>'직무' 자체</strong>에 있습니다. 본인의 경력·학력이 아니라
          <strong> 그 직무를 수행하는 데 필요한 요건</strong>을 적어 주세요.
        </p>
        <ul className="space-y-2">
          <li>
            <span className="font-semibold text-destructive">이렇게 쓰지 마세요</span> — "나는 15년 경력에 석사
            학위가 있다"
          </li>
          <li>
            <span className="font-semibold text-success">이렇게 써 주세요</span> — "이 직무를 맡으려면 학사 이상,
            관련 실무 3년 정도가 필요하다"
          </li>
        </ul>
        <p>
          후임자가 이 직무를 이어받는다고 상상하면 쉽습니다. 그 사람에게 무엇을 알려 줘야 할지를 적으면 됩니다.
        </p>
      </div>
    ),
  },
  {
    icon: Layers,
    title: "용어를 먼저 맞춥니다",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <div className="rounded-lg border bg-secondary p-4">
          <p className="text-xs font-semibold text-muted-foreground">직군 &gt; 직렬 &gt; 직무</p>
          <p className="mt-2 font-mono text-sm text-foreground">사무관리 &gt; 인사 &gt; 인사기획</p>
          <p className="mt-1 font-mono text-sm text-foreground">생산기술 &gt; 생산관리 &gt; 공정관리</p>
        </div>
        <dl className="space-y-3">
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">Task (과업) — 행위 + 목적, 한 문장</dt>
            <dd className="mt-1">"월간 인건비 실적을 집계·분석하여 경영회의 보고자료를 작성한다"</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">Activity (활동) — 과업을 이루는 세부 실행 단위</dt>
            <dd className="mt-1">"부서별 인건비 마감 자료를 취합하여 계정별로 분류한다"</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="font-semibold text-foreground">Skill — 지식·기술·능력</dt>
            <dd className="mt-1">
              "노동관계법령 해석 능력 — 근로기준법을 사안에 적용해 인사 리스크를 판단할 수 있는 지식"
            </dd>
          </div>
        </dl>
      </div>
    ),
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
            <span className="font-semibold text-success">포함</span> — 매월/매주 반복되는 업무, 연 단위로 돌아오는
            정기 업무, 상시 대응 업무
          </li>
          <li>
            <span className="font-semibold text-destructive">제외</span> — 올해만 하는 일시적 프로젝트, TF 파견
            업무, 일회성 지원 업무
          </li>
        </ul>
        <p>
          지금은 하지 않지만 이 직무라면 당연히 해야 하는 업무가 있다면 함께 적어 주셔도 좋습니다.
        </p>
      </div>
    ),
  },
  {
    icon: ListChecks,
    title: "이렇게 진행됩니다",
    body: (
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <ol className="space-y-2">
          {["기본정보 확인", "직무 확인", "정의·목적", "과업 작성", "스킬·요건", "마무리"].map((label, i) => (
            <li key={label} className="flex items-center gap-3 rounded-lg border bg-card p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {i + 1}
              </span>
              <span className="text-foreground">{label}</span>
            </li>
          ))}
        </ol>
        <ul className="space-y-1">
          <li>· 총 6단계, 예상 소요 시간은 약 20분입니다.</li>
          <li>· 입력 내용은 자동으로 저장됩니다.</li>
          <li>· 중간에 나가셔도 다음에 이어서 작성할 수 있습니다.</li>
        </ul>
      </div>
    ),
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

  async function handleStart() {
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

          <div className="mt-8 flex items-center justify-center gap-2">
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
                {starting ? "준비 중..." : "시작하기"}
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
