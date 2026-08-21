import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ImagePlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { ScreenAlert } from "@/components/admin/ScreenAlert";
import { MailPreviewGallery, useMailApprovals } from "@/components/admin/MailPreviewGallery";
import { MailHealthCard } from "@/components/admin/MailHealthCard";
import { MailBatchHistory, MailSendPanel } from "@/components/admin/MailSendPanel";
import { pickLens, type LensSearch } from "@/lib/lens-search";
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
  deleteTemplate,
  listTemplates,
  previewTemplate,
  upsertTemplate,
} from "@/lib/mail.functions";

/**
 * 메일 화면의 주소 규약 (기획 P6 · v4 A4).
 *
 * v4에서 상시 발송은 차수 상세(waves.tsx)로 옮겼다. 이 화면은 템플릿·미리보기·전체 이력을
 * 맡고, 이력 탭 안의 「차수 없이 보내기」 구획이 공지 등 예외 발송을 받는다.
 * 다른 화면(참여자 관리·대시보드)이 대상을 실어 보내는 값은 그대로 받는다:
 *   ?tab=templates|preview|history  탭 지정 (예전 send 는 history 로 받는다)
 *   ?template=<템플릿 id 또는 종류>  종류는 invite | reminder | custom
 *   ?co=<계열사 id> ?org=<소속 id>   계열사·소속 렌즈 (기획 v2 P2) — 모든 관리 화면이 공유한다
 *   ?status=<계정 상태>              쉼표로 여러 개. 예: status=초대발송,미접속
 *   ?ids=<참여자 id>                 쉼표로 여러 개. 이 사람들로만 대상을 좁힌다
 * 대상 지정 값이 있으면 이력 탭으로 열리고 예외 발송 구획이 펼쳐진 채 시작한다.
 */
const TAB_VALUES = ["templates", "preview", "history"] as const;
export type MailTab = (typeof TAB_VALUES)[number];

export type MailSearch = LensSearch & {
  tab?: MailTab;
  template?: string;
  status?: string;
  ids?: string;
};

function searchText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const Route = createFileRoute("/_authenticated/admin/mail")({
  validateSearch: (search: Record<string, unknown>): MailSearch => {
    const out: MailSearch = { ...pickLens(search) };
    let tab = searchText(search["tab"]);
    // 예전 주소 호환: 발송 탭은 없어졌고, 그 일은 이력 탭의 예외 발송 구획이 한다.
    if (tab === "send") tab = "history";
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
      { title: "메일 템플릿 | 서연 그룹 업무조사" },
      { name: "description", content: "메일 템플릿과 발송 이력을 관리합니다." },
      { property: "og:title", content: "메일 템플릿 | 서연 그룹 업무조사" },
      { property: "og:description", content: "메일 템플릿과 발송 이력을 관리합니다." },
    ],
  }),
  component: MailPage,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function MailPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { companyId } = useCompanyScope();
  const { isApproved, approve, revoke } = useMailApprovals();
  const filterCompanyId = companyId === "all" ? null : companyId;

  const hasTargetHint = Boolean(search.template || search.org || search.status || search.ids);
  const tab = search.tab ?? (hasTargetHint ? "history" : "templates");

  // 예외 발송은 평소에는 접어 둔다 — 상시 경로는 차수 상세다. 대상을 실어 온 경우만 펼친다.
  const [exceptionOpen, setExceptionOpen] = useState(hasTargetHint);
  // 미리보기 탭의 「발송 탭으로」처럼 화면 안에서 대상이 실려 와도 펼친다.
  useEffect(() => {
    if (hasTargetHint) setExceptionOpen(true);
  }, [hasTargetHint]);

  const pinnedIds = useMemo(
    () => splitList(search.ids).filter((id) => UUID_RE.test(id)),
    [search.ids],
  );

  function goTab(next: MailTab, extra?: Partial<MailSearch>) {
    void navigate({ search: (prev: MailSearch) => ({ ...prev, ...extra, tab: next }) });
  }

  return (
    <div className="space-y-6">
      {/* 이 화면 몫의 경고 — 발송 실패·메일 반송 (v6 G4) */}
      <ScreenAlert screen="mail" />
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">메일 템플릿</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          안내 메일의 문구와 발송 이력을 관리합니다. 참여자에게 보내는 일은 차수 관리 화면에서
          차수를 골라 진행하세요.
        </p>
      </div>

      {/* 연습/실발송 여부, 발신 도메인 인증, 오늘 남은 여유를 한 장에서 확인한다 (기획 F1). */}
      <MailHealthCard />

      <Tabs value={tab} onValueChange={(v) => goTab(v as MailTab)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="templates" className="flex-1 sm:flex-none">
            템플릿
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex-1 sm:flex-none">
            미리보기
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
            companyId={filterCompanyId}
            isApproved={isApproved}
            onApprove={approve}
            onRevoke={revoke}
            onGoSend={(templateId) => goTab("history", { template: templateId })}
          />
        </TabsContent>
        <TabsContent value="history" className="mt-4 space-y-4">
          <div className="rounded-xl border bg-card shadow-sm">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 p-4 text-left"
              onClick={() => setExceptionOpen((v) => !v)}
              aria-expanded={exceptionOpen}
            >
              <div>
                <p className="font-semibold">차수 없이 보내기 (공지 등 예외 발송)</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  조사 안내·독려는 차수 상세의 발송 구획을 쓰세요. 여기서는 차수와 무관한 공지를
                  소속·상태 조건으로 보냅니다.
                </p>
              </div>
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                  exceptionOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {exceptionOpen && (
              <div className="border-t p-4">
                <MailSendPanel
                  companyId={filterCompanyId}
                  pinnedIds={pinnedIds}
                  {...(search.template ? { initialTemplate: search.template } : {})}
                  initialStatuses={splitList(search.status)}
                  onOpenPreview={() => goTab("preview")}
                />
              </div>
            )}
          </div>

          <MailBatchHistory />
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
