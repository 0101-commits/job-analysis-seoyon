import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Copy,
  Download,
  FileSearch,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  UserPlus,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  archiveParticipant,
  assignParticipantOrg,
  createParticipant,
  deleteParticipant,
  matchParticipantOrgUnits,
  provisionAccounts,
  resetParticipantPassword,
  setParticipantTags,
  updateParticipant,
  upsertParticipants,
} from "@/lib/admin.functions";
import { getAllowedEmailDomains } from "@/lib/settings.functions";
import { fetchAll } from "@/lib/paginate";

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

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type Company = { id: string; name: string };

function useCompanies() {
  return useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("companies").select("id, name").order("created_at");
      if (error) throw error;
      return (data ?? []) as Company[];
    },
  });
}

/** 허용 이메일 도메인은 설정 화면(system_settings)이 단일 원천이다. 검증에 그대로 넘긴다. */
function useAllowedDomains() {
  return useQuery({
    queryKey: ["allowed-email-domains"],
    queryFn: async () => getAllowedEmailDomains({ headers: await authHeaders() }),
  });
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

/* ─────────────────── ① 명부 업로드 → 신규 등록 · 기존 갱신 ─────────────────── */

type ExistingKey = { company_id: string; emp_no: string; email: string | null };
type ExistingIndex = { byKey: Map<string, string | null>; emailOwner: Map<string, string> };
type Classified = RosterRow & { isUpdate: boolean };

function keyOf(companyId: string | null, empNo: string) {
  return `${companyId ?? ""}|${empNo.trim()}`;
}

function indexExisting(rows: ExistingKey[]): ExistingIndex {
  const byKey = new Map<string, string | null>();
  const emailOwner = new Map<string, string>();
  for (const r of rows) {
    const key = keyOf(r.company_id, r.emp_no);
    byKey.set(key, r.email);
    if (r.email) emailOwner.set(r.email.toLowerCase(), key);
  }
  return { byKey, emailOwner };
}

/**
 * 재업로드를 갱신으로 받기 위한 재분류.
 * validateRoster 는 계열사를 구분하지 않고 기등록 사번·이메일을 오류로 본다.
 * 실제 유니크 제약은 (계열사, 사번) 하나뿐이므로
 *  - '이미 등록된 사번' 은 항상 되돌리고, 같은 키가 있으면 갱신 대상으로 표시한다.
 *  - '이미 등록된 이메일' 은 그 이메일의 주인이 같은 사람일 때만 되돌린다(남의 이메일은 진짜 오류).
 */
function reclassify(rows: RosterRow[], index: ExistingIndex): Classified[] {
  return rows.map((r) => {
    const key = keyOf(r.parsed.company_id, r.parsed.emp_no);
    const isUpdate = index.byKey.has(key);
    const ownEmail =
      !!r.parsed.email && index.emailOwner.get(r.parsed.email.toLowerCase()) === key;
    const errors = r.errors.filter(
      (e) => e !== "이미 등록된 사번" && !(e === "이미 등록된 이메일" && ownEmail),
    );
    return { ...r, errors, isUpdate };
  });
}

function RosterUploadTab() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<RosterRaw[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validated, setValidated] = useState<Classified[] | null>(null);

  const { data: companies } = useCompanies();
  const { data: domainInfo } = useAllowedDomains();

  const { data: existing } = useQuery({
    queryKey: ["participants-keys"],
    queryFn: () =>
      // 신규/갱신 판정 근거라 한 행도 빠지면 안 된다. 전량 조회한다.
      fetchAll<ExistingKey>((from, to) =>
        supabase
          .from("participants")
          .select("company_id, emp_no, email")
          .order("id")
          .range(from, to),
      ),
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
  const updateCount = validRows.filter((r) => r.isUpdate).length;
  const newCount = validRows.length - updateCount;

  const reflect = useMutation({
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
      if (payload.length === 0) throw new Error("반영할 건이 없습니다.");
      return upsertParticipants({ data: { rows: payload }, headers: await authHeaders() });
    },
    onSuccess: () => {
      toast.success(
        `신규 ${newCount}명 등록, 갱신 ${updateCount}명 완료했습니다. 명단 탭에서 계정을 생성하세요.`,
      );
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
    const index = indexExisting(existing ?? []);
    const result = reclassify(
      validateRoster(mapped, companies ?? [], existing ?? [], domainInfo?.domains ?? []),
      index,
    );
    setValidated(result);
    const bad = result.filter((r) => r.errors.length > 0).length;
    if (bad === 0) toast.success(`검증 통과 — ${result.length}건 모두 반영 가능합니다.`);
    else toast.error(`${bad}건에 오류가 있습니다.`);
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
            {fileName} · {rows.length}건
          </span>
        )}
      </div>

      <p className="rounded-xl border bg-secondary/40 p-3 text-xs text-muted-foreground">
        이미 등록된 사번은 같은 계열사 기준으로 <strong>갱신</strong>됩니다. 이름·이메일·생년월일·소속·
        직급·역할단계만 덮어쓰고, 계정·상태·초기 비밀번호는 그대로 둡니다.
      </p>

      {rows.length > 0 && (
        <>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-medium">항목 맞추기</p>
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
              <p className="flex items-start gap-2 text-sm">
                {errorRows.length === 0 ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span>
                  신규 {newCount}명 / 갱신 {updateCount}명
                  {errorRows.length > 0 && (
                    <span className="font-medium text-destructive">
                      {" "}
                      · 오류 {errorRows.length}건 · 정상 {validRows.length}건
                    </span>
                  )}
                </span>
              </p>
              {errorRows.length > 0 && (
                <>
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
                      외 {errorRows.length - 50}건 더 있습니다.
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
              disabled={!validated || validRows.length === 0 || reflect.isPending}
              onClick={() => reflect.mutate()}
            >
              {reflect.isPending && <Loader2 className="size-4 animate-spin" />}
              오류 제외하고 {validRows.length}건 반영
            </Button>
            <Button variant="ghost" disabled={reflect.isPending} onClick={reset}>
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
  company_id: string;
  emp_no: string;
  name: string;
  email: string | null;
  birth_date: string | null;
  org_text: string | null;
  grade: string | null;
  role_level: string | null;
  org_unit_id: string | null;
  role: string;
  account_status: string;
  user_id: string | null;
  tags: string[] | null;
  archived_at: string | null;
  /** 계정에 현재 적용된 비밀번호(평문). 발급·초기화·본인 변경 시 갱신된다. */
  initial_password: string | null;
  must_change_password: boolean;
  companies: { name: string } | null;
};

const PARTICIPANT_COLUMNS =
  "id, company_id, emp_no, name, email, birth_date, org_text, grade, role_level, org_unit_id, role, account_status, user_id, tags, archived_at, initial_password, must_change_password, companies(name)";

/** 조직 트리를 들여쓰기 라벨의 평탄 목록으로. 부모가 조회 범위 밖이면 루트로 취급한다. */
function flattenOrgUnits(
  units: { id: string; parent_id: string | null; name: string; sort: number }[],
): { id: string; label: string }[] {
  const idSet = new Set(units.map((u) => u.id));
  const children = new Map<string, typeof units>();
  for (const u of units) {
    const key = u.parent_id && idSet.has(u.parent_id) ? u.parent_id : "__root__";
    const list = children.get(key);
    if (list) list.push(u);
    else children.set(key, [u]);
  }
  const out: { id: string; label: string }[] = [];
  const walk = (parentKey: string, depth: number) => {
    const list = [...(children.get(parentKey) ?? [])].sort(
      (a, b) => a.sort - b.sort || a.name.localeCompare(b.name),
    );
    for (const u of list) {
      out.push({ id: u.id, label: `${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}${u.name}` });
      walk(u.id, depth + 1);
    }
  };
  walk("__root__", 0);
  return out;
}

/** 해당 계열사의 조직 목록(편집 폼 드롭다운용). companyId 가 없으면 조회하지 않는다. */
function useOrgUnitOptions(companyId: string) {
  const { data } = useQuery({
    queryKey: ["org-units-options", companyId],
    enabled: companyId.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("org_units")
        .select("id, parent_id, name, sort")
        .eq("company_id", companyId)
        .order("sort");
      if (error) throw error;
      return data ?? [];
    },
  });
  return useMemo(() => flattenOrgUnits(data ?? []), [data]);
}

/** 추가·수정 공용 폼. 참여자가 null 이면 추가(계열사·사번 입력), 있으면 수정(둘은 고정). */
function ParticipantFormDialog({
  open,
  participant,
  companies,
  defaultCompanyId,
  onOpenChange,
}: {
  open: boolean;
  participant: Participant | null;
  companies: Company[];
  defaultCompanyId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    companyId: participant?.company_id ?? defaultCompanyId,
    emp_no: participant?.emp_no ?? "",
    name: participant?.name ?? "",
    email: participant?.email ?? "",
    birth_date: participant?.birth_date ?? "",
    org_text: participant?.org_text ?? "",
    grade: participant?.grade ?? "",
    role_level: participant?.role_level ?? "",
    org_unit_id: participant?.org_unit_id ?? "",
  }));

  const orgOptions = useOrgUnitOptions(form.companyId);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const save = useMutation({
    mutationFn: async () => {
      const headers = await authHeaders();
      const fields = {
        name: form.name.trim(),
        email: form.email.trim(),
        birth_date: form.birth_date || null,
        org_text: form.org_text.trim(),
        grade: form.grade.trim(),
        role_level: form.role_level.trim(),
        orgUnitId: form.org_unit_id || null,
      };
      if (participant) {
        return updateParticipant({
          data: { participantId: participant.id, ...fields },
          headers,
        });
      }
      return createParticipant({
        data: { companyId: form.companyId, emp_no: form.emp_no.trim(), ...fields },
        headers,
      });
    },
    onSuccess: () => {
      toast.success(
        participant
          ? `${form.name.trim()} 정보를 수정했습니다.`
          : `${form.name.trim()}을 명부에 등록했습니다. 목록에서 선택해 계정을 생성하세요.`,
      );
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canSave =
    form.name.trim().length > 0 &&
    (participant !== null || (form.emp_no.trim().length > 0 && form.companyId.length > 0));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{participant ? "참여자 수정" : "참여자 추가"}</DialogTitle>
          <DialogDescription>
            {participant
              ? `${participant.companies?.name ?? "-"} · 사번 ${participant.emp_no}. 계열사와 사번은 바꿀 수 없습니다.`
              : "한 명을 직접 등록합니다. 계정은 등록 후 명단에서 선택해 발급하세요."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {!participant && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="p-company">계열사 *</Label>
                <Select
                  value={form.companyId}
                  onValueChange={(v) =>
                    // 계열사가 바뀌면 이전 계열사의 조직 선택은 무효다.
                    setForm((prev) => ({ ...prev, companyId: v, org_unit_id: "" }))
                  }
                >
                  <SelectTrigger id="p-company">
                    <SelectValue placeholder="선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p-empno">사번 *</Label>
                <Input
                  id="p-empno"
                  value={form.emp_no}
                  onChange={(e) => set("emp_no", e.target.value)}
                  placeholder="20150908"
                />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="p-name">이름 *</Label>
            <Input id="p-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-email">이메일</Label>
            <Input
              id="p-email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="gildong.hong@seoyon.example"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-birth">생년월일</Label>
            <Input
              id="p-birth"
              type="date"
              value={form.birth_date}
              onChange={(e) => set("birth_date", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-grade">직급</Label>
            <Input id="p-grade" value={form.grade} onChange={(e) => set("grade", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-role-level">역할단계</Label>
            <Input
              id="p-role-level"
              value={form.role_level}
              onChange={(e) => set("role_level", e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="p-org">소속</Label>
            <Input
              id="p-org"
              value={form.org_text}
              onChange={(e) => set("org_text", e.target.value)}
              placeholder="경영기획본부 / 기획팀"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="p-org-unit">조직 (조직도 연결)</Label>
            <Select
              value={form.org_unit_id || "__none__"}
              onValueChange={(v) => set("org_unit_id", v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="p-org-unit">
                <SelectValue placeholder="선택 안 함" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— 선택 안 함</SelectItem>
                {orgOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {orgOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                이 계열사에 등록된 조직도가 없습니다. 마스터 관리에서 조직도를 먼저 올리세요.
              </p>
            )}
          </div>
        </div>

        {participant?.user_id && form.email.trim() !== (participant.email ?? "") && (
          <p className="text-xs text-muted-foreground">
            이메일을 바꾸면 로그인 계정 아이디도 함께 변경됩니다.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            {participant ? "저장" : "등록"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 보관(로그인 차단, 이력 유지) 과 완전 삭제 중 하나를 고르는 확인 창. */
function RemoveDialog({
  participant,
  onOpenChange,
}: {
  participant: Participant;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const archived = !!participant.archived_at;

  function done(message: string) {
    toast.success(message);
    onOpenChange(false);
    void queryClient.invalidateQueries({ queryKey: ["participants"] });
    void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
  }

  const archive = useMutation({
    mutationFn: async () =>
      archiveParticipant({
        data: { participantId: participant.id, archived: !archived },
        headers: await authHeaders(),
      }),
    onSuccess: () =>
      done(archived ? "보관을 해제했습니다." : "보관했습니다. 로그인이 차단됩니다."),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: async () =>
      deleteParticipant({ data: { participantId: participant.id }, headers: await authHeaders() }),
    onSuccess: () => done("완전히 삭제했습니다."),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const pending = archive.isPending || remove.isPending;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {participant.name} · 사번 {participant.emp_no}
          </DialogTitle>
          <DialogDescription>
            {participant.companies?.name ?? "-"} · 상태 {participant.account_status}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          <p className="rounded-lg border p-3">
            <strong>보관</strong> — 명단에서 숨기고 로그인을 차단합니다. 작성한 응답은 그대로
            남습니다.
          </p>
          <p className="rounded-lg border p-3">
            <strong>완전 삭제</strong> — 명부와 로그인 계정을 지웁니다. 응답이 있거나 상태가
            미발송이 아니면 거부됩니다.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => archive.mutate()}>
            {archive.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            {archived ? "보관 해제" : "보관"}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => remove.mutate()}>
            {remove.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            완전 삭제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RosterListTab() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [includeSubOrgs, setIncludeSubOrgs] = useState(true);
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState("");
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Participant | null>(null);
  const [removing, setRemoving] = useState<Participant | null>(null);
  const [orgMatchReport, setOrgMatchReport] = useState<{
    matched: number;
    unmatched: number;
    unmatchedList: { name: string; emp_no: string; org_text: string | null }[];
  } | null>(null);

  const { data: companies } = useCompanies();

  const { data, isLoading } = useQuery({
    queryKey: ["participants", companyId],
    queryFn: async () => {
      // 전사 스코프에서는 1000명을 넘길 수 있어 페이지를 이어 받는다.
      return fetchAll<Participant>(async (from, to) => {
        let query = supabase
          .from("participants")
          .select(PARTICIPANT_COLUMNS)
          // emp_no 는 계열사끼리 겹칠 수 있다. id 로 순서를 확정해야 페이지가 어긋나지 않는다.
          .order("emp_no")
          .order("id")
          .range(from, to);
        if (companyId !== "all") query = query.eq("company_id", companyId);
        const { data, error } = await query;
        return { data: (data ?? []) as unknown as Participant[], error };
      });
    },
  });

  const allTags = useMemo(
    () => [...new Set((data ?? []).flatMap((p) => p.tags ?? []))].sort(),
    [data],
  );

  /** 조직 필터·조직 열·일괄 배정이 함께 쓴다. 전사 스코프면 전 계열사 조직을 가져온다. */
  const { data: orgUnits } = useQuery({
    queryKey: ["org-units-filter", companyId],
    queryFn: async () => {
      let query = supabase.from("org_units").select("id, parent_id, name, sort").order("sort");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
  const orgOptions = useMemo(() => flattenOrgUnits(orgUnits ?? []), [orgUnits]);
  const unitNameById = useMemo(
    () => new Map((orgUnits ?? []).map((u) => [u.id, u.name])),
    [orgUnits],
  );

  /** 선택 조직 + (토글 시) 하위 조직 전체의 id 집합. 전체 조직이면 null. */
  const orgIdSet = useMemo(() => {
    if (orgFilter === "all") return null;
    const set = new Set([orgFilter]);
    if (!includeSubOrgs) return set;
    const childrenOf = new Map<string, string[]>();
    for (const u of orgUnits ?? []) {
      if (!u.parent_id) continue;
      const list = childrenOf.get(u.parent_id);
      if (list) list.push(u.id);
      else childrenOf.set(u.parent_id, [u.id]);
    }
    const stack = [orgFilter];
    while (stack.length > 0) {
      for (const child of childrenOf.get(stack.pop()!) ?? []) {
        if (!set.has(child)) {
          set.add(child);
          stack.push(child);
        }
      }
    }
    return set;
  }, [orgFilter, includeSubOrgs, orgUnits]);

  /** 응답 검토 바로가기 노출 근거 — draft 를 뺀(제출 이상) 응답이 있는 참여자. */
  const { data: responded } = useQuery({
    queryKey: ["participants-responded"],
    queryFn: () =>
      fetchAll<{ participant_id: string }>((from, to) =>
        supabase
          .from("responses")
          .select("participant_id")
          .neq("status", "draft")
          .order("id")
          .range(from, to),
      ),
  });
  const respondedSet = useMemo(
    () => new Set((responded ?? []).map((r) => r.participant_id)),
    [responded],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((p) => {
      if (!includeArchived && p.archived_at) return false;
      if (statusFilter !== "all" && p.account_status !== statusFilter) return false;
      if (tagFilter !== "all" && !(p.tags ?? []).includes(tagFilter)) return false;
      if (orgIdSet && !(p.org_unit_id && orgIdSet.has(p.org_unit_id))) return false;
      if (!q) return true;
      return [p.name, p.emp_no, p.email ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [data, search, statusFilter, tagFilter, orgIdSet, includeArchived]);

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

  const bulkReset = useMutation({
    // ponytail: 순차 호출. 수백 명이면 느리지만 Auth admin API 를 몰아치지 않는다.
    //           체감이 문제되면 서버에서 배치 함수로 옮긴다.
    mutationFn: async (ids: string[]) => {
      const headers = await authHeaders();
      let ok = 0;
      const failures: string[] = [];
      for (const id of ids) {
        try {
          await resetParticipantPassword({ data: { participantId: id }, headers });
          ok += 1;
        } catch (err) {
          failures.push(errorMessage(err));
        }
      }
      return { ok, failures };
    },
    onSuccess: ({ ok, failures }) => {
      toast.success(`${ok}명의 비밀번호를 초기화했습니다.`);
      for (const f of failures.slice(0, 3)) toast.error(f);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const orgMatch = useMutation({
    mutationFn: async () =>
      matchParticipantOrgUnits({
        data: { companyId: companyId !== "all" ? companyId : null },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      setOrgMatchReport(res);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const tagMutation = useMutation({
    mutationFn: async (mode: "add" | "remove") =>
      setParticipantTags({
        data: {
          participantIds: [...selected],
          tags: tagInput
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          mode,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      toast.success(`${res.changed}명의 태그를 변경했습니다.`);
      setTagInput("");
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const orgAssign = useMutation({
    mutationFn: async () =>
      assignParticipantOrg({
        data: { participantIds: [...selected], orgUnitId: bulkOrgId },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      toast.success(`${res.changed}명에게 조직을 배정했습니다.`);
      setBulkOrgId("");
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const selectedIds = [...selected];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const hasTagInput = tagInput.trim().length > 0;
  const busy =
    provision.isPending || bulkReset.isPending || tagMutation.isPending || orgAssign.isPending;

  /** 현재 필터가 적용된 rows 그대로 CSV 로 만든다. 엑셀 호환을 위해 BOM 을 붙인다. */
  function downloadRoster() {
    // 비밀번호도 평문으로 나간다 — 계정 안내용. 파일 자체가 대외비다.
    const header = [
      "사번",
      "이름",
      "계열사",
      "조직",
      "소속",
      "직급",
      "역할단계",
      "이메일",
      "비밀번호",
      "태그",
      "상태",
    ];
    const lines = rows.map((p) =>
      [
        p.emp_no,
        p.name,
        p.companies?.name ?? "",
        (p.org_unit_id && unitNameById.get(p.org_unit_id)) || "",
        p.org_text ?? "",
        p.grade ?? "",
        p.role_level ?? "",
        p.email ?? "",
        p.initial_password ?? "",
        (p.tags ?? []).join(" "),
        p.account_status,
      ]
        .map(csvCell)
        .join(","),
    );
    downloadCsv(
      `참여자_명단_${new Date().toISOString().slice(0, 10)}.csv`,
      "﻿" + [header.join(","), ...lines].join("\n"),
    );
  }

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
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름 · 사번 · 이메일"
                aria-label="참여자 검색"
                className="w-[220px] pl-8"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]" aria-label="상태 필터">
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
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="w-[140px]" aria-label="태그 필터">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 태그</SelectItem>
                {allTags.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={orgFilter} onValueChange={setOrgFilter}>
              <SelectTrigger className="w-[180px]" aria-label="조직 필터">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 조직</SelectItem>
                {orgOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {orgFilter !== "all" && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={includeSubOrgs}
                  onCheckedChange={(v) => setIncludeSubOrgs(v === true)}
                />
                하위 조직 포함
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeArchived}
                onCheckedChange={(v) => setIncludeArchived(v === true)}
              />
              보관 포함
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            >
              {allSelected ? "전체 해제" : "전체 선택"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={downloadRoster}
            >
              <Download className="size-4" />
              명단 내려받기
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={orgMatch.isPending}
              onClick={() => orgMatch.mutate()}
            >
              {orgMatch.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2 className="size-4" />
              )}
              조직 일괄 매칭
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              참여자 추가
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {rows.length}명 표시 중 · 선택 {selectedIds.length}명
        </p>

        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button disabled={busy} onClick={() => provision.mutate(selectedIds)}>
              {provision.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <UserPlus className="size-4" />
              )}
              계정 생성
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => bulkReset.mutate(selectedIds)}>
              {bulkReset.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              비밀번호 초기화
            </Button>
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="태그 (쉼표로 여러 개)"
              aria-label="일괄 적용할 태그"
              className="w-[200px]"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !hasTagInput}
              onClick={() => tagMutation.mutate("add")}
            >
              태그 부여
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !hasTagInput}
              onClick={() => tagMutation.mutate("remove")}
            >
              태그 제거
            </Button>
            <Select
              value={bulkOrgId || "__pick__"}
              onValueChange={(v) => setBulkOrgId(v === "__pick__" ? "" : v)}
            >
              <SelectTrigger className="w-[200px]" aria-label="일괄 배정할 조직">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__pick__">— 조직 선택</SelectItem>
                {orgOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !bulkOrgId}
              onClick={() => orgAssign.mutate()}
            >
              {orgAssign.isPending && <Loader2 className="size-4 animate-spin" />}
              조직 배정
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중...</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          조건에 맞는 참여자가 없습니다.
        </p>
      ) : (
        <>
          {/* 모바일: 카드 스택 */}
          <ul className="space-y-3 md:hidden">
            {rows.map((p) => (
              <li
                key={p.id}
                className={`rounded-xl border bg-card p-4 shadow-sm ${p.archived_at ? "opacity-60" : ""}`}
              >
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
                        {p.companies?.name} ·{" "}
                        {p.org_unit_id ? unitNameById.get(p.org_unit_id) : p.org_text}
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
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">비밀번호</dt>
                    <dd className="mt-0.5">
                      <PasswordCell participant={p} />
                    </dd>
                  </div>
                </dl>
                <TagChips participant={p} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {respondedSet.has(p.id) && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/admin/review">
                        <FileSearch className="size-4" />
                        응답 검토
                      </Link>
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                    <Pencil className="size-4" />
                    수정
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!p.user_id || resetPassword.isPending}
                    onClick={() => resetPassword.mutate(p.id)}
                  >
                    <KeyRound className="size-4" />
                    비밀번호 초기화
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                    <Trash2 className="size-4" />
                    삭제 · 보관
                  </Button>
                </div>
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
                  <th className="px-4 py-3 font-medium">조직</th>
                  <th className="px-4 py-3 font-medium">직급</th>
                  <th className="px-4 py-3 font-medium">태그</th>
                  <th className="px-4 py-3 font-medium">비밀번호</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                  <th className="px-4 py-3 font-medium">관리</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={`border-t ${p.archived_at ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggle(p.id)}
                        aria-label={`${p.name} 선택`}
                      />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.emp_no}</td>
                    <td className="px-4 py-3 font-medium">
                      {p.name}
                      {p.archived_at && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">보관</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{p.companies?.name}</td>
                    <td className="px-4 py-3">
                      {p.org_unit_id ? (
                        (unitNameById.get(p.org_unit_id) ?? "-")
                      ) : (
                        <span className="text-muted-foreground">
                          {p.org_text}
                          <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs">
                            미배정
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{p.grade ?? "-"}</td>
                    <td className="px-4 py-3">
                      <TagChips participant={p} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <PasswordCell participant={p} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.account_status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {respondedSet.has(p.id) && (
                          <Button size="sm" variant="ghost" asChild>
                            {/* review.tsx 는 URL 로 응답 지정을 지원하지 않아 목록 이동까지만. */}
                            <Link to="/admin/review" aria-label={`${p.name} 응답 검토로 이동`}>
                              <FileSearch className="size-4" />
                            </Link>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${p.name} 수정`}
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${p.name} 비밀번호 초기화`}
                          disabled={!p.user_id || resetPassword.isPending}
                          onClick={() => resetPassword.mutate(p.id)}
                        >
                          <KeyRound className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${p.name} 삭제 또는 보관`}
                          onClick={() => setRemoving(p)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {adding && (
        <ParticipantFormDialog
          open
          participant={null}
          companies={companies ?? []}
          defaultCompanyId={
            companyId !== "all" ? companyId : ((companies ?? [])[0]?.id ?? "")
          }
          onOpenChange={(open) => !open && setAdding(false)}
        />
      )}
      {editing && (
        <ParticipantFormDialog
          key={editing.id}
          open
          participant={editing}
          companies={companies ?? []}
          defaultCompanyId={editing.company_id}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      {removing && (
        <RemoveDialog
          key={removing.id}
          participant={removing}
          onOpenChange={(open) => !open && setRemoving(null)}
        />
      )}
      {orgMatchReport && (
        <Dialog open onOpenChange={(open) => !open && setOrgMatchReport(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>조직 일괄 매칭 결과</DialogTitle>
              <DialogDescription>
                조직 미연결 참여자의 소속 표기를 조직도 이름과 대조했습니다 (공백 제거 후 정확
                일치).
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              매칭 <strong>{orgMatchReport.matched}명</strong> · 미매칭{" "}
              <strong>{orgMatchReport.unmatched}명</strong>
            </p>
            {orgMatchReport.unmatchedList.length > 0 && (
              <>
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-3 text-xs">
                  {orgMatchReport.unmatchedList.map((u) => (
                    <li key={`${u.emp_no}-${u.name}`}>
                      <span className="font-medium">{u.name}</span> ({u.emp_no}) · 소속:{" "}
                      {u.org_text || "(비어 있음)"}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  미매칭 건은 참여자 수정 화면에서 조직을 직접 선택하거나, 조직도 이름과 소속
                  표기를 맞춘 뒤 다시 실행하세요.
                  {orgMatchReport.unmatched > orgMatchReport.unmatchedList.length &&
                    ` (목록은 ${orgMatchReport.unmatchedList.length}건까지만 표시)`}
                </p>
              </>
            )}
            <DialogFooter>
              <Button onClick={() => setOrgMatchReport(null)}>닫기</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * 계정 비밀번호 노출 셀. 관리자만 보는 화면이고, 값은 서버가 실제로 적용한 평문이다
 * (발급·초기화·본인 변경 모두 participants.initial_password 를 갱신).
 * 계정이 없으면 비밀번호도 없고, 값이 비어 있으면 옛 계정이라 [비밀번호 초기화]로 다시 만들어야 한다.
 */
function PasswordCell({ participant }: { participant: Participant }) {
  const pw = participant.initial_password;
  if (!participant.user_id) {
    return <span className="text-xs text-muted-foreground">계정 없음</span>;
  }
  if (!pw) {
    return <span className="text-xs text-muted-foreground">미기록 — 초기화 필요</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{pw}</code>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        aria-label={`${participant.name} 비밀번호 복사`}
        onClick={() => {
          void navigator.clipboard
            .writeText(pw)
            .then(() => toast.success("비밀번호를 복사했습니다."))
            .catch(() => toast.error("복사에 실패했습니다. 값을 직접 선택해 복사해 주세요."));
        }}
      >
        <Copy className="size-3.5" />
      </Button>
      {participant.must_change_password && (
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
          최초 변경 전
        </span>
      )}
    </span>
  );
}

function TagChips({ participant }: { participant: Participant }) {
  const tags = participant.tags ?? [];
  if (tags.length === 0) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <div className="mt-2 flex flex-wrap gap-1 md:mt-0">
      {tags.map((t) => (
        <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs">
          {t}
        </span>
      ))}
    </div>
  );
}

function ParticipantsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">참여자 관리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          참여자를 등록·수정·보관하고, 계정을 일괄 생성합니다.
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
