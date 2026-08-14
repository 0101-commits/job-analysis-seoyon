import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  Upload,
  UserPlus,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import { StatusBadge } from "@/components/StatusBadge";
import { useCompanyScope } from "@/components/CompanyContext";
import { similarity } from "@/components/survey/validation";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import {
  ROSTER_COLUMNS,
  parseRosterFile,
  rosterTemplateCsv,
  validateRoster,
  type RosterRaw,
  type RosterRow,
} from "@/lib/roster";
import { provisionAccounts, resetParticipantPassword } from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/admin/participants")({
  head: () => ({
    meta: [
      { title: "참여자 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "계열사별 참여자 명단과 계정 상태를 관리합니다." },
      { property: "og:title", content: "참여자 관리 | 서연 그룹 업무조사" },
      { property: "og:description", content: "계열사별 참여자 명단과 계정 상태를 관리합니다." },
    ],
  }),
  component: ParticipantsPage,
});

/** 매핑 없이도 통과시킬 수 있는 열. 나머지는 필수. */
const OPTIONAL_COLUMNS = new Set(["생년월일(YYMMDD)", "소속", "직급", "역할단계"]);

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

/** 파일 헤더 ↔ 명부 열 자동 추정. 이름이 같으면 바로, 아니면 유사도 0.6 이상. */
function guessMapping(headers: string[]) {
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const column of ROSTER_COLUMNS) {
    const exact = headers.find((h) => h === column && !taken.has(h));
    if (exact) {
      mapping[column] = exact;
      taken.add(exact);
      continue;
    }
    let best: { header: string; score: number } | null = null;
    for (const header of headers) {
      if (taken.has(header)) continue;
      const score = similarity(header, column);
      if (!best || score > best.score) best = { header, score };
    }
    if (best && best.score >= 0.6) {
      mapping[column] = best.header;
      taken.add(best.header);
    }
  }
  return mapping;
}

/* ─────────────────────── ① 명부 업로드 → 계정 생성 ─────────────────────── */

function RosterUploadTab() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<RosterRaw[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validated, setValidated] = useState<RosterRow[] | null>(null);

  const { data: companies } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name")
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: existing } = useQuery({
    queryKey: ["participants-keys"],
    queryFn: async () => {
      const { data, error } = await supabase.from("participants").select("emp_no, email");
      if (error) throw error;
      return data ?? [];
    },
  });

  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  const missing = ROSTER_COLUMNS.filter((c) => !OPTIONAL_COLUMNS.has(c) && !mapping[c]);

  /** 매핑을 적용해 명부 열 이름을 키로 하는 행으로 바꾼다. validateRoster 가 이 키를 읽는다. */
  const mapped = useMemo(
    () =>
      rows.map((row) => {
        const out: RosterRaw = {};
        for (const column of ROSTER_COLUMNS) {
          const header = mapping[column];
          out[column] = (header ? row[header] : "") ?? "";
        }
        return out;
      }),
    [rows, mapping],
  );

  const validRows = (validated ?? []).filter((r) => r.errors.length === 0);
  const errorRows = (validated ?? []).filter((r) => r.errors.length > 0);

  const insert = useMutation({
    mutationFn: async () => {
      const payload = validRows.map((r) => ({
        company_id: r.parsed.company_id as string,
        emp_no: r.parsed.emp_no,
        name: r.parsed.name,
        email: r.parsed.email,
        birth_date: r.parsed.birth_date,
        org_text: r.parsed.org_text,
        grade: r.parsed.grade,
        role_level: r.parsed.role_level,
      }));
      if (payload.length === 0) throw new Error("반영할 행이 없습니다.");
      const { error } = await supabase.from("participants").insert(payload);
      if (error) throw new Error(error.message);
      return payload.length;
    },
    onSuccess: (count) => {
      toast.success(`${count}명을 명부에 등록했습니다. 명단 탭에서 계정을 생성하세요.`);
      reset();
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function reset() {
    setFileName("");
    setRows([]);
    setMapping({});
    setValidated(null);
  }

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
      setMapping(guessMapping(Object.keys(parsed[0] ?? {})));
      setValidated(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function runValidation() {
    const result = validateRoster(mapped, companies ?? [], existing ?? []);
    setValidated(result);
    const bad = result.filter((r) => r.errors.length > 0).length;
    if (bad === 0) toast.success(`검증 통과 — ${result.length}행 모두 반영 가능합니다.`);
    else toast.error(`${bad}행에 오류가 있습니다.`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv("참여자_명부_템플릿.csv", rosterTemplateCsv())}
        >
          <Download className="size-4" />
          템플릿 내려받기
        </Button>
        <Label
          htmlFor="roster-file"
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium hover:bg-secondary"
        >
          <Upload className="size-4" />
          파일 선택
        </Label>
        <input
          id="roster-file"
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
              파일의 열을 명부 항목에 연결합니다. 헤더 이름으로 자동 추정했습니다.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {ROSTER_COLUMNS.map((column) => (
                <div key={column} className="space-y-1">
                  <Label className="text-xs">
                    {column}
                    {!OPTIONAL_COLUMNS.has(column) && (
                      <span className="ml-1 text-destructive">*</span>
                    )}
                  </Label>
                  <Select
                    value={mapping[column] ?? "__none__"}
                    onValueChange={(value) =>
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (value === "__none__") delete next[column];
                        else next[column] = value;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger aria-label={`${column} 열 선택`}>
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
                필수 항목 미지정: {missing.join(", ")}
              </p>
            )}
          </div>

          {validated && (
            <div className="space-y-2 rounded-xl border bg-card p-4">
              {errorRows.length === 0 ? (
                <p className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  {validRows.length}행 모두 반영 가능합니다.
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="size-4" />
                    오류 {errorRows.length}행 · 정상 {validRows.length}행
                  </p>
                  <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                    {errorRows.slice(0, 50).map((r) => (
                      <li key={r.rowNo}>
                        <span className="font-medium">{r.rowNo}행</span> {r.parsed.name || "-"} ·{" "}
                        {r.errors.join(", ")}
                      </li>
                    ))}
                  </ul>
                  {errorRows.length > 50 && (
                    <p className="text-xs text-muted-foreground">
                      외 {errorRows.length - 50}행 더 있습니다.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button disabled={missing.length > 0} onClick={runValidation}>
              검증
            </Button>
            <Button
              variant="secondary"
              disabled={!validated || validRows.length === 0 || insert.isPending}
              onClick={() => insert.mutate()}
            >
              {insert.isPending && <Loader2 className="size-4 animate-spin" />}
              오류 제외하고 {validRows.length}행 반영
            </Button>
            <Button variant="ghost" disabled={insert.isPending} onClick={reset}>
              전체 취소
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── ② 명단 ───────────────────────────── */

type Participant = {
  id: string;
  emp_no: string;
  name: string;
  email: string | null;
  org_text: string | null;
  grade: string | null;
  role: string;
  account_status: string;
  user_id: string | null;
  companies: { name: string } | null;
};

function RosterListTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["participants", companyId],
    queryFn: async () => {
      let query = supabase
        .from("participants")
        .select(
          "id, emp_no, name, email, org_text, grade, role, account_status, user_id, companies(name)",
        )
        .order("emp_no");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Participant[];
    },
  });

  const rows = useMemo(
    () => (data ?? []).filter((p) => statusFilter === "all" || p.account_status === statusFilter),
    [data, statusFilter],
  );

  const provision = useMutation({
    mutationFn: async (ids: string[]) =>
      provisionAccounts({ data: { participantIds: ids }, headers: await authHeaders() }),
    onSuccess: (res) => {
      const failed = res.failures.length;
      toast.success(
        `계정 ${res.created}건 생성, ${res.updated}건 갱신${failed ? ` · 실패 ${failed}건` : ""}`,
      );
      for (const f of res.failures.slice(0, 5)) toast.error(`${f.name}: ${f.reason}`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resetPassword = useMutation({
    mutationFn: async (participantId: string) =>
      resetParticipantPassword({ data: { participantId }, headers: await authHeaders() }),
    onSuccess: (res) => toast.success(`초기 비밀번호를 ${res.password} 로 재설정했습니다.`),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const selectedIds = [...selected];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]" aria-label="상태 필터">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 상태</SelectItem>
              {ACCOUNT_STATUS_LABELS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
          >
            {allSelected ? "전체 해제" : "전체 선택"}
          </Button>
        </div>
        <Button
          disabled={selectedIds.length === 0 || provision.isPending}
          onClick={() => provision.mutate(selectedIds)}
        >
          {provision.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UserPlus className="size-4" />
          )}
          선택 {selectedIds.length}명 계정 생성
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : (
        <>
          {/* 모바일: 카드 스택 */}
          <ul className="space-y-3 md:hidden">
            {rows.map((p) => (
              <li key={p.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={() => toggle(p.id)}
                      aria-label={`${p.name} 선택`}
                    />
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {p.name}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {p.emp_no}
                        </span>
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {p.companies?.name} · {p.org_text}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={p.account_status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">직급</dt>
                    <dd className="mt-0.5 font-medium">{p.grade ?? "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">권한</dt>
                    <dd className="mt-0.5 font-medium">
                      {p.role === "admin" ? "관리자" : "응답자"}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">이메일</dt>
                    <dd className="mt-0.5 truncate font-medium">{p.email ?? "-"}</dd>
                  </div>
                </dl>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={!p.user_id || resetPassword.isPending}
                  onClick={() => resetPassword.mutate(p.id)}
                >
                  <KeyRound className="size-4" />
                  비밀번호 초기화
                </Button>
              </li>
            ))}
          </ul>

          {/* 데스크톱: 표 */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="bg-secondary text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-3" />
                  <th className="px-4 py-3 font-medium">사번</th>
                  <th className="px-4 py-3 font-medium">이름</th>
                  <th className="px-4 py-3 font-medium">계열사</th>
                  <th className="px-4 py-3 font-medium">소속</th>
                  <th className="px-4 py-3 font-medium">직급</th>
                  <th className="px-4 py-3 font-medium">권한</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                  <th className="px-4 py-3 font-medium">계정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggle(p.id)}
                        aria-label={`${p.name} 선택`}
                      />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.emp_no}</td>
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3">{p.companies?.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{p.org_text}</td>
                    <td className="px-4 py-3">{p.grade ?? "-"}</td>
                    <td className="px-4 py-3">{p.role === "admin" ? "관리자" : "응답자"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.account_status} />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!p.user_id || resetPassword.isPending}
                        onClick={() => resetPassword.mutate(p.id)}
                      >
                        <KeyRound className="size-4" />
                        비밀번호 초기화
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ParticipantsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">참여자 관리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          명부를 업로드해 참여자를 등록하고, 계정을 일괄 생성합니다.
        </p>
      </div>

      <Tabs defaultValue="list">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto">
          <TabsTrigger value="list">명단 · 계정</TabsTrigger>
          <TabsTrigger value="upload">명부 업로드</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="mt-4">
          <RosterListTab />
        </TabsContent>
        <TabsContent value="upload" className="mt-4">
          <RosterUploadTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
