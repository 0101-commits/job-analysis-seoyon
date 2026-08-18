import { useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  History,
  MoreHorizontal,
  Plus,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyScope } from "@/components/CompanyContext";
import { OrgCanvas, type CanvasRollup } from "@/components/admin/OrgCanvas";
import { getOrgOverview, type OrgOverview } from "@/lib/dashboard.functions";
import { parseRosterFile } from "@/lib/roster";
import { similarity } from "@/components/survey/validation";
import {
  JOB_FIELDS,
  ORG_FIELDS,
  applyResponseMapping,
  createOrgUnit,
  deleteCatalogVersion,
  deleteJobCatalogRow,
  deleteOrgUnit,
  diffCatalogVersions,
  draftDutyCharts,
  draftJobCatalog,
  DUTY_ORG_LIMIT,
  getMasterStatus,
  jobCatalogTemplateCsv,
  listCatalogVersions,
  listDutyCharts,
  moveOrgUnit,
  orgTemplateCsv,
  previewImpact,
  renameOrgUnit,
  restoreCatalogVersion,
  saveCatalogVersion,
  suggestResponseMapping,
  uploadDutyChart,
  uploadJobCatalog,
  uploadOrgUnits,
  upsertJobCatalogRow,
  type CatalogDiff,
  type DutyDraftChart,
  type DutyDraftRow,
  type EditResult,
  type ImpactKind,
  type ImpactPreview,
  type JobDraftRow,
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

/* ─────────────── 변경 전 영향 확인 다이얼로그 (V14-①) ─────────────── */

type PendingConfirm = {
  title: string;
  impact: ImpactPreview;
  confirmLabel: string;
  destructive?: boolean;
  run: () => void;
};

/**
 * previewImpact 결과가 0건이면 (always 가 아닌 한) 다이얼로그 없이 바로 실행하고,
 * 영향이 있으면 요약 + 대상 표본을 보여준 뒤 확인을 받는다.
 */
function makeImpactGate(setPending: (pending: PendingConfirm) => void) {
  return async function gate(opts: {
    kind: ImpactKind;
    id: string;
    title: string;
    confirmLabel: string;
    destructive?: boolean;
    always?: boolean;
    run: () => void;
  }) {
    try {
      const impact = await previewImpact({
        data: { kind: opts.kind, id: opts.id },
        headers: await authHeaders(),
      });
      if (impact.count === 0 && !opts.always) {
        opts.run();
        return;
      }
      setPending({
        title: opts.title,
        impact,
        confirmLabel: opts.confirmLabel,
        destructive: opts.destructive === true,
        run: opts.run,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
}

function ImpactConfirmDialog({
  pending,
  onClose,
}: {
  pending: PendingConfirm | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.impact.summary || "영향을 받는 대상이 없습니다. 계속할까요?"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending && pending.impact.samples.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="text-xs font-medium text-primary hover:underline">
              영향 대상 보기 ({pending.impact.samples.length}건 표시
              {pending.impact.count > pending.impact.samples.length
                ? ` / 전체 ${pending.impact.count}건`
                : ""}
              )
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs text-muted-foreground">
                {pending.impact.samples.map((sample, index) => (
                  <li key={index}>{sample}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction
            className={
              pending?.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            onClick={() => {
              pending?.run();
              onClose();
            }}
          >
            {pending?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ───────────────── 공통 업로더 (조직도 / 직무분류) ───────────────── */

type FieldDef = { key: string; label: string; required: boolean };

/** 파일 헤더 ↔ 시스템 항목 자동 추정. 라벨 일치 우선, 없으면 유사도 0.6 이상. */
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
        <div className="space-y-1">
          <p>{report.applied}건이 반영되었습니다. 변경 전 백업은 변경 기록에 저장되었습니다.</p>
          {report.relinked !== undefined && (
            <p className="text-xs text-muted-foreground">
              참여자 조직 연결 재연결 {report.relinked}명
              {report.unmatched ? ` · 미매칭 ${report.unmatched}명(조직명이 바뀐 인원)` : ""}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (report.ok) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          검증 통과 — 총 {report.total}건 중 {report.valid}건이 반영 대상입니다. 반영 버튼을 누르면
          기존 데이터를 교체합니다.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4" />
        오류 {report.issues.length}건 — 수정 후 다시 검증하세요.
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
          외 {report.issues.length - 50}건 더 있습니다.
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
          전체 {rows.length}건 중 20건만 표시합니다.
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
        toast.error(`오류 ${result.issues.length}건이 있습니다.`);
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
            {fileName} · {rows.length}건
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-medium">항목 맞추기</p>
            <p className="mt-1 text-xs text-muted-foreground">
              파일의 열을 시스템 항목에 연결합니다. 열 이름으로 자동 추정했습니다.
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
                필수 항목 미지정: {missing.map((f) => f.label).join(", ")}
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

/** 인라인 편집 대상. rename=이름·레벨 수정, child=하위 추가, move=상위 이동. */
type OrgAction = { kind: "rename" | "child" | "move"; unit: OrgUnit };

function OrgNodeEditor({
  action,
  units,
  busy,
  onCancel,
  onSubmit,
}: {
  action: OrgAction;
  units: OrgUnit[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { name: string; level: string; parentId: string | null }) => void;
}) {
  const { kind, unit } = action;
  const [name, setName] = useState(kind === "rename" ? unit.name : "");
  const [level, setLevel] = useState(kind === "rename" ? (unit.level ?? "") : "");
  const [parentId, setParentId] = useState(unit.parent_id ?? "__root__");

  // 이동 후보는 같은 계열사 조직만. 순환 여부는 서버가 최종 검증한다.
  const candidates = units.filter((u) => u.company_id === unit.company_id && u.id !== unit.id);
  const canSubmit = kind === "move" ? true : name.trim() !== "";

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
      {kind === "move" ? (
        <Select value={parentId} onValueChange={setParentId}>
          <SelectTrigger className="h-8 w-56" aria-label="상위 조직 선택">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__root__">— 최상위</SelectItem>
            {candidates.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Input
            className="h-8 w-44"
            value={name}
            autoFocus
            placeholder={kind === "child" ? "하위 조직명" : "조직명"}
            aria-label="조직명"
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            className="h-8 w-28"
            value={level}
            placeholder="레벨(본부/팀)"
            aria-label="조직 레벨"
            onChange={(e) => setLevel(e.target.value)}
          />
        </>
      )}
      <Button
        size="sm"
        className="h-8"
        disabled={busy || !canSubmit}
        onClick={() =>
          onSubmit({
            name: name.trim(),
            level: level.trim(),
            parentId: parentId === "__root__" ? null : parentId,
          })
        }
      >
        {kind === "child" ? "추가" : "저장"}
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
        <X className="size-4" />
        취소
      </Button>
    </div>
  );
}

function OrgTree({
  units,
  action,
  busy,
  onAction,
  onCancel,
  onSubmit,
  onDelete,
}: {
  units: OrgUnit[];
  action: OrgAction | null;
  busy: boolean;
  onAction: (action: OrgAction) => void;
  onCancel: () => void;
  onSubmit: (values: { name: string; level: string; parentId: string | null }) => void;
  onDelete: (unit: OrgUnit) => void;
}) {
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
            <div className="group flex items-center gap-2">
              <span className="text-sm">
                {unit.name}
                {unit.level && (
                  <span className="ml-2 text-xs text-muted-foreground">{unit.level}</span>
                )}
                {depth === 0 && unit.companies?.name && (
                  <span className="ml-2 text-xs text-primary">{unit.companies.name}</span>
                )}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-40 hover:opacity-100"
                    aria-label={`${unit.name} 조직 관리`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onAction({ kind: "rename", unit })}>
                    이름 변경
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "child", unit })}>
                    하위 조직 추가
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "move", unit })}>
                    상위 이동
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(unit)}>
                    삭제
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {action?.unit.id === unit.id && (
              <OrgNodeEditor
                key={`${action.kind}-${unit.id}`}
                action={action}
                units={units}
                busy={busy}
                onCancel={onCancel}
                onSubmit={onSubmit}
              />
            )}
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

/** 대시보드(admin/index.tsx)와 같은 기준: 응답자 계정상태 제출/승인 = 제출 완료. */
const ORG_DONE_STATUSES = ["제출", "승인"];

/** 조직별 하위 합산 대상/제출 롤업 — 캔버스 노드의 제출률 링에 쓴다. */
function buildCanvasRollup(overview: OrgOverview | undefined, units: OrgUnit[]): CanvasRollup | null {
  if (!overview) return null;
  const ids = new Set(units.map((u) => u.id));
  const childIds = new Map<string, string[]>();
  for (const u of units) {
    if (!u.parent_id || !ids.has(u.parent_id)) continue;
    const list = childIds.get(u.parent_id);
    if (list) list.push(u.id);
    else childIds.set(u.parent_id, [u.id]);
  }

  const own = new Map<string, { total: number; done: number }>();
  for (const p of overview.participants) {
    if (p.role !== "respondent" || !p.org_unit_id || !ids.has(p.org_unit_id)) continue;
    const acc = own.get(p.org_unit_id) ?? { total: 0, done: 0 };
    acc.total += 1;
    if (ORG_DONE_STATUSES.includes(p.account_status)) acc.done += 1;
    own.set(p.org_unit_id, acc);
  }

  const rollup: CanvasRollup = new Map();
  const compute = (id: string): { total: number; done: number } => {
    const base = own.get(id);
    const acc = { total: base?.total ?? 0, done: base?.done ?? 0 };
    for (const child of childIds.get(id) ?? []) {
      const c = compute(child);
      acc.total += c.total;
      acc.done += c.done;
    }
    rollup.set(id, acc);
    return acc;
  };
  for (const u of units) {
    if (!u.parent_id || !ids.has(u.parent_id)) compute(u.id);
  }
  return rollup;
}

function OrgTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<OrgAction | null>(null);
  const [newRoot, setNewRoot] = useState("");
  const [orgView, setOrgView] = useState<"tree" | "canvas">("tree");
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const gate = makeImpactGate(setPending);

  // 제출률 링 데이터. 캔버스를 열 때만 불러온다 (dashboard.functions 재사용, 수정 없음).
  const { data: overview } = useQuery({
    queryKey: ["org-overview"],
    queryFn: async () => getOrgOverview({ headers: await authHeaders() }),
    enabled: orgView === "canvas",
  });

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

  const edit = useMutation({
    mutationFn: async (run: () => Promise<EditResult>) => run(),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setAction(null);
      setNewRoot("");
      void queryClient.invalidateQueries({ queryKey: ["master-org-units"] });
      void queryClient.invalidateQueries({ queryKey: ["master-status"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submitAction(values: { name: string; level: string; parentId: string | null }) {
    if (!action) return;
    const { kind, unit } = action;
    const run = () =>
      edit.mutate(async () => {
        const headers = await authHeaders();
        if (kind === "rename") {
          return renameOrgUnit({
            data: { id: unit.id, name: values.name, level: values.level },
            headers,
          });
        }
        if (kind === "child") {
          return createOrgUnit({
            data: {
              companyId: unit.company_id,
              parentId: unit.id,
              name: values.name,
              level: values.level,
            },
            headers,
          });
        }
        return moveOrgUnit({ data: { id: unit.id, parentId: values.parentId }, headers });
      });
    if (kind === "child") {
      run();
      return;
    }
    void gate({
      kind: kind === "rename" ? "org_rename" : "org_move",
      id: unit.id,
      title: kind === "rename" ? `「${unit.name}」 이름 변경` : `「${unit.name}」 상위 이동`,
      confirmLabel: kind === "rename" ? "변경" : "이동",
      run,
    });
  }

  const canvasRollup = useMemo(() => buildCanvasRollup(overview, units ?? []), [overview, units]);

  function handleDelete(unit: OrgUnit) {
    void gate({
      kind: "org_delete",
      id: unit.id,
      title: `「${unit.name}」 조직 삭제`,
      confirmLabel: "삭제",
      destructive: true,
      always: true,
      run: () =>
        edit.mutate(async () =>
          deleteOrgUnit({ data: { id: unit.id }, headers: await authHeaders() }),
        ),
    });
  }

  /** 캔버스에서 노드를 다른 노드에 드롭 = 상위 이동. 서버 moveOrgUnit 이 순환을 최종 검증한다. */
  function handleDropMove(unit: OrgUnit, target: OrgUnit) {
    if (unit.company_id !== target.company_id) {
      toast.error("같은 계열사 안의 조직으로만 옮길 수 있습니다.");
      return;
    }
    void gate({
      kind: "org_move",
      id: unit.id,
      title: `「${unit.name}」 을(를) 「${target.name}」 하위로 이동`,
      confirmLabel: "이동",
      always: true,
      run: () =>
        edit.mutate(async () =>
          moveOrgUnit({ data: { id: unit.id, parentId: target.id }, headers: await authHeaders() }),
        ),
    });
  }

  // 전체 계열사 보기에서는 어느 회사에 붙일지 정할 수 없어 최상위 추가를 막는다.
  const rootCompanyId = companyId === "all" ? "" : companyId;

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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">조직도 {units ? `(${units.length})` : ""}</p>
            <div className="flex items-center rounded-lg border p-0.5">
              <Button
                size="sm"
                variant={orgView === "tree" ? "secondary" : "ghost"}
                className="h-6 px-2 text-xs"
                onClick={() => setOrgView("tree")}
              >
                트리
              </Button>
              <Button
                size="sm"
                variant={orgView === "canvas" ? "secondary" : "ghost"}
                className="h-6 px-2 text-xs"
                onClick={() => setOrgView("canvas")}
              >
                캔버스
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 w-40"
              value={newRoot}
              placeholder="최상위 조직명"
              aria-label="최상위 조직명"
              onChange={(e) => setNewRoot(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={edit.isPending || newRoot.trim() === "" || rootCompanyId === ""}
              onClick={() =>
                edit.mutate(async () =>
                  createOrgUnit({
                    data: {
                      companyId: rootCompanyId,
                      parentId: null,
                      name: newRoot.trim(),
                      level: "",
                    },
                    headers: await authHeaders(),
                  }),
                )
              }
            >
              <Plus className="size-4" />
              최상위 추가
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          각 조직의 ⋯ 버튼으로 이름 변경·하위 추가·상위 이동·삭제를 할 수 있습니다. 하위 조직이나
          배정 인원이 있는 조직은 삭제되지 않습니다.
          {companyId === "all" && " 최상위 추가는 계열사를 선택한 뒤 사용하세요."}
        </p>
        {orgView === "tree" ? (
          <div className="mt-3">
            <OrgTree
              units={units ?? []}
              action={action}
              busy={edit.isPending}
              onAction={setAction}
              onCancel={() => setAction(null)}
              onSubmit={submitAction}
              onDelete={handleDelete}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {action && (
              <OrgNodeEditor
                key={`${action.kind}-${action.unit.id}`}
                action={action}
                units={units ?? []}
                busy={edit.isPending}
                onCancel={() => setAction(null)}
                onSubmit={submitAction}
              />
            )}
            <OrgCanvas
              units={units ?? []}
              rollup={canvasRollup}
              busy={edit.isPending}
              onAction={setAction}
              onDelete={handleDelete}
              onDropMove={handleDropMove}
            />
            <p className="text-xs text-muted-foreground">
              휠로 확대·축소, 빈 곳을 끌어 이동합니다. 노드를 다른 노드 위에 끌어 놓으면 그 조직의
              하위로 이동합니다. 링은 하위 조직을 합산한 제출률입니다.
            </p>
          </div>
        )}
      </div>

      <ImpactConfirmDialog pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

/* ──────────────────────── ② 직무분류 ──────────────────────── */

type JobRow = {
  id: string;
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string | null;
};

type JobEdit = {
  id: string | null;
  job_group: string;
  job_series: string;
  job_name: string;
  definition: string;
};

const EMPTY_JOB_EDIT: JobEdit = {
  id: null,
  job_group: "",
  job_series: "",
  job_name: "",
  definition: "",
};

function JobRowEditor({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: JobEdit;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: JobEdit) => void;
}) {
  const [values, setValues] = useState(initial);
  const filled =
    values.job_group.trim() !== "" &&
    values.job_series.trim() !== "" &&
    values.job_name.trim() !== "";

  const field = (key: keyof Omit<JobEdit, "id">, label: string, className: string) => (
    <Input
      className={`h-8 ${className}`}
      value={values[key]}
      placeholder={label}
      aria-label={label}
      onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
    />
  );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
      {field("job_group", "직군", "w-28")}
      {field("job_series", "직렬", "w-28")}
      {field("job_name", "직무", "w-36")}
      {field("definition", "정의 한 문장", "w-full sm:w-72")}
      <Button size="sm" className="h-8" disabled={busy || !filled} onClick={() => onSubmit(values)}>
        저장
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
        <X className="size-4" />
        취소
      </Button>
    </div>
  );
}

function JobCatalogList() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<JobEdit | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const gate = makeImpactGate(setPending);

  const { data: rows } = useQuery({
    queryKey: ["master-job-catalog"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_catalog")
        .select("id, job_group, job_series, job_name, definition")
        .order("job_group")
        .order("job_series")
        .order("job_name");
      if (error) throw error;
      return data as JobRow[];
    },
  });

  const edit = useMutation({
    mutationFn: async (run: () => Promise<EditResult>) => run(),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["master-job-catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["master-status"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function save(values: JobEdit) {
    const run = () =>
      edit.mutate(async () =>
        upsertJobCatalogRow({
          data: {
            id: values.id,
            job_group: values.job_group.trim(),
            job_series: values.job_series.trim(),
            job_name: values.job_name.trim(),
            definition: values.definition.trim(),
            companyIds: [],
          },
          headers: await authHeaders(),
        }),
      );
    if (!values.id) {
      run();
      return;
    }
    void gate({
      kind: "catalog_row_update",
      id: values.id,
      title: `「${values.job_name.trim()}」 직무 수정`,
      confirmLabel: "수정",
      run,
    });
  }

  // 직군 → 직렬 → 행 으로 묶는다. 쿼리에서 이미 정렬돼 오므로 삽입 순서를 그대로 쓴다.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, Map<string, JobRow[]>>();
    for (const row of rows ?? []) {
      const series = byGroup.get(row.job_group) ?? new Map<string, JobRow[]>();
      const list = series.get(row.job_series) ?? [];
      list.push(row);
      series.set(row.job_series, list);
      byGroup.set(row.job_group, series);
    }
    return [...byGroup.entries()];
  }, [rows]);

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">직무분류표 {rows ? `(${rows.length})` : ""}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            직군 &gt; 직렬로 묶어 보여줍니다. 행을 눌러 직군·직렬·직무·정의를 바로 고칠 수 있습니다.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing({ ...EMPTY_JOB_EDIT })}
          disabled={editing?.id === null}
        >
          <Plus className="size-4" />
          직무 추가
        </Button>
      </div>

      {editing?.id === null && (
        <JobRowEditor
          initial={editing}
          busy={edit.isPending}
          onCancel={() => setEditing(null)}
          onSubmit={save}
        />
      )}

      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">등록된 직무가 없습니다.</p>
      ) : (
        <Accordion type="multiple" className="w-full">
          {grouped.map(([group, seriesMap]) => {
            const count = [...seriesMap.values()].reduce((sum, list) => sum + list.length, 0);
            return (
              <AccordionItem key={group} value={group}>
                <AccordionTrigger className="text-sm">
                  {group}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    직렬 {seriesMap.size} · 직무 {count}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="space-y-3">
                  {[...seriesMap.entries()].map(([series, list]) => (
                    <div key={series} className="space-y-1">
                      <p className="text-xs font-medium text-primary">{series}</p>
                      {list.map((row) =>
                        editing?.id === row.id ? (
                          <JobRowEditor
                            key={row.id}
                            initial={editing}
                            busy={edit.isPending}
                            onCancel={() => setEditing(null)}
                            onSubmit={save}
                          />
                        ) : (
                          <div
                            key={row.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                          >
                            <span className="font-medium">{row.job_name}</span>
                            <span className="flex-1 text-muted-foreground">
                              {row.definition ?? "정의 없음"}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              onClick={() =>
                                setEditing({
                                  id: row.id,
                                  job_group: row.job_group,
                                  job_series: row.job_series,
                                  job_name: row.job_name,
                                  definition: row.definition ?? "",
                                })
                              }
                            >
                              수정
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-destructive"
                              disabled={edit.isPending}
                              onClick={() =>
                                void gate({
                                  kind: "catalog_row_delete",
                                  id: row.id,
                                  title: `「${row.job_name}」 직무 삭제`,
                                  confirmLabel: "삭제",
                                  destructive: true,
                                  always: true,
                                  run: () =>
                                    edit.mutate(async () =>
                                      deleteJobCatalogRow({
                                        data: { id: row.id },
                                        headers: await authHeaders(),
                                      }),
                                    ),
                                })
                              }
                            >
                              삭제
                            </Button>
                          </div>
                        ),
                      )}
                    </div>
                  ))}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}

      <ImpactConfirmDialog pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

/* ──────────────── 직무분류 버전 관리 (V6) ──────────────── */

function CatalogVersionPanel() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const gate = makeImpactGate(setPending);
  const [label, setLabel] = useState("");
  const [baseId, setBaseId] = useState("current");
  const [diff, setDiff] = useState<CatalogDiff | null>(null);

  const { data: versions } = useQuery({
    queryKey: ["catalog-versions"],
    queryFn: async () => listCatalogVersions({ headers: await authHeaders() }),
  });

  function invalidateVersions() {
    void queryClient.invalidateQueries({ queryKey: ["catalog-versions"] });
  }

  const save = useMutation({
    mutationFn: async () =>
      saveCatalogVersion({ data: { label: label.trim() }, headers: await authHeaders() }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setLabel("");
      invalidateVersions();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      deleteCatalogVersion({ data: { id }, headers: await authHeaders() }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setDiff(null);
      invalidateVersions();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const restore = useMutation({
    mutationFn: async (id: string) =>
      restoreCatalogVersion({ data: { id }, headers: await authHeaders() }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setDiff(null);
      invalidateVersions();
      void queryClient.invalidateQueries({ queryKey: ["master-job-catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["master-status"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const compare = useMutation({
    mutationFn: async (id: string) =>
      diffCatalogVersions({
        data: { id, againstId: baseId === "current" ? null : baseId },
        headers: await authHeaders(),
      }),
    onSuccess: setDiff,
    onError: (err) => toast.error(errorMessage(err)),
  });

  const busy = save.isPending || remove.isPending || restore.isPending || compare.isPending;

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            버전 관리 {versions ? `(${versions.length})` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            AI 가안 반영·업로드 교체·복원 전에 자동 백업 버전이 만들어집니다. 개별 행 편집은 버전을
            만들지 않습니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-44"
            value={label}
            placeholder="버전 라벨(비우면 자동)"
            aria-label="버전 라벨"
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save.mutate()}>
            <History className="size-4" />
            현재 버전 저장
          </Button>
        </div>
      </div>

      {(versions ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">저장된 버전이 없습니다.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">비교 기준</span>
            <Select value={baseId} onValueChange={setBaseId}>
              <SelectTrigger className="h-8 w-56" aria-label="비교 기준 선택">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">현재 직무분류표</SelectItem>
                {versions?.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ul className="divide-y rounded-lg border text-sm">
            {versions?.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{v.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(v.createdAt)} · {v.rowCount}행
                    {v.note ? ` · ${v.note}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy || v.id === baseId}
                  onClick={() => compare.mutate(v.id)}
                >
                  비교
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy}
                  onClick={() =>
                    void gate({
                      kind: "catalog_restore",
                      id: v.id,
                      title: `「${v.label}」 버전으로 복원`,
                      confirmLabel: "복원",
                      destructive: true,
                      always: true,
                      run: () => restore.mutate(v.id),
                    })
                  }
                >
                  복원
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`「${v.label}」 버전을 삭제할까요?`)) return;
                    remove.mutate(v.id);
                  }}
                >
                  삭제
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {diff && (
        <div className="space-y-2 rounded-lg border p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">
              「{diff.aLabel}」 ↔ 「{diff.bLabel}」 비교
            </p>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setDiff(null)}>
              <X className="size-4" />
              닫기
            </Button>
          </div>
          {diff.onlyA.length === 0 && diff.onlyB.length === 0 && diff.changed.length === 0 ? (
            <p className="text-muted-foreground">두 버전의 직무 구성이 같습니다.</p>
          ) : (
            <>
              {diff.onlyB.length > 0 && (
                <div>
                  <p className="font-medium text-primary">
                    {diff.bLabel}에만 있음 — 추가된 직무 {diff.onlyB.length}건
                  </p>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                    {diff.onlyB.map((key) => (
                      <li key={key}>{key}</li>
                    ))}
                  </ul>
                </div>
              )}
              {diff.onlyA.length > 0 && (
                <div>
                  <p className="font-medium text-destructive">
                    {diff.aLabel}에만 있음 — 삭제된 직무 {diff.onlyA.length}건
                  </p>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                    {diff.onlyA.map((key) => (
                      <li key={key}>{key}</li>
                    ))}
                  </ul>
                </div>
              )}
              {diff.changed.length > 0 && (
                <div>
                  <p className="font-medium">정의 변경 {diff.changed.length}건</p>
                  <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                    {diff.changed.map((item) => (
                      <li key={item.key}>
                        <span className="font-medium">{item.key}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          — {item.a || "(정의 없음)"} → {item.b || "(정의 없음)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <ImpactConfirmDialog pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

function JobDraftPanel({ onApplied }: { onApplied: () => void }) {
  const [draft, setDraft] = useState<JobDraftRow[] | null>(null);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [failedGroups, setFailedGroups] = useState<string[]>([]);

  // groups 지정 시 해당 직군만 재생성해 기존 가안과 병합한다(부분 실패 복구).
  const generate = useMutation({
    mutationFn: async (groups: string[] | null) =>
      draftJobCatalog({
        data: groups && groups.length > 0 ? { groups } : {},
        headers: await authHeaders(),
      }),
    onSuccess: (result, groups) => {
      if (groups && groups.length > 0) {
        const regenerated = new Set(groups);
        setDraft((prev) => [
          ...(prev ?? []).filter((row) => !regenerated.has(row.job_group)),
          ...result.rows,
        ]);
      } else {
        setDraft(result.rows);
      }
      setFailedGroups(result.failedGroups);
      setReport(null);
      toast.success(`직무 ${result.rows.length}건의 가안을 만들었습니다. 검토 후 반영하세요.`);
      if (result.failedGroups.length > 0) {
        toast.error(
          `일부 직군 생성에 실패했습니다: ${result.failedGroups.join(", ")} — 실패 직군만 다시 생성할 수 있습니다.`,
        );
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const apply = useMutation({
    mutationFn: async () => {
      const rows = (draft ?? []).filter((r) => r.job_group && r.job_series && r.job_name);
      if (rows.length === 0) throw new Error("반영할 행이 없습니다.");
      return uploadJobCatalog({
        data: {
          confirm: true,
          source: "ai_draft",
          rows: rows.map((r) => ({
            job_group: r.job_group,
            job_series: r.job_series,
            job_name: r.job_name,
            definition: r.definition,
            companies: "",
          })),
        },
        headers: await authHeaders(),
      });
    },
    onSuccess: (result) => {
      setReport(result);
      if (result.applied > 0) {
        toast.success(`직무분류표 ${result.applied}건을 반영했습니다.`);
        setDraft(null);
        onApplied();
      } else {
        toast.error(`오류 ${result.issues.length}건이 있습니다.`);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function update(index: number, key: keyof JobDraftRow, value: string) {
    setDraft((prev) =>
      (prev ?? []).map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    );
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">AI 직무분류 가안</p>
          <p className="mt-1 text-xs text-muted-foreground">
            조직도와 참여자 소속·직급 분포를 근거로 직군 7개 체계를 제안합니다. 참여자 이름·사번은
            AI에 전달하지 않습니다. 가안은 아래 표에서 고친 뒤 반영됩니다.
          </p>
        </div>
        <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate(null)}>
          <Wand2 className="size-4" />
          {generate.isPending ? "생성 중..." : "AI 가안 생성"}
        </Button>
      </div>

      {failedGroups.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="text-xs">생성 실패 직군:</span>
          {failedGroups.map((name) => (
            <span
              key={name}
              className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
            >
              {name}
            </span>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={generate.isPending}
            onClick={() => generate.mutate(failedGroups)}
          >
            {generate.isPending ? "생성 중..." : "실패 직군만 다시 생성"}
          </Button>
        </div>
      )}

      {draft && draft.length > 0 && (
        <>
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">직군</th>
                  <th className="px-2 py-2 font-medium">직렬</th>
                  <th className="px-2 py-2 font-medium">직무</th>
                  <th className="px-2 py-2 font-medium">정의</th>
                  <th className="w-16 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {draft.map((row, index) => (
                  <tr key={index} className="border-t">
                    {(["job_group", "job_series", "job_name", "definition"] as const).map((key) => (
                      <td key={key} className="px-2 py-1">
                        <Input
                          className="h-8"
                          value={row[key]}
                          aria-label={`${index + 1}번째 행 ${key}`}
                          onChange={(e) => update(index, key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-destructive"
                        onClick={() =>
                          setDraft((prev) => (prev ?? []).filter((_, i) => i !== index))
                        }
                      >
                        삭제
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report && <ReportPanel report={report} />}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft((prev) => [
                  ...(prev ?? []),
                  { job_group: "", job_series: "", job_name: "", definition: "" },
                ])
              }
            >
              <Plus className="size-4" />행 추가
            </Button>
            <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
              가안 {draft.length}건 반영
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setFailedGroups([]);
              }}
            >
              가안 버리기
            </Button>
            <span className="text-xs text-muted-foreground">
              반영하면 기존 직무분류표를 교체합니다. 변경 전 백업은 변경 기록에 저장됩니다.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function JobTab() {
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<MappingSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const suggest = useMutation({
    mutationFn: async () => suggestResponseMapping({ headers: await authHeaders() }),
    onSuccess: (items) => {
      setSuggestions(items);
      setSelected(new Set(items.map((i) => i.responseId)));
      if (items.length === 0) toast.info("연결을 제안할 응답이 없습니다.");
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
          void queryClient.invalidateQueries({ queryKey: ["master-job-catalog"] });
          void queryClient.invalidateQueries({ queryKey: ["master-status"] });
          void queryClient.invalidateQueries({ queryKey: ["catalog-versions"] });
        }}
      />

      <JobDraftPanel
        onApplied={() => {
          setSuggestions(null);
          void queryClient.invalidateQueries({ queryKey: ["master-job-catalog"] });
          void queryClient.invalidateQueries({ queryKey: ["master-status"] });
          void queryClient.invalidateQueries({ queryKey: ["catalog-versions"] });
        }}
      />

      <JobCatalogList />

      <CatalogVersionPanel />

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">기존 응답 연결 제안</p>
            <p className="mt-1 text-xs text-muted-foreground">
              응답자가 자유 입력한 직군·직렬·직무를 직무분류표 항목과 대조해 유사도 60% 이상만
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
                    <th className="px-3 py-2 font-medium">직무분류표 제안</th>
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

/** AI 업무분장 가안 (V8). 생성 → 편집 가능한 검토 표 → 확인 후 조직별 uploadDutyChart 로 반영. */
function DutyDraftPanel({ onApplied }: { onApplied: () => void }) {
  const [charts, setCharts] = useState<DutyDraftChart[] | null>(null);
  const [failedOrgs, setFailedOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [skipped, setSkipped] = useState(0);

  // orgIds 지정 시 해당 조직만 재생성해 기존 가안과 병합한다(부분 실패 복구).
  const generate = useMutation({
    mutationFn: async (orgIds: string[] | null) =>
      draftDutyCharts({
        data: orgIds && orgIds.length > 0 ? { orgIds } : {},
        headers: await authHeaders(),
      }),
    onSuccess: (result, orgIds) => {
      if (orgIds && orgIds.length > 0) {
        const regenerated = new Set(result.charts.map((c) => c.orgId));
        setCharts((prev) => [
          ...(prev ?? []).filter((c) => !regenerated.has(c.orgId)),
          ...result.charts,
        ]);
      } else {
        setCharts(result.charts);
      }
      setFailedOrgs(result.failedOrgs);
      setSkipped(result.skippedOrgs);
      toast.success(
        `${result.charts.length}개 조직의 업무분장 가안을 만들었습니다. 검토 후 반영하세요.`,
      );
      if (result.failedOrgs.length > 0) {
        toast.error(
          `일부 조직 생성 실패: ${result.failedOrgs.map((f) => f.orgName).join(", ")} — 실패 조직만 다시 생성할 수 있습니다.`,
        );
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const apply = useMutation({
    mutationFn: async () => {
      const ready = (charts ?? [])
        .map((c) => ({
          ...c,
          rows: c.rows.filter((r) => r.main.trim() !== "" || r.detail.trim() !== ""),
        }))
        .filter((c) => c.rows.length > 0);
      if (ready.length === 0) throw new Error("반영할 조직이 없습니다.");
      const headers = await authHeaders();
      // 조직 단위로 기존 uploadDutyChart 를 재사용한다(해당 조직 행 교체 + 스냅샷 + 감사 로그).
      const settled = await Promise.allSettled(
        ready.map((c) =>
          uploadDutyChart({
            data: {
              confirm: true,
              companyId: c.companyId,
              orgName: c.orgName,
              rows: c.rows.map((r) => ({ "주요 업무": r.main.trim(), "세부 업무": r.detail.trim() })),
            },
            headers,
          }),
        ),
      );
      const failed = ready.filter((_, i) => settled[i]!.status === "rejected");
      return { applied: ready.length - failed.length, failed };
    },
    onSuccess: ({ applied, failed }) => {
      if (applied > 0) toast.success(`${applied}개 조직의 업무분장표를 반영했습니다.`);
      if (failed.length > 0) {
        toast.error(`반영 실패: ${failed.map((c) => c.orgName).join(", ")} — 표에 남겨두었습니다.`);
        setCharts(failed);
      } else {
        setCharts(null);
        setFailedOrgs([]);
      }
      onApplied();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function updateRow(ci: number, ri: number, key: keyof DutyDraftRow, value: string) {
    setCharts((prev) =>
      (prev ?? []).map((c, i) =>
        i === ci
          ? { ...c, rows: c.rows.map((r, j) => (j === ri ? { ...r, [key]: value } : r)) }
          : c,
      ),
    );
  }

  const totalRows = (charts ?? []).reduce((sum, c) => sum + c.rows.length, 0);
  const busy = generate.isPending || apply.isPending;

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">AI 업무분장 가안</p>
          <p className="mt-1 text-xs text-muted-foreground">
            인원이 배정된 조직 전체(최대 {DUTY_ORG_LIMIT}개, 배정 인원 많은 순)를 대상으로 조직별
            「주요 업무 → 세부 업무」 초안을 만듭니다. 근거는 조직도·직급 분포·제출 응답의 과업
            집계이며 참여자 이름·사번은 AI에 전달하지 않습니다. 반영 전 아래 표에서 검토·수정합니다.
          </p>
        </div>
        <Button size="sm" disabled={busy} onClick={() => generate.mutate(null)}>
          <Wand2 className="size-4" />
          {generate.isPending ? "생성 중..." : "AI 가안 생성"}
        </Button>
      </div>

      {skipped > 0 && (
        <p className="text-xs text-muted-foreground">
          대상 상한을 넘어 {skipped}개 조직이 이번 생성에서 빠졌습니다. 반영 후 다시 생성하면 이어서
          만들 수 있습니다.
        </p>
      )}

      {failedOrgs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="text-xs">생성 실패 조직:</span>
          {failedOrgs.map((f) => (
            <span
              key={f.orgId}
              className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
            >
              {f.orgName}
            </span>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => generate.mutate(failedOrgs.map((f) => f.orgId))}
          >
            {generate.isPending ? "생성 중..." : "실패 조직만 다시 생성"}
          </Button>
        </div>
      )}

      {charts && charts.length > 0 && (
        <>
          <div className="max-h-[480px] space-y-3 overflow-y-auto pr-1">
            {charts.map((chart, ci) => (
              <div key={chart.orgId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {chart.orgName}
                    <span className="ml-2 text-xs font-normal text-primary">
                      {chart.companyName}
                    </span>
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      배정 {chart.memberCount}명 · {chart.rows.length}행
                    </span>
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => setCharts((prev) => (prev ?? []).filter((_, i) => i !== ci))}
                  >
                    조직 제외
                  </Button>
                </div>
                <table className="mt-2 w-full min-w-[420px] text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="w-2/5 px-1 py-1 font-medium">주요 업무</th>
                      <th className="px-1 py-1 font-medium">세부 업무</th>
                      <th className="w-14 px-1 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {chart.rows.map((row, ri) => (
                      <tr key={ri} className="border-t">
                        <td className="px-1 py-1">
                          <Input
                            className="h-8"
                            value={row.main}
                            aria-label={`${chart.orgName} ${ri + 1}번째 행 주요 업무`}
                            onChange={(e) => updateRow(ci, ri, "main", e.target.value)}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Input
                            className="h-8"
                            value={row.detail}
                            aria-label={`${chart.orgName} ${ri + 1}번째 행 세부 업무`}
                            onChange={(e) => updateRow(ci, ri, "detail", e.target.value)}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-destructive"
                            onClick={() =>
                              setCharts((prev) =>
                                (prev ?? []).map((c, i) =>
                                  i === ci
                                    ? { ...c, rows: c.rows.filter((_, j) => j !== ri) }
                                    : c,
                                ),
                              )
                            }
                          >
                            삭제
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7"
                  onClick={() =>
                    setCharts((prev) =>
                      (prev ?? []).map((c, i) =>
                        i === ci ? { ...c, rows: [...c.rows, { main: "", detail: "" }] } : c,
                      ),
                    )
                  }
                >
                  <Plus className="size-4" />행 추가
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `${charts.length}개 조직의 업무분장표(총 ${totalRows}행)를 반영할까요? 같은 조직의 기존 업무분장표는 교체되며, 변경 전 내용은 변경 기록에 저장됩니다.`,
                  )
                )
                  return;
                apply.mutate();
              }}
            >
              {apply.isPending ? "반영 중..." : `가안 ${charts.length}개 조직 반영`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCharts(null);
                setFailedOrgs([]);
              }}
            >
              가안 버리기
            </Button>
            <span className="text-xs text-muted-foreground">
              반영 전에는 DB에 저장되지 않습니다.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

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
        toast.success(`${result.applied}건이 저장되었습니다.`);
        setRows([]);
        setFileName("");
        void queryClient.invalidateQueries({ queryKey: ["duty-charts"] });
        void queryClient.invalidateQueries({ queryKey: ["master-status"] });
      } else {
        toast.error(`오류 ${result.issues.length}건이 있습니다.`);
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
      <DutyDraftPanel
        onApplied={() => {
          void queryClient.invalidateQueries({ queryKey: ["duty-charts"] });
          void queryClient.invalidateQueries({ queryKey: ["master-status"] });
        }}
      />

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
              {fileName} · {rows.length}건
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
                  {chart.rowCount}건 · {formatDate(chart.uploadedAt)}
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
    { label: "직무분류표", value: data?.jobCatalog ?? 0 },
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
        반영 전 백업이 변경 기록에 저장됩니다. 잘못 반영한 경우 변경 기록의 백업을 되돌리기 지점으로
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
