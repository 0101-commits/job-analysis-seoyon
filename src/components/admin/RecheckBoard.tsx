// 변경 재확인 미확인 잔량 보드 (기획 F10).
//
// 조직·직무를 바꾸면 영향 인원에게 배너 고지가 예약된다. 그러나 배너는 알림일 뿐이어서
// 「누가 실제로 확인했는지」는 남지 않았다. notifyImpacted 가 응답에 재확인 표시를 세우고
// 참여자가 확인하면 표시가 내려가므로, 그 차이가 곧 여기 보이는 잔량이다.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { SignalCard } from "@/components/SignalCard";
import { EmptyState } from "@/components/EmptyState";
import { listRecheckPending, type RecheckGroup } from "@/lib/master.functions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 한 번에 독려 화면으로 넘기는 인원 상한 — 메일 화면의 기본 발송 상한과 같은 눈금. */
const HANDOFF_LIMIT = 200;

function GroupTable({
  title,
  rows,
  hrefFor,
}: {
  title: string;
  rows: RecheckGroup[];
  hrefFor: (row: RecheckGroup) => { to: string; search: Record<string, string> } | null;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[380px] text-xs">
          <thead className="bg-secondary text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">구분</th>
              <th className="px-3 py-2 font-medium">미확인</th>
              <th className="px-3 py-2 font-medium">확인 완료</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const link = hrefFor(row);
              return (
                <tr key={row.key} className="border-t">
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {row.pending > 0 ? (
                      <span className="font-semibold text-destructive">{row.pending}건</span>
                    ) : (
                      <span className="text-muted-foreground">0건</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.cleared}건</td>
                  <td className="px-3 py-2 text-right">
                    {link && row.pending > 0 ? (
                      <Link
                        to={link.to}
                        search={link.search}
                        className="text-primary hover:underline"
                      >
                        명부에서 보기
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RecheckBoard({ companyId }: { companyId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["recheck-pending", companyId ?? "all"],
    queryFn: async () =>
      listRecheckPending({
        data: companyId ? { companyId } : {},
        headers: await authHeaders(),
      }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;
  if (!data) return null;

  if (data.pendingTotal === 0) {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-primary" />
          재확인을 기다리는 응답이 없습니다.
          {data.clearedTotal > 0 ? ` 지금까지 ${data.clearedTotal}건이 확인 완료되었습니다.` : ""}
        </p>
        {data.clearedTotal === 0 && (
          <EmptyState
            kind="nothing"
            title="아직 재확인을 보낸 적이 없습니다"
            description="조직도나 직무분류를 고칠 때 「저장하면 변경 안내를 예약합니다」 를 켜 두면, 그때 영향받은 응답이 여기에 재확인 대상으로 모입니다."
          />
        )}
      </div>
    );
  }

  const overdue = data.pending.filter((p) => (p.elapsedDays ?? 0) >= 3);
  const handoff = data.participantIds.slice(0, HANDOFF_LIMIT);

  return (
    <div className="space-y-4">
      <SignalCard
        tone="attention"
        signal={`변경 안내를 받고 아직 확인하지 않은 응답이 ${data.pendingTotal}건입니다`}
        evidence={[
          `확인 완료 ${data.clearedTotal}건 대비 미확인 ${data.pendingTotal}건입니다.`,
          overdue.length > 0
            ? `그중 ${overdue.length}건은 안내한 지 3일이 넘었습니다.`
            : "안내한 지 3일이 넘은 건은 없습니다.",
          data.truncated
            ? `아래 목록에는 ${data.pending.length}건만 담았습니다 — 집계 숫자는 전건 기준입니다.`
            : "아래 목록이 전부입니다.",
        ]}
        asOf={timeLabel(data.asOf)}
        scope={`대상 ${data.participantIds.length}명`}
        actions={[]}
      >
        <div className="flex flex-wrap gap-2 border-t px-4 py-3">
          <Button asChild size="sm">
            <Link to="/admin/mail" search={{ ids: handoff.join(",") }}>
              독려 대상으로 넘기기 ({handoff.length}명)
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/admin/participants" search={{}}>
              참여자 명부 열기
            </Link>
          </Button>
        </div>
      </SignalCard>

      {data.participantIds.length > HANDOFF_LIMIT && (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          대상이 {data.participantIds.length}명이라 한 번에 {HANDOFF_LIMIT}명까지만 넘깁니다. 남은
          인원은 아래 조직별 표에서 소속을 골라 나눠 보내세요.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <GroupTable
          title="소속별"
          rows={data.byOrg}
          hrefFor={(row) =>
            row.key === "none" ? null : { to: "/admin/participants", search: { org: row.key } }
          }
        />
        <GroupTable
          title="직무별"
          rows={data.byJob}
          hrefFor={(row) =>
            row.key === "none"
              ? null
              : { to: "/admin/review", search: { view: "job", job: row.key } }
          }
        />
      </div>

      <div className="min-w-0">
        <p className="text-sm font-medium">미확인 목록</p>
        <div className="mt-2 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-secondary text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">참여자</th>
                <th className="px-3 py-2 font-medium">소속</th>
                <th className="px-3 py-2 font-medium">직무</th>
                <th className="px-3 py-2 font-medium">바뀐 내용</th>
                <th className="px-3 py-2 font-medium">안내일</th>
                <th className="px-3 py-2 font-medium">경과</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.pending.map((item) => (
                <tr key={item.responseId} className="border-t align-top">
                  <td className="px-3 py-2 font-medium">{item.participantName}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.orgName}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.jobName}</td>
                  <td className="px-3 py-2">{item.reason}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {item.notifiedAt ? new Date(item.notifiedAt).toLocaleDateString("ko-KR") : "-"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {item.elapsedDays === null ? (
                      "-"
                    ) : item.elapsedDays >= 3 ? (
                      <span className="font-semibold text-destructive">{item.elapsedDays}일</span>
                    ) : (
                      <span className="text-muted-foreground">{item.elapsedDays}일</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      to="/admin/review"
                      search={{ response: item.responseId }}
                      className="text-primary hover:underline"
                    >
                      응답 보기
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
