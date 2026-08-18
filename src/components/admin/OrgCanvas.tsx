// 조직도 노드 캔버스 (V5). 신규 의존성 없이 SVG 엣지 + 절대배치 카드로 그린다.
// 휠 줌 · 배경 드래그 팬 · 노드를 다른 노드에 드롭하면 상위 이동(검증·확인은 부모가 담당).
// 캔버스는 보조 뷰다 — 동일 기능의 트리 뷰(OrgTree)가 항상 함께 제공된다.
import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type CanvasUnit = {
  id: string;
  name: string;
  level: string | null;
  parent_id: string | null;
  company_id: string;
  companies: { name: string } | null;
};

export type CanvasAction = { kind: "rename" | "child" | "move"; unit: CanvasUnit };

export type CanvasRollup = Map<string, { total: number; done: number }>;

const NODE_W = 172;
const NODE_H = 60;
const H_GAP = 20;
const V_GAP = 64;
/** 이 개수를 넘을 때만 미니맵을 띄운다. */
const MINIMAP_AT = 50;

/**
 * 리프 카운트 방식 tidy tree: 리프에 가로 슬롯을 차례로 주고 부모는 자식 중앙에 둔다.
 * 깊이(depth)가 세로, 슬롯 순번이 가로 — 업로드 검증(validateOrgRows)의 위상 구조와 같은 원리.
 */
function layout(units: CanvasUnit[]) {
  const ids = new Set(units.map((u) => u.id));
  const byParent = new Map<string, CanvasUnit[]>();
  const roots: CanvasUnit[] = [];
  for (const u of units) {
    if (u.parent_id && ids.has(u.parent_id)) {
      const list = byParent.get(u.parent_id);
      if (list) list.push(u);
      else byParent.set(u.parent_id, [u]);
    } else {
      roots.push(u);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  let maxDepth = 0;
  const seen = new Set<string>(); // 순환 데이터 방어
  const walk = (u: CanvasUnit, depth: number): number => {
    if (seen.has(u.id)) return cursor * (NODE_W + H_GAP) + NODE_W / 2;
    seen.add(u.id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = byParent.get(u.id) ?? [];
    let cx: number;
    if (kids.length === 0) {
      cx = cursor * (NODE_W + H_GAP) + NODE_W / 2;
      cursor += 1;
    } else {
      const centers = kids.map((k) => walk(k, depth + 1));
      cx = (centers[0]! + centers[centers.length - 1]!) / 2;
    }
    pos.set(u.id, { x: cx - NODE_W / 2, y: depth * (NODE_H + V_GAP) + 8 });
    return cx;
  };
  for (const root of roots) walk(root, 0);

  return {
    pos,
    width: Math.max(cursor * (NODE_W + H_GAP) + H_GAP, NODE_W + H_GAP * 2),
    height: (maxDepth + 1) * (NODE_H + V_GAP) + 16,
  };
}

function ringColor(rate: number) {
  if (rate >= 80) return "#16a34a";
  if (rate >= 40) return "#d97706";
  return "#dc2626";
}

/** 하위 합산 제출률 링. 배정 인원이 없으면 회색 링에 「-」. */
function SubmitRing({ stats }: { stats: { total: number; done: number } | undefined }) {
  const total = stats?.total ?? 0;
  const rate = total > 0 ? Math.round(((stats?.done ?? 0) / total) * 100) : 0;
  const r = 10;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      className="shrink-0"
      role="img"
      aria-label={total > 0 ? `제출률 ${rate}%` : "배정 인원 없음"}
    >
      <circle
        cx="13"
        cy="13"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.15"
        strokeWidth="3"
      />
      {total > 0 && (
        <circle
          cx="13"
          cy="13"
          r={r}
          fill="none"
          stroke={ringColor(rate)}
          strokeWidth="3"
          strokeDasharray={`${(c * rate) / 100} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 13 13)"
        />
      )}
      <text x="13" y="16" textAnchor="middle" fontSize="8" fill="currentColor">
        {total > 0 ? rate : "-"}
      </text>
    </svg>
  );
}

export function OrgCanvas({
  units,
  rollup,
  busy,
  onAction,
  onDelete,
  onDropMove,
}: {
  units: CanvasUnit[];
  rollup: CanvasRollup | null;
  busy: boolean;
  onAction: (action: CanvasAction) => void;
  onDelete: (unit: CanvasUnit) => void;
  onDropMove: (unit: CanvasUnit, target: CanvasUnit) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const [box, setBox] = useState({ w: 800, h: 480 });
  const [drag, setDrag] = useState<{
    id: string;
    dx: number;
    dy: number;
    overId: string | null;
  } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const dragRef = useRef<{ unit: CanvasUnit; sx: number; sy: number; moved: boolean } | null>(
    null,
  );

  const { pos, width, height } = useMemo(() => layout(units), [units]);

  // React 는 wheel 을 passive 로 붙이므로 preventDefault 가 필요한 줌은 네이티브로 단다.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function toCanvas(clientX: number, clientY: number) {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.k,
      y: (clientY - rect.top - view.y) / view.k,
    };
  }

  function hitTest(clientX: number, clientY: number, excludeId: string): CanvasUnit | null {
    const p = toCanvas(clientX, clientY);
    for (const u of units) {
      if (u.id === excludeId) continue;
      const q = pos.get(u.id);
      if (!q) continue;
      if (p.x >= q.x && p.x <= q.x + NODE_W && p.y >= q.y && p.y <= q.y + NODE_H) return u;
    }
    return null;
  }

  /* 배경 팬 */
  function onBgPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  }
  function onBgPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  }
  function onBgPointerUp() {
    panRef.current = null;
  }

  /* 노드 드래그 → 드롭 이동 */
  function onNodePointerDown(e: React.PointerEvent<HTMLDivElement>, unit: CanvasUnit) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { unit, sx: e.clientX, sy: e.clientY, moved: false };
  }
  function onNodePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    const target = hitTest(e.clientX, e.clientY, d.unit.id);
    setDrag({ id: d.unit.id, dx: dx / view.k, dy: dy / view.k, overId: target?.id ?? null });
  }
  function onNodePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) return; // 클릭 — 메뉴는 ⋯ 버튼이 담당
    const target = hitTest(e.clientX, e.clientY, d.unit.id);
    setDrag(null);
    if (target && target.id !== d.unit.parent_id && !busy) onDropMove(d.unit, target);
  }
  function onNodePointerCancel() {
    dragRef.current = null;
    setDrag(null);
  }

  if (units.length === 0) {
    return <p className="text-sm text-muted-foreground">등록된 조직이 없습니다.</p>;
  }

  const mmScale = Math.min(150 / Math.max(width, 1), 110 / Math.max(height, 1));

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="조직도 캔버스 — 동일한 편집 기능을 트리 뷰에서도 사용할 수 있습니다"
      className="relative h-[480px] cursor-grab overflow-hidden rounded-xl border bg-secondary/20"
      style={{ touchAction: "none" }}
      onPointerDown={onBgPointerDown}
      onPointerMove={onBgPointerMove}
      onPointerUp={onBgPointerUp}
      onPointerCancel={onBgPointerUp}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: "0 0",
          width,
          height,
        }}
      >
        <svg width={width} height={height} className="absolute left-0 top-0 text-muted-foreground">
          {units.map((u) => {
            if (!u.parent_id) return null;
            const p = pos.get(u.parent_id);
            const c = pos.get(u.id);
            if (!p || !c) return null;
            const x1 = p.x + NODE_W / 2;
            const y1 = p.y + NODE_H;
            const x2 = c.x + NODE_W / 2;
            const y2 = c.y;
            return (
              <path
                key={u.id}
                d={`M ${x1} ${y1} C ${x1} ${y1 + V_GAP / 2}, ${x2} ${y2 - V_GAP / 2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.3"
                strokeWidth={1.5}
              />
            );
          })}
        </svg>

        {units.map((unit) => {
          const q = pos.get(unit.id);
          if (!q) return null;
          const dragging = drag?.id === unit.id;
          const isOver = drag !== null && drag.overId === unit.id;
          const stats = rollup?.get(unit.id);
          const subtitle = [
            !unit.parent_id ? unit.companies?.name : null,
            unit.level,
            `${stats?.total ?? 0}명 · 제출 ${stats?.done ?? 0}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              key={unit.id}
              className={`absolute select-none rounded-lg border bg-card p-2 shadow-sm ${
                dragging ? "z-10 opacity-80 ring-2 ring-primary" : ""
              } ${isOver ? "ring-2 ring-primary" : ""}`}
              style={{
                left: q.x,
                top: q.y,
                width: NODE_W,
                height: NODE_H,
                transform: dragging && drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
                touchAction: "none",
              }}
              onPointerDown={(e) => onNodePointerDown(e, unit)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onPointerCancel={onNodePointerCancel}
            >
              <div className="flex h-full items-center gap-1.5">
                <SubmitRing stats={stats} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{unit.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{subtitle}</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 opacity-50 hover:opacity-100"
                      aria-label={`${unit.name} 조직 관리`}
                      disabled={busy}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => onAction({ kind: "rename", unit })}>
                      이름 변경
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onAction({ kind: "child", unit })}>
                      하위 조직 추가
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onAction({ kind: "move", unit })}>
                      상위 이동
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(unit)}>
                      삭제
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
      </div>

      {units.length > MINIMAP_AT && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-md border bg-card/90 p-1 shadow-sm">
          <div className="relative" style={{ width: width * mmScale, height: height * mmScale }}>
            {units.map((u) => {
              const q = pos.get(u.id);
              if (!q) return null;
              return (
                <div
                  key={u.id}
                  className="absolute rounded-[1px] bg-primary/50"
                  style={{
                    left: q.x * mmScale,
                    top: q.y * mmScale,
                    width: Math.max(2, NODE_W * mmScale),
                    height: Math.max(2, NODE_H * mmScale),
                  }}
                />
              );
            })}
            <div
              className="absolute border border-primary"
              style={{
                left: (-view.x / view.k) * mmScale,
                top: (-view.y / view.k) * mmScale,
                width: (box.w / view.k) * mmScale,
                height: (box.h / view.k) * mmScale,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
