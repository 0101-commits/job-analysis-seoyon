import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Braces,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { DEFAULT_OPS, getOpsValues } from "@/lib/settings.functions";
import {
  draftJobDescriptions,
  exportJson,
  exportStdjob,
  listJobDrafts,
  snapshotAll,
  type JobDescDraft,
  type JobDraftView,
  type Sheet,
} from "@/lib/export.functions";

export const Route = createFileRoute("/_authenticated/admin/export")({
  head: () => ({
    meta: [
      { title: "직무기술서·내보내기 | 서연 그룹 업무조사" },
      { name: "description", content: "조사 결과를 엑셀 등 파일로 내려받습니다." },
      { property: "og:title", content: "내보내기 | 서연 그룹 업무조사" },
      { property: "og:description", content: "조사 결과를 엑셀 등 파일로 내려받습니다." },
    ],
  }),
  component: ExportPage,
});

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
}

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Excel 이 UTF-8 로 인식하도록 BOM 을 붙인다 */
function toCsv(sheet: Sheet) {
  return "﻿" + [sheet.headers, ...sheet.rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** 시트 키는 표준 양식 규격이라 그대로 두고, 화면에만 한글 이름을 보여준다. */
const SHEET_LABELS: Record<string, string> = {
  job_description: "직무기술서",
  task_activity: "과업·활동",
  skill: "필요 역량",
  skill_pool: "역량 목록",
};

/** 응답 상태 코드 → 화면 상태 문구. 배지 색·문구는 StatusBadge 한 곳에서만 정한다. */
const STATUS_LABEL: Record<string, string> = {
  draft: "작성중",
  submitted: "제출",
  rejected: "반려",
  approved: "승인",
};

type OrgUnitRow = {
  id: string;
  parent_id: string | null;
  name: string;
  company_id: string;
};

/** 회사로 거른 뒤 트리 순서대로 펼친다. depth 는 들여쓰기 표시용. */
function flattenOrgTree(units: OrgUnitRow[], companyId: string | null) {
  const list = companyId ? units.filter((u) => u.company_id === companyId) : units;
  const ids = new Set(list.map((u) => u.id));
  const byParent = new Map<string, OrgUnitRow[]>();
  for (const u of list) {
    const key = u.parent_id && ids.has(u.parent_id) ? u.parent_id : "__root__";
    byParent.set(key, [...(byParent.get(key) ?? []), u]);
  }
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (parentKey: string, depth: number) => {
    for (const u of byParent.get(parentKey) ?? []) {
      out.push({ id: u.id, name: u.name, depth });
      walk(u.id, depth + 1);
    }
  };
  walk("__root__", 0);
  return out;
}

/** 직무기술서 초안 카드 — 편집 가능한 문자열 상태. 내려받기 시 이 값이 그대로 실린다. */
type DraftCard = {
  key: string;
  company: string;
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string;
  mission: string;
  /** 한 줄 = 「과업명: 활동1 / 활동2」 */
  tasksText: string;
  knowledge: string;
  skills: string;
  attitudes: string;
  requirements: string;
};

function toCard(d: JobDescDraft): DraftCard {
  return {
    key: d.key,
    company: d.company,
    job_group: d.job_group,
    job_series: d.job_series,
    job_name: d.job_name,
    definition: d.definition,
    mission: d.mission,
    tasksText: d.tasks
      .map((t) => (t.activities.length ? `${t.task}: ${t.activities.join(" / ")}` : t.task))
      .join("\n"),
    knowledge: d.knowledge.join(", "),
    skills: d.skills.join(", "),
    attitudes: d.attitudes.join(", "),
    requirements: d.requirements,
  };
}

function draftSheet(cards: DraftCard[]): Sheet {
  return {
    name: "job_description_draft",
    headers: [
      "직군",
      "직렬",
      "직무",
      "회사",
      "정의(Description)",
      "목적(Mission)",
      "주요 과업(과업: 활동)",
      "지식(K)",
      "기술(S)",
      "태도(A)",
      "자격요건",
    ],
    rows: cards.map((c) => [
      c.job_group,
      c.job_series,
      c.job_name,
      c.company,
      c.definition,
      c.mission,
      c.tasksText,
      c.knowledge,
      c.skills,
      c.attitudes,
      c.requirements,
    ]),
  };
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 응답 수에 따른 신뢰도 배지 (검토 화면과 같은 3단계).
 * 기준값은 설정 화면(운영 기본 → 판정 기준)에서 바꿀 수 있다.
 */
function JobCountBadge({ count, ok, caution }: { count: number; ok: number; caution: number }) {
  const label = count >= ok ? "정상" : count >= caution ? "심층검토" : "인터뷰 필수";
  const style =
    count >= ok
      ? "bg-success/15 text-success"
      : count >= caution
        ? "bg-warning/15 text-warning"
        : "bg-destructive/10 text-destructive";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style,
      )}
    >
      {count}인 · {label}
    </span>
  );
}

/** 초안 한 줄 + 그 내용이 어느 응답에서 왔는지로 가는 링크. */
function SourceLine({ text, responseId }: { text: string; responseId: string }) {
  return (
    <li className="flex items-start justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5">
      <span className="min-w-0 text-[13px] leading-relaxed">{text}</span>
      <a
        href={`/admin/review?response=${responseId}`}
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        응답 보기
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </li>
  );
}

function ExportPage() {
  const { companyId: scopedCompany } = useCompanyScope();
  const [company, setCompany] = useState(scopedCompany);
  const [approvedOnly, setApprovedOnly] = useState(true);
  const [jsonApprovedOnly, setJsonApprovedOnly] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [orgUnit, setOrgUnit] = useState("all");
  const [drafts, setDrafts] = useState<DraftCard[] | null>(null);
  const [failedJobs, setFailedJobs] = useState<{ key: string; label: string }[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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

  const { data: orgUnits } = useQuery({
    queryKey: ["org-units", "export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("org_units")
        .select("id, parent_id, name, company_id, sort")
        .order("sort");
      if (error) throw error;
      return data;
    },
  });

  const { data: ops } = useQuery({
    queryKey: ["admin-ops-values"],
    queryFn: async () => getOpsValues({ headers: await authHeaders() }),
  });
  const okCount = ops?.values.jobCountOk ?? DEFAULT_OPS.jobCountOk;
  const cautionCount = ops?.values.jobCountCaution ?? DEFAULT_OPS.jobCountCaution;

  const companyParam = company === "all" ? null : company;
  const orgUnitParam = orgUnit === "all" ? null : orgUnit;
  const orgOptions = flattenOrgTree(orgUnits ?? [], companyParam);
  const scopeParam: "approved" | "all" = approvedOnly ? "approved" : "all";

  /** 화면에서 확인할 초안 — AI 를 돌리지 않아도 무엇이 나갈지 미리 보여 준다. */
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ["job-drafts", companyParam, orgUnitParam, scopeParam],
    queryFn: async () =>
      listJobDrafts({
        data: { companyId: companyParam, orgUnitId: orgUnitParam, scope: scopeParam },
        headers: await authHeaders(),
      }),
  });

  const jobs: JobDraftView[] = preview?.jobs ?? [];
  const selected = jobs.find((j) => j.key === selectedKey) ?? jobs[0] ?? null;

  /** 필터가 바뀌면 이전 조건으로 만든 결과를 비운다 */
  function resetResults() {
    setSheets(null);
    setDrafts(null);
    setFailedJobs([]);
  }

  const buildStdjob = useMutation({
    mutationFn: async () =>
      exportStdjob({
        data: {
          companyId: companyParam,
          orgUnitId: orgUnitParam,
          scope: scopeParam,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setSheets(res.sheets);
      if (res.meta.jobs === 0) toast.info("조건에 해당하는 응답이 없습니다.");
      else toast.success(`직무 ${res.meta.jobs}건 · 응답 ${res.meta.responses}건을 정리했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const buildJson = useMutation({
    mutationFn: async () =>
      exportJson({
        data: {
          companyId: companyParam,
          orgUnitId: orgUnitParam,
          scope: jsonApprovedOnly ? "approved" : "all",
          anonymize,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      download(`seoyon_export_${today()}.json`, res.json, "application/json;charset=utf-8");
      if (res.meta.jobs === 0) toast.info("조건에 해당하는 응답이 없습니다.");
      else toast.success(`직무 ${res.meta.jobs}건을 담은 원본 파일을 내려받았습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const buildDrafts = useMutation({
    mutationFn: async () =>
      draftJobDescriptions({
        data: { companyId: companyParam, orgUnitId: orgUnitParam },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setDrafts(res.drafts.map(toCard));
      setFailedJobs(res.failedJobs);
      if (res.drafts.length === 0 && res.failedJobs.length === 0)
        toast.info("조건에 해당하는 승인된 응답이 없습니다.");
      else if (res.failedJobs.length > 0)
        toast.error(
          `${res.failedJobs.length}건 실패 — [실패 직무만 다시 생성]으로 재시도해 주세요.`,
        );
      else toast.success(`직무 ${res.drafts.length}건의 초안을 생성했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const retryDrafts = useMutation({
    mutationFn: async () =>
      draftJobDescriptions({
        data: {
          companyId: companyParam,
          orgUnitId: orgUnitParam,
          jobs: failedJobs.map((f) => f.key),
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setDrafts((prev) => {
        const merged = [...(prev ?? [])];
        for (const d of res.drafts) {
          const card = toCard(d);
          const idx = merged.findIndex((c) => c.key === card.key);
          if (idx >= 0) merged[idx] = card;
          else merged.push(card);
        }
        return merged;
      });
      setFailedJobs(res.failedJobs);
      if (res.failedJobs.length > 0)
        toast.error(
          `${res.failedJobs.length}건이 여전히 실패했습니다. 잠시 후 다시 시도해 주세요.`,
        );
      else toast.success(`실패했던 직무 ${res.drafts.length}건을 다시 생성했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function updateDraft(key: string, patch: Partial<DraftCard>) {
    setDrafts((prev) => prev?.map((c) => (c.key === key ? { ...c, ...patch } : c)) ?? prev);
  }

  const snapshot = useMutation({
    mutationFn: async () => snapshotAll({ headers: await authHeaders() }),
    onSuccess: (res) => {
      download(`snapshot_${stamp()}.json`, res.json, "application/json;charset=utf-8");
      const rows = Object.values(res.counts).reduce((a, b) => a + b, 0);
      toast.success(`전체 ${rows}건을 보관했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function downloadSheet(sheet: Sheet) {
    const label = SHEET_LABELS[sheet.name] ?? sheet.name;
    download(`서연_직무기술서_${label}_${today()}.csv`, toCsv(sheet), "text/csv;charset=utf-8");
  }

  const companySelect = (
    <Select
      value={company}
      onValueChange={(v) => {
        setCompany(v);
        setOrgUnit("all");
        resetResults();
      }}
    >
      <SelectTrigger className="w-full sm:w-[220px]" aria-label="대상 계열사">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">전체 계열사</SelectItem>
        {companies?.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const orgSelect = (
    <Select
      value={orgUnit}
      onValueChange={(v) => {
        setOrgUnit(v);
        resetResults();
      }}
    >
      <SelectTrigger className="w-full sm:w-[220px]" aria-label="대상 조직">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">전체 조직</SelectItem>
        {orgOptions.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {`${"  ".repeat(o.depth)}${o.name}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  /** 지금 조건이면 무엇이 몇 건 나가는지 — 버튼을 누르기 전에 알려 준다. */
  const scopeLine = preview
    ? `지금 조건이면 직무 ${preview.meta.jobs}개 · 응답 ${preview.meta.responses}건이 나갑니다${
        approvedOnly ? " (승인된 응답만)" : " (승인 전 응답 포함)"
      }.`
    : "대상을 세는 중...";

  const selectedCard = selected ? drafts?.find((c) => c.key === selected.key) : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">직무기술서·내보내기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          직무별 초안을 화면에서 확인한 뒤 표준 직무기술서 양식(엑셀)으로 내려받고, 전체 데이터를
          보관합니다.
        </p>
      </div>

      {/* 0. 대상 고르기 — 아래 모든 구획이 이 조건을 따른다 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="font-semibold">대상 고르기</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>대상 계열사</Label>
            {companySelect}
          </div>
          <div className="space-y-1.5">
            <Label>대상 조직 (하위 조직 포함)</Label>
            {orgSelect}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="std-approved" className="cursor-pointer">
              승인된 응답만 포함
            </Label>
            <Switch
              id="std-approved"
              checked={approvedOnly}
              onCheckedChange={(v) => {
                setApprovedOnly(v);
                setSheets(null);
              }}
            />
          </div>
        </div>
        <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">{scopeLine}</p>
      </section>

      {/* 1. 직무기술서 초안 — 화면에서 보고 다듬는다 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h2 className="font-semibold">직무기술서 초안</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          왼쪽에서 직무를 고르면 그 직무의 초안이 오른쪽에 나옵니다. 각 줄이 어느 응답에서 왔는지
          확인할 수 있고, [초안 생성]을 누르면 AI 가 중복을 합쳐 다듬은 문장을 만들어 그 자리에서
          고칠 수 있습니다.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={buildDrafts.isPending || retryDrafts.isPending}
            onClick={() => buildDrafts.mutate()}
          >
            <Sparkles className="size-4" />
            {buildDrafts.isPending ? "생성하는 중... (직무당 수 초)" : "초안 생성 (AI)"}
          </Button>
          {failedJobs.length > 0 && (
            <Button
              type="button"
              variant="outline"
              disabled={buildDrafts.isPending || retryDrafts.isPending}
              onClick={() => retryDrafts.mutate()}
            >
              <RefreshCw className="size-4" />
              {retryDrafts.isPending ? "다시 생성하는 중..." : "실패 직무만 다시 생성"}
            </Button>
          )}
          {drafts && drafts.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                download(
                  `서연_직무기술서_초안_${today()}.csv`,
                  toCsv(draftSheet(drafts)),
                  "text/csv;charset=utf-8",
                )
              }
            >
              <Download className="size-4" />
              초안 엑셀 내려받기 ({drafts.length}건)
            </Button>
          )}
        </div>

        {failedJobs.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              AI 응답이 중간에 끊긴 직무가 있습니다 — [실패 직무만 다시 생성]을 눌러 주세요.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {failedJobs.map((f) => (
                <Badge key={f.key} variant="destructive">
                  {f.label}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {previewLoading ? (
          <p className="text-sm text-muted-foreground">직무를 모으는 중...</p>
        ) : jobs.length === 0 ? (
          <EmptyState
            kind="nothing"
            title="조건에 해당하는 응답이 없습니다"
            description={
              approvedOnly
                ? "아직 승인된 응답이 없습니다. [승인된 응답만 포함]을 꺼서 작성 중인 응답까지 보거나, 응답 검토에서 먼저 승인해 주세요."
                : "선택한 계열사·조직에 작성된 응답이 없습니다. 대상을 넓혀 보세요."
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
            {/* 좌: 직무 목록 */}
            <ul className="max-h-[520px] space-y-1.5 overflow-y-auto rounded-lg border p-2">
              {jobs.map((job) => {
                const active = selected?.key === job.key;
                const pending = job.responses.filter((r) => r.status !== "approved").length;
                return (
                  <li key={job.key}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(job.key)}
                      className={cn(
                        "w-full rounded-md px-2.5 py-2 text-left transition-colors",
                        active ? "bg-primary text-primary-foreground" : "hover:bg-secondary",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{job.jobName}</span>
                        {!active && (
                          <JobCountBadge
                            count={job.responses.length}
                            ok={okCount}
                            caution={cautionCount}
                          />
                        )}
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[11px]",
                          active ? "text-primary-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {job.company}
                        {active ? ` · 응답 ${job.responses.length}건` : ""}
                        {pending > 0 ? ` · 검토 전 ${pending}건` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* 우: 고른 직무의 초안 */}
            {selected && (
              <div className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center gap-2 border-b pb-3">
                  <h3 className="text-base font-semibold">{selected.jobName}</h3>
                  <JobCountBadge
                    count={selected.responses.length}
                    ok={okCount}
                    caution={cautionCount}
                  />
                  <span className="text-xs text-muted-foreground">
                    {selected.company}
                    {selected.jobGroup || selected.jobSeries
                      ? ` · ${selected.jobGroup} / ${selected.jobSeries}`
                      : ""}
                  </span>
                </div>

                {selected.responses.length < cautionCount && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                    응답이 {selected.responses.length}건뿐입니다. 이대로 확정하지 말고 후속 인터뷰로
                    내용을 확인해 주세요.
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5">
                  {selected.responses.map((r) => (
                    <a
                      key={r.id}
                      href={`/admin/review?response=${r.id}`}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] hover:bg-secondary"
                    >
                      <StatusBadge
                        status={STATUS_LABEL[r.status] ?? r.status}
                        className="px-2 py-0 text-[10px]"
                      />
                      {r.roleLevel ?? "역할단계 미기재"}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ))}
                </div>

                {/* AI 초안이 있으면 그 자리에서 고친다 */}
                {selectedCard ? (
                  <div className="space-y-3 rounded-lg border bg-secondary/30 p-3">
                    <p className="text-xs font-semibold text-primary">
                      AI 가 다듬은 초안 — 여기서 고친 내용이 엑셀에 그대로 실립니다
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">직군</Label>
                        <Input
                          value={selectedCard.job_group}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { job_group: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">직렬</Label>
                        <Input
                          value={selectedCard.job_series}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { job_series: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">직무</Label>
                        <Input
                          value={selectedCard.job_name}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { job_name: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">정의(Description)</Label>
                      <Textarea
                        rows={2}
                        value={selectedCard.definition}
                        onChange={(e) =>
                          updateDraft(selectedCard.key, { definition: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">목적(Mission)</Label>
                      <Textarea
                        rows={2}
                        value={selectedCard.mission}
                        onChange={(e) => updateDraft(selectedCard.key, { mission: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        주요 과업 — 한 줄에 하나, 「과업명: 활동1 / 활동2」
                      </Label>
                      <Textarea
                        rows={6}
                        value={selectedCard.tasksText}
                        onChange={(e) =>
                          updateDraft(selectedCard.key, { tasksText: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">지식(K) — 쉼표 구분</Label>
                        <Textarea
                          rows={3}
                          value={selectedCard.knowledge}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { knowledge: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">기술(S) — 쉼표 구분</Label>
                        <Textarea
                          rows={3}
                          value={selectedCard.skills}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { skills: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">태도(A) — 쉼표 구분</Label>
                        <Textarea
                          rows={3}
                          value={selectedCard.attitudes}
                          onChange={(e) =>
                            updateDraft(selectedCard.key, { attitudes: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">자격요건</Label>
                      <Textarea
                        rows={2}
                        value={selectedCard.requirements}
                        onChange={(e) =>
                          updateDraft(selectedCard.key, { requirements: e.target.value })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed bg-secondary/40 p-3 text-xs text-muted-foreground">
                    아직 AI 초안을 만들지 않았습니다. 아래는 응답에 적힌 내용을 그대로 모은
                    것입니다. [초안 생성 (AI)]을 누르면 중복을 합쳐 다듬은 문장이 이 자리에 나오고,
                    바로 고칠 수 있습니다.
                  </p>
                )}

                {/* 응답에서 온 원문 — 어느 응답에서 왔는지 링크로 확인한다 */}
                <div className="space-y-3">
                  {(
                    [
                      ["정의(Description)", selected.definitions],
                      ["목적(Mission)", selected.missions],
                      ["자격요건", selected.requirements],
                    ] as const
                  ).map(([label, lines]) => (
                    <div key={label} className="space-y-1.5">
                      <p className="text-xs font-semibold">
                        {label}{" "}
                        <span className="font-normal text-muted-foreground">
                          응답 {lines.length}건
                        </span>
                      </p>
                      {lines.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          작성된 내용이 없습니다 — 응답 검토에서 보완을 요청해 주세요.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {lines.map((l, i) => (
                            <SourceLine
                              key={`${l.responseId}-${i}`}
                              text={l.text}
                              responseId={l.responseId}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}

                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold">
                      과업{" "}
                      <span className="font-normal text-muted-foreground">
                        {selected.tasks.length}건
                      </span>
                    </p>
                    {selected.tasks.length === 0 ? (
                      <p className="text-xs text-muted-foreground">작성된 과업이 없습니다.</p>
                    ) : (
                      <ul className="space-y-1">
                        {selected.tasks.map((t, i) => (
                          <SourceLine
                            key={`${t.responseId}-${i}`}
                            text={`${t.isKey ? "[핵심] " : ""}${t.name}${
                              t.activities.length ? ` — ${t.activities.join(" / ")}` : ""
                            }`}
                            responseId={t.responseId}
                          />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold">
                      필요 역량{" "}
                      <span className="font-normal text-muted-foreground">
                        {selected.skills.length}건
                      </span>
                    </p>
                    {selected.skills.length === 0 ? (
                      <p className="text-xs text-muted-foreground">작성된 역량이 없습니다.</p>
                    ) : (
                      <ul className="space-y-1">
                        {selected.skills.map((s, i) => (
                          <SourceLine
                            key={`${s.responseId}-${i}`}
                            text={`${s.name}${s.ksao || s.hardSoft ? ` (${[s.ksao, s.hardSoft].filter(Boolean).join("/")})` : ""}`}
                            responseId={s.responseId}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2. 표준 직무기술서 양식 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-primary" />
          <h2 className="font-semibold">표준 직무기술서 양식(엑셀)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          직무기술서·과업·필요 역량·역량 목록 4개 시트를 각각 파일로 내려받습니다. 엑셀에서 바로
          열립니다. 위에서 고른 대상 기준입니다 — {scopeLine}
        </p>

        <Button type="button" disabled={buildStdjob.isPending} onClick={() => buildStdjob.mutate()}>
          <FileSpreadsheet className="size-4" />
          {buildStdjob.isPending ? "정리하는 중..." : "양식 생성"}
        </Button>

        {sheets && (
          <div className="space-y-2 rounded-lg border bg-secondary/50 p-3">
            {sheets.map((sheet) => (
              <div key={sheet.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">
                  <span className="font-medium">{SHEET_LABELS[sheet.name] ?? sheet.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{sheet.rows.length}건</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sheet.rows.length === 0}
                  onClick={() => downloadSheet(sheet)}
                >
                  <Download className="size-4" />
                  내려받기
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              disabled={sheets.every((s) => s.rows.length === 0)}
              onClick={() => sheets.filter((s) => s.rows.length > 0).forEach(downloadSheet)}
            >
              <Download className="size-4" />
              4개 시트 모두 내려받기
            </Button>
          </div>
        )}
      </section>

      {/* 3. 데이터 원본 내려받기 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Braces className="size-5 text-primary" />
          <h2 className="font-semibold">데이터 원본 내려받기(시스템용)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          각 항목의 뜻을 함께 담은 데이터 원본 파일입니다. 다른 시스템이나 AI 분석에 그대로 넣어 쓸
          수 있습니다. 위에서 고른 계열사·조직 기준으로 생성됩니다.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="json-approved" className="cursor-pointer">
              승인된 응답만 포함
            </Label>
            <Switch
              id="json-approved"
              checked={jsonApprovedOnly}
              onCheckedChange={setJsonApprovedOnly}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="json-anonymize" className="cursor-pointer">
              개인정보 익명화
            </Label>
            <Switch id="json-anonymize" checked={anonymize} onCheckedChange={setAnonymize} />
          </div>
        </div>
        {!anonymize && (
          <p className="text-xs text-destructive">
            익명화를 끄면 응답자 성명·사번·이메일이 파일에 포함됩니다. 외부 공유 시 주의해 주세요.
          </p>
        )}

        <Button type="button" disabled={buildJson.isPending} onClick={() => buildJson.mutate()}>
          <Download className="size-4" />
          {buildJson.isPending ? "생성하는 중..." : "원본 파일 내려받기"}
        </Button>
      </section>

      {/* 4. 수동 보관 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Database className="size-5 text-primary" />
          <h2 className="font-semibold">시점 저장본 만들기</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          참여자·응답·기준정보·메일 이력 등 전체 데이터를 그 시점 그대로 한 파일에 담습니다. 초기
          비밀번호와 생년월일은 포함되지 않습니다. <strong>주요 마일스톤마다 보관하세요.</strong>
        </p>
        <p className="rounded-lg border border-dashed bg-secondary/50 p-3 text-xs text-muted-foreground">
          자동 보관(일 2회)은 배포 후 스케줄러로 활성화됩니다. 그전까지는 이 버튼으로 직접 보관해
          주세요.
        </p>

        <Button
          type="button"
          variant="outline"
          disabled={snapshot.isPending}
          onClick={() => snapshot.mutate()}
        >
          <Download className="size-4" />
          {snapshot.isPending ? "만드는 중..." : "시점 저장본 내려받기"}
        </Button>
      </section>
    </div>
  );
}
