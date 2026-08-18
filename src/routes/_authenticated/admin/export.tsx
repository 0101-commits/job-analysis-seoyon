import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Braces, Database, Download, FileSpreadsheet, RefreshCw, Sparkles } from "lucide-react";
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
import {
  draftJobDescriptions,
  exportJson,
  exportStdjob,
  snapshotAll,
  type JobDescDraft,
  type Sheet,
} from "@/lib/export.functions";

export const Route = createFileRoute("/_authenticated/admin/export")({
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
  skill: "스킬",
  skill_pool: "스킬풀",
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
          scope: approvedOnly ? "approved" : "all",
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
        toast.error(`${res.failedJobs.length}건이 여전히 실패했습니다. 잠시 후 다시 시도해 주세요.`);
      else toast.success(`실패했던 직무 ${res.drafts.length}건을 다시 생성했습니다.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function updateDraft(index: number, patch: Partial<DraftCard>) {
    setDrafts((prev) => prev?.map((c, i) => (i === index ? { ...c, ...patch } : c)) ?? prev);
  }

  const snapshot = useMutation({
    mutationFn: async () => snapshotAll({ headers: await authHeaders() }),
    onSuccess: (res) => {
      download(`snapshot_${stamp()}.json`, res.json, "application/json;charset=utf-8");
      const rows = Object.values(res.counts).reduce((a, b) => a + b, 0);
      toast.success(`전체 ${rows}건을 백업했습니다.`);
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
            {`${"  ".repeat(o.depth)}${o.name}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">내보내기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          조사 결과를 표준 직무기술서 양식(엑셀)으로 내려받고, 전체 데이터를 백업합니다.
        </p>
      </div>

      {/* 1. 표준 직무기술서 양식 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-primary" />
          <h2 className="font-semibold">표준 직무기술서 양식(엑셀)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          직무기술서·과업·스킬·스킬풀 4개 시트를 각각 파일로 내려받습니다. 엑셀에서 바로 열립니다.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
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

      {/* 2. 직무기술서 초안 (AI) */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h2 className="font-semibold">직무기술서 초안 (AI)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          승인된 응답을 직무별로 취합해 AI 가 표준 직무기술서 초안을 만듭니다. 위에서 고른
          계열사·조직 기준이며, 카드에서 내용을 바로 고친 뒤 엑셀로 내려받을 수 있습니다.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={buildDrafts.isPending || retryDrafts.isPending}
            onClick={() => buildDrafts.mutate()}
          >
            <Sparkles className="size-4" />
            {buildDrafts.isPending ? "생성하는 중... (직무당 수 초)" : "초안 생성"}
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
              엑셀 내려받기 ({drafts.length}건)
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

        {drafts && drafts.length > 0 && (
          <div className="space-y-3">
            {drafts.map((card, index) => (
              <details
                key={card.key}
                className="rounded-lg border bg-secondary/30"
                open={drafts.length <= 3}
              >
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  {card.job_name || "(직무명 미기재)"}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {card.company} · {card.job_group} / {card.job_series}
                  </span>
                </summary>
                <div className="space-y-3 border-t p-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-xs">직군</Label>
                      <Input
                        value={card.job_group}
                        onChange={(e) => updateDraft(index, { job_group: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">직렬</Label>
                      <Input
                        value={card.job_series}
                        onChange={(e) => updateDraft(index, { job_series: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">직무</Label>
                      <Input
                        value={card.job_name}
                        onChange={(e) => updateDraft(index, { job_name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">정의(Description)</Label>
                    <Textarea
                      rows={2}
                      value={card.definition}
                      onChange={(e) => updateDraft(index, { definition: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">목적(Mission)</Label>
                    <Textarea
                      rows={2}
                      value={card.mission}
                      onChange={(e) => updateDraft(index, { mission: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      주요 과업 — 한 줄에 하나, 「과업명: 활동1 / 활동2」
                    </Label>
                    <Textarea
                      rows={6}
                      value={card.tasksText}
                      onChange={(e) => updateDraft(index, { tasksText: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-xs">지식(K) — 쉼표 구분</Label>
                      <Textarea
                        rows={3}
                        value={card.knowledge}
                        onChange={(e) => updateDraft(index, { knowledge: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">기술(S) — 쉼표 구분</Label>
                      <Textarea
                        rows={3}
                        value={card.skills}
                        onChange={(e) => updateDraft(index, { skills: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">태도(A) — 쉼표 구분</Label>
                      <Textarea
                        rows={3}
                        value={card.attitudes}
                        onChange={(e) => updateDraft(index, { attitudes: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">자격요건</Label>
                    <Textarea
                      rows={2}
                      value={card.requirements}
                      onChange={(e) => updateDraft(index, { requirements: e.target.value })}
                    />
                  </div>
                </div>
              </details>
            ))}
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

      {/* 4. 수동 백업 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Database className="size-5 text-primary" />
          <h2 className="font-semibold">수동 백업</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          참여자·응답·기준정보·메일 이력 등 전체 데이터를 한 파일로 백업합니다. 초기 비밀번호와
          생년월일은 포함되지 않습니다. <strong>주요 마일스톤마다 보관하세요.</strong>
        </p>
        <p className="rounded-lg border border-dashed bg-secondary/50 p-3 text-xs text-muted-foreground">
          자동 백업(일 2회)은 배포 후 스케줄러로 활성화됩니다. 그전까지는 이 버튼으로 직접 보관해
          주세요.
        </p>

        <Button
          type="button"
          variant="outline"
          disabled={snapshot.isPending}
          onClick={() => snapshot.mutate()}
        >
          <Download className="size-4" />
          {snapshot.isPending ? "백업하는 중..." : "전체 백업 내려받기"}
        </Button>
      </section>
    </div>
  );
}
