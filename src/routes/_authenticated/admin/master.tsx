import { useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Download, Sparkles, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { parseRosterFile } from "@/lib/roster";
import { similarity } from "@/components/survey/validation";
import {
  JOB_FIELDS,
  ORG_FIELDS,
  applyResponseMapping,
  getMasterStatus,
  jobCatalogTemplateCsv,
  listDutyCharts,
  orgTemplateCsv,
  suggestResponseMapping,
  uploadDutyChart,
  uploadJobCatalog,
  uploadOrgUnits,
  type MappingSuggestion,
  type UploadReport,
} from "@/lib/master.functions";

export const Route = createFileRoute("/_authenticated/admin/master")({
  head: () => ({
    meta: [
      { title: "마스터 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "직무·조직·등급 등 기준 정보를 관리합니다." },
      { property: "og:title", content: "마스터 관리 | 서연 그룹 업무조사" },
      { property: "og:description", content: "직무·조직·등급 등 기준 정보를 관리합니다." },
    ],
  }),
  component: MasterPage,
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

function downloadCsv(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/* ───────────────── 공통 업로더 (조직도 / 직무분류) ───────────────── */

type FieldDef = { key: string; label: string; required: boolean };

/** 파일 헤더 ↔ 시스템 필드 자동 추정. 라벨 일치 우선, 없으면 유사도 0.6 이상. */
function guessMapping(headers: string[], fields: readonly FieldDef[]) {
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const field of fields) {
    const exact = headers.find((h) => h === field.label && !taken.has(h));
    if (exact) {
      mapping[field.key] = exact;
      taken.add(exact);
      continue;
    }
    let best: { header: string; score: number } | null = null;
    for (const header of headers) {
      if (taken.has(header)) continue;
      const score = similarity(header, field.label);
      if (!best || score > best.score) best = { header, score };
    }
    if (best && best.score >= 0.6) {
      mapping[field.key] = best.header;
      taken.add(best.header);
    }
  }
  return mapping;
}

function ReportPanel({ report }: { report: UploadReport }) {
  if (report.applied > 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>{report.applied}건이 반영되었습니다. 반영 전 스냅샷은 감사 로그에 저장되었습니다.</p>
      </div>
    );
  }
  if (report.ok) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          검증 통과 — 총 {report.total}행 중 {report.valid}행이 반영 대상입니다. 반영 버튼을 누르면
          기존 데이터를 교체합니다.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4" />
        오류 {report.issues.length}행 — 수정 후 다시 검증하세요.
      </p>
      <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
        {report.issues.slice(0, 50).map((issue) => (
          <li key={issue.rowNo}>
            <span className="font-medium">{issue.rowNo}행</span> · {issue.errors.join(", ")}
          </li>
        ))}
      </ul>
      {report.issues.length > 50 && (
        <p className="text-xs text-muted-foreground">
          외 {report.issues.length - 50}행 더 있습니다.
        </p>
      )}
    </div>
  );
}

function PreviewTable({
  headers,
  rows,
  errorRows,
}: {
  headers: string[];
  rows: Record<string, string>[];
  errorRows: Set<number>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full min-w-[560px] text-xs">
        <thead className="bg-secondary text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">행</th>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row, index) => {
            const rowNo = index + 2;
            return (
              <tr
                key={rowNo}
                className={errorRows.has(rowNo) ? "border-t bg-destructive/10" : "border-t"}
              >
                <td className="px-3 py-2 text-muted-foreground">{rowNo}</td>
                {headers.map((h) => (
                  <td key={h} className="whitespace-nowrap px-3 py-2">
                    {row[h] ?? ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 20 && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          전체 {rows.length}행 중 20행만 표시합니다.
        </p>
      )}
    </div>
  );
}

function MappingUploader({
  fields,
  templateName,
  templateCsv,
  onRun,
  onApplied,
}: {
  fields: readonly FieldDef[];
  templateName: string;
  templateCsv: () => string;
  onRun: (rows: Record<string, string>[], confirm: boolean) => Promise<UploadReport>;
  onApplied: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<UploadReport | null>(null);
  const [busy, setBusy] = useState(false);

  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  const missing = fields.filter((f) => f.required && !mapping[f.key]);

  const mapped = useMemo(
    () =>
      rows.map((row) => {
        const out: Record<string, string> = {};
        for (const field of fields) {
          const header = mapping[field.key];
          out[field.key] = (header ? row[header] : "") ?? "";
        }
        return out;
      }),
    [rows, mapping, fields],
  );

  const errorRows = useMemo(() => new Set((report?.issues ?? []).map((i) => i.rowNo)), [report]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await parseRosterFile(file);
      if (parsed.length === 0) {
        toast.error("읽을 수 있는 행이 없습니다.");
        return;
      }
      setFileName(file.name);
      setRows(parsed);
      setMapping(guessMapping(Object.keys(parsed[0] ?? {}), fields));
      setReport(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function run(confirm: boolean) {
    setBusy(true);
    try {
      const result = await onRun(mapped, confirm);
      setReport(result);
      if (result.applied > 0) {
        toast.success(`${result.applied}건이 반영되었습니다.`);
        onApplied();
      } else if (!result.ok) {
        toast.error(`오류 ${result.issues.length}행이 있습니다.`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(templateName, templateCsv())}
        >
          <Download className="size-4" />
          템플릿 내려받기
        </Button>
        <Label
          htmlFor={`file-${templateName}`}
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium hover:bg-secondary"
        >
          <Upload className="size-4" />
          파일 선택
        </Label>
        <input
          id={`file-${templateName}`}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="sr-only"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        {fileName && (
          <span className="text-sm text-muted-foreground">
            {fileName} · {rows.length}행
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-medium">컬럼 매핑</p>
            <p className="mt-1 text-xs text-muted-foreground">
              파일의 열을 시스템 필드에 연결합니다. 헤더 이름으로 자동 추정했습니다.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label className="text-xs">
                    {field.label}
                    {field.required && <span className="ml-1 text-destructive">*</span>}
                  </Label>
                  <Select
                    value={mapping[field.key] ?? "__none__"}
                    onValueChange={(value) =>
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (value === "__none__") delete next[field.key];
                        else next[field.key] = value;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger aria-label={`${field.label} 열 선택`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— 사용 안 함</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missing.length > 0 && (
              <p className="mt-3 text-xs text-destructive">
                필수 필드 미지정: {missing.map((f) => f.label).join(", ")}
              </p>
            )}
          </div>

          <PreviewTable headers={headers} rows={rows} errorRows={errorRows} />

          {report && <ReportPanel report={report} />}

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || missing.length > 0} onClick={() => void run(false)}>
              검증
            </Button>
            <Button
              variant="secondary"
              disabled={busy || missing.length > 0 || !report?.ok || report.applied > 0}
              onClick={() => void run(true)}
            >
              반영 (기존 데이터 교체)
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────── ① 조직도 ───────────────────────── */

type OrgUnit = {
  id: string;
  name: string;
  level: string | null;
  parent_id: string | null;
  company_id: string;
  companies: { name: string } | null;
};

function OrgTree({ units }: { units: OrgUnit[] }) {
  const byParent = new Map<string, OrgUnit[]>();
  for (const unit of units) {
    const key = unit.parent_id ?? "__root__";
    const list = byParent.get(key);
    if (list) list.push(unit);
    else byParent.set(key, [unit]);
  }

  function render(parentKey: string, depth: number): ReactNode {
    const children = byParent.get(parentKey);
    if (!children) return null;
    return (
      <ul className={depth === 0 ? "space-y-1" : "mt-1 space-y-1 border-l pl-4"}>
        {children.map((unit) => (
          <li key={unit.id}>
            <span className="text-sm">
              {unit.name}
              {unit.level && (
                <span className="ml-2 text-xs text-muted-foreground">{unit.level}</span>
              )}
              {depth === 0 && unit.companies?.name && (
                <span className="ml-2 text-xs text-primary">{unit.companies.name}</span>
              )}
            </span>
            {render(unit.id, depth + 1)}
          </li>
        ))}
      </ul>
    );
  }

  if (units.length === 0) {
    return <p className="text-sm text-muted-foreground">등록된 조직이 없습니다.</p>;
  }
  return <>{render("__root__", 0)}</>;
}

function OrgTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();

  const { data: units } = useQuery({
    queryKey: ["master-org-units", companyId],
    queryFn: async () => {
      let query = supabase
        .from("org_units")
        .select("id, name, level, parent_id, company_id, companies(name)")
        .order("sort");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return data as OrgUnit[];
    },
  });

  return (
    <div className="space-y-6">
      <MappingUploader
        fields={ORG_FIELDS}
        templateName="조직도_템플릿.csv"
        templateCsv={orgTemplateCsv}
        onRun={async (rows, confirm) =>
          uploadOrgUnits({
            data: {
              confirm,
              rows: rows.map((r) => ({
                company: r["company"] ?? "",
                parent: r["parent"] ?? "",
                name: r["name"] ?? "",
                level: r["level"] ?? "",
                sort: r["sort"] ?? "",
              })),
            },
            headers: await authHeaders(),
          })
        }
        onApplied={() => {
          void queryClient.invalidateQueries({ queryKey: ["master-org-units"] });
          void queryClient.invalidateQueries({ queryKey: ["master-status"] });
        }}
      />

      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm font-medium">조직 트리 {units ? `(${units.length})` : ""}</p>
        <div className="mt-3">
          <OrgTree units={units ?? []} />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────── ② 직무분류 ──────────────────────── */

function JobTab() {
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<MappingSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const suggest = useMutation({
    mutationFn: async () => suggestResponseMapping({ headers: await authHeaders() }),
    onSuccess: (items) => {
      setSuggestions(items);
      setSelected(new Set(items.map((i) => i.responseId)));
      if (items.length === 0) toast.info("매핑을 제안할 응답이 없습니다.");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const apply = useMutation({
    mutationFn: async () => {
      const items = (suggestions ?? [])
        .filter((s) => selected.has(s.responseId))
        .map((s) => ({ responseId: s.responseId, ...s.suggested }));
      if (items.length === 0) throw new Error("적용할 항목을 선택하세요.");
      return applyResponseMapping({ data: { items }, headers: await authHeaders() });
    },
    onSuccess: (result) => {
      toast.success(`${result.updated}건의 응답 직무를 갱신했습니다.`);
      setSuggestions(null);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["master-status"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <MappingUploader
        fields={JOB_FIELDS}
        templateName="직무분류_템플릿.csv"
        templateCsv={jobCatalogTemplateCsv}
        onRun={async (rows, confirm) =>
          uploadJobCatalog({
            data: {
              confirm,
              rows: rows.map((r) => ({
                job_group: r["job_group"] ?? "",
                job_series: r["job_series"] ?? "",
                job_name: r["job_name"] ?? "",
                definition: r["definition"] ?? "",
                companies: r["companies"] ?? "",
              })),
            },
            headers: await authHeaders(),
          })
        }
        onApplied={() => {
          setSuggestions(null);
          void queryClient.invalidateQueries({ queryKey: ["master-status"] });
        }}
      />

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">기존 응답 매핑 제안</p>
            <p className="mt-1 text-xs text-muted-foreground">
              응답자가 자유 입력한 직군·직렬·직무를 카탈로그 항목과 대조해 유사도 60% 이상만
              제안합니다. 적용회사 열은 세미콜론(;)으로 복수 지정합니다.
            </p>
          </div>
          <Button size="sm" disabled={suggest.isPending} onClick={() => suggest.mutate()}>
            <Sparkles className="size-4" />
            제안 받기
          </Button>
        </div>

        {suggestions && suggestions.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="bg-secondary text-left text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2 font-medium">응답자</th>
                    <th className="px-3 py-2 font-medium">현재 표기</th>
                    <th className="px-3 py-2 font-medium">카탈로그 제안</th>
                    <th className="px-3 py-2 font-medium">유사도</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={s.responseId} className="border-t">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(s.responseId)}
                          aria-label={`${s.participantName} 제안 선택`}
                          onCheckedChange={(checked) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (checked === true) next.add(s.responseId);
                              else next.delete(s.responseId);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{s.participantName || "-"}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {[s.current.job_group, s.current.job_series, s.current.job_name]
                          .filter(Boolean)
                          .join(" / ") || "-"}
                      </td>
                      <td className="px-3 py-2">
                        {[s.suggested.job_group, s.suggested.job_series, s.suggested.job_name].join(
                          " / ",
                        )}
                      </td>
                      <td className="px-3 py-2">{Math.round(s.score * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelected((prev) =>
                    prev.size === suggestions.length
                      ? new Set()
                      : new Set(suggestions.map((s) => s.responseId)),
                  )
                }
              >
                {selected.size === suggestions.length ? "전체 해제" : "전체 선택"}
              </Button>
              <Button
                size="sm"
                disabled={apply.isPending || selected.size === 0}
                onClick={() => apply.mutate()}
              >
                선택 {selected.size}건 적용
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────── ③ 업무분장 ──────────────────────── */

function DutyTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [targetCompany, setTargetCompany] = useState(companyId === "all" ? "" : companyId);
  const [orgName, setOrgName] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [report, setReport] = useState<UploadReport | null>(null);

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

  const { data: charts } = useQuery({
    queryKey: ["duty-charts"],
    queryFn: async () => listDutyCharts({ headers: await authHeaders() }),
  });

  const upload = useMutation({
    mutationFn: async () =>
      uploadDutyChart({
        data: { confirm: true, companyId: targetCompany, orgName: orgName.trim(), rows },
        headers: await authHeaders(),
      }),
    onSuccess: (result) => {
      setReport(result);
      if (result.applied > 0) {
        toast.success(`${result.applied}행이 저장되었습니다.`);
        setRows([]);
        setFileName("");
        void queryClient.invalidateQueries({ queryKey: ["duty-charts"] });
        void queryClient.invalidateQueries({ queryKey: ["master-status"] });
      } else {
        toast.error(`오류 ${result.issues.length}행이 있습니다.`);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await parseRosterFile(file);
      if (parsed.length === 0) {
        toast.error("읽을 수 있는 행이 없습니다.");
        return;
      }
      setFileName(file.name);
      setRows(parsed);
      setReport(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const headers = Object.keys(rows[0] ?? {});
  const ready = targetCompany !== "" && orgName.trim() !== "" && rows.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          자유 양식 그대로 업로드합니다. 모든 열이 보존되며 같은 회사·조직명으로 다시 올리면 이전
          업로드를 교체합니다. 응답자 화면 참고 패널 연결은 추후 제공됩니다.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">회사</Label>
            <Select value={targetCompany} onValueChange={setTargetCompany}>
              <SelectTrigger aria-label="회사 선택">
                <SelectValue placeholder="회사를 선택하세요" />
              </SelectTrigger>
              <SelectContent>
                {companies?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="duty-org">
              조직명
            </Label>
            <Input
              id="duty-org"
              value={orgName}
              placeholder="예: 경영기획본부 기획팀"
              onChange={(e) => setOrgName(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Label
            htmlFor="duty-file"
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium hover:bg-secondary"
          >
            <Upload className="size-4" />
            파일 선택
          </Label>
          <input
            id="duty-file"
            type="file"
            accept=".csv,.xlsx,.xls"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          {fileName && (
            <span className="text-sm text-muted-foreground">
              {fileName} · {rows.length}행
            </span>
          )}
          <Button disabled={!ready || upload.isPending} onClick={() => upload.mutate()}>
            업로드
          </Button>
        </div>

        {rows.length > 0 && (
          <PreviewTable
            headers={headers}
            rows={rows}
            errorRows={new Set((report?.issues ?? []).map((i) => i.rowNo))}
          />
        )}
        {report && <ReportPanel report={report} />}
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">
          업로드된 업무분장표 {charts ? `(${charts.length})` : ""}
        </p>
        {(charts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 업로드된 업무분장표가 없습니다.</p>
        ) : (
          (charts ?? []).map((chart) => (
            <div key={chart.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">
                  {chart.orgName}
                  <span className="ml-2 text-xs font-normal text-primary">{chart.companyName}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {chart.rowCount}행 · {formatDate(chart.uploadedAt)}
                </p>
              </div>
              {chart.preview.length > 0 && (
                <div className="mt-3">
                  <PreviewTable
                    headers={chart.columns}
                    rows={chart.preview}
                    errorRows={new Set<number>()}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── ④ 현황 ───────────────────────── */

function StatusTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["master-status"],
    queryFn: async () => getMasterStatus({ headers: await authHeaders() }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">불러오는 중...</p>;

  const cards = [
    { label: "조직 단위", value: data?.orgUnits ?? 0 },
    { label: "직무 카탈로그", value: data?.jobCatalog ?? 0 },
    { label: "업무분장표", value: data?.dutyCharts ?? 0 },
    { label: "응답", value: data?.responses ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-2xl font-bold">{card.value.toLocaleString("ko-KR")}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm font-medium">최근 업로드</p>
        {(data?.lastUploads ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">업로드 이력이 없습니다.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {data?.lastUploads.map((entry) => (
              <li key={entry.action} className="flex justify-between gap-3">
                <span>{entry.action}</span>
                <span className="text-muted-foreground">{formatDate(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        반영 전 스냅샷은 감사 로그에 저장됩니다. 잘못 반영한 경우 감사 로그의 스냅샷을 롤백 지점으로
        사용하세요.
      </p>
    </div>
  );
}

/* ───────────────────────────── 페이지 ───────────────────────────── */

function MasterPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">마스터 관리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          조직도·직무분류·업무분장표를 업로드하고 기준 정보를 관리합니다.
        </p>
      </div>

      <Tabs defaultValue="org">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:grid-cols-4">
          <TabsTrigger value="org">조직도</TabsTrigger>
          <TabsTrigger value="job">직무분류</TabsTrigger>
          <TabsTrigger value="duty">업무분장</TabsTrigger>
          <TabsTrigger value="status">현황</TabsTrigger>
        </TabsList>
        <TabsContent value="org" className="mt-4">
          <OrgTab />
        </TabsContent>
        <TabsContent value="job" className="mt-4">
          <JobTab />
        </TabsContent>
        <TabsContent value="duty" className="mt-4">
          <DutyTab />
        </TabsContent>
        <TabsContent value="status" className="mt-4">
          <StatusTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
