import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCollapsedSections } from "@/hooks/use-persisted-ui";

/**
 * 긴 화면을 다루는 두 장치 (기획 A4).
 *
 * - `SectionNav`     화면 위쪽의 목차 칩. 누르면 해당 구획으로 내려간다
 * - `CollapsibleSection` 접을 수 있는 구획. 접은 상태를 기억한다
 *
 * 마스터 관리·검토·설정처럼 한 화면이 매우 긴 곳에서 쓴다.
 */

export type SectionDef = { id: string; label: string; count?: number };

export function SectionNav({
  sections,
  className,
}: {
  sections: SectionDef[];
  className?: string;
}) {
  const [active, setActive] = useState<string | null>(null);

  // 화면에 보이는 구획을 칩에 표시한다 — 지금 어디를 보고 있는지 알려 준다.
  useEffect(() => {
    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (targets.length === 0) return;

    // 헤더 높이가 바뀌어도 구획 감지 기준선이 헤더 뒤로 숨지 않도록 --header-h 에서 유도한다.
    const headerH = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--header-h"),
      10,
    );
    const topMargin = (Number.isFinite(headerH) ? headerH : 97) + 8;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: `-${topMargin}px 0px -60% 0px` },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  if (sections.length < 2) return null;

  return (
    <nav
      aria-label="화면 안 이동"
      className={cn("flex flex-wrap gap-1.5 overflow-x-auto pb-1", className)}
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            active === s.id
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-secondary",
          )}
        >
          {s.label}
          {typeof s.count === "number" ? (
            <span className="tabular-nums opacity-80">{s.count}</span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}

export function CollapsibleSection({
  storageKey,
  id,
  title,
  subtitle,
  aside,
  children,
  defaultCollapsed = false,
}: {
  /** 같은 화면의 구획들이 공유하는 저장 키. */
  storageKey: string;
  id: string;
  title: string;
  subtitle?: string;
  /** 제목 줄 오른쪽에 놓을 요소 (건수 배지·부가 버튼). */
  aside?: React.ReactNode;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}) {
  const { isCollapsed, toggle } = useCollapsedSections(storageKey, defaultCollapsed ? [id] : []);
  const collapsed = isCollapsed(id);

  return (
    <section id={id} className="scroll-mt-[var(--sticky-top)] space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggle(id)}
          aria-expanded={!collapsed}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-base font-semibold">{title}</span>
            {subtitle ? (
              <span className="block text-xs text-muted-foreground">{subtitle}</span>
            ) : null}
          </span>
        </button>
        {aside}
      </div>
      {collapsed ? null : children}
    </section>
  );
}
