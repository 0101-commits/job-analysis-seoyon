import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, LogOut } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { SignalCard, type SignalAction } from "@/components/SignalCard";
import { getLatestReject, loadFull } from "@/lib/survey.data";
import { decideMySuggestion } from "@/lib/ai.functions";
import { SURVEY_STEP_LABELS, findFocusFields, focusLabel, focusSearch } from "@/lib/survey.focus";
import { NoticeStack } from "@/components/survey/NoticeStack";
import { InquiryPanel } from "@/components/survey/InquiryPanel";
import {
  SubmissionSummary,
  type SubmissionSummaryProps,
} from "@/components/survey/SubmissionSummary";
import {
  AiSuggestionCards,
  type AiSuggestionItem,
  type SuggestionDecision,
} from "@/components/survey/AiSuggestionCards";

export const Route = createFileRoute("/_authenticated/home")({
  head: () => ({
    meta: [
      { title: "내 조사 홈 | 서연 그룹 업무조사" },
      { name: "description", content: "나의 업무조사 진행 상태와 제출 기한을 확인합니다." },
      { property: "og:title", content: "내 조사 홈 | 서연 그룹 업무조사" },
      { property: "og:description", content: "나의 업무조사 진행 상태와 제출 기한을 확인합니다." },
    ],
  }),
  component: RespondentHome,
});

function daysUntil(deadline: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${deadline}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

/**
 * 참여자 홈 (기획 H1).
 *
 * 이 화면의 주인공은 "지금 내가 할 일" 하나다. 상태·마감·진행률을 나란히 늘어놓으면
 * 무엇부터 눌러야 하는지가 사라진다 — 주행동 하나를 맨 위에 크게 두고, 나머지는
 * 그 판단의 근거로만 아래에 붙인다. 화면에 보이는 것은 전부 그 대상으로 가는 링크다 (P6).
 */
function RespondentHome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["my-participant"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) return null;
      const { data, error } = await supabase
        .from("participants")
        .select(
          "name, emp_no, org_text, grade, account_status, companies(name, survey_settings(deadline))",
        )
        .eq("user_id", uid)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // RLS 상 본인 응답만 조회되므로 participant 조인 없이 바로 읽는다.
  const { data: response } = useQuery({
    queryKey: ["my-response-summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("responses")
        .select(
          "id, status, current_step, onboarding_done, submitted_at, job_group, job_series, job_name, definition, mission",
        )
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // 반려 사유는 홈에서 바로 읽을 수 있어야 한다 — 조사 화면까지 들어가야 보이면 아무도 못 본다.
  const { data: reject } = useQuery({
    queryKey: ["my-latest-reject", response?.id],
    queryFn: () => getLatestReject(response!.id),
    enabled: response?.status === "rejected" && !!response?.id,
  });

  const finished = response?.status === "submitted" || response?.status === "approved";

  // 제출을 마친 뒤에는 "무엇을 냈는지" 가 홈의 본문이 된다.
  const { data: full } = useQuery({
    queryKey: ["my-submission-detail", response?.id],
    queryFn: () => loadFull(response!.id),
    enabled: finished && !!response?.id,
  });

  // RLS 상 본인 응답의 '요청중' 제안만 조회된다.
  const { data: suggestions } = useQuery({
    queryKey: ["my-ai-suggestions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_suggestions")
        .select("id, target, original_value, suggested_value, kind, status, created_at")
        .eq("status", "요청중")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as AiSuggestionItem[];
    },
  });

  const pendingSuggestions = suggestions ?? [];

  async function handleDecide(
    id: string,
    decision: SuggestionDecision,
    note?: string,
    editedValue?: string,
  ) {
    // 결정과 실제 반영을 서버 함수 하나가 같이 처리한다 — 수락·수정은 즉시 응답에 들어간다.
    try {
      const result = await decideMySuggestion({
        data: {
          suggestionId: id,
          decision,
          ...(note ? { note } : {}),
          ...(editedValue ? { editedValue } : {}),
        },
      });
      toast.success(
        result.applied ? `${decision} 처리하고 응답에 반영했습니다.` : "거절 처리했습니다.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "처리에 실패했습니다.");
      return;
    }
    // 반영분이 홈·조사 화면 모두에 즉시 보이도록 관련 쿼리를 통째로 다시 읽는다.
    await queryClient.invalidateQueries();
  }

  const deadline = data?.companies?.survey_settings?.deadline ?? null;
  const dday = deadline ? daysUntil(deadline) : null;

  const currentStep = Math.min(Math.max(response?.current_step ?? 1, 1), SURVEY_STEP_LABELS.length);
  const rejectStep = reject?.step ?? null;

  /** 단계·항목까지 실어 작성 화면을 연다. 규약은 @/lib/survey.focus 참조. */
  const goTo = (field: string | null, fallbackStep: number) => {
    void navigate({ to: "/survey", search: focusSearch(field, fallbackStep) });
  };

  // 지금 눌러야 할 것 하나. 상태마다 문구도 버튼도 달라진다.
  const next = (() => {
    if (!response || !response.onboarding_done) {
      return {
        title: "업무조사를 시작해 주세요",
        description:
          "담당 직무의 과업과 필요 역량을 6단계로 작성합니다. 처음이라면 안내 5장을 먼저 보시면 훨씬 수월합니다.",
        label: "안내 보고 시작하기",
        onClick: () => void navigate({ to: "/onboarding" }),
      };
    }
    switch (response.status) {
      case "submitted":
        return {
          title: "제출을 마쳤습니다",
          description:
            "관리자가 확인하고 있습니다. 보완이 필요하면 이 화면과 메일로 알려 드립니다. 아래에서 제출한 내용을 다시 볼 수 있습니다.",
          label: null,
          onClick: null,
        };
      case "approved":
        return {
          title: "작성이 끝났습니다",
          description:
            "검토가 끝나 확정되었습니다. 더 이상 수정할 수 없으며, 아래에서 제출한 내용을 볼 수 있습니다.",
          label: null,
          onClick: null,
        };
      case "rejected":
        return {
          title: "보완이 필요합니다",
          description: "아래 반려 사유를 확인하고 해당 항목을 고친 뒤 다시 제출해 주세요.",
          label: null,
          onClick: null,
        };
      default:
        return {
          title: "이어서 작성해 주세요",
          description: `${currentStep}단계 「${SURVEY_STEP_LABELS[currentStep - 1]}」까지 왔습니다. 쓰던 내용은 자동으로 저장되어 있습니다.`,
          label: "이어서 작성하기",
          onClick: () => goTo(null, currentStep),
        };
    }
  })();

  // 반려 사유에 적힌 항목 이름을 딥링크로 바꾼다 — 어느 칸을 고쳐야 하는지까지 데려간다.
  const rejectFields = findFocusFields(reject?.body ?? "").slice(0, 2);
  const rejectActions: SignalAction[] = [
    ...rejectFields.map((f) => ({
      label: `${focusLabel(f)} 고치러 가기`,
      onClick: () => goTo(f, rejectStep ?? currentStep),
    })),
    {
      label: rejectStep ? `${rejectStep}단계부터 보완하기` : "작성 화면 열기",
      onClick: () => goTo(null, rejectStep ?? currentStep),
      variant: rejectFields.length > 0 ? ("outline" as const) : ("default" as const),
    },
    {
      label: "내 정보 정정 요청",
      onClick: () => goTo("org_text", 1),
      variant: "ghost" as const,
    },
  ];

  const summary: SubmissionSummaryProps | null =
    finished && response && full
      ? {
          job: {
            group: response.job_group ?? "",
            series: response.job_series ?? "",
            name: response.job_name ?? "",
          },
          definition: response.definition ?? "",
          mission: response.mission ?? "",
          taskCount: full.tasks.length,
          activityCount: full.tasks.reduce((n, t) => n + t.activities.length, 0),
          skillCount: full.skills.length,
          missing: [
            { id: "job_name", label: "직무 이름", step: 2, empty: !response.job_name?.trim() },
            { id: "definition", label: "직무 정의", step: 3, empty: !response.definition?.trim() },
            { id: "mission", label: "직무 목적", step: 3, empty: !response.mission?.trim() },
            { id: "tasks", label: "과업", step: 4, empty: full.tasks.length === 0 },
            { id: "skills", label: "필요 역량", step: 5, empty: full.skills.length === 0 },
          ]
            .filter((m) => m.empty)
            .map(({ id, label, step }) => ({ id, label, step })),
          title: "제출한 내용",
          // 승인된 응답은 읽기 전용이라 단계 링크를 주지 않는다 — 눌러도 고칠 수 없는 링크는 두지 않는다.
          ...(response.status === "submitted"
            ? { onGoToStep: (step: number) => goTo(null, step) }
            : {}),
        }
      : null;

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-secondary">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium text-primary">HCG 컨설팅</p>
            <h1 className="text-base font-bold sm:text-lg">서연 그룹 업무조사</h1>
          </div>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="size-4" />
            로그아웃
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
        <NoticeStack />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold sm:text-xl">
              {data?.name ? `${data.name} 님` : "내 조사 홈"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isLoading ? "불러오는 중..." : (data?.companies?.name ?? "계열사 미지정")}
              {data?.org_text ? ` · ${data.org_text}` : ""}
              {data?.grade ? ` · ${data.grade}` : ""}
              {data?.emp_no ? ` · 사번 ${data.emp_no}` : ""}
            </p>
          </div>
          <StatusBadge
            status={data?.account_status ?? "미발송"}
            perspective="respondent"
            withHelp
          />
        </div>

        {/* 지금 할 일 하나 — 반려는 사유·근거가 함께 있어야 하므로 SignalCard 규격으로 낸다. */}
        {response?.status === "rejected" ? (
          <SignalCard
            tone="attention"
            signal={
              rejectFields.length > 0
                ? `${rejectFields.map(focusLabel).join(" · ")} 항목을 보완해 주세요.`
                : rejectStep
                  ? `${rejectStep}단계 「${SURVEY_STEP_LABELS[rejectStep - 1]}」를 보완해 주세요.`
                  : "제출한 응답에 보완이 필요합니다."
            }
            evidence={[
              `관리자가 남긴 반려 사유 — ${reject?.body?.trim() || "사유가 적혀 있지 않습니다. 관리자에게 확인해 주세요."}`,
              "보완해서 다시 제출하면 검토가 이어집니다.",
            ]}
            {...(reject?.created_at
              ? { asOf: new Date(reject.created_at).toLocaleString("ko-KR") }
              : {})}
            actions={rejectActions}
          />
        ) : (
          <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-7">
            <h3 className="text-lg font-bold sm:text-xl">{next.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{next.description}</p>
            {next.label && next.onClick ? (
              <Button className="mt-5 h-11 px-6 text-base" onClick={next.onClick}>
                {next.label}
              </Button>
            ) : null}
          </section>
        )}

        {/* 진행 단계 — 어디까지 왔고 어디를 눌러야 그리로 가는지 (P6). */}
        <section className="rounded-xl border bg-card p-4 sm:p-5">
          <p className="text-sm font-semibold">
            작성 진행 · {finished ? SURVEY_STEP_LABELS.length : currentStep - 1}/
            {SURVEY_STEP_LABELS.length} 단계 완료
          </p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {SURVEY_STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const done = finished || n < currentStep;
              const here = !finished && n === currentStep;
              const openable = finished || n <= currentStep;
              return (
                <li key={label}>
                  <button
                    type="button"
                    disabled={!openable}
                    onClick={() => goTo(null, n)}
                    className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors ${
                      here ? "border-primary bg-primary-soft/40 font-semibold" : "bg-background"
                    } ${openable ? "hover:border-primary hover:bg-secondary" : "cursor-not-allowed opacity-50"}`}
                  >
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        done
                          ? "bg-success text-white"
                          : here
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {done ? <Check className="size-3.5" /> : n}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {done ? "완료" : here ? "작성 중" : "대기"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {deadline && dday !== null ? (
            <p className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4 text-sm">
              <CalendarClock className="size-4 text-primary" />
              <span className="text-muted-foreground">제출 마감</span>
              <span
                className={`font-semibold ${
                  dday < 0 ? "text-muted-foreground" : dday <= 3 ? "text-destructive" : ""
                }`}
              >
                {dday < 0 ? "마감됨" : dday === 0 ? "오늘까지" : `${dday}일 남음`}
              </span>
              <span className="text-muted-foreground">({deadline})</span>
            </p>
          ) : (
            <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
              제출 마감일은 아직 정해지지 않았습니다.
            </p>
          )}
        </section>

        {summary ? <SubmissionSummary {...summary} /> : null}

        {pendingSuggestions.length > 0 && (
          <section className="space-y-4">
            <div>
              <h3 className="text-base font-semibold">
                내게 온 검토 요청 {pendingSuggestions.length}건
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                관리자가 AI로 보완한 제안입니다. 수락하면 내 응답에 반영됩니다.
              </p>
            </div>
            <AiSuggestionCards suggestions={pendingSuggestions} onDecide={handleDecide} />
          </section>
        )}

        <InquiryPanel />

        {/* 안내는 한 번 보고 끝이 아니다 — 언제든 다시 열 수 있어야 한다 (P10). */}
        <p className="text-sm text-muted-foreground">
          작성 방법이 헷갈리면{" "}
          <Link to="/onboarding" className="font-medium text-primary underline underline-offset-2">
            조사 안내 5장 다시 보기
          </Link>
        </p>
      </main>
    </div>
  );
}
