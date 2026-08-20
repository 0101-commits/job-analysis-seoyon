// 응답자에게 노출되는 AI 제안 검토 카드. 순수 컴포넌트 — 저장은 호출자가 담당한다.
//
// 응답자의 직접 UPDATE 는 RLS 로 막혀 있다. 결정은 서버 함수 decideMySuggestion 이 처리하며,
// 소유 검증 → 수락·수정이면 실제 응답 레코드에 반영 → status='확정' 까지 한 번에 간다
// ('수정' 시 AI 원문은 ai_suggested_value 로 보존). 거절은 값을 건드리지 않는다. 호출자 예시:
//
//   async function handleDecide(id, decision, note, editedValue) {
//     await decideMySuggestion({ data: { suggestionId: id, decision, note, editedValue } });
//   }
//
// 관리자 직접 반영 경로(route A, status='제안')는 applySuggestion 이 같은 반영 로직을 쓴다.
import { useState } from "react";
import { Check, Pencil, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type SuggestionDecision = "수락" | "수정" | "거절";

export type AiSuggestionItem = {
  id: string;
  target: string;
  original_value: string | null;
  suggested_value: string;
  kind: string;
  status: string;
};

const TABLE_LABELS: Record<string, string> = {
  responses: "직무 기본정보",
  response_tasks: "과업",
  response_activities: "활동",
  response_skills: "스킬",
  response_requirements: "자격요건",
};

const FIELD_LABELS: Record<string, string> = {
  job_name: "직무명",
  job_group: "직군",
  job_series: "직렬",
  definition: "직무 정의",
  mission: "직무 미션",
  missed_note: "누락 업무 메모",
  pain_note: "애로사항",
  name: "명칭",
  improve_note: "개선 의견",
  description: "설명",
  majors_required: "필수 전공",
  majors_preferred: "우대 전공",
  trainings: "필요 교육·훈련",
  proficiency: "숙련 수준",
};

/** "테이블:id:필드" 를 사람이 읽는 라벨로 바꾼다. */
export function targetLabel(target: string) {
  const [table, id, field] = target.split(":");
  const tableLabel = TABLE_LABELS[table ?? ""] ?? table ?? target;
  if (id === "new") return `${tableLabel} 신규 추가`;
  return field ? `${tableLabel} · ${FIELD_LABELS[field] ?? field}` : tableLabel;
}

/** 신규 스킬 초안은 JSON 으로 저장되므로 읽기 좋게 편다. */
export function readableValue(target: string, value: string) {
  if (!target.endsWith(":new")) return value;
  try {
    const d = JSON.parse(value) as {
      name?: string;
      ksao?: string | null;
      hard_soft?: string | null;
      description?: string | null;
    };
    return [d.name, [d.ksao, d.hard_soft].filter(Boolean).join("/"), d.description]
      .filter(Boolean)
      .join(" · ");
  } catch {
    return value;
  }
}

export function AiSuggestionCards({
  suggestions,
  onDecide,
}: {
  suggestions: AiSuggestionItem[];
  onDecide: (
    id: string,
    decision: SuggestionDecision,
    note?: string,
    editedValue?: string,
  ) => void | Promise<void>;
}) {
  if (suggestions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
        확인이 필요한 AI 제안이 없습니다.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} onDecide={onDecide} />
      ))}
    </ul>
  );
}

function SuggestionCard({
  suggestion: s,
  onDecide,
}: {
  suggestion: AiSuggestionItem;
  onDecide: (
    id: string,
    decision: SuggestionDecision,
    note?: string,
    editedValue?: string,
  ) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle");
  const [edited, setEdited] = useState(() => readableValue(s.target, s.suggested_value));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decided = s.status !== "요청중";

  async function run(decision: SuggestionDecision, editedValue?: string) {
    setBusy(true);
    try {
      await onDecide(s.id, decision, note.trim() || undefined, editedValue);
      setMode("idle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">{targetLabel(s.target)}</span>
        <Badge variant="secondary">{s.kind}</Badge>
        {decided && <Badge variant="outline">{s.status}</Badge>}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-secondary p-3">
          <p className="text-xs font-medium text-muted-foreground">현재 내용</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {s.original_value?.trim() ? s.original_value : "— (비어 있음)"}
          </p>
        </div>
        <div className="rounded-lg border border-primary/30 bg-primary-soft/40 p-3">
          <p className="text-xs font-medium text-primary">AI 제안</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {readableValue(s.target, s.suggested_value)}
          </p>
        </div>
      </div>

      {mode === "edit" && (
        <div className="mt-3 space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={`edit-${s.id}`}>
            직접 수정한 내용
          </label>
          <Textarea
            id={`edit-${s.id}`}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={3}
          />
        </div>
      )}

      {mode === "reject" && (
        <div className="mt-3 space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={`note-${s.id}`}>
            거절 사유
          </label>
          <Textarea
            id={`note-${s.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="예: 실제 업무에서는 이 표현을 그대로 사용합니다."
          />
        </div>
      )}

      {!decided && (
        <div className="mt-3 flex flex-wrap gap-2">
          {mode === "idle" && (
            <>
              <Button size="sm" disabled={busy} onClick={() => run("수락")}>
                <Check className="size-4" />
                수락
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("edit")}>
                <Pencil className="size-4" />
                수정
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("reject")}>
                <X className="size-4" />
                거절
              </Button>
            </>
          )}
          {mode === "edit" && (
            <>
              <Button
                size="sm"
                disabled={busy || !edited.trim()}
                onClick={() => run("수정", edited.trim())}
              >
                수정 내용으로 확정
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
                취소
              </Button>
            </>
          )}
          {mode === "reject" && (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || !note.trim()}
                onClick={() => run("거절")}
              >
                거절 확정
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
                취소
              </Button>
            </>
          )}
        </div>
      )}

      {decided && s.status === "거절" && (
        <p className="mt-3 text-xs text-muted-foreground">거절 처리된 제안입니다.</p>
      )}
    </li>
  );
}
