import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Braces,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Package,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { JobDescriptionEditor } from "@/components/admin/JobDescriptionEditor";
import { cn } from "@/lib/utils";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { DEFAULT_OPS, getOpsValues } from "@/lib/settings.functions";
import {
  draftJobDescriptions,
  exportJson,
  exportPackage,
  exportStdjob,
  listJobDescriptions,
  listJobDrafts,
  snapshotAll,
  type JobDescriptionView,
  type JobDraftView,
  type PackageCsv,
  type PackageJson,
  type Sheet,
} from "@/lib/export.functions";

export const Route = createFileRoute("/_authenticated/admin/export")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
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

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function whenShort(at: string | null) {
  return at ? new Date(at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : null;
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

/** 직무기술서 상태 — 초안 / 검토중 / 확정. 아직 만들지 않은 직무는 「미작성」. */
function JdStatusBadge({ status, active }: { status: string | null; active: boolean }) {
  const style = active
    ? "bg-primary-foreground/20 text-primary-foreground"
    : status === "확정"
      ? "bg-success/15 text-success"
      : status === "검토중"
        ? "bg-warning/15 text-warning"
        : status === "초안"
          ? "bg-secondary text-muted-foreground"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style,
      )}
    >
      {status ?? "미작성"}
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

/** 목록 한 줄 = 직무 하나. 응답에서 모은 원문과 저장된 직무기술서를 같은 줄에 묶는다. */
type JobRow = {
  key: string;
  jobName: string;
  company: string;
  responses: number;
  pending: number;
  jd: JobDescriptionView | null;
  view: JobDraftView | null;
};

type PackageResult = {
  csv: PackageCsv[];
  json: PackageJson[];
  counts: {
    jobsConfirmed: number;
    jobsUnconfirmed: number;
    responses: number;
    participants: number;
    auditRows: number;
  };
};

function ExportPage() {
  const { companyId: scopedCompany } = useCompanyScope();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState(scopedCompany);
  const [approvedOnly, setApprovedOnly] = useState(true);
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [jsonApprovedOnly, setJsonApprovedOnly] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [orgUnit, setOrgUnit] = useState("all");
  const [failedJobs, setFailedJobs] = useState<{ key: string; label: string }[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pkg, setPkg] = useState<PackageResult | null>(null);
  const [pkgWarnings, setPkgWarnings] = useState<string[]>([]);

  const appVersion = (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? undefined;

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

  /** 응답에 적힌 원문 — AI 를 돌리지 않아도 무엇이 나갈지 미리 보여 준다. */
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ["job-drafts", companyParam, orgUnitParam, scopeParam],
    queryFn: async () =>
      listJobDrafts({
        data: { companyId: companyParam, orgUnitId: orgUnitParam, scope: scopeParam },
        headers: await authHeaders(),
      }),
  });

  /** 저장된 직무기술서 — 새로고침해도 남아 있는 산출물 본체. */
  const { data: stored, isLoading: storedLoading } = useQuery({
    queryKey: ["job-descriptions", companyParam],
    queryFn: async () =>
      listJobDescriptions({ data: { companyId: companyParam }, headers: await authHeaders() }),
  });

  const jdCounts = stored?.counts ?? { total: 0, draft: 0, review: 0, confirmed: 0 };

  const jobRows: JobRow[] = useMemo(() => {
    const byKey = new Map<string, JobRow>();
    for (const v of preview?.jobs ?? []) {
      byKey.set(v.key, {
        key: v.key,
        jobName: v.jobName,
        company: v.company,
        responses: v.responses.length,
        pending: v.responses.filter((r) => r.status !== "approved").length,
        jd: null,
        view: v,
      });
    }
    for (const jd of stored?.jobs ?? []) {
      const key = `${jd.companyId}|${jd.jobName}`;
      const prev = byKey.get(key);
      if (prev) prev.jd = jd;
      else
        byKey.set(key, {
          key,
          jobName: jd.jobName,
          company: jd.company,
          responses: jd.responseCount,
          pending: 0,
          jd,
          view: null,
        });
    }
    return [...byKey.values()].sort((a, b) => a.jobName.localeCompare(b.jobName, "ko"));
  }, [preview, stored]);

  const selected = jobRows.find((r) => r.key === selectedKey) ?? jobRows[0] ?? null;

  function refreshStored() {
    void queryClient.invalidateQueries({ queryKey: ["job-descriptions"] });
  }

  /** 필터가 바뀌면 이전 조건으로 만든 결과를 비운다 */
  function resetResults() {
    setSheets(null);
    setFailedJobs([]);
    setPkg(null);
    setPkgWarnings([]);
  }

  function reportDraftResult(res: {
    saved: number;
    preserved: number;
    preservedJobs: string[];
    lockedJobs: string[];
    failedJobs: { key: string; label: string }[];
  }) {
    setFailedJobs(res.failedJobs);
    refreshStored();
    if (res.saved === 0 && res.failedJobs.length === 0 && res.lockedJobs.length === 0) {
      toast.info("조건에 해당하는 승인된 응답이 없습니다.");
      return;
    }
    if (res.failedJobs.length > 0) {
      toast.error(`${res.failedJobs.length}건 실패 — [실패 직무만 다시 생성]으로 재시도해 주세요.`);
    } else if (res.saved > 0) {
      toast.success(`직무 ${res.saved}건의 초안을 저장했습니다.`);
    }
    if (res.preserved > 0) {
      toast.info(
        `직접 고친 ${res.preserved}개 항목은 그대로 두었습니다. (${res.preservedJobs.slice(0, 3).join(", ")}${
          res.preservedJobs.length > 3 ? " 외" : ""
        })`,
      );
    }
    if (res.lockedJobs.length > 0) {
      toast.info(`확정된 ${res.lockedJobs.length}개 직무는 건드리지 않았습니다.`);
    }
  }

  const buildDrafts = useMutation({
    mutationFn: async () =>
      draftJobDescriptions({
        data: { companyId: companyParam, orgUnitId: orgUnitParam },
        headers: await authHeaders(),
      }),
    onSuccess: reportDraftResult,
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
    onSuccess: reportDraftResult,
    onError: (err) => toast.error(errorMessage(err)),
  });

  const buildStdjob = useMutation({
    mutationFn: async () =>
      exportStdjob({
        data: {
          companyId: companyParam,
          orgUnitId: orgUnitParam,
          scope: scopeParam,
          confirmedOnly,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setSheets(res.sheets);
      if (res.meta.jobs === 0)
        toast.info(
          confirmedOnly
            ? "확정한 직무기술서가 없습니다. 위에서 [확정]을 먼저 눌러 주세요."
            : "조건에 해당하는 직무기술서가 없습니다.",
        );
      else toast.success(`직무 ${res.meta.jobs}건을 정리했습니다.`);
      if (res.meta.skipped > 0)
        toast.info(
          `확정 전 ${res.meta.skipped}건은 빠졌습니다: ${res.meta.skippedNames.join(", ")}`,
        );
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
          confirmedOnly,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      download(`seoyon_export_${today()}.json`, res.json, "application/json;charset=utf-8");
      if (res.meta.jobs === 0) toast.info("조건에 해당하는 응답이 없습니다.");
      else toast.success(`직무 ${res.meta.jobs}건을 담은 원본 파일을 내려받았습니다.`);
      if (res.meta.skipped > 0) toast.info(`확정 전 직무 ${res.meta.skipped}건은 빠졌습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const buildPackage = useMutation({
    mutationFn: async () =>
      exportPackage({
        data: {
          companyId: companyParam,
          orgUnitId: orgUnitParam,
          anonymize,
          ...(appVersion ? { appVersion } : {}),
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setPkg(res);
      // 요약 파일의 건수가 화면 숫자와 다르면 그 사실을 알린다(조사 결과를 그대로 넘기는 파일이므로).
      const warnings: string[] = [];
      if (orgUnitParam === null && res.counts.jobsConfirmed !== jdCounts.confirmed) {
        warnings.push(
          `확정 직무기술서 — 화면 ${jdCounts.confirmed}건 ↔ 요약 파일 ${res.counts.jobsConfirmed}건`,
        );
      }
      if (!approvedOnly && preview && res.counts.responses !== preview.meta.responses) {
        warnings.push(
          `응답 — 화면 ${preview.meta.responses}건 ↔ 요약 파일 ${res.counts.responses}건`,
        );
      }
      setPkgWarnings(warnings);
      toast.success(
        `파일 ${res.csv.length + res.json.length}개를 만들었습니다. 확정 직무기술서 ${res.counts.jobsConfirmed}건이 담겼습니다.`,
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

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

  /**
   * 묶음 내려받기 — zip 을 만들지 않고 파일을 하나씩 차례로 내려보낸다.
   * 브라우저가 연속 내려받기를 막지 않도록 사이에 잠깐 틈을 둔다.
   */
  async function downloadAll(result: PackageResult) {
    for (const item of result.csv) {
      download(item.file, toCsv(item.sheet), "text/csv;charset=utf-8");
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const item of result.json) {
      download(item.file, item.content, "application/json;charset=utf-8");
      await new Promise((r) => setTimeout(r, 300));
    }
    toast.success(`${result.csv.length + result.json.length}개 파일을 내려받았습니다.`);
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
    ? `지금 조건이면 직무 ${preview.meta.jobs}개 · 응답 ${preview.meta.responses}건이 대상입니다${
        approvedOnly ? " (승인된 응답만)" : " (승인 전 응답 포함)"
      }.`
    : "대상을 세는 중...";

  const unconfirmed = jdCounts.total - jdCounts.confirmed;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">직무기술서·내보내기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          직무별 초안을 만들어 다듬고 확정한 뒤, 확정본만 표준 직무기술서 양식(엑셀)과 반출 묶음으로
          내려받습니다.
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
                resetResults();
              }}
            />
          </div>
        </div>
        <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">{scopeLine}</p>
      </section>

      {/* 1. 직무기술서 — 만들고, 다듬고, 확정한다 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h2 className="font-semibold">직무기술서</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          왼쪽에서 직무를 고르면 그 직무의 직무기술서가 오른쪽에 나옵니다. 고친 내용은 [저장]을
          누르면 남고, 다시 생성해도 직접 고친 항목은 덮어쓰지 않습니다. 항목마다 몇 명이 같은
          내용을 적었는지와 그 응답으로 가는 링크가 붙습니다.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={buildDrafts.isPending || retryDrafts.isPending}
            onClick={() => buildDrafts.mutate()}
          >
            <Sparkles className="size-4" />
            {buildDrafts.isPending ? "만드는 중... (직무당 수 초)" : "초안 생성 (AI)"}
          </Button>
          {failedJobs.length > 0 && (
            <Button
              type="button"
              variant="outline"
              disabled={buildDrafts.isPending || retryDrafts.isPending}
              onClick={() => retryDrafts.mutate()}
            >
              <RefreshCw className="size-4" />
              {retryDrafts.isPending ? "다시 만드는 중..." : "실패 직무만 다시 생성"}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            저장됨 {jdCounts.total}건 · 초안 {jdCounts.draft} · 검토중 {jdCounts.review} · 확정{" "}
            {jdCounts.confirmed}
          </span>
        </div>

        {failedJobs.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              AI 응답이 중간에 끊기거나 저장에 실패한 직무가 있습니다 — [실패 직무만 다시 생성]을
              눌러 주세요.
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

        {previewLoading || storedLoading ? (
          <p className="text-sm text-muted-foreground">직무를 모으는 중...</p>
        ) : jobRows.length === 0 ? (
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
          <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_1fr]">
            {/* 좌: 직무 목록 */}
            <ul className="max-h-[640px] space-y-1.5 overflow-y-auto rounded-lg border p-2">
              {jobRows.map((row) => {
                const active = selected?.key === row.key;
                const madeAt = whenShort(row.jd?.generatedAt ?? null);
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(row.key)}
                      className={cn(
                        "w-full rounded-md px-2.5 py-2 text-left transition-colors",
                        active ? "bg-primary text-primary-foreground" : "hover:bg-secondary",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{row.jobName}</span>
                        <JdStatusBadge status={row.jd?.status ?? null} active={active} />
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[11px]",
                          active ? "text-primary-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {row.company} · 응답 {row.responses}건
                        {row.pending > 0 ? ` · 검토 전 ${row.pending}건` : ""}
                        {madeAt ? ` · ${madeAt} 생성` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* 우: 고른 직무 */}
            {selected && (
              <div className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center gap-2 border-b pb-3">
                  <h3 className="text-base font-semibold">{selected.jobName}</h3>
                  <JobCountBadge count={selected.responses} ok={okCount} caution={cautionCount} />
                  <span className="text-xs text-muted-foreground">
                    {selected.company}
                    {selected.view && (selected.view.jobGroup || selected.view.jobSeries)
                      ? ` · ${selected.view.jobGroup} / ${selected.view.jobSeries}`
                      : ""}
                  </span>
                </div>

                {selected.responses < cautionCount && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                    응답이 {selected.responses}건뿐입니다. 이대로 확정하지 말고 후속 인터뷰로 내용을
                    확인해 주세요.
                  </p>
                )}

                {selected.view && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.view.responses.map((r) => (
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
                )}

                {selected.jd ? (
                  <JobDescriptionEditor
                    key={`${selected.jd.id}-${selected.jd.updatedAt}`}
                    jd={selected.jd}
                    authHeaders={authHeaders}
                    onChanged={refreshStored}
                  />
                ) : (
                  <p className="rounded-lg border border-dashed bg-secondary/40 p-3 text-xs text-muted-foreground">
                    아직 이 직무의 직무기술서를 만들지 않았습니다. 아래는 응답에 적힌 내용을 그대로
                    모은 것입니다. [초안 생성 (AI)]을 누르면 중복을 합쳐 다듬은 직무기술서가 이
                    자리에 생기고, 항목마다 근거가 함께 붙습니다.
                  </p>
                )}

                {/* 응답에서 온 원문 — 어느 응답에서 왔는지 링크로 확인한다 */}
                {selected.view && (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground">응답에 적힌 원문</p>
                    {(
                      [
                        ["정의(Description)", selected.view.definitions],
                        ["목적(Mission)", selected.view.missions],
                        ["자격요건", selected.view.requirements],
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
                          {selected.view.tasks.length}건
                        </span>
                      </p>
                      {selected.view.tasks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">작성된 과업이 없습니다.</p>
                      ) : (
                        <ul className="space-y-1">
                          {selected.view.tasks.map((t, i) => (
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
                          {selected.view.skills.length}건
                        </span>
                      </p>
                      {selected.view.skills.length === 0 ? (
                        <p className="text-xs text-muted-foreground">작성된 역량이 없습니다.</p>
                      ) : (
                        <ul className="space-y-1">
                          {selected.view.skills.map((s, i) => (
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
                )}
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
          확정한 직무기술서를 직무기술서·과업·필요 역량·역량 목록 4개 시트로 내려받습니다. 엑셀에서
          바로 열립니다.
        </p>

        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:w-[360px]">
          <Label htmlFor="std-confirmed" className="cursor-pointer">
            확정한 직무기술서만 내보내기
          </Label>
          <Switch
            id="std-confirmed"
            checked={confirmedOnly}
            onCheckedChange={(v) => {
              setConfirmedOnly(v);
              setSheets(null);
            }}
          />
        </div>

        <p
          className={cn(
            "rounded-lg p-3 text-xs",
            confirmedOnly && unconfirmed > 0
              ? "border border-warning/40 bg-warning/5 text-warning"
              : "bg-secondary/60 text-muted-foreground",
          )}
        >
          {confirmedOnly
            ? unconfirmed > 0
              ? `확정한 ${jdCounts.confirmed}건만 나갑니다. 확정 전 ${unconfirmed}건은 빠집니다 — 위에서 [확정]을 눌러 주세요.`
              : `확정한 ${jdCounts.confirmed}건이 모두 나갑니다.`
            : `확정 전 ${unconfirmed}건까지 포함해 ${jdCounts.total}건이 나갑니다. 고객사에 넘기는 파일이면 확정 후 내보내는 편이 안전합니다.`}
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

      {/* 3. 반출 묶음 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Package className="size-5 text-primary" />
          <h2 className="font-semibold">반출 묶음</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          고객사에 한 번에 넘길 파일을 모두 만듭니다 — 확정 직무기술서(4시트), AI 판독용 원본, 응답
          원본, 조직도·직무 분류, 감사 기록, 그리고 <strong>생성 정보 요약</strong>(기준
          시점·모수·앱 버전·건수). 압축하지 않고 파일을 하나씩 차례로 내려받습니다.
        </p>

        <Button
          type="button"
          disabled={buildPackage.isPending}
          onClick={() => buildPackage.mutate()}
        >
          <Package className="size-4" />
          {buildPackage.isPending ? "묶는 중..." : "묶음 만들기"}
        </Button>

        {pkg && (
          <div className="space-y-2 rounded-lg border bg-secondary/50 p-3">
            {pkgWarnings.length > 0 && (
              <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-2.5">
                <p className="text-xs font-semibold text-warning">
                  요약 파일의 건수가 화면 숫자와 다릅니다 — 그대로 넘기기 전에 확인해 주세요.
                </p>
                {pkgWarnings.map((w) => (
                  <p key={w} className="text-[11px] text-warning">
                    {w}
                  </p>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              확정 직무기술서 {pkg.counts.jobsConfirmed}건 · 확정 전 {pkg.counts.jobsUnconfirmed}건
              · 응답 {pkg.counts.responses}건 · 참여자 {pkg.counts.participants}명 · 감사 기록{" "}
              {pkg.counts.auditRows}건
            </p>
            {pkg.csv.map((item) => (
              <div key={item.file} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">
                  {item.file}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {item.sheet.rows.length}건
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => download(item.file, toCsv(item.sheet), "text/csv;charset=utf-8")}
                >
                  <Download className="size-4" />
                  내려받기
                </Button>
              </div>
            ))}
            {pkg.json.map((item) => (
              <div key={item.file} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">
                  {item.file}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {Math.max(1, Math.round(item.content.length / 1024))}KB
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    download(item.file, item.content, "application/json;charset=utf-8")
                  }
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
              onClick={() => void downloadAll(pkg)}
            >
              <Download className="size-4" />
              묶음 내려받기 ({pkg.csv.length + pkg.json.length}개 파일)
            </Button>
          </div>
        )}
      </section>

      {/* 4. 데이터 원본 내려받기 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Braces className="size-5 text-primary" />
          <h2 className="font-semibold">데이터 원본 내려받기(시스템용)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          각 항목의 뜻을 함께 담은 데이터 원본 파일입니다. 다른 시스템이나 AI 분석에 그대로 넣어 쓸
          수 있습니다. 위에서 고른 계열사·조직 기준으로 생성되며, [확정한 직무기술서만 내보내기]를
          켜 두면 확정한 직무만 담습니다.
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
            익명화를 끄면 응답자 성명·사번·이메일이 파일(반출 묶음의 응답 원본 포함)에 들어갑니다.
            외부 공유 시 주의해 주세요.
          </p>
        )}

        <Button type="button" disabled={buildJson.isPending} onClick={() => buildJson.mutate()}>
          <Download className="size-4" />
          {buildJson.isPending ? "생성하는 중..." : "원본 파일 내려받기"}
        </Button>
      </section>

      {/* 5. 수동 보관 */}
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
