import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { UNASSIGNED_ORG } from "@/components/admin/OrgTreeFilter";

/**
 * 조직 참여율 히트맵 (v6 G4).
 *
 * 행 = 조직(트리 위상 순서, 들여쓰기로 계층 표현), 셀 = 하위 합산 참여율(제출 이상/배정).
 * 색은 브랜드 블루 5단계지만 수치를 항상 함께 적는다 — 색만으로 구분하지 않는다(접근성).
 * 행을 누르면 부모가 넘긴 onSelect 로 렌즈(?org=)가 걸리고, 미소속 행은 렌즈 대신
 * 참여자 관리(?org=none)로 직행한다. 데이터 가공은 index.tsx 가 하고 여기는 그리기만 한다.
 */

export type HeatStats = { total: number; done: number };
export type HeatRow = {
  id: string;
  name: string;
  level: string | null;
  depth: number;
  stats: HeatStats;
};
export type HeatGroup = {
  key: string;
  /** 전사 렌즈일 때만 계열사 이름. 아니면 null. */
  title: string | null;
  rows: HeatRow[];
};

/** 참여율 0~100% → 5단계. 낮을수록 옅다. */
const HEAT_STEPS = [
  "bg-primary/10",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/65",
  "bg-primary/85",
] as const;

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function HeatCell({ stats }: { stats: HeatStats }) {
  if (stats.total === 0) {
    return (
      <span className="flex-1 rounded-md bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground">
        대상 없음
      </span>
    );
  }
  const rate = pct(stats.done, stats.total);
  const bucket = Math.min(HEAT_STEPS.length - 1, Math.floor(rate / 20));
  return (
    <span
      className={cn(
        "flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium tabular-nums",
        HEAT_STEPS[bucket],
        bucket >= 3 ? "text-primary-foreground" : "text-foreground",
      )}
    >
      {stats.done}/{stats.total}명 · {rate}%
    </span>
  );
}

export function OrgHeatmap({
  groups,
  selectedId,
  selectedLabel,
  onSelect,
  participantsHref,
}: {
  groups: HeatGroup[];
  /** 지금 걸린 렌즈(?org=). 그 행을 강조하고 상단 칩으로 알린다. */
  selectedId: string | null;
  selectedLabel: string | null;
  onSelect: (id: string | null) => void;
  /** 행별 「참여자 관리에서 보기」 목적지 — 미소속 행은 ?org=none 을 받는다. */
  participantsHref: (id: string) => string;
}) {
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
        이 범위에 표시할 조직이 없습니다. 기준정보 화면에서 조직도를 먼저 올려 주세요.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {selectedId ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-primary-soft px-2.5 py-1 text-xs font-medium text-accent-foreground">
          {selectedLabel ?? "선택한 소속"} 기준으로 보는 중
          <button
            type="button"
            aria-label="소속 선택 해제"
            onClick={() => onSelect(null)}
            className="hover:opacity-70"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="overflow-x-auto rounded-xl border bg-card p-3">
          <div className="min-w-[480px] space-y-0.5">
            {group.title ? (
              <p className="px-1 pb-1.5 text-xs font-semibold text-muted-foreground">
                {group.title}
              </p>
            ) : null}
            {group.rows.map((row) => {
              const unassigned = row.id === UNASSIGNED_ORG;
              const active = !unassigned && selectedId === row.id;
              const nameBlock = (
                <span
                  className="flex w-[200px] shrink-0 items-baseline gap-1.5 truncate"
                  style={{ paddingLeft: `${row.depth * 14}px` }}
                >
                  <span className={cn("truncate text-sm", active && "font-semibold")}>
                    {row.name}
                  </span>
                  {row.level ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{row.level}</span>
                  ) : null}
                </span>
              );
              return (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md pr-1",
                    active && "bg-primary-soft ring-1 ring-primary/40",
                  )}
                >
                  {unassigned ? (
                    <span className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 text-left">
                      {nameBlock}
                      <HeatCell stats={row.stats} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(active ? null : row.id)}
                      title={active ? "누르면 선택을 해제합니다" : "누르면 이 소속 기준으로 봅니다"}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pl-1 text-left transition-colors hover:bg-secondary/60"
                    >
                      {nameBlock}
                      <HeatCell stats={row.stats} />
                    </button>
                  )}
                  {active || unassigned ? (
                    <a
                      href={participantsHref(row.id)}
                      className="shrink-0 rounded-md border bg-card px-2 py-1 text-xs font-medium text-primary hover:bg-secondary"
                    >
                      참여자 관리에서 보기
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
