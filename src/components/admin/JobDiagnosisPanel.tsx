// 직무 중복·과분할 진단 (기획 F14).
//
// AI 가안으로 만든 직무분류는 115건까지 늘어난다. 그중 어떤 것이 사실상 같은 직무이고 어떤 것이
// 너무 잘게 쪼개졌는지는 응답에 적힌 과업을 보면 드러난다. 여기서는 후보만 보여 주고 바꾸지
// 않는다 — 직무분류 수정은 관리자가 표에서 직접 하고 새 버전으로 저장하는 기존 경로를 따른다.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import {
  DIAG_LARGE_TASKS,
  DIAG_OVERLAP_THRESHOLD,
  DIAG_SMALL_TASKS,
  diagnoseJobCatalog,
} from "@/lib/master.functions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 직무명 → 응답 검토의 직무 비교 화면. 진단에서 본 직무를 바로 열어 볼 수 있게 한다. */
function CompareLink({ jobName }: { jobName: string }) {
  return (
    <Link
      to="/admin/review"
      search={{ view: "job", job: jobName }}
      className="text-primary hover:underline"
    >
      비교 보기
    </Link>
  );
}

function Block({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {empty ? (
        <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
          <CheckCircle2 className="size-4 shrink-0 text-primary" />
          해당하는 직무가 없습니다.
        </p>
      ) : (
        children
      )}
    </div>
  );
}

export function JobDiagnosisPanel({ companyId }: { companyId: string | null }) {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["job-diagnosis", companyId ?? "all"],
    queryFn: async () =>
      diagnoseJobCatalog({
        data: companyId ? { companyId } : {},
        headers: await authHeaders(),
      }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">진단하는 중...</p>;
  if (!data) return null;

  if (data.responseCount === 0) {
    return (
      <EmptyState
        kind="nothing"
        title="진단할 응답이 없습니다"
        description="제출·승인된 응답의 과업을 근거로 진단합니다. 응답이 쌓인 뒤 다시 보세요."
      />
    );
  }

  const clean =
    data.duplicatePairs.length === 0 &&
    data.tooSmall.length === 0 &&
    data.tooLarge.length === 0 &&
    data.thinEvidence.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-secondary/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          응답 {data.responseCount}건 · 응답에 쓰인 직무 {data.jobCount}개 · 기준{" "}
          {timeLabel(data.asOf)}
        </p>
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? "다시 진단 중..." : "다시 진단"}
        </Button>
      </div>

      {clean && (
        <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-primary" />
          지금 응답으로는 손볼 직무가 보이지 않습니다.
        </p>
      )}

      <Block
        title={`병합 후보 ${data.duplicatePairs.length}쌍`}
        subtitle={`두 직무의 과업이 ${Math.round(DIAG_OVERLAP_THRESHOLD * 100)}% 이상 겹칩니다. 같은 일을 두 이름으로 부르고 있는지 확인하세요.`}
        empty={data.duplicatePairs.length === 0}
      >
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-secondary text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">직무 A</th>
                <th className="px-3 py-2 font-medium">직무 B</th>
                <th className="px-3 py-2 font-medium">중복률</th>
                <th className="px-3 py-2 font-medium">겹치는 과업</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.duplicatePairs.map((pair) => (
                <tr key={`${pair.a}|${pair.b}`} className="border-t align-top">
                  <td className="px-3 py-2 font-medium">
                    {pair.a}
                    <span className="ml-1 text-muted-foreground">({pair.aTasks}개)</span>
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {pair.b}
                    <span className="ml-1 text-muted-foreground">({pair.bTasks}개)</span>
                  </td>
                  <td className="px-3 py-2 font-semibold tabular-nums">{pair.overlapPct}%</td>
                  <td className="px-3 py-2 text-muted-foreground">{pair.shared.join(", ")}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <CompareLink jobName={pair.a} /> · <CompareLink jobName={pair.b} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <div className="grid gap-5 lg:grid-cols-2">
        <Block
          title={`과분할 후보 ${data.tooSmall.length}건`}
          subtitle={`과업이 ${DIAG_SMALL_TASKS}개 이하인 직무입니다. 상위 직무에 합칠 수 있는지 보세요.`}
          empty={data.tooSmall.length === 0}
        >
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
            {data.tooSmall.map((job) => (
              <li key={job.jobName} className="flex items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{job.jobName}</span>
                  <span className="ml-1 text-muted-foreground">
                    과업 {job.taskCount}개 · 응답 {job.responseCount}건
                  </span>
                </span>
                <CompareLink jobName={job.jobName} />
              </li>
            ))}
          </ul>
        </Block>

        <Block
          title={`분리 후보 ${data.tooLarge.length}건`}
          subtitle={`과업이 ${DIAG_LARGE_TASKS}개 이상인 직무입니다. 두 직무로 나눠야 할 수 있습니다.`}
          empty={data.tooLarge.length === 0}
        >
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
            {data.tooLarge.map((job) => (
              <li key={job.jobName} className="flex items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{job.jobName}</span>
                  <span className="ml-1 text-muted-foreground">
                    과업 {job.taskCount}개 · 응답 {job.responseCount}건
                  </span>
                </span>
                <CompareLink jobName={job.jobName} />
              </li>
            ))}
          </ul>
        </Block>
      </div>

      <Block
        title={`근거 부족 ${data.thinEvidence.length}건`}
        subtitle="응답이 1건뿐인 직무입니다. 판단을 미루고 인터뷰로 채우는 편이 안전합니다 — 표시만 합니다."
        empty={data.thinEvidence.length === 0}
      >
        <ul className="flex flex-wrap gap-2 text-xs">
          {data.thinEvidence.map((job) => (
            <li key={job.jobName} className="rounded-full border px-2 py-0.5">
              {job.jobName}
              <span className="ml-1 text-muted-foreground">과업 {job.taskCount}개</span>
            </li>
          ))}
        </ul>
      </Block>

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        진단은 후보만 알려 줍니다. 합치거나 나누기로 정했으면 위 직무분류표에서 직접 고친 뒤 「버전
        관리」 에서 새 버전으로 저장하세요 — 자동으로 바꾸지 않습니다.
      </p>
    </div>
  );
}
