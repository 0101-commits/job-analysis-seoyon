import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RosterDiffItem, RosterDiffKind, RosterDiffResult } from "@/lib/roster";

/** 퇴사 후보를 어떻게 처리할지. 기본은 보관 — 응답을 남기고 로그인만 막는다. */
export type LeaverAction = "보관" | "삭제";

/**
 * 명부 대조 결과 (기획 F9).
 *
 * 관리자가 반영 전에 「무엇이 달라졌는지」를 분류별로 보고, 분류째 또는 한 명씩 골라 반영한다.
 * 화면에 나오는 순서는 손이 많이 가는 것부터가 아니라, 사람이 확인하는 순서(들어온 사람 →
 * 자리가 바뀐 사람 → 나간 사람)로 둔다.
 */
const KIND_ORDER: RosterDiffKind[] = ["신규", "조직이동", "직무변경", "기타변경", "퇴사후보"];

const KIND_HELP: Record<string, string> = {
  신규: "명부에는 있고 시스템에는 없는 사람입니다. 반영하면 명단에 추가됩니다.",
  조직이동:
    "소속이 달라졌습니다. 반영하면 소속을 다시 배정하고, 이미 작성한 응답에 재확인 표시를 남깁니다.",
  직무변경:
    "역할단계가 달라졌습니다. 반영하면 값을 갱신하고, 이미 작성한 응답에 재확인 표시를 남깁니다.",
  기타변경: "성명·이메일·생년월일·직급이 달라졌습니다. 반영하면 그 값만 갱신합니다.",
  퇴사후보:
    "시스템에는 있고 새 명부에는 없는 사람입니다. 보관 처리해도 이미 작성한 응답은 지우지 않습니다.",
};

/** 한 분류에서 화면에 그리는 항목 수 상한. 그 이상은 사람이 눈으로 확인하지 못한다. */
const SHOW_LIMIT = 200;

function ItemRow({
  item,
  checked,
  onToggle,
}: {
  item: RosterDiffItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-start gap-2.5 border-t px-3 py-2 first:border-t-0">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`${item.name} 반영 대상 선택`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {item.name}
          <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
            {item.emp_no}
          </span>
          {item.archived && (
            <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-normal">
              보관된 사람
            </span>
          )}
        </p>
        {item.changes.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {item.changes.map((c) => (
              <li key={c.field}>
                {c.label}: <span className="line-through">{c.before || "비어 있음"}</span>{" "}
                <span className="font-medium text-foreground">→ {c.after || "비어 있음"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function RosterDiffPanel({
  diff,
  selected,
  leaverAction,
  onToggle,
  onToggleKind,
  onLeaverAction,
}: {
  diff: RosterDiffResult;
  selected: Set<string>;
  leaverAction: LeaverAction;
  onToggle: (key: string) => void;
  onToggleKind: (kind: RosterDiffKind, on: boolean) => void;
  onLeaverAction: (action: LeaverAction) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-3">
      <p className="rounded-xl border bg-secondary/40 p-3 text-xs text-muted-foreground">
        새 명부를 기존 명단과 대조한 결과입니다. 아직 아무것도 바뀌지 않았습니다. 반영할 항목을 고른
        뒤 아래 [반영] 버튼을 누르세요. 달라진 것이 없는 사람{" "}
        <strong>{diff.summary["변경없음"]}명</strong>은 목록에 넣지 않았습니다.
      </p>

      {KIND_ORDER.map((kind) => {
        const items = diff.items.filter((i) => i.kind === kind);
        if (items.length === 0) return null;
        const chosen = items.filter((i) => selected.has(i.key)).length;
        const expanded = open[kind] ?? kind !== "기타변경";
        return (
          <div key={kind} className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <Checkbox
                checked={chosen === items.length}
                onCheckedChange={(v) => onToggleKind(kind, v === true)}
                aria-label={`${kind} ${items.length}건 전체 선택`}
              />
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-semibold"
                onClick={() => setOpen((prev) => ({ ...prev, [kind]: !expanded }))}
                aria-expanded={expanded}
              >
                {expanded ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
                {kind === "퇴사후보" ? "명부에서 빠진 사람" : kind}
                <span className="tabular-nums text-muted-foreground">{items.length}명</span>
              </button>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                선택 {chosen}명
              </span>
              {kind === "퇴사후보" && (
                <Select
                  value={leaverAction}
                  onValueChange={(v) => onLeaverAction(v as LeaverAction)}
                >
                  <SelectTrigger
                    className="h-8 w-[210px]"
                    aria-label="명부에서 빠진 사람 처리 방법"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="보관">보관 처리 (응답 보존)</SelectItem>
                    <SelectItem value="삭제">명부 오등록 삭제 (응답 없는 사람만)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <p className="px-3 pb-3 text-xs text-muted-foreground">{KIND_HELP[kind]}</p>
            {expanded && (
              <>
                <ul className="max-h-72 overflow-y-auto border-t">
                  {items.slice(0, SHOW_LIMIT).map((item) => (
                    <ItemRow
                      key={item.key}
                      item={item}
                      checked={selected.has(item.key)}
                      onToggle={() => onToggle(item.key)}
                    />
                  ))}
                </ul>
                {items.length > SHOW_LIMIT && (
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    외 {items.length - SHOW_LIMIT}명은 목록에 표시하지 않았습니다. 분류 전체 선택은
                    표시하지 않은 사람까지 함께 고릅니다.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
