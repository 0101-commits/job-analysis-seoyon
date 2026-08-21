// 조직도 엑셀식 레벨 그리드 (W2). 캔버스·노드 방식을 대체하는 유일한 편집 뷰다.
// 행 = 조직(부모 다음 자식, 형제는 정렬→이름 순), 열 = 깊이(레벨1~N) + 구분 + 정렬 + 인원 + 작업.
// 칸을 그 자리에서 고치고 Enter 나 다른 곳 누름으로 저장한다. 검증·확인·고지는 부모(master.tsx)가 담당.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, MoreHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type OrgGridUnit = {
  id: string;
  name: string;
  level: string | null;
  parent_id: string | null;
  company_id: string;
  sort: number;
  companies: { name: string } | null;
};

/** 조직별 하위 합산 대상/제출 인원 — 인원 열에 쓴다. */
export type OrgRollup = Map<string, { total: number; done: number }>;

/** siblings/index 는 ↑↓ 순서 이동과 들여쓰기 후보 계산에 쓴다 (표시 순서 기준 형제 목록). */
type GridRow = { unit: OrgGridUnit; depth: number; siblings: OrgGridUnit[]; index: number };

/** 트리 위상 순서로 편다. 형제는 정렬(sort)→이름 순, 순환 데이터는 seen 으로 방어. */
function flatten(units: OrgGridUnit[]) {
  const ids = new Set(units.map((u) => u.id));
  const byParent = new Map<string | null, OrgGridUnit[]>();
  for (const u of units) {
    const key = u.parent_id && ids.has(u.parent_id) ? u.parent_id : null;
    const list = byParent.get(key);
    if (list) list.push(u);
    else byParent.set(key, [u]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
  }
  const rows: GridRow[] = [];
  let maxDepth = 0;
  const seen = new Set<string>();
  const walk = (u: OrgGridUnit, depth: number, siblings: OrgGridUnit[], index: number) => {
    if (seen.has(u.id)) return;
    seen.add(u.id);
    maxDepth = Math.max(maxDepth, depth);
    rows.push({ unit: u, depth, siblings, index });
    const kids = byParent.get(u.id) ?? [];
    kids.forEach((k, i) => walk(k, depth + 1, kids, i));
  };
  const roots = byParent.get(null) ?? [];
  roots.forEach((r, i) => walk(r, 0, roots, i));
  return { rows, maxDepth };
}

/**
 * 엑셀 감각의 인라인 칸. blur·Enter 로 저장, Escape 로 되돌림.
 * 저장 여부와 무관하게 표시는 항상 서버 값(value)으로 돌아간다 — 확인 다이얼로그에서
 * 취소해도 안 바뀐 값이 그대로 보이게 하기 위함이다. 반영된 값은 재조회로 나타난다.
 */
function InlineCell({
  value,
  ariaLabel,
  className,
  placeholder,
  busy,
  onFocus,
  commit,
}: {
  value: string;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  busy: boolean;
  onFocus?: () => void;
  commit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const escaped = useRef(false);
  return (
    <Input
      className={`h-8 text-xs ${className ?? ""}`}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={busy}
      onFocus={onFocus}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          escaped.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (escaped.current) {
          escaped.current = false;
          return;
        }
        const next = draft.trim();
        setDraft(value);
        if (next !== value.trim()) commit(next);
      }}
    />
  );
}

/** 하위·같은 레벨 추가용 새 행. 이름만 받고 나머지는 만들어진 뒤 그 자리에서 고친다. */
function DraftRow({
  depth,
  levels,
  busy,
  onSave,
  onCancel,
}: {
  depth: number;
  levels: number;
  busy: boolean;
  onSave: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const save = async () => {
    const v = name.trim();
    if (!v) return;
    if (await onSave(v)) onCancel();
  };
  return (
    <tr className="border-t bg-secondary/40">
      {Array.from({ length: depth }, (_, i) => (
        <td key={i} />
      ))}
      <td colSpan={levels - depth} className="px-1 py-1">
        <Input
          autoFocus
          className="h-8 min-w-36 text-xs"
          value={name}
          placeholder="새 조직명"
          aria-label="새 조직명"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
        />
      </td>
      <td colSpan={3} className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">
        Enter 로 추가
      </td>
      <td className="px-1 py-1">
        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-7"
            disabled={busy || name.trim() === ""}
            onClick={() => void save()}
          >
            추가
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            aria-label="추가 취소"
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function OrgGrid({
  units,
  rollup,
  busy,
  selectedId,
  groupByCompany,
  onSelect,
  onEditStart,
  onRename,
  onMove,
  onReorder,
  onCreate,
  onDelete,
}: {
  units: OrgGridUnit[];
  rollup: OrgRollup | null;
  busy: boolean;
  selectedId: string | null;
  /** 전사 렌즈일 때 계열사별 구획으로 나눠 그린다. */
  groupByCompany: boolean;
  onSelect: (unit: OrgGridUnit) => void;
  /** 어떤 행의 칸에 손을 대기 시작했다 — 인스펙터가 그 조직의 영향 인원을 세게 한다. */
  onEditStart: (unit: OrgGridUnit) => void;
  onRename: (unit: OrgGridUnit, values: { name: string; level: string; sort: number }) => void;
  onMove: (unit: OrgGridUnit, parentId: string | null, title: string) => void;
  /** ↑↓ 순서 이동 — 형제 전체의 정렬값을 표시 순서대로 다시 매겨 한 번에 저장한다. */
  onReorder: (items: { id: string; sort: number }[]) => void;
  onCreate: (input: {
    companyId: string;
    parentId: string | null;
    name: string;
  }) => Promise<boolean>;
  onDelete: (unit: OrgGridUnit) => void;
}) {
  const [draft, setDraft] = useState<{
    anchorId: string;
    parentId: string | null;
    companyId: string;
    depth: number;
  } | null>(null);

  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const { groups, levels } = useMemo(() => {
    const byCompany = new Map<string, OrgGridUnit[]>();
    for (const u of units) {
      const list = byCompany.get(u.company_id);
      if (list) list.push(u);
      else byCompany.set(u.company_id, [u]);
    }
    const buckets = groupByCompany
      ? [...byCompany.entries()]
          .map(([companyId, list]) => ({
            companyId,
            companyName: list[0]?.companies?.name ?? "",
            list,
          }))
          .sort((a, b) => a.companyName.localeCompare(b.companyName, "ko"))
      : [{ companyId: "", companyName: "", list: units }];
    let maxDepth = 0;
    const flattened = buckets.map((bucket) => {
      const { rows, maxDepth: d } = flatten(bucket.list);
      maxDepth = Math.max(maxDepth, d);
      return { ...bucket, rows };
    });
    // 깊이 열은 지금 최대 깊이 + 여유 1칸, 최소 3칸 — 한 단계 더 들여쓸 자리를 항상 남긴다.
    return { groups: flattened, levels: Math.max(3, maxDepth + 2) };
  }, [units, groupByCompany]);

  if (units.length === 0) {
    return <p className="text-sm text-muted-foreground">등록된 조직이 없습니다.</p>;
  }

  /** 형제 사이 한 칸 이동. 동률 sort 는 표시 순서대로 0,1,2… 로 다시 매겨 함께 저장한다. */
  function moveSibling(siblings: OrgGridUnit[], index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= siblings.length) return;
    const order = [...siblings];
    [order[index], order[target]] = [order[target]!, order[index]!];
    onReorder(order.map((u, i) => ({ id: u.id, sort: i })));
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.companyId || "single"} className="space-y-1">
          {groupByCompany && (
            <p className="text-xs font-semibold text-primary">{group.companyName}</p>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-secondary text-left text-muted-foreground">
                <tr>
                  {Array.from({ length: levels }, (_, i) => (
                    <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">
                      레벨{i + 1}
                    </th>
                  ))}
                  <th className="px-2 py-2 font-medium">구분</th>
                  <th className="px-2 py-2 font-medium">정렬</th>
                  <th className="whitespace-nowrap px-2 py-2 font-medium">인원</th>
                  <th className="w-24 px-2 py-2" aria-label="행 작업" />
                </tr>
              </thead>
              <tbody>
                {group.rows.map(({ unit, depth, siblings, index }) => {
                  const stats = rollup?.get(unit.id);
                  const prevSibling = index > 0 ? siblings[index - 1] : undefined;
                  const parent = unit.parent_id ? byId.get(unit.parent_id) : undefined;
                  return (
                    <FragmentRow key={unit.id}>
                      <tr
                        id={`org-${unit.id}`}
                        className={`scroll-mt-24 border-t ${
                          unit.id === selectedId ? "bg-primary/10" : ""
                        }`}
                      >
                        {Array.from({ length: depth }, (_, i) => (
                          <td key={i} className="w-6" />
                        ))}
                        <td colSpan={levels - depth} className="px-1 py-1">
                          <InlineCell
                            key={unit.name}
                            value={unit.name}
                            ariaLabel={`${unit.name} 조직명`}
                            className="min-w-36"
                            busy={busy}
                            onFocus={() => {
                              onEditStart(unit);
                              onSelect(unit);
                            }}
                            commit={(next) => {
                              if (next === "") return; // 빈 이름은 저장하지 않는다
                              onRename(unit, {
                                name: next,
                                level: unit.level ?? "",
                                sort: unit.sort,
                              });
                            }}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <InlineCell
                            key={unit.level ?? ""}
                            value={unit.level ?? ""}
                            ariaLabel={`${unit.name} 구분`}
                            className="w-24"
                            placeholder="본부/팀"
                            busy={busy}
                            onFocus={() => onEditStart(unit)}
                            commit={(next) =>
                              onRename(unit, { name: unit.name, level: next, sort: unit.sort })
                            }
                          />
                        </td>
                        <td className="px-1 py-1">
                          <InlineCell
                            key={String(unit.sort)}
                            value={String(unit.sort)}
                            ariaLabel={`${unit.name} 정렬 순서`}
                            className="w-16 tabular-nums"
                            busy={busy}
                            onFocus={() => onEditStart(unit)}
                            commit={(next) => {
                              const n = Number.parseInt(next, 10);
                              if (Number.isNaN(n)) return; // 정수가 아니면 되돌린다
                              onRename(unit, {
                                name: unit.name,
                                level: unit.level ?? "",
                                sort: n,
                              });
                            }}
                          />
                        </td>
                        <td
                          className="cursor-pointer whitespace-nowrap px-2 py-1 tabular-nums text-muted-foreground"
                          onClick={() => onSelect(unit)}
                        >
                          {stats ? `${stats.total}명 · 제출 ${stats.done}` : "-"}
                        </td>
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={`${unit.name} 위로 이동`}
                              disabled={busy || index === 0}
                              onClick={() => moveSibling(siblings, index, -1)}
                            >
                              <ChevronUp className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={`${unit.name} 아래로 이동`}
                              disabled={busy || index === siblings.length - 1}
                              onClick={() => moveSibling(siblings, index, 1)}
                            >
                              <ChevronDown className="size-4" />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7"
                                  aria-label={`${unit.name} 조직 관리`}
                                  disabled={busy}
                                >
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setDraft({
                                      anchorId: unit.id,
                                      parentId: unit.id,
                                      companyId: unit.company_id,
                                      depth: depth + 1,
                                    })
                                  }
                                >
                                  하위 조직 추가
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setDraft({
                                      anchorId: unit.id,
                                      parentId: unit.parent_id,
                                      companyId: unit.company_id,
                                      depth,
                                    })
                                  }
                                >
                                  같은 레벨 추가
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!prevSibling}
                                  onSelect={() => {
                                    if (!prevSibling) return;
                                    onMove(
                                      unit,
                                      prevSibling.id,
                                      `「${unit.name}」 을(를) 「${prevSibling.name}」 하위로 이동`,
                                    );
                                  }}
                                >
                                  들여쓰기 (위 조직의 하위로)
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!unit.parent_id}
                                  onSelect={() =>
                                    onMove(
                                      unit,
                                      parent?.parent_id ?? null,
                                      `「${unit.name}」 을(를) 한 단계 위로 이동`,
                                    )
                                  }
                                >
                                  내어쓰기 (한 단계 위로)
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onSelect={() => onDelete(unit)}
                                >
                                  삭제
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                      {draft && draft.anchorId === unit.id && (
                        <DraftRow
                          depth={draft.depth}
                          levels={levels}
                          busy={busy}
                          onSave={(name) =>
                            onCreate({
                              companyId: draft.companyId,
                              parentId: draft.parentId,
                              name,
                            })
                          }
                          onCancel={() => setDraft(null)}
                        />
                      )}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** tbody 안에서 행 + 새 행(초안)을 함께 내보내기 위한 이름 있는 Fragment. */
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
