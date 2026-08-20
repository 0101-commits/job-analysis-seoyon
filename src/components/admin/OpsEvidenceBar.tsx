import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Info } from "lucide-react";
import { mailModeStatus } from "@/lib/admin.functions";
import { aiProxyStatus } from "@/lib/ai.functions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COPY } from "@/lib/glossary";
import { cn } from "@/lib/utils";

/**
 * 운영 증거 바 (기획 B7).
 *
 * 이 프로젝트에서 가장 오래 끌었던 마찰은 "됐다는데 내 눈엔 안 보임"이었다 —
 * 배포·메일·AI 모두. 지금 화면이 어느 판(버전)이고, 메일이 실제로 나가는지,
 * AI가 붙어 있는지를 관리자 헤더에 늘 띄워 두고, 각 항목을 누르면
 * 그게 무슨 뜻이고 어떻게 바꾸는지까지 읽을 수 있게 한다.
 */

type Tone = "ok" | "warn" | "idle";

const TONE: Record<Tone, string> = {
  ok: "bg-success/15 text-success border-success/30",
  warn: "bg-warning/15 text-warning border-warning/30",
  idle: "bg-muted text-muted-foreground border-border",
};

function Chip({
  tone,
  title,
  value,
  children,
}: {
  tone: Tone;
  title: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80",
          TONE[tone],
        )}
      >
        {tone === "warn" ? (
          <AlertTriangle className="size-3" aria-hidden />
        ) : tone === "ok" ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Info className="size-3" aria-hidden />
        )}
        <span className="text-muted-foreground">{title}</span>
        <span className="font-semibold">{value}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-sm leading-relaxed">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** 빌드 시각 문자열을 사람이 읽는 형태로. 값이 없으면 그대로 없다고 말한다. */
function buildLabel(version: string | undefined, builtAt: string | undefined) {
  if (!version && !builtAt) return "확인 불가";
  const when = builtAt ? new Date(builtAt) : null;
  const stamp =
    when && !Number.isNaN(when.getTime())
      ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
      : null;
  return [version, stamp].filter(Boolean).join(" · ");
}

export function OpsEvidenceBar() {
  const version = import.meta.env["VITE_APP_VERSION"] as string | undefined;
  const builtAt = import.meta.env["VITE_BUILD_TIME"] as string | undefined;
  const hasBuildInfo = Boolean(version || builtAt);

  const { data: mail, isPending: mailPending } = useQuery({
    queryKey: ["mail-mode"],
    queryFn: () => mailModeStatus(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: ai, isPending: aiPending } = useQuery({
    queryKey: ["ai-proxy-status"],
    queryFn: () => aiProxyStatus(),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 sm:px-6">
      <Chip
        tone={hasBuildInfo ? "idle" : "warn"}
        title="이 화면"
        value={buildLabel(version, builtAt)}
      >
        <p className="font-semibold">지금 보고 있는 화면이 언제 올라간 것인지</p>
        <p className="mt-1 text-muted-foreground">
          {hasBuildInfo
            ? "고친 내용이 반영됐는지 의심될 때 이 값을 확인하세요. 값이 그대로면 아직 예전 화면을 보고 있는 것입니다. 그럴 때는 새로 고침(Ctrl+Shift+R)을 하세요."
            : "배포한 판을 알려 주는 값이 아직 화면에 들어오지 않았습니다. 값이 없으면 새 배포가 반영됐는지 눈으로 확인할 방법이 없으니, 개발 담당자에게 배포 정보 표시를 요청하세요."}
        </p>
      </Chip>

      <Chip
        tone={mailPending ? "idle" : mail?.simulation ? "warn" : "ok"}
        title="메일"
        value={mailPending ? "확인 중" : mail?.simulation ? "연습 모드" : "실제 발송"}
      >
        <p className="font-semibold">
          {mail?.simulation ? COPY.simulationMode : "누른 메일은 실제로 참여자에게 갑니다"}
        </p>
        <p className="mt-1 text-muted-foreground">
          {mail?.simulation
            ? "발송 버튼을 눌러도 참여자에게 메일이 가지 않고 보낸 내역만 남습니다. 문구를 미리 확인할 때는 이 상태가 안전하고, 실제로 보내야 할 때는 운영 담당자에게 메일 발송 키 등록을 요청하세요."
            : "안내·독려 메일이 곧바로 참여자 메일함으로 갑니다. 보내기 전 받는 사람 범위를 반드시 확인하세요."}
        </p>
        <Link
          to="/admin/mail"
          className="mt-2 inline-block text-xs font-medium text-primary underline"
        >
          안내·독려 메일 화면 열기
        </Link>
      </Chip>

      <Chip
        tone={aiPending ? "idle" : ai?.configured ? "ok" : "warn"}
        title="AI"
        value={aiPending ? "확인 중" : ai?.configured ? "연결됨" : "연결 안 됨"}
      >
        <p className="font-semibold">
          {ai?.configured
            ? "AI 도움 기능을 쓸 수 있습니다"
            : "AI 도움 기능이 지금은 동작하지 않습니다"}
        </p>
        <p className="mt-1 text-muted-foreground">
          {ai?.configured
            ? "오탈자 점검·초안 만들기 같은 도움 기능이 응답합니다. 실제로 답하는지 의심되면 아래 화면에서 연결을 점검하세요."
            : "AI 서버 주소가 등록되지 않아 오탈자 점검·초안 만들기를 눌러도 아무 일도 일어나지 않습니다. 운영 담당자에게 AI 서버 주소 등록을 요청하세요."}
        </p>
        <Link
          to="/admin/ai"
          className="mt-2 inline-block text-xs font-medium text-primary underline"
        >
          AI 일괄 점검 화면에서 연결 확인
        </Link>
      </Chip>
    </div>
  );
}
