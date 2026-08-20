import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 사용자가 만든 화면 상태를 기억한다 (기획 A4·D6).
 *
 * 접은 섹션·목록 밀도처럼 "다시 왔을 때 그대로여야 하는" 값만 저장한다.
 * 서버에 둘 성격이 아니고, 브라우저가 지워져도 기본값으로 돌아가면 되는 값들이다.
 */

const PREFIX = "jd-ui:";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 같은 키를 보는 다른 화면들에 값이 바뀌었음을 알린다.
 *
 * localStorage 의 `storage` 이벤트는 **다른 탭**에서만 발생하므로, 한 화면에서 고른 소속이
 * 같은 탭의 헤더나 옆 목록에 반영되지 않는다. 선택한 소속은 화면을 옮겨도 이어지는 하나의
 * 렌즈여야 하므로(기획 B4), 쓰기 시점에 같은 키를 구독하는 곳들을 직접 깨운다.
 */
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, fn: () => void) {
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 저장 실패는 화면 동작을 막지 않는다.
  }
  listeners.get(key)?.forEach((fn) => fn());
}

/**
 * localStorage 에 붙은 useState. SSR 에서는 기본값으로 렌더하고 마운트 후 복원한다.
 * 같은 키를 쓰는 다른 컴포넌트가 값을 바꾸면 이쪽도 함께 갱신된다.
 */
export function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [restored, setRestored] = useState(false);
  // initial 은 첫 복원에만 쓴다. 렌더마다 새 객체가 와도 구독을 다시 걸지 않기 위해 담아 둔다.
  const initialRef = useRef(initial);

  useEffect(() => {
    setValue(read(key, initialRef.current));
    setRestored(true);
    return subscribe(key, () => setValue(read(key, initialRef.current)));
  }, [key]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        write(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, update, restored] as const;
}

/**
 * 접기 가능한 섹션들의 상태.
 * `defaultOpen` 에 없는 섹션은 펼쳐진 것으로 본다 — 처음 보는 사용자가 내용을 놓치지 않게.
 */
export function useCollapsedSections(key: string, defaultCollapsed: string[] = []) {
  const [collapsed, setCollapsed] = usePersistedState<string[]>(
    `collapsed:${key}`,
    defaultCollapsed,
  );

  const isCollapsed = useCallback((id: string) => collapsed.includes(id), [collapsed]);

  const toggle = useCallback(
    (id: string) =>
      setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [setCollapsed],
  );

  return { isCollapsed, toggle };
}

export type Density = "comfortable" | "compact";

/** 목록 밀도. 500행을 훑을 때와 한 건을 읽을 때 필요한 행 높이가 다르다. */
export function useDensity(key: string) {
  const [density, setDensity] = usePersistedState<Density>(`density:${key}`, "comfortable");
  const rowClass = density === "compact" ? "py-1.5 text-[13px]" : "py-3 text-sm";
  return { density, setDensity, rowClass };
}
