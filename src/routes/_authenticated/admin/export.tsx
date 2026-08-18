import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Braces, Database, Download, FileSpreadsheet } from "lucide-react";
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
import { exportJson, exportStdjob, snapshotAll, type Sheet } from "@/lib/export.functions";

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

  const companyParam = company === "all" ? null : company;

  const buildStdjob = useMutation({
    mutationFn: async () =>
      exportStdjob({
        data: { companyId: companyParam, scope: approvedOnly ? "approved" : "all" },
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
        setSheets(null);
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
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:mt-6">
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

      {/* 2. 데이터 원본 내려받기 */}
      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Braces className="size-5 text-primary" />
          <h2 className="font-semibold">데이터 원본 내려받기(시스템용)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          각 항목의 뜻을 함께 담은 데이터 원본 파일입니다. 다른 시스템이나 AI 분석에 그대로 넣어 쓸
          수 있습니다. 위에서 고른 계열사 기준으로 생성됩니다.
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

      {/* 3. 수동 백업 */}
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
