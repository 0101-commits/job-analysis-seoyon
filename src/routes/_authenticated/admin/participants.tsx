import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileSearch,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  TableProperties,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { josa } from "@/lib/glossary";
import { EmptyState } from "@/components/EmptyState";
import {
  OrgTreeFilter,
  orgPathLabel,
  orgSubtreeIds,
  useOrgLens,
} from "@/components/admin/OrgTreeFilter";
import { useCompanyScope } from "@/components/CompanyContext";
import { pickLens, type LensSearch } from "@/lib/lens-search";
import { similarity } from "@/components/survey/validation";
import { usePersistedState } from "@/hooks/use-persisted-ui";
import { ACCOUNT_STATUS_LABELS } from "@/lib/auth";
import {
  ROSTER_COLUMNS,
  parseRosterFile,
  rosterTemplateSheets,
  validateRoster,
  type RosterDiffKind,
  type RosterDiffResult,
  type RosterDiffRow,
  type RosterRaw,
  type RosterRow,
} from "@/lib/roster";
import { RosterDiffPanel, type LeaverAction } from "@/components/admin/RosterDiffPanel";
import {
  addParticipant,
  applyRoster,
  archiveParticipant,
  assignParticipantOrg,
  deleteParticipant,
  diffRoster,
  matchParticipantOrgUnits,
  provisionAccounts,
  resetParticipantPassword,
  setParticipantTags,
  updateParticipant,
} from "@/lib/admin.functions";
import { getAllowedEmailDomains, getSettings } from "@/lib/settings.functions";
import { listActiveCompanies } from "@/lib/companies";
import { downloadXlsx } from "@/lib/xlsx";
import { fetchAll } from "@/lib/paginate";

/**
 * 이 화면이 URL 로 주고받는 규약 (기획 D4).
 *
 * 받는다 — 대시보드·전역 검색이 보낸다
 *   ?p=<참여자id>    그 사람의 상세 패널을 열고 목록에서 그 행을 강조한다
 *   ?status=<상태[,상태]>   그 상태만 남긴다 (계정 상태 7종, 콤마로 여러 개 —
 *                    대시보드 진행축 딥링크가 「미확인=초대발송,미접속」처럼 묶어 보낸다)
 *   ?recheck=1       변경 재확인이 필요한 응답이 있는 참여자만 (기획 F10)
 *   ?co=<계열사id> ?org=<소속id>   계열사·소속 렌즈 (기획 v2 P2) — 모든 관리 화면이 공유한다
 *   ?q=<검색어> ?tag=<태그> ?archived=1 ?tab=list|upload
 *   ?assignWave=<차수id> 차수 관리 화면이 보낸다 — 그 차수로 배정하는 흐름을 연다
 *
 * 보낸다
 *   /admin/review?response=<응답id>                      그 응답 단건으로 직행
 *   /admin/mail?ids=<id,id,...>   선택한 인원에게 독려 (최대 200명)
 *   /admin/mail?org=<소속id>      선택한 소속 전체에게 독려 (인원 선택이 없을 때)
 *   두 독려 링크 모두 지금 걸린 상태 필터를 &status=<상태> 로 함께 넘긴다.
 */
type ParticipantsSearch = LensSearch & {
  tab?: "list" | "upload";
  p?: string;
  status?: string;
  q?: string;
  tag?: string;
  archived?: boolean;
  recheck?: boolean;
  assignWave?: string;
};

/** 값을 지울 때 undefined 를 명시적으로 넘길 수 있어야 한다(exactOptionalPropertyTypes). */
type SearchPatch = { [K in keyof ParticipantsSearch]?: ParticipantsSearch[K] | undefined };

/** 빈 값·false 는 URL 에서 아예 뺀다 — 주소가 짧아야 공유가 쉽다. */
function patchSearch(prev: ParticipantsSearch, next: SearchPatch): ParticipantsSearch {
  const out: ParticipantsSearch = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === "" || value === false) {
      delete out[key as keyof ParticipantsSearch];
    } else {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export const Route = createFileRoute("/_authenticated/admin/participants")({
  validateSearch: (search: Record<string, unknown>): ParticipantsSearch => {
    const text = (key: string) => {
      const raw = search[key];
      return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    };
    const out: ParticipantsSearch = { ...pickLens(search) };
    if (search["tab"] === "upload" || search["tab"] === "list") out.tab = search["tab"];
    const p = text("p");
    if (p) out.p = p;
    // 모르는 상태 값이 오면 무시한다 — 조건에 맞는 사람이 0명인 빈 화면을 만들지 않기 위해.
    // 콤마로 여러 상태를 받는다(진행축 딥링크). 아는 상태만 남기고, 하나도 없으면 필터를 걸지 않는다.
    const status = text("status");
    if (status) {
      const known = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => (ACCOUNT_STATUS_LABELS as readonly string[]).includes(s));
      if (known.length > 0) out.status = known.join(",");
    }
    const org = text("org");
    if (org) out.org = org;
    const q = text("q");
    if (q) out.q = q;
    const tag = text("tag");
    if (tag) out.tag = tag;
    const archived = search["archived"];
    if (archived === true || archived === "1" || archived === "true") out.archived = true;
    const recheck = search["recheck"];
    if (recheck === true || recheck === "1" || recheck === "true") out.recheck = true;
    const assignWave = text("assignWave");
    if (assignWave) out.assignWave = assignWave;
    return out;
  },
  head: () => ({
    meta: [
      { title: "참여자 명부 | 서연 그룹 업무조사" },
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

/** 운영 중(active) 계열사만 — 계열사 조회의 단일 창구(companies.ts)를 거친다 (v4). */
function useCompanies() {
  return useQuery({
    queryKey: ["companies-active"],
    queryFn: async (): Promise<Company[]> => listActiveCompanies(),
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

type ExistingKey = { company_id: string; emp_no: string; email: string | null; name: string };
type EmailOwner = { key: string; company_id: string; name: string };
type ExistingIndex = { byKey: Map<string, string | null>; emailOwner: Map<string, EmailOwner> };
type Classified = RosterRow & { isUpdate: boolean };

function keyOf(companyId: string | null, empNo: string) {
  return `${companyId ?? ""}|${empNo.trim()}`;
}

function indexExisting(rows: ExistingKey[]): ExistingIndex {
  const byKey = new Map<string, string | null>();
  const emailOwner = new Map<string, EmailOwner>();
  for (const r of rows) {
    const key = keyOf(r.company_id, r.emp_no);
    byKey.set(key, r.email);
    if (r.email) {
      emailOwner.set(r.email.toLowerCase(), {
        key,
        company_id: r.company_id,
        name: r.name.trim(),
      });
    }
  }
  return { byKey, emailOwner };
}

/**
 * 재업로드를 갱신으로 받기 위한 재분류.
 * validateRoster 는 계열사를 구분하지 않고 기등록 사번·이메일을 오류로 본다.
 * 실제 유니크 제약은 (계열사, 사번) 하나뿐이므로
 *  - '이미 등록된 사번' 은 항상 되돌리고, 같은 키가 있으면 갱신 대상으로 표시한다.
 *  - '이미 등록된 이메일' 은 그 이메일의 주인이 같은 사람일 때만 되돌린다(남의 이메일은 진짜 오류).
 *    사번을 다시 발급받아 사번만 달라진 경우도 같은 사람으로 본다 — 같은 계열사에 이름까지 같으면
 *    같은 사람일 가능성이 높고, 실제 변경 내용은 대조 화면에서 「사번 1007 → 1077」로 확인한 뒤
 *    관리자가 직접 골라 반영한다.
 */
function reclassify(rows: RosterRow[], index: ExistingIndex): Classified[] {
  return rows.map((r) => {
    const key = keyOf(r.parsed.company_id, r.parsed.emp_no);
    const isUpdate = index.byKey.has(key);
    const owner = r.parsed.email ? index.emailOwner.get(r.parsed.email.toLowerCase()) : undefined;
    const ownEmail =
      !!owner &&
      (owner.key === key ||
        (owner.company_id === r.parsed.company_id && owner.name === r.parsed.name.trim()));
    const errors = r.errors.filter(
      (e) => e !== "이미 등록된 사번" && !(e === "이미 등록된 이메일" && ownEmail),
    );
    return { ...r, errors, isUpdate };
  });
}

/**
 * 실패 사유별 조치 안내 (기획 P8).
 * 사유 문구에 값이 붙는 경우가 있어 접두어로 찾는다. 사유만 보여 주면 무엇을 고쳐야 하는지
 * 화면에 없으므로, 사유 한 줄마다 조치 한 줄을 붙인다.
 */
const ERROR_FIXES: { match: string; fix: string }[] = [
  { match: "회사 누락", fix: "회사 열을 연결하고, 빈 칸에 계열사 이름을 채우세요." },
  { match: "등록되지 않은 계열사", fix: "기준정보 화면에 등록된 계열사 이름과 똑같이 적으세요." },
  { match: "성명 누락", fix: "성명 열을 연결하고 빈 칸을 채우세요." },
  { match: "사번 누락", fix: "사번 열을 연결하고 빈 칸을 채우세요." },
  { match: "이메일 누락", fix: "계정 발급에 필요합니다. 이메일 열을 연결하고 빈 칸을 채우세요." },
  { match: "이메일 형식 오류", fix: "@ 앞뒤를 확인하세요. 공백·한글이 섞이면 실패합니다." },
  {
    match: "허용되지 않은 이메일 도메인",
    fix: "설정 화면의 허용 도메인에 추가하거나 회사 메일 주소로 바꾸세요.",
  },
  { match: "생년월일 형식 오류", fix: "YYMMDD 6자리로 적으세요. 예: 850312" },
  { match: "파일 내 사번 중복", fix: "같은 사번이 두 번 있습니다. 한 행만 남기세요." },
  { match: "파일 내 이메일 중복", fix: "같은 이메일이 두 번 있습니다. 한 행만 남기세요." },
  {
    match: "이미 등록된 이메일",
    fix: "다른 사람이 쓰는 이메일입니다. 사번과 이메일 짝을 다시 확인하세요.",
  },
];

function fixHint(error: string) {
  return ERROR_FIXES.find((e) => error.startsWith(e.match))?.fix ?? "";
}

/** 분류별 기본 처리. 명부에서 빠진 사람만 관리자가 보관·삭제 중에서 고른다. */
function actionFor(kind: RosterDiffKind, leaver: LeaverAction) {
  if (kind === "신규") return "추가" as const;
  if (kind === "퇴사후보") return leaver;
  return "갱신" as const;
}

type ApplyResult = Awaited<ReturnType<typeof applyRoster>>;

function RosterUploadTab() {
  const queryClient = useQueryClient();
  const { companyId } = useCompanyScope();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<RosterRaw[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validated, setValidated] = useState<Classified[] | null>(null);

  /* 대조 결과와, 그 대조에 실제로 쓴 명부. 반영은 같은 명부를 그대로 다시 보내야
     항목 지목(rowIndex)이 어긋나지 않는다. */
  const [diff, setDiff] = useState<RosterDiffResult | null>(null);
  const [diffRows, setDiffRows] = useState<RosterDiffRow[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [leaverAction, setLeaverAction] = useState<LeaverAction>("보관");
  const [provisionNew, setProvisionNew] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  const { data: companies } = useCompanies();
  const { data: domainInfo } = useAllowedDomains();

  const { data: existing } = useQuery({
    queryKey: ["participants-keys"],
    queryFn: () =>
      // 신규/갱신 판정 근거라 한 행도 빠지면 안 된다. 전량 조회한다.
      fetchAll<ExistingKey>((from, to) =>
        supabase
          .from("participants")
          .select("company_id, emp_no, email, name")
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
  const chosenCount = diff ? diff.items.filter((i) => selectedKeys.has(i.key)).length : 0;

  /** 대조 — 아무것도 바꾸지 않는다. 오류 행은 빼고 정상 행만 기존 명단과 맞춰 본다. */
  const compare = useMutation({
    mutationFn: async () => {
      const index = indexExisting(existing ?? []);
      const result = reclassify(
        validateRoster(mapped, companies ?? [], existing ?? [], domainInfo?.domains ?? []),
        index,
      );
      setValidated(result);
      const ok = result.filter((r) => r.errors.length === 0);
      if (ok.length === 0) {
        throw new Error(
          "반영할 수 있는 행이 없습니다. 아래 목록의 조치대로 고친 뒤 다시 올리세요.",
        );
      }
      const payload: RosterDiffRow[] = ok.map((r) => ({
        company_id: r.parsed.company_id as string,
        emp_no: r.parsed.emp_no,
        name: r.parsed.name,
        email: r.parsed.email,
        birth_date: r.parsed.birth_date,
        org_text: r.parsed.org_text,
        grade: r.parsed.grade,
        role_level: r.parsed.role_level,
      }));
      const diffResult = await diffRoster({
        // 계열사 범위를 좁혀 둔 상태면 그 계열사만 「빠진 사람」 판정 대상으로 삼는다.
        data: { rows: payload, companyId: companyId !== "all" ? companyId : null },
        headers: await authHeaders(),
      });
      return { payload, diffResult, badCount: result.length - ok.length };
    },
    onSuccess: ({ payload, diffResult, badCount }) => {
      setDiffRows(payload);
      setDiff(diffResult);
      setApplyResult(null);
      // 명부에서 빠진 사람은 기본으로 고르지 않는다 — 사람이 한 번 더 확인해야 하는 처리다.
      setSelectedKeys(
        new Set(diffResult.items.filter((i) => i.kind !== "퇴사후보").map((i) => i.key)),
      );
      if (badCount > 0) {
        toast.error(`${badCount}건은 오류가 있어 대조에서 뺐습니다. 아래 목록을 확인하세요.`);
      } else if (diffResult.items.length === 0) {
        toast.success("달라진 사람이 없습니다. 반영할 것이 없습니다.");
      } else {
        toast.success(`대조를 마쳤습니다. 달라진 사람 ${diffResult.items.length}명을 확인하세요.`);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** 반영 — 고른 항목만, 고른 처리로만. 서버가 같은 명부로 다시 대조해 처리 내용을 확정한다. */
  const apply = useMutation({
    mutationFn: async () => {
      if (!diff || !diffRows) throw new Error("먼저 대조를 실행하세요.");
      const decisions = diff.items
        .filter((i) => selectedKeys.has(i.key))
        .map((i) => ({ key: i.key, action: actionFor(i.kind, leaverAction) }));
      if (decisions.length === 0) throw new Error("반영할 항목을 하나 이상 고르세요.");

      const headers = await authHeaders();
      const result = await applyRoster({
        data: {
          companyId: companyId !== "all" ? companyId : null,
          rows: diffRows,
          decisions,
        },
        headers,
      });

      // 계정 발급은 명단 탭의 [계정 생성]과 같은 기능을 그대로 부른다.
      let accounts: { created: number; updated: number; failed: number } | null = null;
      if (provisionNew && result.createdIds.length > 0) {
        const ids = result.createdIds.slice(0, 1000);
        const res = await provisionAccounts({ data: { participantIds: ids }, headers });
        accounts = { created: res.created, updated: res.updated, failed: res.failures.length };
        if (result.createdIds.length > ids.length) {
          accounts.failed += result.createdIds.length - ids.length;
        }
      }
      return { result, accounts };
    },
    onSuccess: ({ result, accounts }) => {
      setApplyResult(result);
      setSelectedKeys(new Set());
      const parts = [
        result.added ? `추가 ${result.added}명` : "",
        result.updated ? `갱신 ${result.updated}명` : "",
        result.archived ? `보관 ${result.archived}명` : "",
        result.deleted ? `삭제 ${result.deleted}명` : "",
      ].filter(Boolean);
      toast.success(`${parts.join(" · ") || "반영할 변화가 없었습니다"} 처리했습니다.`);
      if (result.failures.length > 0)
        toast.error(`${result.failures.length}건은 처리하지 못했습니다.`);
      if (accounts) toast.success(`계정 ${accounts.created}건 생성, ${accounts.updated}건 갱신`);
      if (result.backup.error) toast.error(`백업 없이 진행했습니다: ${result.backup.error}`);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-responses"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function reset() {
    setFileName("");
    setRows([]);
    setMapping({});
    setValidated(null);
    clearDiff();
    setApplyResult(null);
  }

  /** 명부·항목 연결이 바뀌면 대조 결과는 더 이상 그 명부의 것이 아니다. 지우고 다시 대조하게 한다. */
  function clearDiff() {
    setDiff(null);
    setDiffRows(null);
    setSelectedKeys(new Set());
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
      clearDiff();
      setApplyResult(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleKind(kind: RosterDiffKind, on: boolean) {
    const keys = (diff?.items ?? []).filter((i) => i.kind === kind).map((i) => i.key);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadXlsx("참여자_명부_템플릿.xlsx", rosterTemplateSheets())}
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
        올린 명부를 기존 명단과 <strong>대조</strong>한 뒤, 반영할 항목을 골라서 처리합니다.
        대조만으로는 아무것도 바뀌지 않습니다. 같은 사람으로 보는 기준은{" "}
        <strong>계열사 + 사번</strong>이고, 사번이 달라진 경우에는 이메일로 한 번 더 찾습니다. 반영
        직전에 시점 저장본을 만들며, 명부에서 빠진 사람은 보관 처리만 하고 이미 작성한 응답은 지우지
        않습니다.
      </p>

      {rows.length === 0 ? (
        <EmptyState
          kind="nothing"
          title="올릴 명부 파일을 고르세요"
          description="엑셀(.xlsx) 또는 CSV 파일을 올리면 열을 자동으로 맞추고, 반영 전에 오류를 먼저 보여 줍니다. 처음이라면 템플릿을 받아 그 형식대로 채우는 편이 빠릅니다."
          actionLabel="템플릿 내려받기"
          onAction={() => downloadXlsx("참여자_명부_템플릿.xlsx", rosterTemplateSheets())}
        />
      ) : (
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
                    onValueChange={(value) => {
                      clearDiff();
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (value === "__none__") delete next[column];
                        else next[column] = value;
                        return next;
                      });
                    }}
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
                필수 항목 미지정: {missing.join(", ")} — 이 항목을 연결해야 대조할 수 있습니다.
              </p>
            )}
          </div>

          {validated && (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <p className="flex items-start gap-2 text-sm">
                {errorRows.length === 0 ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span>
                  읽은 행 {validated.length}건 · 정상 {validRows.length}건
                  {errorRows.length > 0 && (
                    <span className="font-medium text-destructive">
                      {" "}
                      · 오류 {errorRows.length}건
                    </span>
                  )}
                </span>
              </p>
              {errorRows.length > 0 && (
                <>
                  <div className="max-h-72 overflow-y-auto rounded-lg border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                        <tr>
                          <th className="w-14 border-b px-3 py-2 font-medium">행</th>
                          <th className="w-28 border-b px-3 py-2 font-medium">성명</th>
                          <th className="border-b px-3 py-2 font-medium">왜 실패했는지</th>
                          <th className="border-b px-3 py-2 font-medium">무엇을 고치면 되는지</th>
                        </tr>
                      </thead>
                      <tbody>
                        {errorRows.slice(0, 100).map((r) => (
                          <tr key={r.rowNo} className="border-t align-top">
                            <td className="px-3 py-2 font-medium tabular-nums">{r.rowNo}</td>
                            <td className="px-3 py-2">{r.parsed.name || "-"}</td>
                            <td className="px-3 py-2 text-destructive">
                              <ul className="space-y-0.5">
                                {r.errors.map((e) => (
                                  <li key={e}>{e}</li>
                                ))}
                              </ul>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              <ul className="space-y-0.5">
                                {r.errors.map((e) => (
                                  <li key={e}>{fixHint(e) || "해당 값을 확인해 주세요."}</li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {errorRows.length > 100 && (
                    <p className="text-xs text-muted-foreground">
                      외 {errorRows.length - 100}건 더 있습니다. 같은 사유가 반복되는지 먼저
                      확인하세요.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    오류 행은 대조·반영에서 빠집니다. 정상 {validRows.length}건만 먼저 반영하고,
                    고친 파일을 다시 올려도 됩니다(이미 반영한 사람은 「변경 없음」으로 나옵니다).
                  </p>
                </>
              )}
            </div>
          )}

          {diff && (
            <RosterDiffPanel
              diff={diff}
              selected={selectedKeys}
              leaverAction={leaverAction}
              onToggle={toggleKey}
              onToggleKind={toggleKind}
              onLeaverAction={setLeaverAction}
            />
          )}

          {applyResult && <ApplyResultCard result={applyResult} />}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={missing.length > 0 || compare.isPending}
              onClick={() => compare.mutate()}
            >
              {compare.isPending && <Loader2 className="size-4 animate-spin" />}
              {diff ? "다시 대조" : "기존 명단과 대조"}
            </Button>
            <Button
              variant="secondary"
              disabled={!diff || chosenCount === 0 || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending && <Loader2 className="size-4 animate-spin" />}
              선택한 {chosenCount}건 반영
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={provisionNew}
                onCheckedChange={(v) => setProvisionNew(v === true)}
              />
              새로 추가되는 사람에게 계정도 함께 발급
            </label>
            <Button variant="ghost" disabled={apply.isPending} onClick={reset}>
              전체 취소
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** 반영 결과 — 무엇이 몇 건 처리되고 무엇이 왜 안 됐는지. 실패는 사유까지 표로 보여 준다. */
function ApplyResultCard({ result }: { result: ApplyResult }) {
  const counts = [
    { label: "추가", value: result.added },
    { label: "갱신", value: result.updated },
    { label: "보관", value: result.archived },
    { label: "삭제", value: result.deleted },
    { label: "소속 자동 배정", value: result.orgMatched },
    { label: "재확인 표시", value: result.rechecked },
    { label: "실패", value: result.failures.length },
  ];
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <p className="text-sm font-medium">반영 결과</p>
      <ul className="flex flex-wrap gap-2 text-xs">
        {counts.map((c) => (
          <li
            key={c.label}
            className={`rounded-full px-2.5 py-1 ${
              c.label === "실패" && c.value > 0
                ? "bg-destructive/10 font-semibold text-destructive"
                : "bg-secondary"
            }`}
          >
            {c.label} <span className="tabular-nums">{c.value}</span>건
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {result.backup.error ? (
          <span className="text-destructive">
            반영 전 백업을 만들지 못해 백업 없이 진행했습니다 ({result.backup.error}).
          </span>
        ) : (
          <>
            반영 전 시점 저장본을 만들었습니다{result.backup.path ? ` (${result.backup.path})` : ""}
            .
          </>
        )}
      </p>
      {result.failures.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
              <tr>
                <th className="w-28 border-b px-3 py-2 font-medium">성명</th>
                <th className="w-20 border-b px-3 py-2 font-medium">처리</th>
                <th className="border-b px-3 py-2 font-medium">왜 안 됐는지</th>
              </tr>
            </thead>
            <tbody>
              {result.failures.slice(0, 200).map((f, i) => (
                <tr key={`${f.name}-${f.action}-${i}`} className="border-t align-top">
                  <td className="px-3 py-2">{f.name}</td>
                  <td className="px-3 py-2">{f.action}</td>
                  <td className="px-3 py-2 text-destructive">{f.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  /** 안내 메일이 되돌아온 시점·사유. 채우는 쪽은 메일 담당이고 여기서는 표시만 한다 (기획 F1). */
  mail_bounced_at: string | null;
  mail_bounce_reason: string | null;
  /** 배정된 조사 차수 (기획 F8). */
  wave_id: string | null;
  companies: { name: string } | null;
};

const PARTICIPANT_COLUMNS =
  "id, company_id, emp_no, name, email, birth_date, org_text, grade, role_level, org_unit_id, role, account_status, user_id, tags, archived_at, initial_password, must_change_password, mail_bounced_at, mail_bounce_reason, wave_id, companies(name)";

/* ─────────── 조사 차수 (기획 F8) — 본체는 차수 담당이 만든다 ───────────
 *
 * 차수 관리 화면이 `?assignWave=<차수id>` 로 이 화면에 보내면, 그 차수로 배정하는 흐름을 연다.
 * 모듈은 import.meta.glob 으로 찾는다 — 파일이 없으면 목록이 비어 차수 기능만 꺼지고
 * (버튼 비활성 + 안내), 있으면 그대로 잡힌다.
 *
 * 차수는 survey_waves.company_id 로 계열사에 묶여 있어 목록 조회도 계열사가 필수다.
 * 그래서 계열사 범위가 「전사」면 배정을 열지 않고 계열사를 먼저 고르라고 안내한다.
 */
type WaveOption = {
  id: string;
  seq: number;
  name: string;
  kind: string;
  deadline: string | null;
  status: string;
  assignedCount: number;
  submittedCount: number;
};

type WaveModule = {
  listWaves?: (opts: {
    data: { companyId: string };
    headers: Record<string, string>;
  }) => Promise<WaveOption[]>;
  assignWave?: (opts: {
    data: { participantIds: string[]; waveId: string };
    headers: Record<string, string>;
    /** 마감된 차수 소속 응답은 옮기지 않는다. 그 건수가 protectedResponses 로 돌아온다. */
  }) => Promise<{ updated: number; protectedResponses: number }>;
};

const WAVE_MODULE_PATH = "../../../lib/wave.functions.ts";

async function loadWaveModule(): Promise<WaveModule | null> {
  const mods = import.meta.glob<WaveModule>("../../../lib/wave.functions.ts");
  const load = mods[WAVE_MODULE_PATH];
  if (!load) return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/** 차수 목록. null 이면 지금 차수 배정을 쓸 수 없다는 뜻이다(빈 배열과 구분한다). */
function useWaves(companyId: string) {
  return useQuery({
    queryKey: ["survey-waves", companyId],
    queryFn: async (): Promise<WaveOption[] | null> => {
      if (companyId === "all") return null;
      const mod = await loadWaveModule();
      if (!mod?.listWaves) return null;
      try {
        return await mod.listWaves({ data: { companyId }, headers: await authHeaders() });
      } catch {
        return null;
      }
    },
  });
}

type OrgUnitRow = { id: string; parent_id: string | null; name: string; sort: number };

/** 조직 트리를 들여쓰기 라벨의 평탄 목록으로. 부모가 조회 범위 밖이면 루트로 취급한다. */
function flattenOrgUnits(units: OrgUnitRow[]): { id: string; label: string }[] {
  const idSet = new Set(units.map((u) => u.id));
  const children = new Map<string, OrgUnitRow[]>();
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
      out.push({ id: u.id, label: `${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}${u.name}` });
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
      return (data ?? []) as OrgUnitRow[];
    },
  });
  return useMemo(() => flattenOrgUnits(data ?? []), [data]);
}

/** 수정 폼. 계열사·사번은 고정이다 — 추가는 AddParticipantDialog 가 담당한다. */
function ParticipantFormDialog({
  open,
  participant,
  onOpenChange,
}: {
  open: boolean;
  participant: Participant;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    name: participant.name,
    email: participant.email ?? "",
    birth_date: participant.birth_date ?? "",
    org_text: participant.org_text ?? "",
    grade: participant.grade ?? "",
    role_level: participant.role_level ?? "",
    org_unit_id: participant.org_unit_id ?? "",
  }));

  const orgOptions = useOrgUnitOptions(participant.company_id);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const save = useMutation({
    mutationFn: async () =>
      updateParticipant({
        data: {
          participantId: participant.id,
          name: form.name.trim(),
          email: form.email.trim(),
          birth_date: form.birth_date || null,
          org_text: form.org_text.trim(),
          grade: form.grade.trim(),
          role_level: form.role_level.trim(),
          orgUnitId: form.org_unit_id || null,
        },
        headers: await authHeaders(),
      }),
    onSuccess: () => {
      toast.success(`${form.name.trim()} 정보를 수정했습니다.`);
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canSave = form.name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>참여자 수정</DialogTitle>
          <DialogDescription>
            {`${participant.companies?.name ?? "-"} · 사번 ${participant.emp_no}. 계열사와 사번은 바꿀 수 없습니다.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
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
            <Label htmlFor="p-org-unit">소속 (조직도 연결)</Label>
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
                이 계열사에 등록된 조직도가 없습니다. 기준정보 화면에서 조직도를 먼저 올리세요.
              </p>
            )}
          </div>
        </div>

        {participant.user_id && form.email.trim() !== (participant.email ?? "") && (
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
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** YYMMDD·YYYYMMDD → YYYY-MM-DD. 명부 업로드(roster.ts normalizeBirth)와 같은 규칙(YY>30 → 1900년대). */
function normalizeBirth6(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (digits.length === 6) {
    const yy = Number(digits.slice(0, 2));
    const century = yy > 30 ? 1900 : 2000;
    return `${century + yy}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
  }
  return null;
}

/**
 * 참여자 즉시 추가 (기획 15). 명부 등록과 계정 발급을 한 번에 한다 —
 * 명부 업로드를 다시 돌리지 않고 조사 중간에 합류한 한 명을 바로 태울 수 있다.
 */
function AddParticipantDialog({
  companies,
  defaultCompanyId,
  onOpenChange,
}: {
  companies: Company[];
  defaultCompanyId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    companyId: defaultCompanyId,
    emp_no: "",
    name: "",
    email: "",
    birth: "",
    org_text: "",
    grade: "",
    role_level: "",
  }));

  // 역할단계 선택지는 설정 화면(system_settings.role_levels)이 단일 원천이다.
  const { data: settings } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => getSettings({ headers: await authHeaders() }),
  });
  const roleLevels: string[] = settings?.roleLevels ?? [];

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const birthInvalid = form.birth.trim() !== "" && normalizeBirth6(form.birth) === null;

  const save = useMutation({
    mutationFn: async () =>
      addParticipant({
        data: {
          companyId: form.companyId,
          emp_no: form.emp_no.trim(),
          name: form.name.trim(),
          email: form.email.trim(),
          birth_date: form.birth.trim() ? normalizeBirth6(form.birth) : null,
          org_text: form.org_text.trim(),
          grade: form.grade.trim(),
          role_level: form.role_level,
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      const name = form.name.trim();
      if (res.provisioned) {
        toast.success(
          `${name}${josa(name, "을/를")} 등록하고 계정이 만들어졌습니다. 안내 메일은 차수 발송에서 보냅니다.`,
        );
      } else {
        toast.success(`${name}${josa(name, "을/를")} 명부에 등록했습니다.`);
        toast.error(
          `계정은 지금 만들지 못했습니다(${res.reason ?? "계정은 배포 환경에서 생성됩니다"}). 명단에서 [계정 생성]으로 다시 시도하세요.`,
        );
      }
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["participants-keys"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canSave =
    form.companyId.length > 0 &&
    form.emp_no.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.email.trim().length > 0 &&
    !birthInvalid;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>참여자 추가</DialogTitle>
          <DialogDescription>
            한 명을 바로 등록합니다. 저장하면 규칙 비밀번호(기본: 생년월일 6자리+사번 뒤 4자리)로
            계정까지 만들어지고, 안내 메일은 차수 발송에서 보냅니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="a-company">계열사 *</Label>
            <Select value={form.companyId} onValueChange={(v) => set("companyId", v)}>
              <SelectTrigger id="a-company">
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
            <Label htmlFor="a-empno">사번 *</Label>
            <Input
              id="a-empno"
              value={form.emp_no}
              onChange={(e) => set("emp_no", e.target.value)}
              placeholder="20150908"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-name">이름 *</Label>
            <Input id="a-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-email">이메일 *</Label>
            <Input
              id="a-email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="gildong.hong@seoyon.example"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-birth">생년월일 (YYMMDD)</Label>
            <Input
              id="a-birth"
              inputMode="numeric"
              value={form.birth}
              onChange={(e) => set("birth", e.target.value)}
              placeholder="900312"
            />
            {birthInvalid && (
              <p className="text-xs text-destructive">YYMMDD 6자리로 적어 주세요. 예: 850312</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-grade">직급</Label>
            <Input id="a-grade" value={form.grade} onChange={(e) => set("grade", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-role-level">역할단계</Label>
            <Select
              value={form.role_level || "__none__"}
              onValueChange={(v) => set("role_level", v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="a-role-level">
                <SelectValue placeholder="선택 안 함" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— 선택 안 함</SelectItem>
                {roleLevels.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="a-org">소속</Label>
            <Input
              id="a-org"
              value={form.org_text}
              onChange={(e) => set("org_text", e.target.value)}
              placeholder="경영기획본부 / 기획팀"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            등록하고 계정 만들기
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
    onSuccess: () => done(archived ? "보관을 해제했습니다." : "보관했습니다. 로그인이 차단됩니다."),
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

/**
 * 명단을 훑는 데 필요한 열만 기본으로 켠다 (기획 P1).
 * 이메일·비밀번호처럼 계정을 손볼 때만 필요한 값은 상세 패널과 열 고르기에 둔다.
 */
const LIST_COLUMNS = [
  { key: "emp_no", label: "사번" },
  { key: "name", label: "성명" },
  { key: "company", label: "계열사" },
  { key: "org", label: "소속" },
  { key: "job", label: "직무" },
  { key: "role_level", label: "역할단계" },
  { key: "status", label: "상태" },
  { key: "wave", label: "차수" },
  { key: "grade", label: "직급" },
  { key: "tags", label: "태그" },
  { key: "email", label: "이메일" },
  { key: "password", label: "비밀번호" },
] as const;

type ColumnKey = (typeof LIST_COLUMNS)[number]["key"];

const DEFAULT_COLUMNS: ColumnKey[] = [
  "emp_no",
  "name",
  "company",
  "org",
  "job",
  "role_level",
  "status",
];

function sameColumns(a: ColumnKey[], b: ColumnKey[]) {
  return a.length === b.length && a.every((k) => b.includes(k));
}

type ResponseRef = { id: string; job_name: string | null; status: string };

/**
 * 선택한 인원·소속을 독려 메일 화면으로 넘긴다 (기획 B4). 발송은 메일 화면이 한다.
 * 메일 화면의 수신 규약은 `?template=&org=&status=&ids=` 이고, 여기서는 org·status·ids 만 채운다.
 */
function remindSearch(args: { participantIds: string[]; orgId: string | null; status: string }) {
  const out: { org?: string; status?: string; ids?: string } = {};
  if (args.participantIds.length > 0) {
    // 주소 길이 상한이 있어 200명까지만 싣는다. 그보다 많으면 소속 단위로 보내는 편이 맞다.
    out.ids = args.participantIds.slice(0, 200).join(",");
  } else if (args.orgId) {
    out.org = args.orgId;
  }
  if (args.status !== "all") out.status = args.status;
  return out;
}

function RosterListTab({
  search,
  patch,
}: {
  search: ParticipantsSearch;
  patch: (next: SearchPatch) => void;
}) {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();

  // 필터는 URL 이 원천이다 — 새로고침·뒤로가기·공유가 그대로 동작해야 한다 (기획 D4).
  const statusFilter = search.status ?? "all";
  const tagFilter = search.tag ?? "all";
  const includeArchived = search.archived === true;

  // 검색어만은 입력 중 IME 조합이 끊기지 않도록 지역 상태로 받고 잠깐 뒤 URL 에 싣는다.
  const [searchText, setSearchText] = useState(search.q ?? "");
  useEffect(() => {
    setSearchText(search.q ?? "");
  }, [search.q]);
  useEffect(() => {
    const current = search.q ?? "";
    if (searchText === current) return;
    const timer = setTimeout(() => patch({ q: searchText || undefined }), 300);
    return () => clearTimeout(timer);
    // patch 는 매 렌더 새로 만들어지므로 의존성에서 뺀다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, search.q]);

  const { selectedOrgId, setSelectedOrgId } = useOrgLens();
  const [includeSubOrgs, setIncludeSubOrgs] = useState(true);
  // 행 높이는 넉넉한 한 가지로 고정한다 — 좁게/넓게 토글은 v4에서 뺐다.
  const rowClass = "py-3 text-sm";
  const [visibleColumns, setVisibleColumns] = usePersistedState<ColumnKey[]>(
    "participants-columns",
    DEFAULT_COLUMNS,
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState("");
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [bulkWaveId, setBulkWaveId] = useState("");
  /** 마지막 차수 배정 결과. 마감 차수 때문에 유지된 응답 건수를 화면에 남겨 둔다. */
  const [waveResult, setWaveResult] = useState<{
    waveName: string;
    updated: number;
    protectedResponses: number;
  } | null>(null);
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

  /** 소속 트리·소속 열·일괄 배정이 함께 쓴다. 전사 스코프면 전 계열사 소속을 가져온다. */
  const { data: orgUnits } = useQuery({
    queryKey: ["org-units-filter", companyId],
    queryFn: async () => {
      let query = supabase.from("org_units").select("id, parent_id, name, sort").order("sort");
      if (companyId !== "all") query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as OrgUnitRow[];
    },
  });
  const units = orgUnits ?? [];
  const orgOptions = useMemo(() => flattenOrgUnits(units), [units]);
  const unitNameById = useMemo(() => new Map(units.map((u) => [u.id, u.name])), [units]);

  const { data: waves } = useWaves(companyId);
  const waveAvailable = Array.isArray(waves);
  const waveNameById = useMemo(
    () => new Map((waves ?? []).map((w) => [w.id, `${w.seq}차 ${w.name}`])),
    [waves],
  );

  // 소속 렌즈는 이제 이 화면의 ?org= 자체가 원천이라(useOrgLens), 딥링크 값을 옮겨 싣는
  // 별도 동기화가 필요 없다 — search.org 와 selectedOrgId 는 항상 같은 URL 키를 가리킨다.

  // 차수 관리 화면이 보낸 차수를 일괄 배정 칸에 미리 채운다. 사람만 고르면 바로 배정할 수 있다.
  useEffect(() => {
    if (search.assignWave) setBulkWaveId(search.assignWave);
  }, [search.assignWave]);

  function selectOrg(id: string | null) {
    setSelectedOrgId(id);
    patch({ org: id ?? undefined });
  }

  /** 선택 소속 + (토글 시) 하위 소속 전체의 id 집합. 전체면 null. */
  const orgIdSet = useMemo(() => {
    if (!selectedOrgId) return null;
    if (!includeSubOrgs) return new Set([selectedOrgId]);
    return new Set(orgSubtreeIds(units, selectedOrgId) ?? [selectedOrgId]);
  }, [selectedOrgId, includeSubOrgs, units]);

  /** 응답 검토 딥링크와 직무 열의 근거. 참여자당 한 건(제출 이상을 우선)으로 줄인다. */
  const { data: responses } = useQuery({
    queryKey: ["participants-responses"],
    queryFn: () =>
      fetchAll<{
        id: string;
        participant_id: string;
        job_name: string | null;
        status: string;
        recheck_required: boolean;
      }>((from, to) =>
        supabase
          .from("responses")
          .select("id, participant_id, job_name, status, recheck_required")
          .order("id")
          .range(from, to),
      ),
  });
  /** 변경 재확인이 선 응답을 가진 참여자 — ?recheck=1 필터의 모수 (기획 F10). */
  const recheckIds = useMemo(() => {
    const out = new Set<string>();
    for (const r of responses ?? []) if (r.recheck_required) out.add(r.participant_id);
    return out;
  }, [responses]);
  const responseByParticipant = useMemo(() => {
    const map = new Map<string, ResponseRef>();
    for (const r of responses ?? []) {
      const prev = map.get(r.participant_id);
      // 검토 대상은 제출 이상이다. 작성중(draft)보다 제출된 응답을 우선 잡는다.
      if (prev && prev.status !== "draft" && r.status === "draft") continue;
      map.set(r.participant_id, { id: r.id, job_name: r.job_name, status: r.status });
    }
    return map;
  }, [responses]);

  /** 상태 필터는 콤마로 여러 개를 받는다 — 대시보드 진행축 딥링크(미확인=초대발송,미접속)와 호환. */
  const statusSet = useMemo(
    () => (statusFilter === "all" ? null : new Set(statusFilter.split(","))),
    [statusFilter],
  );

  /** 소속 필터를 뺀 나머지 조건까지 적용한 행 — 트리의 인원수는 이 모수로 센다. */
  const baseRows = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return (data ?? []).filter((p) => {
      if (!includeArchived && p.archived_at) return false;
      if (statusSet && !statusSet.has(p.account_status)) return false;
      if (tagFilter !== "all" && !(p.tags ?? []).includes(tagFilter)) return false;
      if (search.recheck && !recheckIds.has(p.id)) return false;
      if (!q) return true;
      return [p.name, p.emp_no, p.email ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [data, searchText, statusSet, tagFilter, includeArchived, search.recheck, recheckIds]);

  const rows = useMemo(
    () =>
      orgIdSet ? baseRows.filter((p) => p.org_unit_id && orgIdSet.has(p.org_unit_id)) : baseRows,
    [baseRows, orgIdSet],
  );

  /**
   * 소속별 인원수 — 자기 소속과 하위 소속을 합친 값. 트리에서 규모를 바로 본다.
   * ponytail: 소속 수 × 트리 깊이만큼 훑는다. 수백 개까지는 체감이 없고,
   *           수천 개가 되면 부모 방향으로 한 번에 더하는 방식으로 바꾼다.
   */
  const orgCounts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const p of baseRows) {
      if (!p.org_unit_id) continue;
      direct.set(p.org_unit_id, (direct.get(p.org_unit_id) ?? 0) + 1);
    }
    const out: Record<string, number> = {};
    for (const u of units) {
      out[u.id] = (orgSubtreeIds(units, u.id) ?? []).reduce(
        (sum, id) => sum + (direct.get(id) ?? 0),
        0,
      );
    }
    return out;
  }, [baseRows, units]);

  /** 상세 패널 대상. 필터에 걸려 목록에 없어도 딥링크는 열려야 한다. */
  const detail = useMemo(
    () => (search.p ? ((data ?? []).find((p) => p.id === search.p) ?? null) : null),
    [data, search.p],
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
    onSuccess: (res) => {
      toast.success(`초기 비밀번호를 ${res.password} 로 재설정했습니다.`);
      // 상세 패널의 비밀번호가 낡은 값을 계속 보여주지 않게 한다.
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
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
      toast.success(`${res.changed}명의 소속을 배정했습니다.`);
      setBulkOrgId("");
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** 차수 배정. 차수 기능이 아직 없으면 버튼이 비활성이라 여기까지 오지 않는다. */
  const waveAssign = useMutation({
    mutationFn: async () => {
      const mod = await loadWaveModule();
      if (!mod?.assignWave) throw new Error("차수 기능을 아직 쓸 수 없습니다.");
      return mod.assignWave({
        data: { participantIds: [...selected], waveId: bulkWaveId },
        headers: await authHeaders(),
      });
    },
    onSuccess: (res) => {
      const waveName = waveNameById.get(bulkWaveId) ?? "선택한 차수";
      // 마감된 차수에 매인 응답은 옮기지 않는다. 조용히 넘기면 관리자가 옮겨진 줄 안다.
      setWaveResult({ waveName, updated: res.updated, protectedResponses: res.protectedResponses });
      toast.success(
        `${res.updated}명을 ${waveName}에 배정했습니다.` +
          (res.protectedResponses > 0
            ? ` 응답 ${res.protectedResponses}건은 마감된 차수라 유지됩니다.`
            : ""),
      );
      setBulkWaveId("");
      setSelected(new Set());
      patch({ assignWave: undefined });
      void queryClient.invalidateQueries({ queryKey: ["participants"] });
      void queryClient.invalidateQueries({ queryKey: ["survey-waves"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const selectedIds = [...selected];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const hasTagInput = tagInput.trim().length > 0;
  const busy =
    provision.isPending ||
    bulkReset.isPending ||
    tagMutation.isPending ||
    orgAssign.isPending ||
    waveAssign.isPending;
  const columnsChanged = !sameColumns(visibleColumns, DEFAULT_COLUMNS);
  const shownColumns = LIST_COLUMNS.filter((c) => visibleColumns.includes(c.key));
  const remindTarget = selectedIds.length > 0 || !!selectedOrgId;

  /** 현재 필터가 적용된 rows 그대로 CSV 로 만든다. 엑셀 호환을 위해 BOM 을 붙인다. */
  function downloadRoster() {
    // 비밀번호도 평문으로 나간다 — 계정 안내용. 파일 자체가 대외비다.
    const header = [
      "사번",
      "이름",
      "계열사",
      "소속",
      "소속 표기",
      "직급",
      "역할단계",
      "이메일",
      "비밀번호",
      "태그",
      "상태",
      "차수",
      "메일 반송",
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
        p.wave_id ? (waveNameById.get(p.wave_id) ?? "배정됨") : "",
        p.mail_bounced_at
          ? `${p.mail_bounced_at.slice(0, 10)} ${p.mail_bounce_reason ?? ""}`.trim()
          : "",
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

  function openDetail(id: string) {
    patch({ p: id });
  }

  function cell(key: ColumnKey, p: Participant) {
    const response = responseByParticipant.get(p.id);
    switch (key) {
      case "emp_no":
        return <span className="text-muted-foreground tabular-nums">{p.emp_no}</span>;
      case "name":
        return (
          // 모든 행은 그 사람 단건으로 가는 딥링크다 (기획 P6).
          <button
            type="button"
            onClick={() => openDetail(p.id)}
            className="text-left font-medium hover:underline"
          >
            {p.name}
            {p.archived_at && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">보관</span>
            )}
          </button>
        );
      case "company":
        return p.companies?.name ?? "-";
      case "org":
        return p.org_unit_id ? (
          (unitNameById.get(p.org_unit_id) ?? "-")
        ) : (
          <span className="text-muted-foreground">
            {p.org_text}
            <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs">미배정</span>
          </span>
        );
      case "job":
        return response?.job_name ? (
          response.job_name
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      case "role_level":
        return p.role_level ?? <span className="text-muted-foreground">-</span>;
      case "status":
        // 상태 2축 (기획 5) — 진행 배지에, 제출 이후 건은 검토 배지를 병기한다.
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge status={p.account_status} axis="progress" />
            <StatusBadge status={p.account_status} axis="review" />
            <BounceBadge participant={p} />
          </span>
        );
      case "wave":
        // 전사 범위에서는 차수 목록을 불러오지 않는다(차수는 계열사별). 이름 대신 배정 여부만 보여
        // 준다 — 빈칸으로 두면 「차수가 없는 사람」으로 잘못 읽힌다.
        return p.wave_id ? (
          (waveNameById.get(p.wave_id) ?? <span className="text-muted-foreground">배정됨</span>)
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      case "grade":
        return p.grade ?? <span className="text-muted-foreground">-</span>;
      case "tags":
        return <TagChips participant={p} />;
      case "email":
        return <span className="break-all text-xs">{p.email ?? "-"}</span>;
      case "password":
        return <PasswordCell participant={p} />;
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* 관리의 기본 단위는 개인이 아니라 소속이다 (기획 B4·P5). */}
      <OrgTreeFilter
        units={units}
        selectedId={selectedOrgId}
        onSelect={selectOrg}
        counts={orgCounts}
        title="소속"
        className="h-fit lg:sticky lg:top-[var(--sticky-top)]"
      />

      <div className="min-w-0 space-y-4">
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="이름 · 사번 · 이메일"
                  aria-label="참여자 검색"
                  className="w-[220px] pl-8"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => patch({ status: v === "all" ? undefined : v })}
              >
                <SelectTrigger className="w-[140px]" aria-label="상태 필터">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체 상태</SelectItem>
                  {/* 딥링크로 여러 상태가 묶여 온 경우 — 그 묶음 자체를 항목으로 보여 준다. */}
                  {statusFilter.includes(",") && (
                    <SelectItem value={statusFilter}>
                      {statusFilter.split(",").join(" · ")}
                    </SelectItem>
                  )}
                  {ACCOUNT_STATUS_LABELS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={tagFilter}
                onValueChange={(v) => patch({ tag: v === "all" ? undefined : v })}
              >
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
              {selectedOrgId && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={includeSubOrgs}
                    onCheckedChange={(v) => setIncludeSubOrgs(v === true)}
                  />
                  하위 소속 포함
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={includeArchived}
                  onCheckedChange={(v) => patch({ archived: v === true ? true : undefined })}
                />
                보관 포함
              </label>
              {search.recheck && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning">
                  재확인이 필요한 참여자만 보는 중
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => patch({ recheck: undefined })}
                  >
                    해제
                  </button>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={rows.length === 0}
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                }
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
                소속 일괄 매칭
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-4" />
                참여자 추가
              </Button>
            </div>
          </div>

          {/* 지금 무엇을 보고 있는지와, 표를 어떻게 보고 있는지 (기획 P9·D6) */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-secondary px-2.5 py-1 font-medium text-foreground">
                {orgPathLabel(units, selectedOrgId)}
              </span>
              <span className="tabular-nums">
                {rows.length}명 표시 중 · 선택 {selectedIds.length}명
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!remindTarget}
                title={
                  remindTarget ? undefined : "독려할 인원을 선택하거나 왼쪽에서 소속을 고르세요."
                }
                asChild={remindTarget}
              >
                {remindTarget ? (
                  <Link
                    to="/admin/mail"
                    search={remindSearch({
                      participantIds: selectedIds,
                      orgId: selectedOrgId,
                      status: statusFilter,
                    })}
                  >
                    <Mail className="size-4" />
                    독려 메일 보내기
                  </Link>
                ) : (
                  <>
                    <Mail className="size-4" />
                    독려 메일 보내기
                  </>
                )}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <TableProperties className="size-4" />열 고르기
                    {columnsChanged && (
                      <span className="ml-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
                        기본값과 다름
                      </span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>표에 보일 열</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {LIST_COLUMNS.map((c) => {
                    const on = visibleColumns.includes(c.key);
                    return (
                      <DropdownMenuItem
                        key={c.key}
                        // 여러 열을 연달아 켜고 끄는 동작이라 메뉴를 닫지 않는다.
                        onSelect={(e) => {
                          e.preventDefault();
                          setVisibleColumns((prev) =>
                            on ? prev.filter((k) => k !== c.key) : [...prev, c.key],
                          );
                        }}
                      >
                        <Checkbox checked={on} aria-hidden className="pointer-events-none" />
                        {c.label}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!columnsChanged}
                    onSelect={() => setVisibleColumns(DEFAULT_COLUMNS)}
                  >
                    기본값으로 되돌리기
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* 차수 관리 화면에서 「이 차수로 배정」을 눌러 들어온 경우 (기획 F8) */}
          {search.assignWave && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold">
                차수 배정 중
              </span>
              <span className="min-w-0 flex-1">
                {companyId === "all" ? (
                  <span className="text-destructive">
                    차수는 계열사별로 관리합니다. 위에서 계열사를 먼저 고르세요.
                  </span>
                ) : !waveAvailable ? (
                  <span className="text-destructive">
                    차수 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.
                  </span>
                ) : waveNameById.has(search.assignWave) ? (
                  <>
                    <strong>{waveNameById.get(search.assignWave)}</strong>에 배정할 사람을 고르고,
                    아래 [차수 배정]을 누르세요. 지금 선택 {selectedIds.length}명.
                  </>
                ) : (
                  <span className="text-destructive">
                    이 차수는 지금 보고 있는 계열사의 것이 아닙니다. 계열사 범위를 바꿔 주세요.
                  </span>
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={rows.length === 0}
                onClick={() => setSelected(new Set(rows.map((r) => r.id)))}
              >
                표시된 {rows.length}명 모두 고르기
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBulkWaveId("");
                  patch({ assignWave: undefined });
                }}
              >
                배정 그만두기
              </Button>
            </div>
          )}

          {waveResult && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <span>
                <strong>{waveResult.waveName}</strong>에 {waveResult.updated}명을 배정했습니다.
                {waveResult.protectedResponses > 0 ? (
                  <span className="text-warning">
                    {" "}
                    응답 {waveResult.protectedResponses}건은 마감된 차수라 유지됨
                  </span>
                ) : (
                  " 마감된 차수 때문에 유지된 응답은 없습니다."
                )}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setWaveResult(null)}>
                닫기
              </Button>
            </div>
          )}

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
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => bulkReset.mutate(selectedIds)}
              >
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
                <SelectTrigger className="w-[200px]" aria-label="일괄 배정할 소속">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">— 소속 선택</SelectItem>
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
                소속 배정
              </Button>
              {/* 차수를 고를 수 없는 상황이면 그 이유를 그대로 보여 준다. */}
              <Select
                value={bulkWaveId || "__pick__"}
                onValueChange={(v) => setBulkWaveId(v === "__pick__" ? "" : v)}
                disabled={!waveAvailable}
              >
                <SelectTrigger
                  className="w-[190px]"
                  aria-label="일괄 배정할 조사 차수"
                  title={
                    waveAvailable
                      ? undefined
                      : companyId === "all"
                        ? "차수는 계열사별로 관리합니다. 위에서 계열사를 고르세요."
                        : "조사 차수를 불러오지 못했습니다."
                  }
                >
                  <SelectValue placeholder="차수 고를 수 없음" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">— 차수 선택</SelectItem>
                  {(waves ?? []).map((w) => (
                    // 마감된 차수에는 새로 배정할 수 없다(서버가 거부한다). 고르지 못하게 막는다.
                    <SelectItem key={w.id} value={w.id} disabled={w.status === "마감"}>
                      {w.seq}차 {w.name} · {w.status} · 배정 {w.assignedCount}명
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !bulkWaveId}
                onClick={() => waveAssign.mutate()}
              >
                {waveAssign.isPending && <Loader2 className="size-4 animate-spin" />}
                차수 배정
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : rows.length === 0 ? (
          <EmptyState
            kind="nothing"
            title="조건에 맞는 참여자가 없습니다"
            description={
              baseRows.length > 0
                ? `${orgPathLabel(units, selectedOrgId)} 소속으로는 0명입니다. 다른 조건에서는 ${baseRows.length}명이 있습니다.`
                : "지금 걸린 검색어·상태·태그 조건에 맞는 사람이 없습니다. 조건을 풀거나 명부를 올려 참여자를 등록하세요."
            }
            actionLabel="조건 모두 지우기"
            onAction={() => {
              selectOrg(null);
              setSearchText("");
              patch({
                q: undefined,
                status: undefined,
                tag: undefined,
                archived: undefined,
                recheck: undefined,
              });
            }}
          />
        ) : (
          <>
            {/* 모바일: 카드 스택 */}
            <ul className="space-y-3 md:hidden">
              {rows.map((p) => (
                <li
                  key={p.id}
                  className={`rounded-xl border bg-card p-4 shadow-sm ${p.archived_at ? "opacity-60" : ""} ${
                    search.p === p.id ? "ring-2 ring-primary" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggle(p.id)}
                        aria-label={`${p.name} 선택`}
                      />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => openDetail(p.id)}
                          className="text-left font-semibold hover:underline"
                        >
                          {p.name}
                          <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                            {p.emp_no}
                          </span>
                        </button>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {p.companies?.name} ·{" "}
                          {p.org_unit_id ? unitNameById.get(p.org_unit_id) : p.org_text}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={p.account_status} axis="progress" />
                      <StatusBadge status={p.account_status} axis="review" />
                      <BounceBadge participant={p} />
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">직무</dt>
                      <dd className="mt-0.5 truncate font-medium">
                        {responseByParticipant.get(p.id)?.job_name ?? "-"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">역할단계</dt>
                      <dd className="mt-0.5 font-medium">{p.role_level ?? "-"}</dd>
                    </div>
                  </dl>
                  <TagChips participant={p} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => openDetail(p.id)}>
                      상세 · 계정
                    </Button>
                    <RowMenu
                      participant={p}
                      response={responseByParticipant.get(p.id) ?? null}
                      resetting={resetPassword.isPending}
                      onDetail={() => openDetail(p.id)}
                      onEdit={() => setEditing(p)}
                      onReset={() => resetPassword.mutate(p.id)}
                      onRemove={() => setRemoving(p)}
                    />
                  </div>
                </li>
              ))}
            </ul>

            {/* 데스크톱: 표. 500행을 훑어도 머리글을 잃지 않게 표 안에서 스크롤한다 (기획 D6). */}
            <div className="hidden max-h-[calc(100vh-19rem)] overflow-auto rounded-xl border bg-card shadow-sm md:block">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-secondary text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 border-b px-4 py-3" />
                    {shownColumns.map((c) => (
                      <th key={c.key} className="border-b px-4 py-3 font-medium">
                        {c.label}
                      </th>
                    ))}
                    <th className="w-14 border-b px-4 py-3 font-medium">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-t ${p.archived_at ? "opacity-60" : ""} ${
                        search.p === p.id ? "bg-primary-soft" : ""
                      }`}
                    >
                      <td className={`px-4 ${rowClass}`}>
                        <Checkbox
                          checked={selected.has(p.id)}
                          onCheckedChange={() => toggle(p.id)}
                          aria-label={`${p.name} 선택`}
                        />
                      </td>
                      {shownColumns.map((c) => (
                        <td key={c.key} className={`px-4 ${rowClass}`}>
                          {cell(c.key, p)}
                        </td>
                      ))}
                      <td className={`px-4 ${rowClass}`}>
                        <RowMenu
                          participant={p}
                          response={responseByParticipant.get(p.id) ?? null}
                          resetting={resetPassword.isPending}
                          onDetail={() => openDetail(p.id)}
                          onEdit={() => setEditing(p)}
                          onReset={() => resetPassword.mutate(p.id)}
                          onRemove={() => setRemoving(p)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* 딥링크로 지목된 한 사람 (기획 D4·P6) */}
      <Sheet open={!!search.p} onOpenChange={(open) => !open && patch({ p: undefined })}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {detail ? (
            <ParticipantDetail
              participant={detail}
              orgLabel={orgPathLabel(units, detail.org_unit_id)}
              response={responseByParticipant.get(detail.id) ?? null}
              resetting={resetPassword.isPending}
              onEdit={() => setEditing(detail)}
              onReset={() => resetPassword.mutate(detail.id)}
              onRemove={() => setRemoving(detail)}
            />
          ) : (
            <>
              <SheetHeader>
                <SheetTitle>참여자 상세</SheetTitle>
                <SheetDescription>지목된 참여자를 확인합니다.</SheetDescription>
              </SheetHeader>
              <div className="mt-6">
                {isLoading ? (
                  <p className="text-sm text-muted-foreground">불러오는 중...</p>
                ) : (
                  <EmptyState
                    kind="nothing"
                    title="이 참여자를 찾지 못했습니다"
                    description="삭제되었거나, 지금 보고 있는 계열사 범위 밖에 있습니다. 상단의 계열사 범위를 전체로 바꾼 뒤 다시 시도해 보세요."
                    actionLabel="명단으로 돌아가기"
                    onAction={() => patch({ p: undefined })}
                  />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {adding && (
        <AddParticipantDialog
          companies={companies ?? []}
          defaultCompanyId={companyId !== "all" ? companyId : ((companies ?? [])[0]?.id ?? "")}
          onOpenChange={(open) => !open && setAdding(false)}
        />
      )}
      {editing && (
        <ParticipantFormDialog
          key={editing.id}
          open
          participant={editing}
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
              <DialogTitle>소속 일괄 매칭 결과</DialogTitle>
              <DialogDescription>
                소속 미연결 참여자의 소속 표기를 조직도 이름과 대조했습니다 (공백 제거 후 정확
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
                  미매칭 건은 참여자 수정 화면에서 소속을 직접 선택하거나, 조직도 이름과 소속 표기를
                  맞춘 뒤 다시 실행하세요.
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
 * 행의 ⋯ 메뉴 (기획 P1).
 * 계정을 손보는 동작은 전부 여기 또는 상세 패널에 있다. 명단을 훑는 면적과 다투지 않게 한다.
 */
function RowMenu({
  participant,
  response,
  resetting,
  onDetail,
  onEdit,
  onReset,
  onRemove,
}: {
  participant: Participant;
  response: ResponseRef | null;
  resetting: boolean;
  onDetail: () => void;
  onEdit: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const reviewable = !!response && response.status !== "draft";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`${participant.name} 관리 메뉴`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onDetail}>
          <FileSearch className="size-4" />
          상세 · 계정 보기
        </DropdownMenuItem>
        {reviewable && response && (
          <DropdownMenuItem asChild>
            {/* 목록이 아니라 그 응답 단건으로 착지시킨다 (기획 P6). */}
            <Link to="/admin/review" search={{ response: response.id }}>
              <FileSearch className="size-4" />
              응답 검토
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="size-4" />
          수정
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!participant.user_id || resetting} onSelect={onReset}>
          <KeyRound className="size-4" />
          비밀번호 초기화
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemove}>
          <Trash2 className="size-4" />
          삭제 · 보관
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 상세 패널 — 계정 운영 정보와 동작을 여기 모은다 (기획 P1). */
function ParticipantDetail({
  participant,
  orgLabel,
  response,
  resetting,
  onEdit,
  onReset,
  onRemove,
}: {
  participant: Participant;
  orgLabel: string;
  response: ResponseRef | null;
  resetting: boolean;
  onEdit: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "사번", value: <span className="tabular-nums">{participant.emp_no}</span> },
    { label: "계열사", value: participant.companies?.name ?? "-" },
    {
      label: "소속",
      value: participant.org_unit_id ? orgLabel : `${participant.org_text ?? "-"} (미배정)`,
    },
    { label: "직급", value: participant.grade ?? "-" },
    { label: "역할단계", value: participant.role_level ?? "-" },
    { label: "생년월일", value: participant.birth_date ?? "-" },
    { label: "직무", value: response?.job_name ?? "-" },
    { label: "권한", value: participant.role === "admin" ? "관리자" : "참여자" },
    { label: "이메일", value: <span className="break-all">{participant.email ?? "-"}</span> },
    { label: "비밀번호", value: <PasswordCell participant={participant} /> },
  ];
  if (participant.mail_bounced_at) {
    rows.push({
      label: "메일 반송",
      value: (
        <span className="text-destructive">
          {participant.mail_bounced_at.slice(0, 10)} ·{" "}
          {participant.mail_bounce_reason ?? "사유가 기록되지 않았습니다"}
        </span>
      ),
    });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {participant.name}
          <StatusBadge status={participant.account_status} withHelp />
        </SheetTitle>
        <SheetDescription>
          {participant.companies?.name ?? "-"} · 사번 {participant.emp_no}
          {participant.archived_at && " · 보관됨(로그인 차단)"}
        </SheetDescription>
      </SheetHeader>

      <dl className="mt-5 space-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 border-b pb-2 last:border-0">
            <dt className="w-20 shrink-0 text-xs text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 flex-1">{r.value}</dd>
          </div>
        ))}
      </dl>

      <TagChips participant={participant} />

      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="size-4" />
          수정
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!participant.user_id || resetting}
          onClick={onReset}
        >
          {resetting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          비밀번호 초기화
        </Button>
        {response && response.status !== "draft" && (
          <Button size="sm" variant="outline" asChild>
            <Link to="/admin/review" search={{ response: response.id }}>
              <FileSearch className="size-4" />
              응답 검토
            </Link>
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <Link to="/admin/mail" search={{ ids: participant.id }}>
            <Mail className="size-4" />
            독려 메일
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="size-4" />
          삭제 · 보관
        </Button>
      </div>

      {!participant.user_id && (
        <p className="mt-4 rounded-lg border bg-secondary/40 p-3 text-xs text-muted-foreground">
          아직 로그인 계정이 없습니다. 명단에서 이 사람을 선택한 뒤 [계정 생성]을 누르면 초기
          비밀번호가 만들어집니다.
        </p>
      )}
    </>
  );
}

/**
 * 계정 비밀번호 노출 셀. 관리자만 보는 화면이고, 값은 서버가 실제로 적용한 평문이다
 * (발급·초기화·본인 변경 모두 participants.initial_password 를 갱신).
 * 계정이 없으면 비밀번호도 없고, 값이 비어 있으면 옛 계정이라 [비밀번호 초기화]로 다시 만들어야 한다.
 *
 * 기본은 가린다 — 화면 공유·어깨 너머로 명단 전체의 비밀번호가 새는 일을 막는다.
 * 복사는 값을 드러내지 않고도 되고, 한 번 드러낸 값은 15초 뒤 자동으로 다시 가린다.
 */
function PasswordCell({ participant }: { participant: Participant }) {
  const [shown, setShown] = useState(false);
  const pw = participant.initial_password;

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 15000);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!participant.user_id) {
    return <span className="text-xs text-muted-foreground">계정 없음</span>;
  }
  if (!pw) {
    return <span className="text-xs text-muted-foreground">미기록 — 초기화 필요</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
        {shown ? pw : "••••••••"}
      </code>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        aria-label={`${participant.name} 비밀번호 ${shown ? "가리기" : "보기"}`}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        aria-label={`${participant.name} 비밀번호 복사`}
        onClick={() => {
          void navigator.clipboard
            .writeText(pw)
            .then(() => toast.success("비밀번호를 복사했습니다."))
            .catch(() => toast.error("복사에 실패했습니다. 눈 모양 버튼으로 값을 확인해 주세요."));
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

/**
 * 안내 메일이 되돌아온 사람 표시 (기획 F1).
 * 값을 채우는 쪽은 메일 담당이고 여기서는 표시만 한다 — 사유는 길어서 호버로 보여 준다.
 */
function BounceBadge({ participant }: { participant: Participant }) {
  if (!participant.mail_bounced_at) return null;
  const when = participant.mail_bounced_at.slice(0, 10);
  return (
    <span
      className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive"
      title={`${when} 메일이 되돌아왔습니다. 사유: ${participant.mail_bounce_reason ?? "기록되지 않음"}`}
    >
      메일 반송
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab = search.tab ?? "list";

  /** URL 을 화면 상태의 원천으로 쓴다. 필터를 바꿔도 뒤로가기가 필터 이력을 삼키지 않게 replace. */
  function patch(next: SearchPatch) {
    void navigate({
      to: "/admin/participants",
      search: (prev) => patchSearch(prev, next),
      replace: true,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">참여자 명부</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          참여자를 등록·수정·보관하고, 계정을 일괄 생성합니다.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => patch({ tab: v === "upload" ? "upload" : "list", p: undefined })}
      >
        <TabsList className="grid w-full grid-cols-2 sm:w-auto">
          <TabsTrigger value="list">명단 · 계정</TabsTrigger>
          <TabsTrigger value="upload">명부 업로드</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="mt-4">
          <RosterListTab search={search} patch={patch} />
        </TabsContent>
        <TabsContent value="upload" className="mt-4">
          <RosterUploadTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
