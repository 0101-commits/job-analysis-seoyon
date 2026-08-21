import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Eye, MailCheck, RotateCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { SignalCard } from "@/components/SignalCard";
import { useMailApprovals } from "@/components/admin/MailPreviewGallery";
import {
  OrgTreeFilter,
  orgPathLabel,
  orgSubtreeIds,
  useOrgLens,
} from "@/components/admin/OrgTreeFilter";
import { usePersistedState } from "@/hooks/use-persisted-ui";
import { COPY } from "@/lib/glossary";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import { MAIL_KIND_LABELS } from "@/lib/mail-vars";
import {
  cancelScheduledBatch,
  listBatches,
  listLogs,
  listRecipientPreview,
  listSendTargets,
  listTemplates,
  resendFailedLogs,
  sendTestMail,
  type SendTargetRow,
} from "@/lib/mail.functions";
import { mailModeStatus, resendMailLog, sendMailBatch } from "@/lib/admin.functions";

/**
 * 발송 패널 (v4 구획 A4).
 *
 * mail.tsx 발송 탭에 있던 핵심 흐름(템플릿 선택 → 대상 상태 필터 → 예약 일시 →
 * 확인 다이얼로그[수신자 미리보기] → 발송)을 공용 부품으로 꺼냈다. 쓰는 곳 두 군데:
 *   - 차수 상세(waves.tsx): waveId 있음 — 대상 = 그 차수 배정자. 소속 트리 없음.
 *   - 메일 화면(mail.tsx) 예외 발송: waveId 없음 — 소속 트리 + 상태 필터 (공지 등).
 *
 * 같은 파일에 발송 이력(MailBatchHistory)도 함께 둔다 — 실패 재발송·예약 취소 로직을
 * 메일 화면과 차수 상세가 똑같이 쓰기 위해서다.
 */

/** 한 번에 보낼 수 있는 기본 상한. 운영 설정 항목이 생기면 그 값으로 대체한다(기획 P9). */
const DEFAULT_SEND_LIMIT = 300;

/** 더 보낼 이유가 없는 상태 — 독려 대상에서 빠진다. */
const FINISHED = ["제출", "승인"];

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function origin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function daysSince(value: string, now: number) {
  return Math.max(0, Math.floor((now - Date.parse(value)) / 86_400_000));
}

/** 발송에 걸릴 시간 — 한 통씩 순차로 보내므로 건수에 비례한다. */
function durationLabel(count: number, simulation: boolean) {
  const seconds = Math.round(count * (simulation ? 0.15 : 0.6));
  if (seconds < 60) return `약 ${Math.max(seconds, 1)}초`;
  return `약 ${Math.ceil(seconds / 60)}분`;
}

/** 독려 안내를 보낼 이유. 없으면 null — 보낼 이유가 없는 사람이다. */
function reminderReason(row: SendTargetRow, now: number): string | null {
  if (FINISHED.includes(row.account_status)) return null;
  if (!row.invited_at) {
    return "안내 메일을 보낸 적이 없습니다 — 독려가 아니라 초대가 필요합니다";
  }
  const invited = `안내 ${dateOnly(row.invited_at)}`;
  if (!row.last_seen_at) {
    return `${invited} · 발송 ${daysSince(row.invited_at, now)}일째 접속 없음`;
  }
  const idle = daysSince(row.last_seen_at, now);
  if (row.account_status === "반려") {
    return `${invited} · 보완 요청 후 ${idle}일째 다시 제출하지 않음`;
  }
  return `${invited} · 작성 중, 마지막 접속 ${idle}일 전`;
}

export type MailSendPanelProps = {
  /** 대상 계열사. null 이면 전체 계열사(예외 발송에서만 씀). */
  companyId: string | null;
  /** 있으면 대상 = 이 차수 배정자(participants.wave_id). 소속 트리 없이 상태 필터만 쓴다. */
  waveId?: string;
  /** ?ids= 딥링크 — 이 명단으로 대상을 좁힌다. waveId 가 있으면 무시된다. */
  pinnedIds?: string[];
  /** ?template= 딥링크 — 템플릿 id 또는 종류(invite·reminder·custom). */
  initialTemplate?: string;
  /** ?status= 딥링크 — 초기 상태 필터. */
  initialStatuses?: string[];
  /** 실물 미확인 템플릿일 때 「미리보기에서 확인」이 할 행동. 없으면 메일 화면으로 이동한다. */
  onOpenPreview?: () => void;
};

export function MailSendPanel({
  companyId,
  waveId,
  pinnedIds = [],
  initialTemplate,
  initialStatuses = [],
  onOpenPreview,
}: MailSendPanelProps) {
  const queryClient = useQueryClient();
  const { isApproved } = useMailApprovals();
  const { selectedOrgId, setSelectedOrgId } = useOrgLens();
  const waveMode = Boolean(waveId);

  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [statuses, setStatuses] = useState<string[]>(() =>
    initialStatuses.filter((s) => (ACCOUNT_STATUS_LABELS as readonly string[]).includes(s)),
  );
  const [scheduledAt, setScheduledAt] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkAck, setBulkAck] = useState(false);
  const [sendLimit, setSendLimit] = usePersistedState<number>(
    "mail-send-limit",
    DEFAULT_SEND_LIMIT,
  );

  const { data: mode } = useQuery({ queryKey: ["mail-mode"], queryFn: () => mailModeStatus() });
  const simulation = Boolean(mode?.simulation);

  const { data: templates } = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => listTemplates(),
  });

  // ?template= 은 템플릿 id 또는 종류(invite·reminder·custom) 둘 다 받는다.
  useEffect(() => {
    if (!initialTemplate || !templates?.length) return;
    const hit =
      templates.find((t) => t.id === initialTemplate) ??
      templates.find((t) => t.kind === initialTemplate);
    if (hit) setTemplateId(hit.id);
  }, [initialTemplate, templates]);

  /* ── 차수 발송: 서버가 발송과 같은 조건으로 수를 세고 명단 200명을 미리 보여 준다 ── */
  const {
    data: wavePreview,
    isFetching: waveLoading,
    error: waveError,
  } = useQuery({
    queryKey: ["mail-recipient-preview", waveId, companyId, statuses],
    queryFn: () =>
      listRecipientPreview({ data: { companyId, statuses, waveId: waveId as string } }),
    enabled: waveMode,
  });

  /* ── 예외 발송: 전량을 받아 소속 트리·이메일 없는 사람까지 화면에서 보여 준다 ── */
  const {
    data: targets,
    isFetching: targetsLoading,
    error: targetsError,
  } = useQuery({
    queryKey: ["mail-send-targets", companyId, statuses, pinnedIds],
    queryFn: () =>
      listSendTargets({
        data: {
          companyId,
          statuses,
          ...(pinnedIds.length ? { participantIds: pinnedIds } : {}),
        },
      }),
    enabled: !waveMode,
  });

  const units = targets?.units ?? [];
  const subtree = useMemo(() => orgSubtreeIds(units, selectedOrgId), [units, selectedOrgId]);

  /** 소속 하위 필터는 트리를 그린 뒤라야 알 수 있어 화면에서 걸러 낸다. */
  const scoped = useMemo(() => {
    const rows = targets?.rows ?? [];
    if (!subtree) return rows;
    const allow = new Set(subtree);
    return rows.filter((r) => r.org_unit_id && allow.has(r.org_unit_id));
  }, [targets, subtree]);

  const included = useMemo(() => scoped.filter((r) => r.email), [scoped]);
  const excluded = useMemo(() => scoped.filter((r) => !r.email), [scoped]);
  const archivedCount = included.filter((r) => r.archived_at).length;

  /** 소속별 대상자 수 — 상위 조직에는 하위를 합쳐서 보여 준다. */
  const orgCounts = useMemo(() => {
    const parentOf = new Map(units.map((u) => [u.id, u.parent_id]));
    const total: Record<string, number> = {};
    (targets?.rows ?? []).forEach((r) => {
      if (!r.email || !r.org_unit_id) return;
      let cur: string | null | undefined = r.org_unit_id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        total[cur] = (total[cur] ?? 0) + 1;
        cur = parentOf.get(cur) ?? null;
      }
    });
    return total;
  }, [targets, units]);

  const includedCount = waveMode ? (wavePreview?.count ?? 0) : included.length;
  const loading = waveMode ? waveLoading : targetsLoading;
  const loadError = waveMode ? waveError : targetsError;

  const template = templates?.find((t) => t.id === templateId);
  const approved = isApproved(templateId, template?.updated_at);
  const isReminder = template?.kind === "reminder";
  const now = Date.now();

  const reminderRows = useMemo(
    () => included.map((r) => ({ row: r, reason: reminderReason(r, now) })),
    // now 는 렌더 시점 기준값이라 의존성에서 뺀다(1초마다 다시 계산할 이유가 없다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [included],
  );
  const reminderTargets = reminderRows.filter((r) => r.reason);
  const nothingToRemind =
    !waveMode && isReminder && included.length > 0 && reminderTargets.length === 0;

  const overLimit = includedCount > sendLimit;

  /**
   * 예외 발송(즉시)은 확인한 명단을 그대로 고정해서 보낸다(화면과 실제 발송이 어긋나지 않게).
   * 예약은 발송 시각의 명부를 다시 계산하는 것이 자연스러워 조건만 넘기되,
   * 소속·참여자 지정처럼 조건으로 표현할 수 없는 선택이 있으면 그때도 명단을 고정한다.
   * 차수 발송은 항상 조건(waveId)으로 보낸다 — 확인 화면과 발송이 같은 selectTargets 를
   * 쓰므로 어긋나지 않고, 예약이 실행될 때도 조건 재계산에 waveId 가 그대로 살아 있다.
   */
  const freezeList = !waveMode && (!scheduledAt || Boolean(selectedOrgId) || pinnedIds.length > 0);

  const sendMutation = useMutation({
    mutationFn: () =>
      sendMailBatch({
        data: {
          name: name.trim() || `메일 발송 ${new Date().toISOString().slice(0, 10)}`,
          templateId,
          filters: waveMode
            ? { companyId, statuses, waveId: waveId as string }
            : {
                companyId,
                statuses,
                ...(freezeList ? { participantIds: included.map((r) => r.id) } : {}),
              },
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          origin: origin(),
        },
      }),
    onSuccess: (result) => {
      setConfirmOpen(false);
      setBulkAck(false);
      if (result.scheduled)
        toast.success("발송이 예약되었습니다. 발송 이력에서 확인·취소할 수 있습니다.");
      else
        toast.success(
          `발송 완료 — 성공 ${result.sent ?? 0}건 / 실패 ${result.failed ?? 0}건${
            result.simulated ? ` (${COPY.simulationMode})` : ""
          }`,
        );
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-send-targets"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-recipient-preview"] });
      // 차수 목록의 '최근 발송' 이 바로 갱신되게 한다.
      void queryClient.invalidateQueries({ queryKey: ["survey-waves"] });
    },
    onError: (err) => toast.error(`발송에 실패했습니다: ${errorMessage(err)}`),
  });

  const testMutation = useMutation({
    mutationFn: () => sendTestMail({ data: { templateId, companyId, origin: origin() } }),
    onSuccess: (result) => {
      if (result.simulated) {
        toast.info(`${COPY.simulationMode} (수신 예정: ${result.to})`);
      } else if (result.status === "실패") {
        toast.error(`테스트 발송에 실패했습니다: ${result.error ?? "알 수 없는 오류"}`);
      } else {
        toast.success(`${result.to} 으로 테스트 메일을 보냈습니다.`);
      }
    },
    onError: (err) => toast.error(`테스트 발송에 실패했습니다: ${errorMessage(err)}`),
  });

  function toggleStatus(status: string, checked: boolean) {
    setStatuses((prev) => (checked ? [...prev, status] : prev.filter((s) => s !== status)));
  }

  const blockedReason = !templateId
    ? "먼저 템플릿을 고르세요."
    : !approved
      ? "미리보기에서 이 템플릿의 실물을 확인해야 발송할 수 있습니다."
      : includedCount === 0
        ? "조건에 맞는 수신 대상이 없습니다."
        : null;

  const previewAction = onOpenPreview
    ? { label: "미리보기에서 확인", onClick: onOpenPreview }
    : { label: "미리보기에서 확인", href: "/admin/mail?tab=preview" };

  const form = (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      <div className="space-y-2">
        <Label htmlFor="send-template">템플릿</Label>
        <Select value={templateId} onValueChange={setTemplateId}>
          <SelectTrigger id="send-template">
            <SelectValue placeholder="발송할 템플릿을 선택하세요" />
          </SelectTrigger>
          <SelectContent>
            {(templates ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name} · {MAIL_KIND_LABELS[t.kind] ?? t.kind}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {templateId && !approved && (
        <SignalCard
          tone="attention"
          signal="아직 실물을 확인하지 않은 템플릿입니다"
          evidence={[
            "메일은 보내고 나면 되돌릴 수 없어, 발송 전 실물 확인을 한 번 거치게 되어 있습니다.",
            "템플릿을 고치면 확인이 자동으로 풀리고 다시 확인해야 합니다.",
          ]}
          actions={[previewAction]}
        />
      )}

      <div className="space-y-2">
        <Label htmlFor="send-name">발송 이름</Label>
        <Input
          id="send-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 1차 초대 발송"
        />
        <p className="text-xs text-muted-foreground">
          발송 이력에서 이 이름으로 찾습니다. 비우면 오늘 날짜로 붙습니다.
        </p>
      </div>

      <div className="space-y-2">
        <Label>대상 계정 상태</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ACCOUNT_STATUS_LABELS.map((status) => (
            <label
              key={status}
              className="flex cursor-pointer items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <Checkbox
                checked={statuses.includes(status)}
                onCheckedChange={(v) => toggleStatus(status, v === true)}
              />
              {status}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          선택하지 않으면 상태와 무관하게 {waveMode ? "이 차수 배정자 전체" : "전체"}가 대상이
          됩니다.
        </p>
      </div>

      {!waveMode && pinnedIds.length > 0 && (
        <p className="rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-xs text-accent-foreground">
          다른 화면에서 지정한 {pinnedIds.length}명으로 대상을 좁혀 두었습니다. 계정 상태·소속
          조건은 이 명단 안에서만 적용됩니다.
        </p>
      )}

      {loadError ? (
        <EmptyState
          kind="blocked"
          title="대상자를 불러오지 못했습니다"
          description={`원인: ${errorMessage(loadError)} — 잠시 후 다시 시도해 주세요. 대상자 수를 확인하기 전에는 발송하지 않습니다.`}
        />
      ) : (
        <div className="rounded-lg border bg-background px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {waveMode
              ? "이 차수에 배정된 참여자"
              : `${companyId ? "선택 계열사" : "전체 계열사"} · ${orgPathLabel(units, selectedOrgId)}`}
            {statuses.length ? ` · 상태 ${statuses.join("·")}` : " · 상태 전체"}
          </p>
          <p className="mt-1 text-lg font-bold">보낼 사람 {loading ? "…" : includedCount}명</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {waveMode
              ? "이메일이 등록된 배정자만 셉니다. 이메일이 없는 사람은 대상에서 빠집니다."
              : excluded.length > 0
                ? `이메일이 없어 제외된 ${excluded.length}명은 발송 대상이 아닙니다.`
                : "제외된 사람은 없습니다."}
          </p>
        </div>
      )}

      {nothingToRemind && (
        <SignalCard
          tone="good"
          signal="지금 독려 안내를 보낼 사람이 없습니다"
          evidence={[
            `대상 ${included.length}명 모두 제출을 마쳤거나 승인되었습니다.`,
            "보낼 이유가 없는 메일은 다음 안내의 신뢰를 깎습니다 — 발송을 권하지 않습니다.",
          ]}
          scope={`대상 ${included.length}명 기준`}
        />
      )}

      {!waveMode && isReminder && reminderTargets.length > 0 && (
        <div className="rounded-lg border bg-background p-4">
          <p className="text-sm font-semibold">왜 이 {reminderTargets.length}명이 독려 대상인지</p>
          <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
            {reminderTargets.slice(0, 50).map(({ row, reason }) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-medium">{row.name}</span>
                <StatusBadge status={row.account_status} className="px-2 py-0" withHelp />
                <span className="text-muted-foreground">{reason}</span>
              </li>
            ))}
          </ul>
          {reminderTargets.length > 50 && (
            <p className="mt-2 text-xs text-muted-foreground">
              화면에는 50명까지 보여 줍니다. 나머지 {reminderTargets.length - 50}명도 같은 조건으로
              발송됩니다.
            </p>
          )}
          {reminderRows.length - reminderTargets.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              이미 제출·승인된 {reminderRows.length - reminderTargets.length}명도 조건에 들어
              있습니다. 상태 조건에서 제출·승인을 빼면 이들에게는 가지 않습니다.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="send-schedule">예약 발송 일시 (선택)</Label>
        <Input
          id="send-schedule"
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          비워두면 즉시 발송됩니다.{" "}
          {freezeList
            ? "지금 화면에 보이는 명단이 그대로 고정되어 나갑니다."
            : "발송 시각에 같은 조건으로 명부를 다시 계산하므로, 그때 추가된 사람도 포함됩니다."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="h-11 w-full sm:w-auto"
          onClick={() => setConfirmOpen(true)}
          disabled={Boolean(blockedReason) || sendMutation.isPending}
          variant={nothingToRemind ? "outline" : "default"}
        >
          <Send className="size-4" />
          {sendMutation.isPending
            ? "처리 중..."
            : nothingToRemind
              ? "그래도 발송"
              : scheduledAt
                ? "예약 등록"
                : "즉시 발송"}
        </Button>

        <Button
          variant="outline"
          className="h-11 w-full sm:w-auto"
          onClick={() => testMutation.mutate()}
          disabled={!templateId || testMutation.isPending}
        >
          <MailCheck className="size-4" />
          {testMutation.isPending ? "보내는 중..." : "나에게 테스트 발송"}
        </Button>

        {simulation && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1 text-xs font-semibold text-warning">
            <AlertTriangle className="size-3.5" />
            {COPY.simulationMode}
          </span>
        )}
      </div>

      {blockedReason && <p className="text-xs text-muted-foreground">{blockedReason}</p>}
      <p className="text-xs text-muted-foreground">
        테스트 발송은 대상자와 무관하게 로그인한 관리자 본인에게 1건만 보냅니다.
      </p>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setBulkAck(false);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>발송 전 확인</DialogTitle>
            <DialogDescription>
              {template?.name ?? "템플릿"} · {scheduledAt ? "예약 발송" : "즉시 발송"} ·{" "}
              {simulation ? COPY.simulationMode : "실제로 메일이 나갑니다"}
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-background p-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">받는 사람</dt>
              <dd className="text-base font-bold">{includedCount}명</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">제외</dt>
              <dd className="text-base font-bold">{waveMode ? "—" : `${excluded.length}명`}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">예상 소요</dt>
              <dd className="text-base font-bold">{durationLabel(includedCount, simulation)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{waveMode ? "대상" : "소속"}</dt>
              <dd className="truncate text-sm font-semibold">
                {waveMode ? "이 차수 배정자" : orgPathLabel(units, selectedOrgId)}
              </dd>
            </div>
          </dl>

          {!waveMode && excluded.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs font-semibold text-warning">
                제외된 {excluded.length}명 — 이메일이 등록되지 않았습니다
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {excluded
                  .slice(0, 8)
                  .map((r) => `${r.name}(${r.emp_no})`)
                  .join(", ")}
                {excluded.length > 8 ? ` 외 ${excluded.length - 8}명` : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                참여자 관리에서 이메일을 채우면 다음 발송에 포함됩니다.
              </p>
            </div>
          )}

          {!waveMode && archivedCount > 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              보관 처리된 참여자 {archivedCount}명이 대상에 들어 있습니다. 보내지 않으려면 참여자
              관리에서 제외한 뒤 다시 시도하세요.
            </p>
          )}

          <div className="rounded-lg border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="send-limit" className="text-xs">
                한 번에 보낼 상한
              </Label>
              <Input
                id="send-limit"
                type="number"
                min={1}
                max={5000}
                value={sendLimit}
                onChange={(e) => setSendLimit(Math.max(1, Number(e.target.value) || 1))}
                className="h-8 w-24"
              />
              <span className="text-xs text-muted-foreground">통</span>
            </div>
            {overLimit && (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-destructive">
                <Checkbox
                  checked={bulkAck}
                  onCheckedChange={(v) => setBulkAck(v === true)}
                  className="mt-0.5"
                />
                <span>
                  상한 {sendLimit}통을 넘는 {includedCount}통입니다. 한 번에 많이 보내면 메일 서버가
                  일부를 거절할 수 있습니다 — 그래도 보내겠습니다.
                </span>
              </label>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">받는 사람 명단</p>
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border bg-background p-2">
              {waveMode
                ? (wavePreview?.recipients ?? []).map((r, i) => (
                    <li
                      key={`${r.email}-${i}`}
                      className="flex justify-between gap-3 px-2 py-1 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {r.name}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {r.status}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{r.email}</span>
                    </li>
                  ))
                : included.slice(0, 200).map((r) => (
                    <li key={r.id} className="flex justify-between gap-3 px-2 py-1 text-sm">
                      <span className="min-w-0 truncate font-medium">
                        {r.name}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {r.org_text ?? orgPathLabel(units, r.org_unit_id)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{r.email}</span>
                    </li>
                  ))}
              {includedCount === 0 && (
                <li className="px-2 py-1 text-sm text-muted-foreground">
                  조건에 맞는 수신 대상이 없습니다.
                </li>
              )}
            </ul>
            {includedCount > 200 && (
              <p className="text-xs text-muted-foreground">
                화면에는 200명까지 보여 줍니다. 실제로는 {includedCount}명 전원에게 나갑니다.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              닫기
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={
                sendMutation.isPending ||
                includedCount === 0 ||
                (overLimit && !bulkAck) ||
                !approved
              }
            >
              <Send className="size-4" />
              {sendMutation.isPending
                ? "처리 중..."
                : scheduledAt
                  ? "예약 등록"
                  : `${includedCount}명에게 발송`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (waveMode) return form;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="space-y-3">
        <OrgTreeFilter
          units={units}
          selectedId={selectedOrgId}
          onSelect={setSelectedOrgId}
          counts={orgCounts}
          title="보낼 소속"
        />
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          숫자는 이메일이 등록된 대상자 수입니다(하위 조직 포함). 고르면 다른 관리 화면에서도 같은
          소속을 보게 됩니다.
        </p>
      </div>
      {form}
    </div>
  );
}

/* ───────────────────────────── 발송 이력 ───────────────────────────── */

/** 실패 사유를 "왜 그런지 + 다음에 무엇을 누를지" 로 바꿔 준다 (기획 P8). */
function failureHelp(message: string | null) {
  const m = message ?? "";
  if (/domain|from|verif/i.test(m)) {
    return "보내는 주소가 아직 인증되지 않았습니다. 운영 설정에서 발신 주소 인증을 마친 뒤 [재발송]을 누르세요.";
  }
  if (/401|403|unauthor|api.?key/i.test(m)) {
    return "메일 발송 키가 거부되었습니다. 발송 키를 다시 등록해야 하며, 재발송만으로는 해결되지 않습니다.";
  }
  if (/rate|429|too many/i.test(m)) {
    return "짧은 시간에 너무 많이 보내 잠시 거절되었습니다. 1~2분 뒤 [재발송]을 누르면 됩니다.";
  }
  if (/invalid|not a valid|recipient|address/i.test(m)) {
    return "받는 주소가 올바르지 않습니다. 참여자 관리에서 이메일을 고친 뒤 [재발송]을 누르세요.";
  }
  if (/timeout|network|fetch|socket|ECONN/i.test(m)) {
    return "메일 서버에 닿지 못했습니다. 잠시 뒤 [재발송]을 누르세요.";
  }
  if (m) return `원인: ${m} — 원인을 해결한 뒤 [재발송]을 누르세요.`;
  return "원인이 기록되지 않았습니다. [재발송]을 눌러 다시 시도해 보세요.";
}

/** 반송 사유 — 발송 서비스가 준 통지 문구를 그대로 보여 주고 다음 행동을 붙인다. */
function bounceHelp(reason: string | null) {
  const head = reason?.trim() ? reason.trim() : "되돌아온 이유가 기록되지 않았습니다.";
  return `${head} 참여자 관리에서 주소를 확인·수정한 뒤 [재발송]을 누르세요.`;
}

type LogBucket = "all" | "성공" | "실패" | "반송" | "접속";

const BUCKET_LABELS: Record<LogBucket, string> = {
  all: "전체",
  성공: "성공",
  실패: "실패",
  반송: "반송",
  접속: "발송 후 접속",
};

/** 수신자에게 닿지 못한 상태. 재발송 대상이 된다. */
const UNREACHED_STATUSES = ["실패", "반송"];

export type MailBatchHistoryProps = {
  /** 있으면 이 차수의 발송만 보여 준다(차수 상세). 없으면 전체 이력(메일 화면). */
  waveId?: string;
};

/**
 * 발송 이력 — 배치 목록 + 사람별 기록, 실패 재발송·예약 취소 포함.
 * mail.tsx 이력 탭에 있던 것을 그대로 옮겨 차수 상세와 공유한다.
 */
export function MailBatchHistory({ waveId }: MailBatchHistoryProps) {
  const queryClient = useQueryClient();
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  const { data: batches, isLoading } = useQuery({
    queryKey: ["mail-batches", waveId ?? "all"],
    queryFn: () => listBatches({ data: waveId ? { waveId } : {} }),
  });

  const cancelMutation = useMutation({
    mutationFn: (batchId: string) => cancelScheduledBatch({ data: { batchId } }),
    onSuccess: () => {
      toast.success("예약을 취소했습니다.");
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`예약 취소에 실패했습니다: ${errorMessage(err)}`),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;

  const rows = batches ?? [];
  if (!rows.length) {
    return (
      <EmptyState
        kind="nothing"
        title="아직 발송 이력이 없습니다"
        description={
          waveId
            ? "위 발송 구획에서 템플릿과 대상을 고르고 한 번 보내면, 여기에 성공·실패·발송 후 접속이 사람별로 남습니다."
            : "차수 상세의 발송 구획에서 한 번 보내면, 여기에 성공·실패·발송 후 접속이 사람별로 남습니다."
        }
      />
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((b) => (
        <li key={b.id} className="rounded-xl border bg-card shadow-sm">
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 p-4 text-left"
            onClick={() => setOpenBatchId(openBatchId === b.id ? null : b.id)}
            aria-expanded={openBatchId === b.id}
          >
            <div className="min-w-0">
              <p className="font-semibold">
                {b.name}
                {!waveId && b.wave_id && (
                  // 어느 차수의 발송인지. 누르면 그 차수 상세로 간다.
                  <a
                    href={`/admin/waves?co=${b.company_id ?? ""}&wave=${b.wave_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-normal text-accent-foreground hover:underline"
                  >
                    {b.survey_waves?.name ?? "차수"}
                  </a>
                )}
                {b.simulated && (
                  <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-normal text-warning">
                    실제 발송 안 함
                  </span>
                )}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {b.companies?.name ?? "전체 계열사"} · {b.mail_templates?.name ?? "템플릿 삭제됨"} ·{" "}
                {(b.scheduled_at ?? b.created_at).slice(0, 16).replace("T", " ")}
              </p>
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">대상</dt>
                  <dd className="font-semibold">{b.total_count}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">성공</dt>
                  <dd className="font-semibold text-success">{b.sent_count}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">실패</dt>
                  <dd className="font-semibold text-destructive">{b.failed_count}</dd>
                </div>
                {b.bounced_count > 0 && (
                  <div className="flex gap-1">
                    <dt className="text-muted-foreground">반송</dt>
                    <dd className="font-semibold text-warning">{b.bounced_count}</dd>
                  </div>
                )}
              </dl>
              {b.held_count > 0 && (
                <p className="mt-2 text-xs font-medium text-warning">
                  하루 발송 상한
                  {b.held_cap ? ` ${b.held_cap.toLocaleString()}건` : ""}을 넘어 {b.held_count}건을
                  보내지 않고 남겼습니다. 다음 날 같은 대상으로 다시 보내거나 운영 설정에서 상한을
                  올리세요.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={b.status} />
              <ChevronDown
                className={`size-4 text-muted-foreground transition-transform ${
                  openBatchId === b.id ? "rotate-180" : ""
                }`}
              />
            </div>
          </button>

          {b.status === "예약" && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5">
              <p className="text-xs text-muted-foreground">
                아직 보내지 않은 예약 건입니다. 취소하면 이 예약 자체가 목록에서 사라집니다(발송
                전이라 사람별 기록은 없습니다). 취소한 사실은 감사 기록에 남고, 이미 발송이 시작된
                뒤에는 취소되지 않습니다.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancelMutation.mutate(b.id)}
                disabled={cancelMutation.isPending}
              >
                {cancelMutation.isPending ? "취소 중..." : "예약 취소"}
              </Button>
            </div>
          )}

          {openBatchId === b.id && <BatchLogs batchId={b.id} />}
        </li>
      ))}
    </ul>
  );
}

function BatchLogs({ batchId }: { batchId: string }) {
  const queryClient = useQueryClient();
  const [bucket, setBucket] = useState<LogBucket>("all");

  const { data: logs, isLoading } = useQuery({
    queryKey: ["mail-logs", batchId],
    queryFn: () => listLogs({ data: { batchId } }),
  });

  const resendMutation = useMutation({
    mutationFn: (logId: string) => resendMailLog({ data: { logId } }),
    onSuccess: (result) => {
      toast.success(`재발송 결과: ${result.status}`);
      void queryClient.invalidateQueries({ queryKey: ["mail-logs", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`재발송에 실패했습니다: ${errorMessage(err)}`),
  });

  const resendFailedMutation = useMutation({
    mutationFn: () => resendFailedLogs({ data: { batchId, origin: origin() } }),
    onSuccess: (result) => {
      if (result.total === 0) toast.info("재발송할 건이 없습니다(이미 재발송되었습니다).");
      else if (result.stopped)
        toast.warning(
          `${result.ok + result.failed}건까지만 보냈습니다 — ${result.stopped.reason} (남은 ${result.stopped.remainingTargets}건)`,
        );
      else
        toast.success(
          `닿지 못한 ${result.total}건 재발송 — 성공 ${result.ok}건 / 실패 ${result.failed}건`,
        );
      void queryClient.invalidateQueries({ queryKey: ["mail-logs", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`일괄 재발송에 실패했습니다: ${errorMessage(err)}`),
  });

  if (isLoading) {
    return <p className="border-t px-4 py-3 text-sm text-muted-foreground">불러오는 중...</p>;
  }

  const rows = logs?.rows ?? [];
  if (!rows.length) {
    return (
      <p className="border-t px-4 py-3 text-sm text-muted-foreground">
        사람별 발송 기록이 없습니다. 예약 건이면 아직 보내지 않았다는 뜻입니다.
      </p>
    );
  }

  /** 메일 열람 자체는 추적하지 않는다. 보낸 뒤 실제 접속했는지로 도달을 판단한다. */
  function accessedAfterSend(log: (typeof rows)[number]) {
    const seen = log.participants?.last_seen_at;
    return (
      !UNREACHED_STATUSES.includes(log.status) &&
      Boolean(seen) &&
      Date.parse(seen as string) > Date.parse(log.sent_at)
    );
  }

  const counts = {
    all: rows.length,
    성공: rows.filter((l) => !UNREACHED_STATUSES.includes(l.status)).length,
    실패: rows.filter((l) => l.status === "실패").length,
    반송: rows.filter((l) => l.status === "반송").length,
    접속: rows.filter(accessedAfterSend).length,
  };
  const unreached = counts.실패 + counts.반송;

  const visible = rows.filter((log) => {
    if (bucket === "all") return true;
    if (bucket === "실패") return log.status === "실패";
    if (bucket === "반송") return log.status === "반송";
    if (bucket === "접속") return accessedAfterSend(log);
    return !UNREACHED_STATUSES.includes(log.status);
  });

  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-secondary/40 px-4 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(BUCKET_LABELS) as LogBucket[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setBucket(key)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                bucket === key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-secondary"
              }`}
            >
              {BUCKET_LABELS[key]} {counts[key]}
            </button>
          ))}
        </div>
        {unreached > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => resendFailedMutation.mutate()}
            disabled={resendFailedMutation.isPending}
          >
            <RotateCw className="size-4" />
            {resendFailedMutation.isPending ? "재발송 중..." : `닿지 못한 ${unreached}건 재발송`}
          </Button>
        )}
      </div>

      {bucket === "접속" && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          메일을 열었는지는 추적하지 않습니다. 발송 시각 뒤에 시스템에 접속한 기록이 있는 사람만
          셉니다.
        </p>
      )}

      {bucket === "반송" && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          한 번 나갔지만 받는 쪽에서 되돌려보낸 건입니다. 없는 주소·꽉 찬 메일함·수신 거부가
          대부분이며, 주소를 고치지 않고 재발송하면 다시 되돌아옵니다.
        </p>
      )}

      {visible.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {BUCKET_LABELS[bucket]}에 해당하는 기록이 없습니다.
        </p>
      ) : (
        <ul>
          {visible.map((log) => (
            <li
              key={log.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {log.participant_id ? (
                    <a
                      href={`/admin/participants?p=${log.participant_id}`}
                      className="underline decoration-dotted underline-offset-2 hover:text-primary"
                    >
                      {log.to_name ?? "이름 없음"}
                    </a>
                  ) : (
                    (log.to_name ?? "이름 없음")
                  )}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {log.to_email}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {log.sent_at.slice(0, 16).replace("T", " ")}
                  {accessedAfterSend(log) ? " · 발송 후 접속함" : ""}
                  {log.bounced_at
                    ? ` · ${log.bounced_at.slice(0, 16).replace("T", " ")} 되돌아옴`
                    : ""}
                  {log.retry_count > 0 ? ` · 자동 재시도 ${log.retry_count}회` : ""}
                </p>
                {log.status === "실패" && (
                  <p className="mt-1 text-xs text-destructive">{failureHelp(log.error_message)}</p>
                )}
                {log.status === "반송" && (
                  <p className="mt-1 text-xs text-warning">
                    {bounceHelp(log.participants?.mail_bounce_reason ?? log.error_message)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    log.status === "성공"
                      ? "bg-success/15 text-success"
                      : log.status === "실패"
                        ? "bg-destructive/10 text-destructive"
                        : log.status === "반송"
                          ? "bg-warning/15 text-warning"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  {log.status === "시뮬레이션" ? "실제 발송 안 함" : log.status}
                </span>
                {accessedAfterSend(log) && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
                    <Eye className="size-3" /> 접속
                  </span>
                )}
                {UNREACHED_STATUSES.includes(log.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resendMutation.mutate(log.id)}
                    disabled={resendMutation.isPending}
                  >
                    재발송
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
