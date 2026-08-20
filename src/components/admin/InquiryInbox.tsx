import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

/**
 * F6 문의함(관리자) — 참여자가 보낸 문의를 확인하고 답변한다.
 *
 * 서버함수(listInquiries·answerInquiry)는 다른 담당이 만든 src/lib/inquiry.functions.ts 에 있다.
 * 그 파일이 아직 없거나 함수 이름이 바뀌어도 검토 화면 전체가 죽지 않도록 불러오기를 감싸고,
 * 실패하면 무엇이 안 됐는지 적고 다시 시도할 수 있게 한다(조용히 빈 화면을 보여주지 않는다).
 */

const CATEGORIES = ["직무없음", "항목이해", "접속문제", "기타"] as const;
/** 같은 유형이 이만큼 쌓이면 개별 답변이 아니라 안내·화면을 고쳐야 한다는 신호다. */
export const INQUIRY_ALERT_LIMIT = 5;

export interface InquiryRow {
  id: string;
  category: string;
  body: string;
  status: string;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
  participants: {
    name: string;
    emp_no: string;
    org_text: string | null;
    companies: { name: string } | null;
  } | null;
}

/** 다른 담당 소유 파일이므로 타입을 빌려오지 않고 호출 모양만 좁게 적는다. */
type InquiryApi = {
  listInquiries: (args: {
    data: { status: string | null; category: string | null };
  }) => Promise<unknown>;
  answerInquiry: (args: { data: { id: string; answer: string } }) => Promise<unknown>;
};

async function inquiryApi(): Promise<Partial<InquiryApi>> {
  try {
    return (await import("@/lib/inquiry.functions")) as unknown as Partial<InquiryApi>;
  } catch {
    throw new Error("문의함 기능(inquiry.functions)을 불러오지 못했습니다.");
  }
}

async function loadInquiries(): Promise<InquiryRow[]> {
  const api = await inquiryApi();
  if (typeof api.listInquiries !== "function") {
    throw new Error("문의함 조회 기능이 아직 연결되지 않았습니다.");
  }
  const result = await api.listInquiries({ data: { status: null, category: null } });
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  return rows as InquiryRow[];
}

/** 문의 전체를 한 번 읽어 온다. 접힌 구획에서도 배지를 띄우려면 화면 쪽에서 이 훅을 쓴다. */
export function useInquiries(): UseQueryResult<InquiryRow[], Error> {
  return useQuery<InquiryRow[], Error>({
    queryKey: ["inquiries"],
    queryFn: loadInquiries,
    retry: false,
  });
}

/** 같은 유형이 기준치 이상 쌓였는지 — 화면 상단 주의 표시의 근거. */
export function inquiryAlerts(rows: InquiryRow[] | undefined) {
  const counts: Record<string, number> = {};
  for (const r of rows ?? []) {
    if (r.status !== "접수") continue;
    counts[r.category] = (counts[r.category] ?? 0) + 1;
  }
  return {
    pending: Object.values(counts).reduce((a, b) => a + b, 0),
    heavy: Object.entries(counts)
      .filter(([, n]) => n >= INQUIRY_ALERT_LIMIT)
      .map(([category, n]) => ({ category, count: n })),
  };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

function daysSince(value: string) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.floor((Date.now() - t) / 86_400_000);
}

export function InquiryInbox({ query }: { query: UseQueryResult<InquiryRow[], Error> }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>("접수");
  const [category, setCategory] = useState<string>("all");
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  const answerMutation = useMutation({
    mutationFn: async (payload: { id: string; answer: string }) => {
      const api = await inquiryApi();
      if (typeof api.answerInquiry !== "function") {
        throw new Error("문의 답변 기능이 아직 연결되지 않았습니다.");
      }
      return api.answerInquiry({ data: payload });
    },
    onSuccess: () => {
      toast.success("답변을 보냈습니다. 참여자 화면에 바로 표시됩니다.");
      setAnswering(null);
      setAnswer("");
      void queryClient.invalidateQueries({ queryKey: ["inquiries"] });
    },
    onError: (err) => toast.error(`답변하지 못했습니다: ${errorMessage(err)}`),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;

  if (query.isError) {
    return (
      <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            문의를 불러오지 못했습니다 — {errorMessage(query.error)}
            <br />
            다른 검토 작업은 그대로 진행할 수 있습니다.
          </span>
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          다시 시도
        </Button>
      </div>
    );
  }

  const all = query.data ?? [];
  const { heavy } = inquiryAlerts(all);
  const rows = all.filter(
    (r) =>
      (status === "all" || r.status === status) && (category === "all" || r.category === category),
  );

  return (
    <div className="space-y-4">
      {heavy.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            {heavy.map((h) => `${h.category} ${h.count}건`).join(" · ")}이 답변을 기다립니다. 같은
            유형이 {INQUIRY_ALERT_LIMIT}건 넘게 쌓였다면 한 명씩 답하기보다 안내 문구나 해당 화면을
            고치는 편이 빠릅니다.
          </span>
        </p>
      )}

      <div className="grid gap-2 sm:max-w-md sm:grid-cols-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="문의 처리 상태 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="접수">접수</SelectItem>
            <SelectItem value="답변완료">답변완료</SelectItem>
            <SelectItem value="all">전체</SelectItem>
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger aria-label="문의 유형 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">모든 유형</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="처리할 문의가 없습니다"
          description="참여자가 작성 화면에서 문의를 보내면 여기에 쌓입니다. 다른 상태를 보려면 위 필터를 바꾸세요."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const waiting = daysSince(r.created_at);
            return (
              <li key={r.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {r.category}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {r.participants?.name ?? "-"} · 사번 {r.participants?.emp_no ?? "-"} ·{" "}
                        {r.participants?.companies?.name ?? "계열사 미지정"}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        r.status === "접수" && waiting >= 2
                          ? "bg-warning/15 text-warning"
                          : "bg-secondary text-muted-foreground",
                      )}
                    >
                      접수 후 {waiting}일
                    </span>
                  </div>
                </div>

                <p className="mt-3 whitespace-pre-wrap rounded-lg bg-secondary p-3 text-sm">
                  {r.body}
                </p>

                {r.answer && (
                  <p className="mt-2 whitespace-pre-wrap rounded-lg border p-3 text-sm">
                    <span className="text-xs font-semibold text-muted-foreground">보낸 답변</span>
                    <br />
                    {r.answer}
                  </p>
                )}

                {answering === r.id ? (
                  <div className="mt-3 space-y-2">
                    <Label htmlFor={`answer-${r.id}`}>답변 내용</Label>
                    <Textarea
                      id={`answer-${r.id}`}
                      rows={4}
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="참여자가 바로 읽습니다. 무엇을 어떻게 하면 되는지 적어 주세요."
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={!answer.trim() || answerMutation.isPending}
                        onClick={() => answerMutation.mutate({ id: r.id, answer: answer.trim() })}
                      >
                        답변 보내기
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={answerMutation.isPending}
                        onClick={() => {
                          setAnswering(null);
                          setAnswer("");
                        }}
                      >
                        취소
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant={r.status === "접수" ? "default" : "outline"}
                      onClick={() => {
                        setAnswering(r.id);
                        setAnswer(r.answer ?? "");
                      }}
                    >
                      {r.status === "접수" ? "답변하기" : "답변 수정"}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
