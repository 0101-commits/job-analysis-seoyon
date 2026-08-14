import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Plus, RotateCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { useCompanyScope } from "@/components/CompanyContext";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import { MAIL_VARIABLES } from "@/lib/mail-vars";
import {
  countRecipients,
  deleteTemplate,
  listBatches,
  listLogs,
  listTemplates,
  previewTemplate,
  upsertTemplate,
} from "@/lib/mail.functions";
import {
  mailModeStatus,
  resendMailLog,
  sendMailBatch,
  triggerReminders,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/admin/mail")({
  head: () => ({
    meta: [
      { title: "메일 발송 | 서연 그룹 업무조사" },
      { name: "description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
      { property: "og:title", content: "메일 발송 | 서연 그룹 업무조사" },
      { property: "og:description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
    ],
  }),
  component: MailPage,
});

const KIND_LABELS: Record<string, string> = {
  invite: "초대",
  reminder: "리마인더",
  custom: "일반",
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function origin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

function MailPage() {
  const { data: mode } = useQuery({
    queryKey: ["mail-mode"],
    queryFn: () => mailModeStatus(),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">메일 발송</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          초대 및 안내 메일의 템플릿, 발송, 이력을 관리합니다.
        </p>
      </div>

      {mode?.simulation && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-semibold text-warning">시뮬레이션 모드</p>
            <p className="mt-1 text-muted-foreground">
              RESEND_API_KEY 미설정 — 실발송 없이 로그만 기록됩니다.
            </p>
          </div>
        </div>
      )}

      <Tabs defaultValue="templates">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="templates" className="flex-1 sm:flex-none">
            템플릿
          </TabsTrigger>
          <TabsTrigger value="send" className="flex-1 sm:flex-none">
            발송
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-1 sm:flex-none">
            이력
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="send" className="mt-4">
          <SendTab />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type EditorState = {
  id?: string;
  name: string;
  kind: "invite" | "reminder" | "custom";
  subject: string;
  body: string;
};

const EMPTY_EDITOR: EditorState = { name: "", kind: "custom", subject: "", body: "" };

function TemplatesTab() {
  const queryClient = useQueryClient();
  const { companyId } = useCompanyScope();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<{ sampleName: string | null; subject: string; body: string } | null>(
    null,
  );
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focusedRef = useRef<"subject" | "body">("body");

  const { data: templates, isLoading } = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => listTemplates(),
  });

  const saveMutation = useMutation({
    mutationFn: (input: EditorState) => upsertTemplate({ data: input }),
    onSuccess: () => {
      toast.success("템플릿이 저장되었습니다.");
      setEditor(null);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["mail-templates"] });
    },
    onError: (err) => toast.error(`저장에 실패했습니다: ${errorMessage(err)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTemplate({ data: { id } }),
    onSuccess: () => {
      toast.success("템플릿이 삭제되었습니다.");
      void queryClient.invalidateQueries({ queryKey: ["mail-templates"] });
    },
    onError: (err) => toast.error(`삭제에 실패했습니다: ${errorMessage(err)}`),
  });

  const previewMutation = useMutation({
    mutationFn: (input: EditorState) =>
      previewTemplate({
        data: {
          subject: input.subject,
          body: input.body,
          companyId: companyId === "all" ? null : companyId,
          origin: origin(),
        },
      }),
    onSuccess: (result) => setPreview(result),
    onError: (err) => toast.error(`미리보기에 실패했습니다: ${errorMessage(err)}`),
  });

  /** 마지막으로 포커스된 입력의 커서 위치에 변수 토큰을 끼워 넣는다. */
  function insertToken(token: string) {
    if (!editor) return;
    const field = focusedRef.current;
    const el = field === "subject" ? subjectRef.current : bodyRef.current;
    const value = field === "subject" ? editor.subject : editor.body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    setEditor({ ...editor, [field]: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          총 {templates?.length ?? 0}개의 템플릿
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditor({ ...EMPTY_EDITOR });
            setPreview(null);
          }}
        >
          <Plus className="size-4" /> 새 템플릿
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {(templates ?? []).map((t) => (
            <li key={t.id} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {t.name}
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {KIND_LABELS[t.kind] ?? t.kind}
                    </span>
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{t.subject}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditor({
                        id: t.id,
                        name: t.name,
                        kind: (t.kind as EditorState["kind"]) ?? "custom",
                        subject: t.subject,
                        body: t.body,
                      });
                      setPreview(null);
                    }}
                  >
                    편집
                  </Button>
                  {!t.is_default && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t.name} 삭제`}
                      onClick={() => deleteMutation.mutate(t.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editor && (
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold">
            {editor.id ? "템플릿 편집" : "새 템플릿"}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tpl-name">템플릿 이름</Label>
              <Input
                id="tpl-name"
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="예: 2차 안내 메일"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tpl-kind">종류</Label>
              <Select
                value={editor.kind}
                onValueChange={(v) => setEditor({ ...editor, kind: v as EditorState["kind"] })}
              >
                <SelectTrigger id="tpl-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="invite">초대</SelectItem>
                  <SelectItem value="reminder">리마인더</SelectItem>
                  <SelectItem value="custom">일반</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>변수 팔레트</Label>
            <div className="flex flex-wrap gap-2">
              {MAIL_VARIABLES.map((v) => (
                <button
                  key={v.token}
                  type="button"
                  title={v.desc}
                  onClick={() => insertToken(v.token)}
                  className="rounded-full border bg-secondary px-3 py-1 text-xs font-medium hover:bg-primary-soft"
                >
                  {v.token}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              클릭하면 마지막으로 편집하던 입력창의 커서 위치에 삽입됩니다.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-subject">제목</Label>
            <Input
              id="tpl-subject"
              ref={subjectRef}
              value={editor.subject}
              onFocus={() => (focusedRef.current = "subject")}
              onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
              placeholder="[서연 그룹 업무조사] {이름}님께 안내드립니다"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-body">본문</Label>
            <Textarea
              id="tpl-body"
              ref={bodyRef}
              rows={14}
              value={editor.body}
              onFocus={() => (focusedRef.current = "body")}
              onChange={(e) => setEditor({ ...editor, body: e.target.value })}
              placeholder="메일 본문을 입력하세요."
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => saveMutation.mutate(editor)}
              disabled={saveMutation.isPending || !editor.name || !editor.subject || !editor.body}
            >
              {saveMutation.isPending ? "저장 중..." : "저장"}
            </Button>
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate(editor)}
              disabled={previewMutation.isPending}
            >
              {previewMutation.isPending ? "생성 중..." : "미리보기"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditor(null);
                setPreview(null);
              }}
            >
              닫기
            </Button>
          </div>

          {preview && (
            <div className="rounded-lg border bg-background p-4">
              <p className="text-xs text-muted-foreground">
                {preview.sampleName
                  ? `표본 참여자: ${preview.sampleName} (초기 비밀번호는 마스킹됩니다)`
                  : "참여자 데이터가 없어 예시 값으로 치환했습니다."}
              </p>
              <p className="mt-3 font-semibold">{preview.subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {preview.body}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SendTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");

  const { data: templates } = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => listTemplates(),
  });

  const filterCompanyId = companyId === "all" ? null : companyId;

  const { data: recipients, isFetching: countingRecipients } = useQuery({
    queryKey: ["mail-recipients", filterCompanyId, statuses],
    queryFn: () => countRecipients({ data: { companyId: filterCompanyId, statuses } }),
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      sendMailBatch({
        data: {
          name: name.trim() || `메일 발송 ${new Date().toISOString().slice(0, 10)}`,
          templateId,
          filters: { companyId: filterCompanyId, statuses },
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          origin: origin(),
        },
      }),
    onSuccess: (result) => {
      if (result.scheduled) toast.success("발송이 예약되었습니다.");
      else
        toast.success(
          `발송 완료 — 성공 ${result.sent ?? 0}건 / 실패 ${result.failed ?? 0}건${
            result.simulated ? " (시뮬레이션)" : ""
          }`,
        );
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`발송에 실패했습니다: ${errorMessage(err)}`),
  });

  const reminderMutation = useMutation({
    mutationFn: () =>
      triggerReminders({ data: { companyId: filterCompanyId, origin: origin() } }),
    onSuccess: (result) => {
      const sent = result.results.reduce((acc, r) => acc + r.sent, 0);
      toast.success(`리마인더 ${sent}건을 처리했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`리마인더 발송에 실패했습니다: ${errorMessage(err)}`),
  });

  function toggleStatus(status: string, checked: boolean) {
    setStatuses((prev) =>
      checked ? [...prev, status] : prev.filter((s) => s !== status),
    );
  }

  return (
    <div className="space-y-4">
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
                  {t.name} · {KIND_LABELS[t.kind] ?? t.kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="send-name">배치 이름</Label>
          <Input
            id="send-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 1차 초대 발송"
          />
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
            선택하지 않으면 상태와 무관하게 전체가 대상이 됩니다.
          </p>
        </div>

        <div className="rounded-lg border bg-background px-4 py-3">
          <p className="text-xs text-muted-foreground">
            대상 범위: {companyId === "all" ? "전체 계열사" : "선택 계열사"} · 이메일 보유 응답자
          </p>
          <p className="mt-1 text-lg font-bold">
            예상 대상자 {countingRecipients ? "…" : (recipients?.count ?? 0)}명
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="send-schedule">예약 발송 일시 (선택)</Label>
          <Input
            id="send-schedule"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            비워두면 즉시 발송됩니다.
          </p>
        </div>

        <Button
          className="h-11 w-full sm:w-auto"
          onClick={() => sendMutation.mutate()}
          disabled={!templateId || sendMutation.isPending}
        >
          <Send className="size-4" />
          {sendMutation.isPending
            ? "처리 중..."
            : scheduledAt
              ? "예약 등록"
              : "즉시 발송"}
        </Button>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">리마인더 수동 실행</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          계열사 설정의 리마인더 템플릿과 대상 조건으로 즉시 발송합니다.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => reminderMutation.mutate()}
          disabled={reminderMutation.isPending}
        >
          <RotateCw className="size-4" />
          {reminderMutation.isPending ? "발송 중..." : "리마인더 발송"}
        </Button>
      </div>
    </div>
  );
}

function HistoryTab() {
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  const { data: batches, isLoading } = useQuery({
    queryKey: ["mail-batches"],
    queryFn: () => listBatches(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;

  const rows = batches ?? [];
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">아직 발송 이력이 없습니다.</p>
      </div>
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
                {b.simulated && (
                  <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-normal text-warning">
                    시뮬레이션
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
              </dl>
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

          {openBatchId === b.id && <BatchLogs batchId={b.id} />}
        </li>
      ))}
    </ul>
  );
}

function BatchLogs({ batchId }: { batchId: string }) {
  const queryClient = useQueryClient();

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

  if (isLoading) {
    return <p className="border-t px-4 py-3 text-sm text-muted-foreground">불러오는 중...</p>;
  }

  const rows = logs ?? [];
  if (!rows.length) {
    return (
      <p className="border-t px-4 py-3 text-sm text-muted-foreground">
        개인별 발송 기록이 없습니다.
      </p>
    );
  }

  return (
    <ul className="border-t">
      {rows.map((log) => (
        <li
          key={log.id}
          className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 last:border-b-0"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {log.to_name ?? "이름 없음"}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {log.to_email}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {log.sent_at.slice(0, 16).replace("T", " ")}
              {log.error_message ? ` · ${log.error_message}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                log.status === "성공"
                  ? "bg-success/15 text-success"
                  : log.status === "실패"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {log.status}
            </span>
            {log.status === "실패" && (
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
  );
}
