import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, FileText, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";

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
        .select("name, emp_no, org_text, grade, account_status, companies(name, survey_settings(deadline))")
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
        .select("status, current_step, onboarding_done")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const deadline = data?.companies?.survey_settings?.deadline ?? null;
  const dday = deadline ? daysUntil(deadline) : null;

  const surveyTarget = response?.onboarding_done ? "/survey" : "/onboarding";
  const { surveyLabel, surveyMessage, surveyAction } = (() => {
    switch (response?.status) {
      case "submitted":
        return {
          surveyLabel: "제출 완료 (검토 중)",
          surveyMessage: "제출해 주셔서 감사합니다. 관리자 검토 결과를 기다리고 있습니다.",
          surveyAction: null,
        };
      case "approved":
        return {
          surveyLabel: "승인 완료",
          surveyMessage: "작성하신 업무조사가 승인되었습니다. 더 이상 수정할 수 없습니다.",
          surveyAction: null,
        };
      case "rejected":
        return {
          surveyLabel: "반려됨 — 수정하러 가기",
          surveyMessage: "관리자 검토 의견이 등록되었습니다. 내용을 보완해 다시 제출해 주세요.",
          surveyAction: surveyTarget,
        };
      case "draft":
        return {
          surveyLabel: "이어서 작성하기",
          surveyMessage: "작성 중인 조사가 있습니다. 이어서 마무리해 주세요.",
          surveyAction: surveyTarget,
        };
      default:
        return {
          surveyLabel: "조사 시작하기",
          surveyMessage: "담당 직무의 과업과 필요 역량을 6단계로 작성합니다. 예상 소요 시간은 약 20분입니다.",
          surveyAction: "/onboarding",
        };
    }
  })();

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
        <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-7">
          <p className="text-sm text-muted-foreground">
            {isLoading ? "불러오는 중..." : (data?.companies?.name ?? "계열사 미지정")}
          </p>
          <h2 className="mt-1 text-xl font-bold sm:text-2xl">
            {data?.name ? `${data.name} 님, 안녕하세요` : "내 조사 홈"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {data?.org_text ?? "소속 정보 미등록"}
            {data?.grade ? ` · ${data.grade}` : ""}
            {data?.emp_no ? ` · 사번 ${data.emp_no}` : ""}
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">진행 상태</p>
              <div className="mt-2">
                <StatusBadge status={data?.account_status ?? "미발송"} />
              </div>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">제출 마감</p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-lg font-semibold">
                <CalendarClock className="size-5 text-primary" />
                {dday === null ? (
                  <>
                    D-–
                    <span className="text-sm font-normal text-muted-foreground">(기한 미설정)</span>
                  </>
                ) : (
                  <>
                    <span className={dday < 0 ? "text-muted-foreground" : dday <= 3 ? "text-destructive" : ""}>
                      {dday < 0 ? "마감됨" : dday === 0 ? "D-Day" : `마감까지 D-${dday}`}
                    </span>
                    <span className="text-sm font-normal text-muted-foreground">({deadline})</span>
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-dashed bg-card p-5 text-center sm:p-10">
          {response?.status === "submitted" || response?.status === "approved" ? (
            <CheckCircle2 className="mx-auto size-8 text-success" />
          ) : (
            <FileText className="mx-auto size-8 text-muted-foreground" />
          )}
          <h3 className="mt-3 text-base font-semibold">업무조사 작성</h3>
          <p className="mt-2 text-sm text-muted-foreground">{surveyMessage}</p>
          {response && response.status !== "draft" && response.status !== "rejected" ? null : (
            <p className="mt-3 text-xs text-muted-foreground">
              진행률 {Math.round(((response?.current_step ?? 1) / 6) * 100)}% (
              {response?.current_step ?? 1}/6 단계)
            </p>
          )}
          <Button
            className="mt-5"
            disabled={surveyAction === null}
            onClick={() => surveyAction && navigate({ to: surveyAction })}
          >
            {surveyLabel}
          </Button>
        </section>
      </main>
    </div>
  );
}
