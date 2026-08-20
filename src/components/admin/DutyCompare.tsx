// 업무분장 ↔ 응답 대조 (기획 F11).
//
// 업무분장표는 올려 두기만 하고 쓰는 화면이 없어 창고에 있었다. 조직을 고르면 그 조직의 분장
// 과업과 실제 응답에 적힌 과업을 나란히 놓고, 어느 일이 조사에서 빠졌고 어느 일이 분장에
// 없는지 보여 준다. 표현이 비슷한 것은 같다고 단정하지 않고 「유사(확인 필요)」 로 남긴다.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SignalCard } from "@/components/SignalCard";
import { EmptyState } from "@/components/EmptyState";
import { SectionNav, CollapsibleSection, type SectionDef } from "@/components/SectionNav";
import {
  compareDutyCoverage,
  flagRecheck,
  listDutyCharts,
  type DutyCoverage,
} from "@/lib/master.functions";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.";
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

type Unit = { id: string; name: string; company_id: string };

/** 반영률 막대 — 차트 라이브러리 없이 폭만 준다. */
function ReflectedBar({ pct }: { pct: number }) {
  const tone = pct >= 80 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-destructive";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" role="presentation">
      <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function TaskList({
  items,
  empty,
}: {
  items: { key: string; primary: string; secondary?: string }[];
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
      {items.map((item) => (
        <li key={item.key} className="border-b border-dashed pb-1 last:border-0 last:pb-0">
          <span className="font-medium">{item.primary}</span>
          {item.secondary ? (
            <span className="block text-muted-foreground">{item.secondary}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CoverageResult({
  coverage,
  onRequestRecheck,
  requesting,
}: {
  coverage: DutyCoverage;
  onRequestRecheck: () => void;
  requesting: boolean;
}) {
  if (!coverage.hasChart) {
    return (
      <EmptyState
        kind="nothing"
        title="이 조직의 업무분장표가 없습니다"
        description="업무분장 탭에서 이 조직의 분장표를 올리거나 AI 가안을 만든 뒤 다시 대조하세요."
      />
    );
  }
  if (coverage.responseCount === 0) {
    return (
      <EmptyState
        kind="nothing"
        title="대조할 응답이 없습니다"
        description="이 조직(하위 조직 포함)에서 제출·승인된 응답이 아직 없습니다. 작성 중인 응답은 누락이 부풀려지므로 대조에 넣지 않습니다."
      />
    );
  }

  const sections: SectionDef[] = [
    { id: "duty-missing", label: "누락 후보", count: coverage.missing.length },
    { id: "duty-similar", label: "유사(확인 필요)", count: coverage.similar.length },
    { id: "duty-extra", label: "분장 미반영", count: coverage.extra.length },
    { id: "duty-matched", label: "정확 일치", count: coverage.matched.length },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">
            「{coverage.orgName}」 분장 반영률{" "}
            <span className="text-2xl font-bold tabular-nums">{coverage.reflectedPct}%</span>
          </p>
          <p className="text-xs text-muted-foreground">
            분장 과업 {coverage.dutyTaskCount}개 · 응답 {coverage.responseCount}건 · 응답 과업{" "}
            {coverage.responseTaskCount}개
          </p>
        </div>
        <div className="mt-3">
          <ReflectedBar pct={coverage.reflectedPct} />
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
          {[
            { label: "정확 일치", value: coverage.matched.length },
            { label: "유사(확인 필요)", value: coverage.similar.length },
            { label: "누락 후보", value: coverage.missing.length },
            { label: "분장 미반영", value: coverage.extra.length },
          ].map((cell) => (
            <div key={cell.label} className="rounded-lg border px-3 py-2">
              <p className="text-muted-foreground">{cell.label}</p>
              <p className="mt-0.5 text-base font-semibold tabular-nums">{cell.value}개</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          기준 {timeLabel(coverage.asOf)}
          {coverage.chartUploadedAt
            ? ` · 분장표 올린 날 ${new Date(coverage.chartUploadedAt).toLocaleDateString("ko-KR")}`
            : ""}
        </p>
      </div>

      {coverage.missing.length > 0 && (
        <SignalCard
          tone="attention"
          signal={`업무분장에는 있는데 어떤 응답에도 없는 과업이 ${coverage.missing.length}개입니다`}
          evidence={[
            `분장 과업 ${coverage.dutyTaskCount}개 중 ${coverage.missing.length}개가 응답에서 보이지 않습니다.`,
            "표현만 다른 경우는 아래 「유사(확인 필요)」 로 따로 빼 두었습니다.",
            `대상 응답 ${coverage.responseCount}건에 재확인 표시를 걸 수 있습니다.`,
          ]}
          asOf={timeLabel(coverage.asOf)}
          scope={`대상 「${coverage.orgName}」`}
          actions={[
            {
              label: requesting
                ? "요청 중..."
                : `이 조직 응답 ${coverage.responseCount}건에 확인 요청`,
              onClick: onRequestRecheck,
            },
          ]}
        />
      )}

      <SectionNav sections={sections} />

      <CollapsibleSection
        storageKey="duty-compare"
        id="duty-missing"
        title="누락 후보"
        subtitle="업무분장에는 있는데 응답에서 찾지 못한 과업입니다."
      >
        <TaskList
          items={coverage.missing.map((task) => ({ key: task, primary: task }))}
          empty="분장 과업이 모두 응답에 나타났습니다."
        />
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="duty-compare"
        id="duty-similar"
        title="유사(확인 필요)"
        subtitle="표현이 비슷하지만 같은 일인지 사람이 판단해야 하는 짝입니다."
      >
        <TaskList
          items={coverage.similar.map((pair) => ({
            key: `${pair.dutyTask}|${pair.responseTask}`,
            primary: `${pair.dutyTask} ↔ ${pair.responseTask}`,
            secondary: `유사도 ${Math.round(pair.score * 100)}% · 응답 작성자 ${pair.who}`,
          }))}
          empty="표현이 비슷한 짝은 없습니다."
        />
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="duty-compare"
        id="duty-extra"
        title="분장 미반영"
        subtitle="응답에는 있는데 업무분장표에 없는 과업입니다 — 분장을 손볼 거리입니다."
        defaultCollapsed
      >
        <TaskList
          items={coverage.extra.map((item) => ({
            key: `${item.name}|${item.who}`,
            primary: item.name,
            secondary: `작성자 ${item.who}`,
          }))}
          empty="응답 과업이 모두 분장에 들어 있습니다."
        />
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="duty-compare"
        id="duty-matched"
        title="정확 일치"
        subtitle="분장과 응답이 같은 과업으로 확인된 것입니다."
        defaultCollapsed
      >
        <TaskList
          items={coverage.matched.map((pair) => ({
            key: `${pair.dutyTask}|${pair.responseTask}`,
            primary: pair.dutyTask,
            secondary: `응답 작성자 ${pair.who}`,
          }))}
          empty="정확히 일치한 과업이 없습니다."
        />
      </CollapsibleSection>
    </div>
  );
}

export function DutyCompare({ companyId }: { companyId: string | null }) {
  const [company, setCompany] = useState(companyId ?? "");
  const [orgId, setOrgId] = useState("");

  // 상위에서 계열사 범위를 좁혔으면 그 값을 따른다.
  const activeCompany = companyId ?? company;

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
    enabled: companyId === null,
  });

  const { data: charts } = useQuery({
    queryKey: ["duty-charts"],
    queryFn: async () => listDutyCharts({ headers: await authHeaders() }),
  });

  const { data: units } = useQuery({
    queryKey: ["master-org-units", activeCompany || "all"],
    queryFn: async () => {
      let query = supabase.from("org_units").select("id, name, company_id").order("sort");
      if (activeCompany) query = query.eq("company_id", activeCompany);
      const { data, error } = await query;
      if (error) throw error;
      return data as Unit[];
    },
    enabled: activeCompany !== "",
  });

  /** 분장표가 올라와 있는 조직만 고를 수 있게 한다 — 없는 조직을 골라도 볼 것이 없다. */
  const options = useMemo(() => {
    const withChart = new Set(
      (charts ?? [])
        .filter((c) => !activeCompany || c.companyId === activeCompany)
        .map((c) => `${c.companyId}|${c.orgName}`),
    );
    return (units ?? []).filter((u) => withChart.has(`${u.company_id}|${u.name}`));
  }, [charts, units, activeCompany]);

  const { data: coverage, isFetching } = useQuery({
    queryKey: ["duty-coverage", activeCompany, orgId],
    queryFn: async () =>
      compareDutyCoverage({
        data: { companyId: activeCompany, orgUnitId: orgId },
        headers: await authHeaders(),
      }),
    enabled: activeCompany !== "" && orgId !== "",
  });

  const request = useMutation({
    mutationFn: async () => {
      if (!coverage || coverage.responseIds.length === 0) {
        throw new Error("확인 요청을 걸 응답이 없습니다.");
      }
      const shown = coverage.missing.slice(0, 5).join(", ");
      const rest = coverage.missing.length - Math.min(5, coverage.missing.length);
      const reason = `업무분장에 있는 과업이 응답에 없습니다: ${shown}${
        rest > 0 ? ` 외 ${rest}건` : ""
      }`;
      return flagRecheck({
        data: { responseIds: coverage.responseIds, reason: reason.slice(0, 300) },
        headers: await authHeaders(),
      });
    },
    onSuccess: (result) => {
      toast.success(
        `응답 ${result.flagged}건을 재확인 대상으로 올렸습니다 — 현황 탭의 미확인 잔량에서 확인하세요.`,
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm font-medium">대조할 조직 고르기</p>
        <p className="mt-1 text-xs text-muted-foreground">
          업무분장표가 올라와 있는 조직만 나옵니다. 하위 조직 인원의 응답까지 함께 봅니다.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {companyId === null && (
            <div className="space-y-1">
              <Label htmlFor="duty-compare-company">계열사</Label>
              <Select
                value={company}
                onValueChange={(v) => {
                  setCompany(v);
                  setOrgId("");
                }}
              >
                <SelectTrigger id="duty-compare-company">
                  <SelectValue placeholder="계열사 선택" />
                </SelectTrigger>
                <SelectContent>
                  {(companies ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="duty-compare-org">조직</Label>
            <Select value={orgId} onValueChange={setOrgId} disabled={options.length === 0}>
              <SelectTrigger id="duty-compare-org">
                <SelectValue
                  placeholder={options.length === 0 ? "고를 조직이 없습니다" : "조직 선택"}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {options.length === 0 && activeCompany !== "" && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <CheckCircle2 className="size-4 shrink-0" />
            올라온 업무분장표와 이름이 같은 조직이 없습니다. 업무분장 탭에서 조직명을 조직도와 같게
            맞춰 다시 올리세요.
          </p>
        )}
      </div>

      {orgId === "" ? (
        <EmptyState
          kind="nothing"
          title="조직을 고르면 대조 결과가 나옵니다"
          description="업무분장표의 과업과 그 조직 응답에 적힌 과업을 맞춰 누락 후보·유사·분장 미반영으로 나눠 보여 줍니다."
        />
      ) : isFetching || !coverage ? (
        <p className="text-sm text-muted-foreground">대조하는 중...</p>
      ) : (
        <CoverageResult
          coverage={coverage}
          requesting={request.isPending}
          onRequestRecheck={() => request.mutate()}
        />
      )}

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        직무별로 응답을 나란히 보려면{" "}
        <Link to="/admin/review" search={{ view: "job" }} className="text-primary hover:underline">
          응답 검토의 직무 비교
        </Link>
        를 쓰세요.
      </p>
    </div>
  );
}
