// 마스터 변경 영향 인스펙터 (기획 B5 · P11).
//
// 조직도·직무분류를 편집하는 동안 편집 영역 옆에 상시 붙어, 「지금 이 변경이 누구에게 닿는지」를
// 저장을 누르기 전에 보여 준다. previewImpact 다이얼로그(변경 직전 1회 확인)는 그대로 두고,
// 이쪽은 편집 중 내내 켜져 있는 계기판이다.
//
// 정합성 점검(checkIntegrity 5종)도 같은 패널에 합친다 — 지금 만드는 변경과 이미 어긋나 있는 것을
// 한 자리에서 보게 하기 위함이다. 각 항목은 그 대상으로 가는 링크를 가진다(P6).
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SignalCard } from "@/components/SignalCard";
import { EmptyState } from "@/components/EmptyState";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { checkIntegrity } from "@/lib/dashboard.functions";
import {
  inspectImpact,
  notifyImpacted,
  type ImpactAudience,
  type ImpactKind,
} from "@/lib/master.functions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

/** 고지 배너가 라벨을 아는 필드 (survey.data 의 INFO_FIELDS · InfoChangeBanner 의 EXTRA_LABELS). */
export type NoticeField = "org_text" | "job_name" | "role_level";

/** 지금 편집 중인 변경 하나. null 이면 인스펙터는 「편집 중 아님」 상태로 대기한다. */
export type ImpactTarget = {
  kind: ImpactKind;
  id: string;
  /** 화면에 쓰는 대상 이름 — 「경영기획팀」 같은 것. */
  label: string;
  /** 저장 후 고지에 쓸 참여자 정보 항목. */
  field: NoticeField;
  /** 배너에 남길 한 줄 — 무엇이 바뀌는지. */
  note: string;
};

/** 편집 중인 대상의 영향 인원. 대상이 바뀔 때마다 다시 센다. */
export function useImpactAudience(target: ImpactTarget | null) {
  return useQuery({
    queryKey: ["impact-audience", target?.kind ?? "", target?.id ?? ""],
    queryFn: async () =>
      inspectImpact({
        data: { kind: target!.kind, id: target!.id },
        headers: await authHeaders(),
      }),
    enabled: target !== null,
    // 편집 중에는 명부가 크게 흔들리지 않는다. 매 입력마다 다시 세지 않게 잠시 재사용한다.
    staleTime: 30_000,
  });
}

/**
 * 저장이 끝난 뒤 부르면 영향 인원에게 배너 고지를 예약한다.
 * 저장 자체는 이미 성공한 뒤이므로 실패해도 되돌리지 않고 알리기만 한다 (P8 — 조용히 넘어가지 않는다).
 */
export async function scheduleImpactNotice(
  target: ImpactTarget,
  audience: ImpactAudience | undefined,
) {
  if (!audience || audience.ids.length === 0) return;
  try {
    const { notified } = await notifyImpacted({
      data: { participantIds: audience.ids, field: target.field, note: target.note },
      headers: await authHeaders(),
    });
    toast.success(
      `영향 인원 ${notified}명에게 변경 안내를 예약했습니다 — 다음 접속 때 배너로 보입니다.`,
    );
  } catch (err) {
    toast.error(
      err instanceof Error
        ? `변경은 저장됐지만 안내 예약에 실패했습니다: ${err.message}`
        : "변경은 저장됐지만 안내 예약에 실패했습니다.",
    );
  }
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 저장 버튼 옆에 붙이는 영향 인원 배지 — 규모를 알고 누르게 한다. */
export function ImpactCountBadge({
  audience,
  loading,
}: {
  audience: ImpactAudience | undefined;
  loading: boolean;
}) {
  if (loading) {
    return <span className="text-xs text-muted-foreground">영향 인원 확인 중...</span>;
  }
  if (!audience) return null;
  if (audience.total === 0) {
    return <span className="text-xs text-muted-foreground">영향 인원 없음</span>;
  }
  return (
    <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium">
      영향 {audience.total}명
      {audience.stages[0] && audience.stages[0].count > 0
        ? ` (제출 완료 ${audience.stages[0].count}명)`
        : ""}
    </span>
  );
}

function PeopleList({ label, people, count }: { label: string; people: string[]; count: number }) {
  if (count === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs font-medium text-primary hover:underline">
        {label} {count}명 명단 보기
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-2 text-xs text-muted-foreground">
          {people.map((person) => (
            <li key={person}>{person}</li>
          ))}
        </ul>
        {count > people.length && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            외 {count - people.length}명은 명단에 표시하지 않았습니다.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ImpactInspector({
  target,
  audience,
  loading,
  notifyOnSave,
  onNotifyOnSaveChange,
  className,
}: {
  target: ImpactTarget | null;
  audience: ImpactAudience | undefined;
  loading: boolean;
  notifyOnSave: boolean;
  onNotifyOnSaveChange: (next: boolean) => void;
  className?: string;
}) {
  const { data: integrity } = useQuery({
    queryKey: ["dashboard-integrity"],
    queryFn: async () => checkIntegrity({ headers: await authHeaders() }),
  });

  const problems = (integrity?.checks ?? []).filter((check) => check.count > 0);

  return (
    <aside className={className} aria-label="변경 영향 인스펙터">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">변경 영향</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            편집 중인 변경이 지금 누구에게 닿는지 저장 전에 보여 줍니다.
          </p>
        </div>

        {target === null ? (
          <EmptyState
            kind="nothing"
            title="편집 중인 변경이 없습니다"
            description="조직이나 직무를 고치기 시작하면, 그 변경이 닿는 인원이 여기에서 진행 상태별로 집계됩니다."
          />
        ) : loading || !audience ? (
          <p className="text-sm text-muted-foreground">영향 인원을 세는 중...</p>
        ) : audience.total > 0 ? (
          <SignalCard
            tone="attention"
            signal={`「${target.label}」 를 바꾸면 ${audience.total}명이 영향을 받습니다`}
            evidence={[
              ...audience.stages.map((stage) => `${stage.label} ${stage.count}명`),
              audience.truncated
                ? "인원이 많아 일부만 집계했습니다 — 실제 영향 인원은 더 많을 수 있습니다."
                : "이미 제출한 인원은 다시 확인해야 할 수 있습니다.",
            ]}
            asOf={timeLabel(audience.asOf)}
            scope={`대상 「${audience.target || target.label}」`}
          >
            <div className="space-y-1 border-t px-4 py-3">
              {audience.stages.map((stage) => (
                <PeopleList
                  key={stage.stage}
                  label={stage.label}
                  people={stage.people}
                  count={stage.count}
                />
              ))}
              <label className="flex items-start gap-2 pt-2 text-xs">
                <Checkbox
                  checked={notifyOnSave}
                  onCheckedChange={(checked) => onNotifyOnSaveChange(checked === true)}
                  aria-label="저장 후 영향 인원에게 변경 안내"
                />
                <span className="text-muted-foreground">
                  저장하면 이 인원에게 변경 안내를 예약합니다 — 다음 접속 때 각자 화면 위에 배너로
                  한 번 보입니다.
                </span>
              </label>
            </div>
          </SignalCard>
        ) : (
          <SignalCard
            tone="good"
            signal={`「${target.label}」 변경은 지금 아무에게도 닿지 않습니다`}
            evidence={[
              "이 대상에 연결된 참여자·응답이 없습니다.",
              "지금 고쳐도 다시 작성해야 하는 사람이 생기지 않습니다.",
            ]}
            asOf={timeLabel(audience.asOf)}
          />
        )}

        <div className="space-y-3 border-t pt-3">
          <div>
            <p className="text-sm font-semibold">정합성 점검</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              지금 기준 정보와 응답 사이에 어긋난 것들입니다.
            </p>
          </div>
          {integrity === undefined ? (
            <p className="text-sm text-muted-foreground">점검하는 중...</p>
          ) : problems.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <CheckCircle2 className="size-4 shrink-0 text-primary" />
              어긋난 항목이 없습니다.
            </p>
          ) : (
            problems.map((check) => (
              <SignalCard
                key={check.key}
                tone="attention"
                signal={`${check.label} ${check.count}건`}
                evidence={[
                  ...check.items.slice(0, 5),
                  check.count > check.items.slice(0, 5).length
                    ? `외 ${check.count - check.items.slice(0, 5).length}건`
                    : "위가 전부입니다.",
                ]}
                actions={[{ label: check.linkLabel, href: check.link, variant: "outline" }]}
              />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
