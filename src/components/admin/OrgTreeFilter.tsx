import { useMemo } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronRight, Building2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/hooks/use-persisted-ui";
import { applyLensPatch, pickLens } from "@/lib/lens-search";

/**
 * 소속 트리 선택 (기획 B4).
 *
 * 관리 화면의 기본 단위는 개인이 아니라 조직이다. 참여자·검토·메일·내보내기가 모두
 * 같은 컴포넌트를 쓰고 선택 상태를 공유해서, 메뉴를 옮겨도 "울산공장을 보는 중"이라는
 * 맥락이 끊기지 않게 한다.
 *
 * 데이터는 화면이 넘긴다. 이 컴포넌트는 트리를 그리고 고르는 일만 한다.
 */

export type OrgUnitNode = {
  id: string;
  name: string;
  parent_id: string | null;
  level?: string | null;
  sort?: number | null;
};

/**
 * 선택한 소속은 화면 간에 공유하는 하나의 렌즈다 — URL 의 `?org=` 가 유일한 원천이다
 * (기획 v2 P2). 새로고침·뒤로가기·링크 공유가 모두 같은 소속을 연다.
 */
export function useOrgLens() {
  const search = useRouterState({ select: (s) => s.location.search });
  const navigate = useNavigate();
  const selectedOrgId = pickLens(search as Record<string, unknown>).org ?? null;

  function setSelectedOrgId(id: string | null) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => applyLensPatch(prev, { org: id }),
    });
  }

  return { selectedOrgId, setSelectedOrgId };
}

type TreeNode = OrgUnitNode & { children: TreeNode[] };

function buildTree(units: OrgUnitNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  units.forEach((u) => byId.set(u.id, { ...u, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  const sortNodes = (list: TreeNode[]) => {
    list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, "ko"));
    list.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

/** 선택한 소속과 그 하위 전부의 id — 목록 필터에 그대로 쓴다. */
export function orgSubtreeIds(units: OrgUnitNode[], rootId: string | null): string[] | null {
  if (!rootId) return null;
  const childrenOf = new Map<string, string[]>();
  units.forEach((u) => {
    if (!u.parent_id) return;
    childrenOf.set(u.parent_id, [...(childrenOf.get(u.parent_id) ?? []), u.id]);
  });
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    (childrenOf.get(id) ?? []).forEach(walk);
  };
  walk(rootId);
  return out;
}

export function orgPathLabel(units: OrgUnitNode[], id: string | null): string {
  if (!id) return "전체";
  const byId = new Map(units.map((u) => [u.id, u]));
  const parts: string[] = [];
  let cur = byId.get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(" / ") || "전체";
}

function Branch({
  node,
  depth,
  selectedId,
  counts,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  counts: Record<string, number> | undefined;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = usePersistedState<boolean>(`org-open:${node.id}`, depth < 1);
  const hasChildren = node.children.length > 0;
  const active = selectedId === node.id;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 rounded-md pr-2 text-sm transition-colors",
          active ? "bg-primary-soft text-accent-foreground" : "hover:bg-secondary",
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? `${node.name} 접기` : `${node.name} 펼치기`}
            onClick={() => setOpen(!open)}
            className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(active ? null : node.id)}
          className={cn("min-w-0 flex-1 truncate py-1.5 text-left", active && "font-semibold")}
        >
          {node.name}
        </button>
        {counts && typeof counts[node.id] === "number" ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {counts[node.id]}
          </span>
        ) : null}
      </div>
      {hasChildren && open ? (
        <ul>
          {node.children.map((c) => (
            <Branch
              key={c.id}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              counts={counts}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OrgTreeFilter({
  units,
  selectedId,
  onSelect,
  counts,
  className,
  title = "소속",
}: {
  units: OrgUnitNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 소속별 건수 — 넘기면 이름 오른쪽에 표시한다. */
  counts?: Record<string, number>;
  className?: string;
  title?: string;
}) {
  const tree = useMemo(() => buildTree(units), [units]);

  return (
    <div className={cn("rounded-xl border bg-card", className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
        {selectedId ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
          >
            <X className="size-3" aria-hidden />
            전체
          </button>
        ) : null}
      </div>

      {units.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
          등록된 소속이 없습니다.
          <br />
          기준정보 화면에서 조직도를 먼저 만들어 주세요.
        </p>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto p-1.5">
          {tree.map((n) => (
            <Branch
              key={n.id}
              node={n}
              depth={0}
              selectedId={selectedId}
              counts={counts}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
