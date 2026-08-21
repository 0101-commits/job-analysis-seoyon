import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { useCompanyScope } from "@/components/CompanyContext";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { supabase } from "@/integrations/supabase/client";
import {
  closeWave,
  createWave,
  listWaves,
  updateWave,
  waveStats,
  type Wave,
} from "@/lib/wave.functions";

/**
 * 차수 관리 화면 (기획 F8).
 *
 * 계열사별 마감이 하나뿐이면 보완 조사·신규 입사자 조사를 할 때마다 마감을 다시 열어야 했고,
 * 그러면 1차 집계가 흔들렸다. 여기서 계열사마다 여러 차수를 만들고, 배정·제출 현황을 따로 본다.
 *
 * 대상 지정(누구를 이 차수에 넣을지)은 이 화면이 하지 않는다 — 참여자 명부 화면에서
 * 일괄로 고르는 것이 이미 있는 방식이라, 「대상 지정」 버튼은 그 화면으로 딥링크만 한다
 * (?assignWave=<차수 id>, 참여자 명부 담당이 받아 처리).
 */

export const Route = createFileRoute("/_authenticated/admin/waves")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
  head: () => ({
    meta: [
      { title: "차수 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "계열사별 조사 차수를 만들고 마감·배정 현황을 관리합니다." },
      { property: "og:title", content: "차수 관리 | 서연 그룹 업무조사" },
      {
        property: "og:description",
        content: "계열사별 조사 차수를 만들고 마감·배정 현황을 관리합니다.",
      },
    ],
  }),
  component: WavesPage,
});

const KINDS = ["1차", "보완", "신규입사"] as const;
type Kind = (typeof KINDS)[number];

const KIND_HINT: Record<Kind, string> = {
  "1차": "전 인원 대상 최초 조사입니다. 계열사마다 하나만 두는 것을 권장합니다.",
  보완: "미응답자·조직 변경자 등 일부만 다시 받는 조사입니다.",
  신규입사: "1차 이후 입사한 인원만 받는 조사입니다.",
};

type Draft = { name: string; kind: Kind; deadline: string; reminderDays: string; note: string };

const EMPTY_DRAFT: Draft = {
  name: "",
  kind: "보완",
  deadline: "",
  reminderDays: "7, 3, 1",
  note: "",
};

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.";
}

/** 「7, 3, 1」·「D-7 D-3」처럼 섞어 써도 받는다. settings.tsx 의 같은 규칙과 맞춘다. */
function parseReminderDays(text: string) {
  const days = text
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v.replace(/^D-/i, "")));
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 60)) return null;
  return days;
}

function formatDate(value: string | null) {
  if (!value) return "미설정";
  return new Date(`${value}T00:00:00`).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 참여자 명부 화면의 배정 대상 고르기를 이 차수로 열게 하는 딥링크. */
function assignLink(waveId: string) {
  return `/admin/participants?assignWave=${waveId}`;
}

function WavesPage() {
  const { companyId, setCompanyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Wave | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const scoped = companyId !== "all";

  const { data: companies } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

  const {
    data: waves,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["survey-waves", companyId],
    queryFn: async () => listWaves({ data: { companyId }, headers: await authHeaders() }),
    enabled: scoped,
  });

  const { data: stats } = useQuery({
    queryKey: ["survey-wave-stats", companyId],
    queryFn: async () => waveStats({ data: { companyId }, headers: await authHeaders() }),
    enabled: scoped,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["survey-waves", companyId] });
    void queryClient.invalidateQueries({ queryKey: ["survey-wave-stats", companyId] });
  }

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  }
  function openEdit(w: Wave) {
    setEditing(w);
    setDraft({
      name: w.name,
      kind: w.kind as Kind,
      deadline: w.deadline ?? "",
      reminderDays: w.reminderDays.join(", "),
      note: w.note ?? "",
    });
    setDialogOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const days = parseReminderDays(draft.reminderDays);
      if (days === null) {
        throw new Error("독려 안내 일자는 0~60 사이 숫자를 쉼표로 구분해 입력해 주세요.");
      }
      if (!draft.name.trim()) throw new Error("차수 이름을 입력해 주세요.");
      const headers = await authHeaders();
      if (editing) {
        return updateWave({
          data: {
            id: editing.id,
            name: draft.name.trim(),
            kind: draft.kind,
            deadline: draft.deadline || null,
            reminderDays: days,
            note: draft.note.trim() || null,
          },
          headers,
        });
      }
      return createWave({
        data: {
          companyId,
          name: draft.name.trim(),
          kind: draft.kind,
          deadline: draft.deadline || null,
          reminderDays: days,
        },
        headers,
      });
    },
    onSuccess: () => {
      toast.success(editing ? "차수를 수정했습니다." : "차수를 만들었습니다.");
      setDialogOpen(false);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const closeMutation = useMutation({
    mutationFn: async (id: string) => closeWave({ data: { id }, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("차수를 마감했습니다.");
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const rows = waves ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">차수 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            보완 조사·신규 입사자 조사를 마감이 끝난 1차 집계와 섞이지 않게 나눠 관리합니다.
          </p>
        </div>
        {scoped ? (
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 size-4" /> 새 차수
          </Button>
        ) : null}
      </div>

      {!scoped ? (
        <EmptyState
          kind="blocked"
          title="계열사를 선택하세요"
          description="차수는 계열사마다 따로 관리합니다. 위 상단에서 계열사를 선택한 뒤 다시 열어 주세요."
        >
          <div className="flex flex-wrap justify-center gap-2">
            {companies?.map((c) => (
              <Button key={c.id} size="sm" variant="outline" onClick={() => setCompanyId(c.id)}>
                {c.name}
              </Button>
            ))}
          </div>
        </EmptyState>
      ) : error ? (
        <EmptyState
          kind="blocked"
          title="차수를 불러오지 못했습니다"
          description={errorMessage(error)}
          actionLabel="다시 시도"
          onAction={() => void refetch()}
        />
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : rows.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="아직 차수가 없습니다"
          description="구조 변경을 적용하면 계열사마다 '1차 조사' 차수가 자동으로 만들어집니다. 그 뒤에 보완·신규입사 차수를 추가하세요."
        />
      ) : (
        <div className="space-y-3">
          {stats ? (
            <p className="text-xs text-muted-foreground">
              총 {stats.total}개 차수 · 준비 {stats.preparing} · 진행 {stats.active} · 마감{" "}
              {stats.closed}
              {stats.nextDeadline ? ` · 다음 마감 ${formatDate(stats.nextDeadline)}` : ""}
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-xl border bg-card">
            <div className="min-w-[820px]">
              <div className="grid grid-cols-[52px_minmax(160px,1fr)_88px_120px_72px_80px_80px_220px] gap-2 border-b bg-secondary px-4 py-2.5 text-xs font-medium text-muted-foreground">
                <span>차수</span>
                <span>이름</span>
                <span>종류</span>
                <span>마감</span>
                <span>상태</span>
                <span className="text-right">배정</span>
                <span className="text-right">제출</span>
                <span className="text-right">작업</span>
              </div>
              {rows.map((w) => (
                <div
                  key={w.id}
                  className="grid grid-cols-[52px_minmax(160px,1fr)_88px_120px_72px_80px_80px_220px] items-center gap-2 border-b px-4 py-3 text-sm last:border-b-0"
                >
                  <span className="tabular-nums text-muted-foreground">{w.seq}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{w.name}</span>
                    {w.note ? (
                      <span className="block truncate text-xs text-muted-foreground">{w.note}</span>
                    ) : null}
                  </span>
                  <span>{w.kind}</span>
                  <span>{formatDate(w.deadline)}</span>
                  <span
                    className={
                      w.status === "마감"
                        ? "text-muted-foreground"
                        : w.status === "진행"
                          ? "font-medium text-primary"
                          : ""
                    }
                  >
                    {w.status}
                  </span>
                  <span className="text-right tabular-nums">{w.assignedCount}</span>
                  <span className="text-right tabular-nums">{w.submittedCount}</span>
                  <span className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" asChild>
                      <a href={assignLink(w.id)}>대상 지정</a>
                    </Button>
                    {w.status !== "마감" ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(w)}>
                          수정
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `「${w.name}」 차수를 마감할까요? 마감하면 이 차수의 응답은 다른 차수로 옮길 수 없습니다.`,
                              )
                            ) {
                              closeMutation.mutate(w.id);
                            }
                          }}
                        >
                          <Lock className="mr-1 size-3.5" /> 마감
                        </Button>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "차수 수정" : "새 차수 만들기"}</DialogTitle>
            <DialogDescription>
              대상 지정은 여기서 하지 않습니다. 저장한 뒤 「대상 지정」을 눌러 참여자 관리 화면에서
              일괄로 고르세요.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wave-name">이름</Label>
              <Input
                id="wave-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="예: 2차 보완 조사"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wave-kind">종류</Label>
              <Select
                value={draft.kind}
                onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as Kind }))}
              >
                <SelectTrigger id="wave-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{KIND_HINT[draft.kind]}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wave-deadline">제출 마감</Label>
              <Input
                id="wave-deadline"
                type="date"
                value={draft.deadline}
                onChange={(e) => setDraft((d) => ({ ...d, deadline: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wave-reminder">독려 안내 일자 (D-N, 쉼표로 구분)</Label>
              <Input
                id="wave-reminder"
                value={draft.reminderDays}
                onChange={(e) => setDraft((d) => ({ ...d, reminderDays: e.target.value }))}
                placeholder="7, 3, 1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wave-note">메모 (선택)</Label>
              <Textarea
                id="wave-note"
                value={draft.note}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                maxLength={300}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              취소
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
