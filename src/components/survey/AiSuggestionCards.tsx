// 응답자에게 노출되는 AI 제안 검토 카드. 순수 컴포넌트 — 저장은 호출자가 담당한다.
//
// 알림 규격은 SignalCard 하나로 통일한다 (기획 H3 · P7): 무엇을 왜 바꾸자는 것인지 한 문장,
// 그렇게 판단한 근거, 그리고 지금 누를 수 있는 행동 셋(수락·수정·거절). 확인할 제안이
// 없으면 빈 안내를 띄우지 않고 아무것도 렌더하지 않는다 — 할 일이 없으면 화면을 차지하지 않는다.
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

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SignalCard, type SignalAction } from "@/components/SignalCard";
import { focusLabel } from "@/lib/survey.focus";

export type SuggestionDecision = "수락" | "수정" | "거절";

export type AiSuggestionItem = {
  id: string;
  target: string;
  original_value: string | null;
  suggested_value: string;
  kind: string;
  status: string;
  created_at: string;
};

const TABLE_LABELS: Record<string, string> = {
  responses: "직무 기본정보",
  response_tasks: "과업",
  response_activities: "세부 활동",
  response_skills: "필요 역량",
  response_requirements: "자격요건",
};

/** 필드 라벨 — 딥링크 규약(survey.focus)과 겹치는 키는 거기서 가져오고 나머지만 여기 둔다. */
const FIELD_LABELS: Record<string, string> = {
  name: "명칭",
  improve_note: "개선 의견",
  description: "설명",
  majors_required: "필수 전공",
  majors_preferred: "우대 전공",
  trainings: "필요 교육·훈련",
  proficiency: "숙련 수준",
};

/** 제안 유형별로 "왜 바꾸자는 것인지" 한 문장. */
const KIND_REASON: Record<string, string> = {
  오타: "표현을 다듬자는 제안입니다",
  자동채움: "비어 있던 내용을 채우자는 제안입니다",
};

const reason = (kind: string) => KIND_REASON[kind] ?? "내용을 바꾸자는 제안입니다";

/** "테이블:id:필드" 를 사람이 읽는 라벨로 바꾼다. */
export function targetLabel(target: string) {
  const [table, id, field] = target.split(":");
  const tableLabel = TABLE_LABELS[table ?? ""] ?? table ?? target;
  if (id === "new") return `${tableLabel} 신규 추가`;
  if (!field) return tableLabel;
  return `${tableLabel} · ${FIELD_LABELS[field] ?? focusLabel(field)}`;
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
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-4">
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} onDecide={onDecide} />
      ))}
    </div>
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

  const hasOriginal = Boolean(s.original_value?.trim());
  // 근거 = 지금 값과 제안 값의 대조. 무엇이 어떻게 바뀌는지가 판단의 전부다.
  const evidence = [
    `지금 내용 — ${hasOriginal ? s.original_value?.trim() : "비어 있습니다"}`,
    `제안 내용 — ${readableValue(s.target, s.suggested_value)}`,
    "관리자가 확인을 요청한 제안입니다. 수락하면 내 응답에 바로 반영됩니다.",
  ];

  // 행동은 셋 — 그대로 받기 / 고쳐서 받기 / 받지 않기. 입력이 필요한 두 갈래는
  // 확정 버튼을 입력칸 바로 아래에 두어 무엇을 확정하는지 헷갈리지 않게 한다.
  const actions: SignalAction[] =
    decided || mode !== "idle" || busy
      ? []
      : [
          { label: "수락", onClick: () => void run("수락") },
          { label: "직접 고쳐서 반영", onClick: () => setMode("edit"), variant: "outline" },
          { label: "거절", onClick: () => setMode("reject"), variant: "ghost" },
        ];

  return (
    <SignalCard
      signal={`${targetLabel(s.target)} — ${reason(s.kind)}`}
      evidence={evidence}
      asOf={new Date(s.created_at).toLocaleDateString("ko-KR")}
      actions={actions}
    >
      {mode === "edit" && (
        <div className="space-y-2 border-t px-4 py-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={`edit-${s.id}`}>
            직접 고친 내용
          </label>
          <Textarea
            id={`edit-${s.id}`}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={3}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              disabled={busy || !edited.trim()}
              onClick={() => void run("수정", edited.trim())}
            >
              고친 내용으로 확정
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
              취소
            </Button>
          </div>
        </div>
      )}

      {mode === "reject" && (
        <div className="space-y-2 border-t px-4 py-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={`note-${s.id}`}>
            거절 사유 — 관리자에게 전달됩니다
          </label>
          <Textarea
            id={`note-${s.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="예: 실제 업무에서는 이 표현을 그대로 사용합니다."
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !note.trim()}
              onClick={() => void run("거절")}
            >
              거절 확정
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
              취소
            </Button>
          </div>
        </div>
      )}

      {decided && (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          이미 {s.status} 처리한 제안입니다.
        </p>
      )}
    </SignalCard>
  );
}
