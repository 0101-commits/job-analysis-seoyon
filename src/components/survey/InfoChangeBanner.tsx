// 관리자가 내 소속·직무·기본정보를 정정했을 때 참여자에게 1회 알리는 배너 (V14-③).
// 홈과 설문 1단계 두 곳에서 쓴다. 확인(닫기)하면 마지막 확인 시각을 localStorage 에 남기고,
// 그 이후에 생긴 변경 건만 다시 보여 준다.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getMyInfoChanges, infoFieldLabel } from "@/lib/survey.data";

const ACK_KEY = "info-change-ack";

/** infoFieldLabel(participants 필드) 가 모르는 응답·명부 필드의 한국어 라벨 */
const EXTRA_LABELS: Record<string, string> = {
  birth_date: "생년월일",
  job_group: "직군",
  job_series: "직렬",
  job_name: "직무",
  definition: "직무 정의",
  mission: "직무 목적",
  missed_note: "못 담은 측면",
  pain_note: "애로사항",
};

const label = (field: string) => EXTRA_LABELS[field] ?? infoFieldLabel(field);

export function InfoChangeBanner() {
  const [ack, setAck] = useState(() => globalThis.localStorage?.getItem(ACK_KEY) ?? "");
  const { data } = useQuery({
    queryKey: ["my-info-changes"],
    queryFn: () => getMyInfoChanges(),
    staleTime: 60_000,
  });

  const fresh = (data ?? []).filter((e) => e.at > ack);
  if (fresh.length === 0) return null;

  const fields = [...new Set(fresh.flatMap((e) => e.fields.map(label)))];
  const latest = fresh[0]?.at ?? new Date().toISOString();

  const dismiss = () => {
    globalThis.localStorage?.setItem(ACK_KEY, latest);
    setAck(latest);
  };

  return (
    <div className="flex items-start gap-2 rounded-xl border border-primary/40 bg-primary-soft/30 p-4">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">내 정보가 변경되었습니다</span>
        <span className="text-muted-foreground"> — 변경 항목: {fields.join(", ")}</span>
      </p>
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
  );
}

export default InfoChangeBanner;
