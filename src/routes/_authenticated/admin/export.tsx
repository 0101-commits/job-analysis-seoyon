import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Braces, Database, Download, FileSpreadsheet, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
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
import { cn } from "@/lib/utils";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { downloadText, downloadXlsx, type SheetSpec } from "@/lib/xlsx";
import {
  exportJson,
  exportStdjob,
  listJobDescriptions,
  listJobDrafts,
  snapshotAll,
  type Sheet,
} from "@/lib/export.functions";

export const Route = createFileRoute("/_authenticated/admin/export")({
  /** `?co=` `?org=` — 계열사·소속 렌즈 (기획 v2 P2). 다른 화면과 값을 주고받을 때 필요하다. */
  validateSearch: (search: Record<string, unknown>): LensSearch => pickLens(search),
  head: () => ({
    meta: [
      { title: "내보내기 | 서연 그룹 업무조사" },
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

/** 시트 키는 표준 양식 규격이라 그대로 두고, 엑셀 시트에는 한글 이름을 붙인다. */
const XLSX_SHEET: Record<string, { label: string; colWidths: number[] }> = {
  job_description: { label: "직무기술서", colWidths: [14, 14, 20, 50, 50, 14] },
  task_activity: { label: "과업활동", colWidths: [20, 36, 44] },
  skill: { label: "필요역량", colWidths: [20, 24, 10, 8, 44, 24] },
  skill_pool: { label: "역량목록", colWidths: [20, 24] },
};

/** 서버가 준 4개 시트를 엑셀 한 파일로 내려받는다 (기획 8 — CSV 4개 → 엑셀 1개). */
function downloadStdjobXlsx(sheets: Sheet[]) {
  const specs: SheetSpec[] = sheets.map((s) => {
    const meta = XLSX_SHEET[s.name];
    return {
      name: meta?.label ?? s.name,
      rows: [s.headers, ...s.rows],
      ...(meta ? { colWidths: meta.colWidths } : {}),
    };
  });
  downloadXlsx(`서연_표준직무기술서_${today().replace(/-/g, "")}.xlsx`, specs);
}

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

function ExportPage() {
  const { companyId: scopedCompany } = useCompanyScope();
  const [company, setCompany] = useState(scopedCompany);
  const [approvedOnly, setApprovedOnly] = useState(true);
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [jsonApprovedOnly, setJsonApprovedOnly] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [orgUnit, setOrgUnit] = useState("all");

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

  const companyParam = company === "all" ? null : company;
  const orgUnitParam = orgUnit === "all" ? null : orgUnit;
  const orgOptions = flattenOrgTree(orgUnits ?? [], companyParam);
  const scopeParam: "approved" | "all" = approvedOnly ? "approved" : "all";

  /** 지금 조건이면 무엇이 몇 건 나가는지 — 버튼을 누르기 전에 알려 준다. */
  const { data: preview } = useQuery({
    queryKey: ["job-drafts", companyParam, orgUnitParam, scopeParam],
    queryFn: async () =>
      listJobDrafts({
        data: { companyId: companyParam, orgUnitId: orgUnitParam, scope: scopeParam },
        headers: await authHeaders(),
      }),
  });

  /** 저장된 직무기술서 — 확정·미확정 건수를 안내문에 쓴다. */
  const { data: stored } = useQuery({
    queryKey: ["job-descriptions", companyParam],
    queryFn: async () =>
      listJobDescriptions({ data: { companyId: companyParam }, headers: await authHeaders() }),
  });

  const jdCounts = stored?.counts ?? { total: 0, draft: 0, review: 0, confirmed: 0 };

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
      if (res.meta.jobs === 0) {
        toast.info(
          confirmedOnly
            ? "확정한 직무기술서가 없습니다. AI 도구 화면에서 [확정]을 먼저 눌러 주세요."
            : "조건에 해당하는 직무기술서가 없습니다.",
        );
        return;
      }
      downloadStdjobXlsx(res.sheets);
      toast.success(`직무 ${res.meta.jobs}건을 엑셀 한 파일(4시트)로 내려받았습니다.`);
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
      downloadText(`seoyon_export_${today()}.json`, res.json, "application/json;charset=utf-8");
      if (res.meta.jobs === 0) toast.info("조건에 해당하는 응답이 없습니다.");
      else toast.success(`직무 ${res.meta.jobs}건을 담은 원본 파일을 내려받았습니다.`);
      if (res.meta.skipped > 0) toast.info(`확정 전 직무 ${res.meta.skipped}건은 빠졌습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const snapshot = useMutation({
    mutationFn: async () => snapshotAll({ headers: await authHeaders() }),
    onSuccess: (res) => {
      downloadText(`snapshot_${stamp()}.json`, res.json, "application/json;charset=utf-8");
      const rows = Object.values(res.counts).reduce((a, b) => a + b, 0);
      toast.success(`전체 ${rows}건을 보관했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const companySelect = (
    <Select
      value={company}
      onValueChange={(v) => {
        setCompany(v);
        setOrgUnit("all");
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
    <Select value={orgUnit} onValueChange={setOrgUnit}>
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
        <h1 className="text-xl font-bold sm:text-2xl">내보내기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          확정한 직무기술서를 표준 양식(엑셀)으로, 조사 데이터를 원본 파일로 내려받습니다.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          직무기술서 작성·확정은{" "}
          <Link to="/admin/ai" className="font-medium text-primary hover:underline">
            <Sparkles className="mr-0.5 inline size-3.5 align-[-2px]" aria-hidden />
            AI 도구 화면
          </Link>
          에서 합니다.
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
            <Switch id="std-approved" checked={approvedOnly} onCheckedChange={setApprovedOnly} />
          </div>
        </div>
        <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">{scopeLine}</p>
      </section>

      {/* 1. 표준 직무기술서 엑셀 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-primary" />
          <h2 className="font-semibold">표준 직무기술서 엑셀</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          확정한 직무기술서를 직무기술서·과업활동·필요역량·역량목록 4개 시트를 담은 엑셀 한 파일로
          내려받습니다.
        </p>

        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:w-[360px]">
          <Label htmlFor="std-confirmed" className="cursor-pointer">
            확정한 직무기술서만 내보내기
          </Label>
          <Switch id="std-confirmed" checked={confirmedOnly} onCheckedChange={setConfirmedOnly} />
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
              ? `확정한 ${jdCounts.confirmed}건만 나갑니다. 확정 전 ${unconfirmed}건은 빠집니다 — AI 도구 화면에서 [확정]을 눌러 주세요.`
              : `확정한 ${jdCounts.confirmed}건이 모두 나갑니다.`
            : `확정 전 ${unconfirmed}건까지 포함해 ${jdCounts.total}건이 나갑니다. 고객사에 넘기는 파일이면 확정 후 내보내는 편이 안전합니다.`}
        </p>

        <Button type="button" disabled={buildStdjob.isPending} onClick={() => buildStdjob.mutate()}>
          <Download className="size-4" />
          {buildStdjob.isPending ? "정리하는 중..." : "엑셀 내려받기"}
        </Button>
      </section>

      {/* 2. 데이터 원본 내려받기 */}
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
            익명화를 끄면 응답자 성명·사번·이메일이 파일에 들어갑니다. 외부 공유 시 주의해 주세요.
          </p>
        )}

        <Button type="button" disabled={buildJson.isPending} onClick={() => buildJson.mutate()}>
          <Download className="size-4" />
          {buildJson.isPending ? "생성하는 중..." : "원본 파일 내려받기"}
        </Button>
      </section>

      {/* 3. 수동 보관 */}
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
