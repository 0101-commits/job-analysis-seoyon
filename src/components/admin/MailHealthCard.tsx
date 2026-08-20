import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Info, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mailHealth } from "@/lib/mail.functions";

/**
 * 발송 건강검진 카드 (기획 F1).
 *
 * 500명에게 초대 메일을 보내기 직전에 관리자가 확인해야 하는 것은 넷이다.
 *   ① 지금 실제로 나가는 상태인가 (연습/실발송)
 *   ② 발신 주소와 그 도메인 인증이 끝났는가 — 안 끝났으면 상당수가 스팸함으로 간다
 *   ③ 오늘 얼마나 더 보낼 수 있는가 (일일 상한 대비)
 *   ④ 되돌아온 메일이 얼마나 쌓였는가
 *
 * 값은 전부 실측이고, 조회하지 못한 항목은 빈칸으로 두지 않고 왜 못 했는지를 적는다.
 */

const SIGNAL_STYLE: Record<string, { chip: string; bar: string; icon: typeof Check }> = {
  정상: { chip: "bg-success/15 text-success border-success/30", bar: "bg-success", icon: Check },
  주의: { chip: "bg-warning/15 text-warning border-warning/30", bar: "bg-warning", icon: Info },
  차단: {
    chip: "bg-destructive/10 text-destructive border-destructive/30",
    bar: "bg-destructive",
    icon: AlertTriangle,
  },
};

const RECORD_TONE: Record<string, string> = {
  ok: "text-success",
  warn: "text-warning",
  unknown: "text-muted-foreground",
};

function Fact({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string;
  note?: string | null;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 break-words text-sm font-semibold tabular-nums",
          warn ? "text-warning" : undefined,
        )}
      >
        {value}
      </dd>
      {note ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function MailHealthCard() {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["mail-health"],
    queryFn: () => mailHealth(),
    // 도메인 인증 상태는 발송 서비스에 물어보는 값이라 매번 부르지 않는다.
    staleTime: 60 * 1000,
  });

  if (isPending) {
    return (
      <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
        발송 상태를 확인하는 중...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <div className="text-sm">
          <p className="font-semibold text-destructive">발송 상태를 확인하지 못했습니다</p>
          <p className="mt-1 text-muted-foreground">
            {error instanceof Error ? error.message : "알 수 없는 오류"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RotateCw className="size-4" /> 다시 확인
        </Button>
      </div>
    );
  }

  const style = SIGNAL_STYLE[data.signal] ?? SIGNAL_STYLE["주의"]!;
  const SignalIcon = style.icon;
  const remaining = Math.max(data.dailyCap - data.sentToday, 0);
  const asOf = data.asOf.slice(0, 16).replace("T", " ");

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex">
        <div className={cn("w-1 shrink-0", style.bar)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                  style.chip,
                )}
              >
                <SignalIcon className="size-3" aria-hidden />
                {data.signal}
              </span>
              <p className="text-sm font-semibold">
                {data.simulation
                  ? "지금은 실제로 발송되지 않는 연습 모드입니다"
                  : "누른 메일은 실제로 참여자에게 갑니다"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="발송 상태 다시 확인"
            >
              <RotateCw className={cn("size-4", isFetching && "animate-spin")} />
              {isFetching ? "확인 중" : "다시 확인"}
            </Button>
          </div>

          {data.todo ? (
            <p className="border-t bg-secondary/50 px-4 py-2.5 text-sm font-medium">
              지금 할 일 — {data.todo}
            </p>
          ) : null}

          <dl className="grid gap-4 border-t px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="발송 키"
              value={data.keyRegistered ? "등록됨" : "없음"}
              note={
                data.keyRegistered ? null : "키가 없어 실제 발송이 되지 않고 보낸 내역만 남습니다."
              }
              warn={!data.keyRegistered}
            />
            <Fact
              label="발신 주소"
              value={data.fromAddress}
              note={data.fromIsDefault ? "아직 임시 주소입니다. 회사 도메인으로 바꾸세요." : null}
              warn={data.fromIsDefault}
            />
            <Fact
              label="발신 도메인 인증"
              value={`${data.fromDomain ?? "확인 불가"} · ${data.domain.state}`}
              note={data.domain.detail}
              warn={data.domain.state !== "정상"}
            />
            <Fact
              label="오늘 남은 발송 여유"
              value={`${remaining.toLocaleString()}건 (상한 ${data.dailyCap.toLocaleString()}건)`}
              note={`오늘 ${data.sentToday.toLocaleString()}건 보냈습니다.`}
              warn={remaining === 0}
            />
            <Fact
              label="이번 달 발송량"
              value={`${data.sentThisMonth.toLocaleString()}건`}
              note={data.monthlyQuotaNote}
            />
            <Fact
              label="이번 달 반송"
              value={`${data.bouncedThisMonth.toLocaleString()}건`}
              note={
                data.bouncedThisMonth > 0
                  ? "이력 탭에서 반송 건을 골라 주소를 고친 뒤 재발송하세요."
                  : "되돌아온 메일이 없습니다."
              }
              warn={data.bouncedThisMonth > 0}
            />
            <Fact
              label="반송 표시가 남은 참여자"
              value={`${data.bouncedParticipants.toLocaleString()}명`}
              note={
                data.bouncedParticipants > 0
                  ? "이 사람들은 마지막 발송이 닿지 않았습니다. 주소를 확인하세요."
                  : "전원 마지막 발송이 정상 접수됐습니다."
              }
              warn={data.bouncedParticipants > 0}
            />
          </dl>

          {data.domain.records.length > 0 ? (
            <div className="border-t bg-secondary/40 px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground">
                발신 도메인 확인 항목 (도메인 관리자가 넣어야 하는 값)
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                {data.domain.records.map((r) => (
                  <li key={r.label} className="text-xs">
                    <span className="text-muted-foreground">{r.label}</span>{" "}
                    <span className={cn("font-semibold", RECORD_TONE[r.tone])}>{r.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="border-t px-4 py-2 text-[11px] tabular-nums text-muted-foreground">
            기준 {asOf}
          </p>
        </div>
      </div>
    </section>
  );
}
