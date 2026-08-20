import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePersistedState } from "@/hooks/use-persisted-ui";

/**
 * 조사 차수 선택 (기획 F8).
 *
 * 소속 렌즈(useOrgLens)와 같은 방식 — 고른 차수는 진행 현황 화면을 옮겨도 이어지는
 * 하나의 필터다. 데이터는 화면이 넘기고, 이 컴포넌트는 고르는 일만 한다.
 */

export type WaveOption = { id: string; name: string; status: string };

export function useWaveLens() {
  const [selected, setSelected] = usePersistedState<string | null>("wave-lens", null);
  return { selectedWaveId: selected, setSelectedWaveId: setSelected };
}

export function WaveFilter({
  waves,
  selectedId,
  onSelect,
}: {
  waves: WaveOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (waves.length === 0) return null;
  return (
    <Select value={selectedId ?? "all"} onValueChange={(v) => onSelect(v === "all" ? null : v)}>
      <SelectTrigger className="w-[190px]" aria-label="조사 차수 선택">
        <SelectValue placeholder="전체 차수" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">전체 차수</SelectItem>
        {waves.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
            {w.status === "마감" ? " (마감)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
