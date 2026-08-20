import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  ImagePlus,
  MailCheck,
  Plus,
  RotateCw,
  Send,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useCompanyScope } from "@/components/CompanyContext";
import {
  MailPreviewGallery,
  useMailApprovals,
} from "@/components/admin/MailPreviewGallery";
import {
  OrgTreeFilter,
  orgPathLabel,
  orgSubtreeIds,
  useOrgLens,
} from "@/components/admin/OrgTreeFilter";
import { usePersistedState } from "@/hooks/use-persisted-ui";
import { COPY } from "@/lib/glossary";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_IMAGE_WIDTH,
  MAIL_ASSET_BUCKET,
  MAIL_KIND_LABELS,
  MAIL_VARIABLES,
  MAX_IMAGE_WIDTH,
  imageToken,
} from "@/lib/mail-vars";
import {
  cancelScheduledBatch,
  deleteTemplate,
  listBatches,
  listLogs,
  listSendTargets,
  listTemplates,
  previewTemplate,
  resendFailedLogs,
  sendTestMail,
  upsertTemplate,
  type SendTargetRow,
} from "@/lib/mail.functions";
import {
  mailModeStatus,
  resendMailLog,
  sendMailBatch,
  triggerReminders,
} from "@/lib/admin.functions";

/**
 * 메일 화면의 주소 규약 (기획 P6).
 *
 * 다른 화면(참여자 관리·대시보드)이 대상을 실어 이 화면으로 보낼 수 있게 네 값을 받는다.
 *   ?tab=templates|preview|send|history  탭 지정. 없으면 대상 지정이 있으면 발송 탭으로 간다
 *   ?template=<템플릿 id 또는 종류>       종류는 invite | reminder | custom
 *   ?org=<소속 id>                        소속 트리 선택을 그대로 이어받는다
 *   ?status=<계정 상태>                    쉼표로 여러 개. 예: status=초대발송,미접속
 *   ?ids=<참여자 id>                       쉼표로 여러 개. 이 사람들로만 대상을 좁힌다
 */
const TAB_VALUES = ["templates", "preview", "send", "history"] as const;
export type MailTab = (typeof TAB_VALUES)[number];

export type MailSearch = {
  tab?: MailTab;
  template?: string;
  org?: string;
  status?: string;
  ids?: string;
};

function searchText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const Route = createFileRoute("/_authenticated/admin/mail")({
  validateSearch: (search: Record<string, unknown>): MailSearch => {
    const out: MailSearch = {};
    const tab = searchText(search["tab"]);
    if (tab && (TAB_VALUES as readonly string[]).includes(tab)) {
      out.tab = tab as MailTab;
    }
    const template = searchText(search["template"]);
    if (template) out.template = template;
    const org = searchText(search["org"]);
    if (org) out.org = org;
    const status = searchText(search["status"]);
    if (status) out.status = status;
    const ids = searchText(search["ids"]);
    if (ids) out.ids = ids;
    return out;
  },
  head: () => ({
    meta: [
      { title: "안내·독려 메일 | 서연 그룹 업무조사" },
      { name: "description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
      { property: "og:title", content: "메일 발송 | 서연 그룹 업무조사" },
      { property: "og:description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
    ],
  }),
  component: MailPage,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 한 번에 보낼 수 있는 기본 상한. 운영 설정 항목이 생기면 그 값으로 대체한다(기획 P9). */
const DEFAULT_SEND_LIMIT = 300;

/** 아직 작성을 시작하지 않은 상태. */
const NOT_STARTED = ["미발송", "초대발송", "미접속"];
/** 더 보낼 이유가 없는 상태 — 독려 대상에서 빠진다. */
const FINISHED = ["제출", "승인"];

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function origin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

function splitList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

function MailPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { companyId } = useCompanyScope();
  const { isApproved, approve, revoke } = useMailApprovals();

  const { data: mode } = useQuery({
    queryKey: ["mail-mode"],
    queryFn: () => mailModeStatus(),
  });

  const hasTargetHint = Boolean(search.template || search.org || search.status || search.ids);
  const tab = search.tab ?? (hasTargetHint ? "send" : "templates");

  function goTab(next: MailTab, extra?: Partial<MailSearch>) {
    void navigate({ search: (prev: MailSearch) => ({ ...prev, ...extra, tab: next }) });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">안내·독려 메일</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          초대 및 안내 메일의 템플릿, 발송, 이력을 관리합니다.
        </p>
      </div>

      {mode?.simulation && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-semibold text-warning">{COPY.simulationMode}</p>
            <p className="mt-1 text-muted-foreground">
              메일 발송 키가 등록되지 않아 실제 메일은 나가지 않고 발송 기록만 남습니다. 실제로
              보내려면 운영 설정에서 발송 키를 등록해야 합니다.
            </p>
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => goTab(v as MailTab)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="templates" className="flex-1 sm:flex-none">
            템플릿
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex-1 sm:flex-none">
            미리보기
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
        <TabsContent value="preview" className="mt-4">
          <MailPreviewGallery
            companyId={companyId === "all" ? null : companyId}
            isApproved={isApproved}
            onApprove={approve}
            onRevoke={revoke}
            onGoSend={(templateId) => goTab("send", { template: templateId })}
          />
        </TabsContent>
        <TabsContent value="send" className="mt-4">
          <SendTab
            search={search}
            simulation={Boolean(mode?.simulation)}
            isApproved={isApproved}
            onOpenPreview={() => goTab("preview")}
          />
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
  const [preview, setPreview] = useState<{
    sampleName: string | null;
    subject: string;
    body: string;
    html: string;
  } | null>(null);
  const [imageWidth, setImageWidth] = useState(DEFAULT_IMAGE_WIDTH);
  const [uploading, setUploading] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef<"subject" | "body">("body");

  const { data: templates, isLoading } = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => listTemplates(),
  });

  const saveMutation = useMutation({
    mutationFn: (input: EditorState) => upsertTemplate({ data: input }),
    onSuccess: () => {
      toast.success("템플릿이 저장되었습니다. 미리보기 탭에서 다시 확인해 주세요.");
      setEditor(null);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["mail-templates"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-preview-all"] });
    },
    onError: (err) => toast.error(`저장에 실패했습니다: ${errorMessage(err)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTemplate({ data: { id } }),
    onSuccess: () => {
      toast.success("템플릿이 삭제되었습니다.");
      void queryClient.invalidateQueries({ queryKey: ["mail-templates"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-preview-all"] });
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

  /** 마지막으로 포커스된 입력의 커서 위치에 토큰을 끼워 넣는다(이미지는 본문에만). */
  function insertToken(token: string, target?: "subject" | "body") {
    if (!editor) return;
    const field = target ?? focusedRef.current;
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

  /** 이미지는 공개 버킷에 올리고 본문에는 경로 토큰만 남긴다(발송 시 <img> 로 변환). */
  async function uploadImage(file: File) {
    if (!["image/png", "image/jpeg", "image/gif"].includes(file.type)) {
      toast.error("PNG · JPG · GIF 이미지만 삽입할 수 있습니다.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("이미지는 2MB 이하만 삽입할 수 있습니다.");
      return;
    }
    setUploading(true);
    const path = `${Date.now()}_${file.name.replace(/[^A-Za-z0-9.]+/g, "_").slice(-60)}`;
    const { error } = await supabase.storage
      .from(MAIL_ASSET_BUCKET)
      .upload(path, file, { contentType: file.type });
    setUploading(false);
    if (error) {
      toast.error(`이미지 업로드에 실패했습니다: ${error.message}`);
      return;
    }
    insertToken(imageToken(path, imageWidth), "body");
    toast.success("본문 커서 위치에 이미지를 삽입했습니다.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">총 {templates?.length ?? 0}개의 템플릿</p>
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
                      {MAIL_KIND_LABELS[t.kind] ?? t.kind}
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
          <h2 className="text-base font-semibold">{editor.id ? "템플릿 편집" : "새 템플릿"}</h2>

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
                  <SelectItem value="reminder">독려 안내</SelectItem>
                  <SelectItem value="custom">일반</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>자동 입력 항목</Label>
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
              클릭하면 마지막으로 편집하던 입력창의 커서 위치에 삽입됩니다. 여기 없는 이름을 직접
              적으면 치환되지 않고 그대로 발송됩니다.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border bg-background p-3">
            <Label htmlFor="tpl-image-width">이미지 삽입</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="tpl-image-width"
                type="number"
                min={80}
                max={MAX_IMAGE_WIDTH}
                value={imageWidth}
                onChange={(e) => setImageWidth(Number(e.target.value))}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">px 폭으로</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                <ImagePlus className="size-4" />
                {uploading ? "올리는 중..." : "이미지 삽입"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadImage(file);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              PNG · JPG · GIF, 2MB 이하. 최대 폭 {MAX_IMAGE_WIDTH}px. 본문 커서 위치에 이미지 자리
              표시가 삽입되고 발송 시 그림으로 바뀝니다.
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
                  ? `표본 참여자: ${preview.sampleName} (초기 비밀번호는 가려서 보여 줍니다)`
                  : "참여자 데이터가 없어 예시 값으로 치환했습니다."}
              </p>
              <p className="mt-3 font-semibold">{preview.subject}</p>
              <iframe
                title="메일 미리보기"
                sandbox=""
                srcDoc={preview.html}
                className="mt-2 h-96 w-full rounded-md border bg-white"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                실제 메일에서 보이는 모습입니다. 메일 프로그램에 따라 여백·글꼴은 조금 다를 수
                있습니다.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
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

function SendTab({
  search,
  simulation,
  isApproved,
  onOpenPreview,
}: {
  search: MailSearch;
  simulation: boolean;
  isApproved: (templateId: string, updatedAt: string | null | undefined) => boolean;
  onOpenPreview: () => void;
}) {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const filterCompanyId = companyId === "all" ? null : companyId;
  const { selectedOrgId, setSelectedOrgId } = useOrgLens();

  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [statuses, setStatuses] = useState<string[]>(() =>
    splitList(search.status).filter((s) => (ACCOUNT_STATUS_LABELS as readonly string[]).includes(s)),
  );
  const [scheduledAt, setScheduledAt] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkAck, setBulkAck] = useState(false);
  const [sendLimit, setSendLimit] = usePersistedState<number>(
    "mail-send-limit",
    DEFAULT_SEND_LIMIT,
  );

  const pinnedIds = useMemo(
    () => splitList(search.ids).filter((id) => UUID_RE.test(id)),
    [search.ids],
  );

  const { data: templates } = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => listTemplates(),
  });

  // ?template= 은 템플릿 id 또는 종류(invite·reminder·custom) 둘 다 받는다.
  useEffect(() => {
    if (!search.template || !templates?.length) return;
    const hit =
      templates.find((t) => t.id === search.template) ??
      templates.find((t) => t.kind === search.template);
    if (hit) setTemplateId(hit.id);
  }, [search.template, templates]);

  // ?org= 로 넘어온 소속을 공용 렌즈에 반영한다 — 다른 화면에서 보던 조직을 그대로 이어받는다.
  useEffect(() => {
    if (search.org && search.org !== selectedOrgId) setSelectedOrgId(search.org);
  }, [search.org, selectedOrgId, setSelectedOrgId]);

  const {
    data: targets,
    isFetching: targetsLoading,
    error: targetsError,
  } = useQuery({
    queryKey: ["mail-send-targets", filterCompanyId, statuses, pinnedIds],
    queryFn: () =>
      listSendTargets({
        data: {
          companyId: filterCompanyId,
          statuses,
          ...(pinnedIds.length ? { participantIds: pinnedIds } : {}),
        },
      }),
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
  const nothingToRemind = isReminder && included.length > 0 && reminderTargets.length === 0;

  const overLimit = included.length > sendLimit;
  const asOfLabel = targets?.asOf
    ? targets.asOf.slice(0, 16).replace("T", " ")
    : "";

  /**
   * 즉시 발송은 확인한 명단을 그대로 고정해서 보낸다(화면과 실제 발송이 어긋나지 않게).
   * 예약은 발송 시각의 명부를 다시 계산하는 것이 자연스러워 조건만 넘기되,
   * 소속·참여자 지정처럼 조건으로 표현할 수 없는 선택이 있으면 그때도 명단을 고정한다.
   */
  const freezeList = !scheduledAt || Boolean(selectedOrgId) || pinnedIds.length > 0;

  const sendMutation = useMutation({
    mutationFn: () =>
      sendMailBatch({
        data: {
          name: name.trim() || `메일 발송 ${new Date().toISOString().slice(0, 10)}`,
          templateId,
          filters: {
            companyId: filterCompanyId,
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
      if (result.scheduled) toast.success("발송이 예약되었습니다. 이력 탭에서 확인·취소할 수 있습니다.");
      else
        toast.success(
          `발송 완료 — 성공 ${result.sent ?? 0}건 / 실패 ${result.failed ?? 0}건${
            result.simulated ? ` (${COPY.simulationMode})` : ""
          }`,
        );
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-send-targets"] });
    },
    onError: (err) => toast.error(`발송에 실패했습니다: ${errorMessage(err)}`),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      sendTestMail({
        data: { templateId, companyId: filterCompanyId, origin: origin() },
      }),
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

  const reminderMutation = useMutation({
    mutationFn: () => triggerReminders({ data: { companyId: filterCompanyId, origin: origin() } }),
    onSuccess: (result) => {
      const sent = result.results.reduce((acc, r) => acc + r.sent, 0);
      toast.success(`독려 안내 ${sent}건을 처리했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`독려 안내 발송에 실패했습니다: ${errorMessage(err)}`),
  });

  function toggleStatus(status: string, checked: boolean) {
    setStatuses((prev) => (checked ? [...prev, status] : prev.filter((s) => s !== status)));
  }

  const blockedReason = !templateId
    ? "먼저 템플릿을 고르세요."
    : !approved
      ? "미리보기에서 이 템플릿의 실물을 확인해야 발송할 수 있습니다."
      : included.length === 0
        ? "조건에 맞는 수신 대상이 없습니다."
        : null;

  return (
    <div className="space-y-4">
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
              actions={[{ label: "미리보기에서 확인", onClick: onOpenPreview }]}
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
              이력 탭에서 이 이름으로 찾습니다. 비우면 오늘 날짜로 붙습니다.
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
              선택하지 않으면 상태와 무관하게 전체가 대상이 됩니다.
            </p>
          </div>

          {pinnedIds.length > 0 && (
            <p className="rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-xs text-accent-foreground">
              다른 화면에서 지정한 {pinnedIds.length}명으로 대상을 좁혀 두었습니다. 계정 상태·소속
              조건은 이 명단 안에서만 적용됩니다.
            </p>
          )}

          {targetsError ? (
            <EmptyState
              kind="blocked"
              title="대상자를 불러오지 못했습니다"
              description={`원인: ${errorMessage(targetsError)} — 잠시 후 다시 시도해 주세요. 대상자 수를 확인하기 전에는 발송하지 않습니다.`}
            />
          ) : (
            <div className="rounded-lg border bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">
                {companyId === "all" ? "전체 계열사" : "선택 계열사"} ·{" "}
                {orgPathLabel(units, selectedOrgId)}
                {statuses.length ? ` · 상태 ${statuses.join("·")}` : " · 상태 전체"}
              </p>
              <p className="mt-1 text-lg font-bold">
                보낼 사람 {targetsLoading ? "…" : included.length}명
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {excluded.length > 0
                  ? `이메일이 없어 제외된 ${excluded.length}명은 발송 대상이 아닙니다.`
                  : "제외된 사람은 없습니다."}
                {asOfLabel ? ` · 기준 ${asOfLabel}` : ""}
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
              {...(asOfLabel ? { asOf: asOfLabel } : {})}
            />
          )}

          {isReminder && reminderTargets.length > 0 && (
            <div className="rounded-lg border bg-background p-4">
              <p className="text-sm font-semibold">
                왜 이 {reminderTargets.length}명이 독려 대상인지
              </p>
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
                  화면에는 50명까지 보여 줍니다. 나머지 {reminderTargets.length - 50}명도 같은
                  조건으로 발송됩니다.
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
                : "예약은 발송 시각의 명부를 다시 계산하므로, 그때 추가된 사람도 포함됩니다."}
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
                  <dd className="text-base font-bold">{included.length}명</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">제외</dt>
                  <dd className="text-base font-bold">{excluded.length}명</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">예상 소요</dt>
                  <dd className="text-base font-bold">
                    {durationLabel(included.length, simulation)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">소속</dt>
                  <dd className="truncate text-sm font-semibold">
                    {orgPathLabel(units, selectedOrgId)}
                  </dd>
                </div>
              </dl>

              {excluded.length > 0 && (
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

              {archivedCount > 0 && (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  보관 처리된 참여자 {archivedCount}명이 대상에 들어 있습니다. 보내지 않으려면
                  참여자 관리에서 제외한 뒤 다시 시도하세요.
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
                      상한 {sendLimit}통을 넘는 {included.length}통입니다. 한 번에 많이 보내면
                      메일 서버가 일부를 거절할 수 있습니다 — 그래도 보내겠습니다.
                    </span>
                  </label>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-semibold">받는 사람 명단</p>
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border bg-background p-2">
                  {included.slice(0, 200).map((r) => (
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
                  {included.length === 0 && (
                    <li className="px-2 py-1 text-sm text-muted-foreground">
                      조건에 맞는 수신 대상이 없습니다.
                    </li>
                  )}
                </ul>
                {included.length > 200 && (
                  <p className="text-xs text-muted-foreground">
                    화면에는 200명까지 보여 줍니다. 실제로는 {included.length}명 전원에게 나갑니다.
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
                    included.length === 0 ||
                    (overLimit && !bulkAck) ||
                    !approved
                  }
                >
                  <Send className="size-4" />
                  {sendMutation.isPending
                    ? "처리 중..."
                    : scheduledAt
                      ? "예약 등록"
                      : `${included.length}명에게 발송`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">독려 안내 수동 실행</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          계열사 설정에 저장된 독려 안내 템플릿과 대상 조건으로 즉시 발송합니다. 위의 소속·상태
          선택과는 무관하게 계열사 설정을 따릅니다.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => reminderMutation.mutate()}
          disabled={reminderMutation.isPending}
        >
          <RotateCw className="size-4" />
          {reminderMutation.isPending ? "발송 중..." : "독려 안내 발송"}
        </Button>
      </div>
    </div>
  );
}

function HistoryTab() {
  const queryClient = useQueryClient();
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  const { data: batches, isLoading } = useQuery({
    queryKey: ["mail-batches"],
    queryFn: () => listBatches(),
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
        description="발송 탭에서 템플릿과 대상을 고르고 한 번 보내면, 여기에 성공·실패·발송 후 접속이 사람별로 남습니다."
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

type LogBucket = "all" | "성공" | "실패" | "접속";

const BUCKET_LABELS: Record<LogBucket, string> = {
  all: "전체",
  성공: "성공",
  실패: "실패",
  접속: "발송 후 접속",
};

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
      if (result.total === 0) toast.info("재발송할 실패 건이 없습니다(이미 재발송되었습니다).");
      else
        toast.success(`실패 ${result.total}건 재발송 — 성공 ${result.ok}건 / 실패 ${result.failed}건`);
      void queryClient.invalidateQueries({ queryKey: ["mail-logs", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["mail-batches"] });
    },
    onError: (err) => toast.error(`일괄 재발송에 실패했습니다: ${errorMessage(err)}`),
  });

  if (isLoading) {
    return <p className="border-t px-4 py-3 text-sm text-muted-foreground">불러오는 중...</p>;
  }

  const rows = logs ?? [];
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
    return log.status !== "실패" && Boolean(seen) && Date.parse(seen as string) > Date.parse(log.sent_at);
  }

  const counts = {
    all: rows.length,
    성공: rows.filter((l) => l.status !== "실패").length,
    실패: rows.filter((l) => l.status === "실패").length,
    접속: rows.filter(accessedAfterSend).length,
  };

  const visible = rows.filter((log) => {
    if (bucket === "all") return true;
    if (bucket === "실패") return log.status === "실패";
    if (bucket === "접속") return accessedAfterSend(log);
    return log.status !== "실패";
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
        {counts.실패 > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => resendFailedMutation.mutate()}
            disabled={resendFailedMutation.isPending}
          >
            <RotateCw className="size-4" />
            {resendFailedMutation.isPending ? "재발송 중..." : "실패 건 재발송"}
          </Button>
        )}
      </div>

      {bucket === "접속" && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          메일을 열었는지는 추적하지 않습니다. 발송 시각 뒤에 시스템에 접속한 기록이 있는 사람만
          셉니다.
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
                </p>
                {log.status === "실패" && (
                  <p className="mt-1 text-xs text-destructive">{failureHelp(log.error_message)}</p>
                )}
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
                  {log.status === "시뮬레이션" ? "실제 발송 안 함" : log.status}
                </span>
                {accessedAfterSend(log) && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
                    <Eye className="size-3" /> 접속
                  </span>
                )}
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
      )}
    </div>
  );
}
