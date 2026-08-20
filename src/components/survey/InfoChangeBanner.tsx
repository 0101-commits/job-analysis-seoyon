// 관리자가 내 소속·직무·기본정보를 정정했을 때 참여자에게 알리는 배너 (V14-③ · 기획 C8-2).
// 홈과 설문 1단계 두 곳에서 쓴다. 확인(닫기)하면 마지막 확인 시각을 localStorage 에 남기고,
// 그 이후에 생긴 변경 건만 다시 보여 준다.
//
// 항목 이름은 그 항목이 있는 작성 화면으로 가는 링크다 (P6). 링크 규약은 @/lib/survey.focus.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getMyInfoChanges } from "@/lib/survey.data";
import { focusLabel, focusSearch } from "@/lib/survey.focus";

const ACK_KEY = "info-change-ack";

const when = (at: string) =>
  new Date(at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

export function InfoChangeBanner() {
  const [ack, setAck] = useState(() => globalThis.localStorage?.getItem(ACK_KEY) ?? "");
  const { data } = useQuery({
    queryKey: ["my-info-changes"],
    queryFn: () => getMyInfoChanges(),
    staleTime: 60_000,
  });

  const fresh = (data ?? []).filter((e) => e.at > ack);
  if (fresh.length === 0) return null;

  const latest = fresh[0]?.at ?? new Date().toISOString();

  const dismiss = () => {
    globalThis.localStorage?.setItem(ACK_KEY, latest);
    setAck(latest);
  };

  return (
    <div className="rounded-xl border border-primary/40 bg-primary-soft/30 p-4">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm font-semibold">관리자가 내 정보를 정정했습니다</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mt-1 shrink-0"
          onClick={dismiss}
          aria-label="변경 안내 닫기"
        >
          <X className="size-4" />
        </Button>
      </div>

      <ul className="mt-2 space-y-1.5 pl-6">
        {fresh.map((e) => (
          <li key={e.at} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className="tabular-nums text-muted-foreground">{when(e.at)}</span>
            {e.fields.map((f) => (
              <Link
                key={f}
                to="/survey"
                search={focusSearch(f)}
                className="rounded-md border border-primary/30 bg-card px-2 py-0.5 font-medium text-primary hover:bg-primary-soft/60"
              >
                {focusLabel(f)}
              </Link>
            ))}
          </li>
        ))}
      </ul>

      <p className="mt-2 pl-6 text-xs text-muted-foreground">
        항목을 누르면 해당 작성 화면이 열립니다. 바뀐 내용이 맞는지 확인해 주세요.
      </p>
    </div>
  );
}

export default InfoChangeBanner;
