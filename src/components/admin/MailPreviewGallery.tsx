import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { usePersistedState } from "@/hooks/use-persisted-ui";
import { MAIL_KIND_LABELS } from "@/lib/mail-vars";
import { previewAllTemplates } from "@/lib/mail.functions";

/**
 * 발송 전 실물 미리보기 갤러리 (기획 B6 · P8).
 *
 * 메일은 한 번 나가면 되돌릴 수 없다. 그래서 이 화면은 등록된 템플릿 **전부**를
 * 실제 수신자 한 명의 값으로 치환해 실물 그대로 보여 주고, 관리자가 눈으로 확인한 뒤
 * 템플릿별로 승인해야 발송 화면에서 그 템플릿을 쓸 수 있게 한다.
 *
 * 승인은 템플릿의 수정 시각(`updated_at`)과 함께 기억한다. 템플릿을 고치면 승인은
 * 자동으로 풀리고 다시 확인해야 한다 — "예전에 승인했던 것" 이 조용히 나가지 않게.
 */

const WIDTHS = { desktop: 640, mobile: 380 } as const;
type Viewport = keyof typeof WIDTHS;

/** 승인 상태 = 템플릿 id → 승인 당시의 updated_at. 관리자 브라우저에 남긴다. */
export function useMailApprovals() {
  const [approvals, setApprovals] = usePersistedState<Record<string, string>>("mail-approved", {});
  const isApproved = (templateId: string, updatedAt: string | null | undefined) =>
    Boolean(updatedAt) && approvals[templateId] === updatedAt;
  const approve = (templateId: string, updatedAt: string) =>
    setApprovals((prev) => ({ ...prev, [templateId]: updatedAt }));
  const revoke = (templateId: string) =>
    setApprovals((prev) => {
      const next = { ...prev };
      delete next[templateId];
      return next;
    });
  return { approvals, isApproved, approve, revoke };
}

function origin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

export function MailPreviewGallery({
  companyId,
  isApproved,
  onApprove,
  onRevoke,
  onGoSend,
}: {
  /** 표본 참여자를 고르는 범위. `null` 이면 전체 계열사. */
  companyId: string | null;
  isApproved: (templateId: string, updatedAt: string | null | undefined) => boolean;
  onApprove: (templateId: string, updatedAt: string) => void;
  onRevoke: (templateId: string) => void;
  /** 승인한 템플릿으로 발송 화면으로 넘어간다. */
  onGoSend: (templateId: string) => void;
}) {
  const [participantId, setParticipantId] = usePersistedState<string | null>(
    "mail-preview-sample",
    null,
  );
  const [viewport, setViewport] = usePersistedState<Viewport>("mail-preview-viewport", "desktop");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mail-preview-all", companyId, participantId],
    queryFn: () =>
      previewAllTemplates({
        data: { companyId, participantId, origin: origin() },
      }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">미리보기를 만드는 중...</p>;

  if (error) {
    return (
      <EmptyState
        kind="blocked"
        title="미리보기를 만들지 못했습니다"
        description={`원인: ${error instanceof Error ? error.message : "알 수 없는 오류"} — 잠시 후 다시 시도하거나 템플릿 내용을 확인해 주세요.`}
      />
    );
  }

  const previews = data?.previews ?? [];
  if (previews.length === 0) {
    return (
      <EmptyState
        kind="nothing"
        title="등록된 메일 템플릿이 없습니다"
        description="템플릿 탭에서 초대 메일을 먼저 만들면 여기에서 실물 모습을 확인하고 승인할 수 있습니다."
      />
    );
  }

  const problemCount = previews.filter((p) => p.unreplaced.length > 0).length;
  const width = WIDTHS[viewport];

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              어느 참여자 기준으로 볼지
            </p>
            <Select
              value={participantId ?? "auto"}
              onValueChange={(v) => setParticipantId(v === "auto" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">자동 선택 (사번 순 첫 참여자)</SelectItem>
                {(data?.candidates ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.emp_no}
                    {c.org_text ? ` · ${c.org_text}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">보이는 폭</p>
            <div className="flex gap-1 rounded-lg border bg-background p-1">
              <Button
                type="button"
                size="sm"
                variant={viewport === "desktop" ? "default" : "ghost"}
                onClick={() => setViewport("desktop")}
              >
                <Monitor className="size-4" /> 컴퓨터
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewport === "mobile" ? "default" : "ghost"}
                onClick={() => setViewport("mobile")}
              >
                <Smartphone className="size-4" /> 휴대폰
              </Button>
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {data?.sampleName
            ? `${data.sampleName} (${data.sampleEmail}) 님의 값으로 치환했습니다. 초기 비밀번호는 ●●●● 로 가려 두었고 실제 메일에는 본인 비밀번호가 들어갑니다.`
            : "참여자 데이터가 없어 예시 값으로 치환했습니다. 명부를 올린 뒤 다시 확인해 주세요."}
        </p>

        {problemCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-xs leading-relaxed text-destructive">
              템플릿 {problemCount}개에 채워지지 않은 항목이 남아 있습니다. 그대로 보내면 수신자
              화면에 중괄호가 그대로 보입니다. 템플릿 탭에서 항목 이름을 고쳐 주세요.
            </p>
          </div>
        )}
      </div>

      <ul className="space-y-4">
        {previews.map((p) => {
          const approved = isApproved(p.id, p.updatedAt);
          const blocked = p.unreplaced.length > 0;
          return (
            <li key={p.id} className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {p.name}
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {MAIL_KIND_LABELS[p.kind] ?? p.kind}
                    </span>
                    {approved && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-normal text-success">
                        <CheckCircle2 className="size-3" /> 확인함
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">제목: {p.subject}</p>
                  {blocked && (
                    <p className="mt-1.5 text-xs font-medium text-destructive">
                      채워지지 않은 항목: {p.unreplaced.join(", ")} — 이 이름의 자동 입력 항목이
                      없습니다. 템플릿에서 지우거나 올바른 이름으로 바꿔 주세요.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {approved ? (
                    <>
                      <Button size="sm" onClick={() => onGoSend(p.id)}>
                        이 템플릿으로 발송
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onRevoke(p.id)}>
                        확인 취소
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={blocked}
                      onClick={() => onApprove(p.id, p.updatedAt)}
                    >
                      내용을 확인했습니다
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex justify-center bg-secondary/40 p-3">
                <iframe
                  title={`${p.name} 미리보기`}
                  sandbox=""
                  srcDoc={p.html}
                  style={{ width: `${width}px` }}
                  className="h-[520px] max-w-full rounded-md border bg-white"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
