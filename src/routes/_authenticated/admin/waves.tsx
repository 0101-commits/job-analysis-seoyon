import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Lock, Plus, RotateCw } from "lucide-react";
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
import { MailBatchHistory, MailSendPanel } from "@/components/admin/MailSendPanel";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { listActiveCompanies } from "@/lib/companies";
import { supabase } from "@/integrations/supabase/client";
import { triggerReminders } from "@/lib/admin.functions";
import {
  closeWave,
  createWave,
  listWaves,
  updateWave,
  waveStats,
  type Wave,
} from "@/lib/wave.functions";

/**
 * 차수 관리 화면 (기획 F8 · v4 구획 A4: 차수 운영 허브).
 *
 * 계열사별 마감이 하나뿐이면 보완 조사·신규 입사자 조사를 할 때마다 마감을 다시 열어야 했고,
 * 그러면 1차 집계가 흔들렸다. 여기서 계열사마다 여러 차수를 만들고, 배정·제출 현황을 따로 본다.
 *
 * v4부터 이 화면이 차수 운영의 허브다 — 목록(훑기)에서 행을 누르면 상세(단일 열)로 바뀌고,
 * 상세에서 대상 확인 → 발송 → 이력 → 마감·독려까지 한 흐름으로 처리한다. 발송·이력 부품은
 * 메일 화면과 공유한다(MailSendPanel · MailBatchHistory).
 *
 * 대상 지정(누구를 이 차수에 넣을지)은 이 화면이 하지 않는다 — 참여자 명부 화면에서
 * 일괄로 고르는 것이 이미 있는 방식이라, 「대상 지정」 버튼은 그 화면으로 딥링크만 한다
 * (?assignWave=<차수 id>, 참여자 명부 담당이 받아 처리).
 */

type WavesSearch = LensSearch & {
  /** 상세로 열어 둘 차수 id. 발송 이력의 차수 칩 등 다른 화면에서 딥링크로 들어온다. */
  wave?: string;
};

export const Route = createFileRoute("/_authenticated/admin/waves")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): WavesSearch => {
    const out: WavesSearch = { ...pickLens(search) };
    const wave = search["wave"];
    if (typeof wave === "string" && wave.trim()) out.wave = wave.trim();
    return out;
  },
  head: () => ({
    meta: [
      { title: "차수 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "계열사별 조사 차수를 만들고 대상·발송·마감을 관리합니다." },
      { property: "og:title", content: "차수 관리 | 서연 그룹 업무조사" },
      {
        property: "og:description",
        content: "계열사별 조사 차수를 만들고 대상·발송·마감을 관리합니다.",
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

function origin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
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

function formatDateTime(value: string | null) {
  if (!value) return null;
  return value.slice(0, 16).replace("T", " ");
}

/** 오늘(한국 시간) 기준 마감까지 남은 일수 표기. 마감이 없으면 null. */
function ddayLabel(deadline: string | null) {
  if (!deadline) return null;
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const today = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
  const diff = Math.round(
    (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (diff > 0) return `D-${diff}`;
  if (diff === 0) return "오늘 마감";
  return `${-diff}일 지남`;
}

/** 참여자 명부 화면의 배정 대상 고르기를 이 차수로 열게 하는 딥링크. */
function assignLink(waveId: string) {
  return `/admin/participants?assignWave=${waveId}`;
}

function WavesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { companyId, setCompanyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Wave | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const scoped = companyId !== "all";

  const { data: companies } = useQuery({
    queryKey: ["companies-active"],
    queryFn: () => listActiveCompanies(),
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

  /** 목록 ↔ 상세 전환. 상세는 ?wave= 로 남겨 새로고침·딥링크에도 같은 화면이 나온다. */
  function openDetail(id: string | null) {
    void navigate({
      search: (prev: WavesSearch) => {
        const next = { ...prev };
        if (id) next.wave = id;
        else delete next.wave;
        return next;
      },
    });
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
  const selected = scoped && search.wave ? (rows.find((w) => w.id === search.wave) ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">차수 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            차수를 골라 대상 확인 → 발송 → 이력 → 마감·독려를 한 흐름으로 처리합니다.
          </p>
        </div>
        {scoped && !selected ? (
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
      ) : selected ? (
        <WaveDetail
          key={selected.id}
          wave={selected}
          companyId={companyId}
          onBack={() => openDetail(null)}
          onEdit={() => openEdit(selected)}
          onClose={() => {
            if (
              window.confirm(
                `「${selected.name}」 차수를 마감할까요? 마감하면 이 차수의 응답은 다른 차수로 옮길 수 없습니다.`,
              )
            ) {
              closeMutation.mutate(selected.id);
            }
          }}
          onSaved={invalidate}
        />
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
            <div className="min-w-[880px]">
              <div className="grid grid-cols-[52px_minmax(160px,1fr)_88px_150px_72px_150px_140px] gap-2 border-b bg-secondary px-4 py-2.5 text-xs font-medium text-muted-foreground">
                <span>차수</span>
                <span>이름</span>
                <span>종류</span>
                <span>마감</span>
                <span>상태</span>
                <span>배정 → 제출</span>
                <span>최근 발송</span>
              </div>
              {rows.map((w) => {
                const dday = ddayLabel(w.deadline);
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => openDetail(w.id)}
                    className="grid w-full grid-cols-[52px_minmax(160px,1fr)_88px_150px_72px_150px_140px] items-center gap-2 border-b px-4 py-3 text-left text-sm last:border-b-0 hover:bg-secondary/40"
                  >
                    <span className="tabular-nums text-muted-foreground">{w.seq}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{w.name}</span>
                      {w.note ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {w.note}
                        </span>
                      ) : null}
                    </span>
                    <span>{w.kind}</span>
                    <span>
                      {formatDate(w.deadline)}
                      {dday && w.status !== "마감" ? (
                        <span className="ml-1.5 text-xs font-semibold text-primary">{dday}</span>
                      ) : null}
                    </span>
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
                    {/* 배정 대비 제출을 숫자+막대로 훑는다. 눌러 들어가면 상태 분포가 나온다. */}
                    <span className="pr-2">
                      <span className="text-xs tabular-nums">
                        배정 {w.assignedCount} / 제출 {w.submittedCount}
                      </span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-secondary">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{
                            width: `${
                              w.assignedCount > 0
                                ? Math.round((w.submittedCount / w.assignedCount) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(w.lastSentAt) ?? "발송 없음"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            행을 누르면 그 차수의 대상·발송·이력·마감을 한 화면에서 처리합니다.
          </p>
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

/**
 * 차수 상세 — 단일 열, 목록은 화면에서 빠진다 (기획 10+14).
 * key={wave.id} 로 마운트되므로 차수를 옮기면 입력 초안이 새로 시작된다.
 */
function WaveDetail({
  wave,
  companyId,
  onBack,
  onEdit,
  onClose,
  onSaved,
}: {
  wave: Wave;
  companyId: string;
  onBack: () => void;
  onEdit: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const closed = wave.status === "마감";
  const [deadline, setDeadline] = useState(wave.deadline ?? "");
  const [reminderText, setReminderText] = useState(wave.reminderDays.join(", "));

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      const days = parseReminderDays(reminderText);
      if (days === null) {
        throw new Error("독려 안내 일자는 0~60 사이 숫자를 쉼표로 구분해 입력해 주세요.");
      }
      return updateWave({
        data: { id: wave.id, deadline: deadline || null, reminderDays: days },
        headers: await authHeaders(),
      });
    },
    onSuccess: () => {
      toast.success("마감·독려 일정을 저장했습니다.");
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const reminderMutation = useMutation({
    mutationFn: () => triggerReminders({ data: { companyId, origin: origin() } }),
    onSuccess: (result) => {
      const sent = result.results.reduce((acc, r) => acc + r.sent, 0);
      toast.success(`독려 안내 ${sent}건을 처리했습니다.`);
    },
    onError: (err) => toast.error(`독려 안내 발송에 실패했습니다: ${errorMessage(err)}`),
  });

  const dday = ddayLabel(wave.deadline);
  const statusLine = Object.entries(wave.statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1 size-4" /> 목록
          </Button>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">
              {wave.seq}차 · {wave.name}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{wave.kind}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {wave.status}
              {wave.deadline ? ` · 마감 ${formatDate(wave.deadline)}` : " · 마감 미설정"}
              {dday && !closed ? ` (${dday})` : ""}
              {wave.note ? ` · ${wave.note}` : ""}
            </p>
          </div>
        </div>
        {!closed && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              수정
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              <Lock className="mr-1 size-3.5" /> 마감
            </Button>
          </div>
        )}
      </div>

      {/* ① 대상 */}
      <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">대상</h2>
            <p className="mt-1 text-sm">
              배정 <span className="font-bold">{wave.assignedCount}</span>명 · 제출{" "}
              <span className="font-bold">{wave.submittedCount}</span>명
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {statusLine || "아직 이 차수에 배정된 참여자가 없습니다."}
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <a href={assignLink(wave.id)}>대상 지정</a>
          </Button>
        </div>
      </section>

      {/* ② 발송 — 대상은 이 차수 배정자로 고정된다(소속 트리 없음). */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">발송</h2>
        {closed ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-sm">
            마감된 차수입니다. 새 안내가 필요하면 보완 차수를 만들어 보내세요.
          </p>
        ) : (
          <MailSendPanel waveId={wave.id} companyId={companyId} />
        )}
      </section>

      {/* ③ 이력 — 이 차수로 나간 발송만. 실패 재발송·예약 취소 포함(메일 화면과 같은 부품). */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">발송 이력</h2>
        <MailBatchHistory waveId={wave.id} />
      </section>

      {/* ④ 마감·독려 */}
      <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">마감 · 독려</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          이 차수의 일정이 계열사 기본값보다 우선합니다. 독려 안내 일자를 비우면 계열사 설정을
          따릅니다.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="detail-deadline">제출 마감</Label>
            <Input
              id="detail-deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              disabled={closed}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detail-reminder">독려 안내 일자 (D-N, 쉼표로 구분)</Label>
            <Input
              id="detail-reminder"
              value={reminderText}
              onChange={(e) => setReminderText(e.target.value)}
              placeholder="7, 3, 1"
              disabled={closed}
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => scheduleMutation.mutate()}
              disabled={closed || scheduleMutation.isPending}
            >
              {scheduleMutation.isPending ? "저장 중..." : "일정 저장"}
            </Button>
          </div>
        </div>

        <div className="mt-4 border-t pt-4">
          <p className="text-sm font-medium">독려 안내 수동 실행</p>
          <p className="mt-1 text-xs text-muted-foreground">
            계열사 설정에 저장된 독려 안내 템플릿과 대상 조건으로 즉시 발송합니다. 계열사 단위로
            돌며, 이 차수 배정자 중 차수 일정이 있는 사람에게는 차수 일정이 우선 적용됩니다.
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => reminderMutation.mutate()}
            disabled={reminderMutation.isPending}
          >
            <RotateCw className="size-4" />
            {reminderMutation.isPending ? "발송 중..." : "독려 안내 발송"}
          </Button>
        </div>
      </section>
    </div>
  );
}
