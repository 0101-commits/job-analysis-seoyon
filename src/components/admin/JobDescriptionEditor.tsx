import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  ExternalLink,
  History,
  Loader2,
  RotateCcw,
  Save,
  TriangleAlert,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  confirmJobDescription,
  diffJobDescriptionVersions,
  listJobDescriptionVersions,
  reopenJobDescription,
  restoreJobDescriptionVersion,
  saveJobDescription,
  type JobDescSource,
  type JobDescriptionView,
} from "@/lib/export.functions";

/** 「과업명: 활동1 / 활동2」 한 줄 = 과업 하나. 화면에서 가장 손대기 쉬운 형태다. */
function parseTasks(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const [head, ...rest] = line.split(":");
      return {
        task: (head ?? "").trim(),
        activities: rest
          .join(":")
          .split("/")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      };
    })
    .filter((t) => t.task !== "");
}

function taskLines(tasks: JobDescriptionView["tasks"]) {
  return tasks
    .map((t) => (t.activities.length > 0 ? `${t.task}: ${t.activities.join(" / ")}` : t.task))
    .join("\n");
}

const splitList = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

function when(at: string | null) {
  return at
    ? new Date(at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })
    : "—";
}

/**
 * 항목 하나의 근거. 출처가 없으면 눈에 띄게 알린다 — 이 표시가 F13 의 핵심이다.
 * (근거가 비는 이유는 두 가지다: 응답에 없던 내용을 AI 가 지어냈거나, AI 가 문장을 크게
 *  바꿔 써서 원문과 이어 붙이지 못했거나.)
 */
function SourceMark({ source }: { source: JobDescSource | undefined }) {
  if (!source || source.responseIds.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
        <TriangleAlert className="size-3" aria-hidden />
        근거 없음 (AI 가 만든 문장)
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">
        {source.responseIds.length}명이 같은 내용을 적었습니다
      </span>
      {source.interviewed > 0 && (
        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
          인터뷰 보완 {source.interviewed}건
        </span>
      )}
      {source.responseIds.slice(0, 5).map((id) => (
        <a
          key={id}
          href={`/admin/review?response=${id}`}
          className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
        >
          응답 보기
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ))}
      {source.responseIds.length > 5 && <span>외 {source.responseIds.length - 5}건</span>}
    </span>
  );
}

/** 목록형 항목(과업·지식·기술·태도)의 저장된 값과 그 근거를 한 줄씩 보여 준다. */
function ItemSources({
  items,
  prefix,
  sourceOf,
}: {
  items: string[];
  prefix: string;
  sourceOf: (path: string) => JobDescSource | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-md border bg-card p-2">
      {items.map((text, i) => (
        <li key={`${prefix}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12px] font-medium">{text}</span>
          <SourceMark source={sourceOf(`${prefix}.${i}`)} />
        </li>
      ))}
    </ul>
  );
}

type Props = {
  jd: JobDescriptionView;
  authHeaders: () => Promise<Record<string, string>>;
  /** 저장·확정·되돌리기 뒤 목록을 다시 읽는다. */
  onChanged: () => void;
};

export function JobDescriptionEditor({ jd, authHeaders, onChanged }: Props) {
  const locked = jd.status === "확정";
  const [jobGroup, setJobGroup] = useState(jd.jobGroup);
  const [jobSeries, setJobSeries] = useState(jd.jobSeries);
  const [definition, setDefinition] = useState(jd.definition);
  const [mission, setMission] = useState(jd.mission);
  const [tasksText, setTasksText] = useState(taskLines(jd.tasks));
  const [knowledge, setKnowledge] = useState(jd.knowledge.join(", "));
  const [skills, setSkills] = useState(jd.skills.join(", "));
  const [attitudes, setAttitudes] = useState(jd.attitudes.join(", "));
  const [requirements, setRequirements] = useState(jd.requirements);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [restoreSeq, setRestoreSeq] = useState<number | null>(null);

  const sourceOf = (path: string) => jd.sources.find((s) => s.path === path);
  const edited = (field: string) => jd.editedFields.includes(field);

  const save = useMutation({
    mutationFn: async () =>
      saveJobDescription({
        data: {
          id: jd.id,
          fields: {
            job_group: jobGroup,
            job_series: jobSeries,
            definition,
            mission,
            tasks: parseTasks(tasksText),
            knowledge: splitList(knowledge),
            skills: splitList(skills),
            attitudes: splitList(attitudes),
            requirements,
          },
        },
        headers: await authHeaders(),
      }),
    onSuccess: (res) => {
      if (res.changed.length === 0) toast.info("바뀐 내용이 없습니다.");
      else toast.success(`${res.changed.length}개 항목을 저장했습니다. (버전 ${res.seq} 로 보관)`);
      onChanged();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "저장하지 못했습니다"),
  });

  const confirm = useMutation({
    mutationFn: async () =>
      confirmJobDescription({ data: { id: jd.id }, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("확정했습니다. 이제 내보내기 대상에 들어갑니다.");
      onChanged();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "확정하지 못했습니다"),
  });

  const reopen = useMutation({
    mutationFn: async () =>
      reopenJobDescription({ data: { id: jd.id }, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("확정을 해제했습니다. 다시 고칠 수 있습니다.");
      onChanged();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "해제하지 못했습니다"),
  });

  const versions = useQuery({
    queryKey: ["jd-versions", jd.id, jd.updatedAt],
    enabled: historyOpen,
    queryFn: async () =>
      listJobDescriptionVersions({ data: { id: jd.id }, headers: await authHeaders() }),
  });

  const diff = useQuery({
    queryKey: ["jd-diff", jd.id, compareSeq, jd.updatedAt],
    enabled: compareSeq !== null,
    queryFn: async () =>
      diffJobDescriptionVersions({
        data: { id: jd.id, seqA: compareSeq ?? 0, seqB: 0 },
        headers: await authHeaders(),
      }),
  });

  const restore = useMutation({
    mutationFn: async (seq: number) =>
      restoreJobDescriptionVersion({ data: { id: jd.id, seq }, headers: await authHeaders() }),
    onSuccess: () => {
      toast.success("그 버전의 내용으로 되돌렸습니다.");
      setRestoreSeq(null);
      setCompareSeq(null);
      onChanged();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "되돌리지 못했습니다"),
  });

  /** 항목 한 칸: 라벨 + 「직접 고친 항목」 표시 + 근거. path 가 null 이면 근거를 아래 목록으로 따로 보여 준다. */
  const field = (label: string, path: string | null, node: ReactNode, fieldName: string) => (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {edited(fieldName) && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold">
            직접 고친 항목 · 다시 생성해도 그대로 둡니다
          </span>
        )}
        {path !== null && <SourceMark source={sourceOf(path)} />}
      </div>
      {node}
    </div>
  );

  return (
    <div className="space-y-4 rounded-lg border bg-secondary/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold",
              jd.status === "확정"
                ? "bg-success/15 text-success"
                : jd.status === "검토중"
                  ? "bg-warning/15 text-warning"
                  : "bg-secondary text-muted-foreground",
            )}
          >
            {jd.status}
          </span>
          <span className="text-[11px] text-muted-foreground">
            응답 {jd.responseCount}건 · 마지막 생성 {when(jd.generatedAt)}
            {jd.confirmedAt ? ` · 확정 ${when(jd.confirmedAt)}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <History className="size-4" />
            버전 이력
          </Button>
          {locked ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={reopen.isPending}
              onClick={() => reopen.mutate()}
            >
              <Unlock className="size-4" />
              확정 해제
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                저장
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                <CheckCircle2 className="size-4" />
                확정
              </Button>
            </>
          )}
        </div>
      </div>

      {locked && (
        <p className="rounded-lg border border-success/30 bg-success/5 p-2.5 text-xs text-success">
          확정된 내용입니다. 내보내기·반출 묶음에는 확정된 직무기술서만 실립니다. 고쳐야 하면 [확정
          해제]를 눌러 주세요.
        </p>
      )}

      {historyOpen && (
        <div className="space-y-2 rounded-lg border bg-card p-3">
          <p className="text-xs font-semibold">버전 이력</p>
          {versions.isLoading ? (
            <p className="text-xs text-muted-foreground">불러오는 중...</p>
          ) : (versions.data?.versions.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              아직 남은 버전이 없습니다. 저장하거나 다시 생성하면 그 직전 내용이 버전으로 남습니다.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {versions.data?.versions.map((v) => (
                <li key={v.seq} className="rounded-md border px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px]">
                      <span className="font-semibold">버전 {v.seq}</span>
                      <span className="ml-2 text-muted-foreground">{when(v.at)}</span>
                      {v.note && <span className="ml-2 text-muted-foreground">· {v.note}</span>}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setCompareSeq(compareSeq === v.seq ? null : v.seq)}
                      >
                        {compareSeq === v.seq ? "차이 닫기" : "지금과 비교"}
                      </Button>
                      {!locked &&
                        (restoreSeq === v.seq ? (
                          <>
                            <span className="text-[11px] text-destructive">정말 되돌릴까요?</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2 text-[11px]"
                              disabled={restore.isPending}
                              onClick={() => restore.mutate(v.seq)}
                            >
                              예
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => setRestoreSeq(null)}
                            >
                              아니오
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => setRestoreSeq(v.seq)}
                          >
                            <RotateCcw className="size-3" />
                            되돌리기
                          </Button>
                        ))}
                    </span>
                  </div>

                  {compareSeq === v.seq && (
                    <div className="mt-2 space-y-2 border-t pt-2">
                      {diff.isLoading ? (
                        <p className="text-[11px] text-muted-foreground">비교하는 중...</p>
                      ) : (diff.data?.diffs.length ?? 0) === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          이 버전과 지금 내용이 같습니다.
                        </p>
                      ) : (
                        diff.data?.diffs.map((d) => (
                          <div key={d.field} className="space-y-1">
                            <p className="text-[11px] font-semibold">{d.label}</p>
                            <div className="grid gap-1.5 sm:grid-cols-2">
                              <p className="whitespace-pre-wrap rounded bg-destructive/5 p-2 text-[11px] text-muted-foreground">
                                <span className="mb-0.5 block font-semibold">
                                  버전 {v.seq} (이전)
                                </span>
                                {d.before || "(비어 있음)"}
                              </p>
                              <p className="whitespace-pre-wrap rounded bg-success/5 p-2 text-[11px]">
                                <span className="mb-0.5 block font-semibold">지금</span>
                                {d.after || "(비어 있음)"}
                              </p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <fieldset disabled={locked} className="space-y-3 disabled:opacity-70">
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            "직군",
            "job_group",
            <Input value={jobGroup} onChange={(e) => setJobGroup(e.target.value)} />,
            "job_group",
          )}
          {field(
            "직렬",
            "job_series",
            <Input value={jobSeries} onChange={(e) => setJobSeries(e.target.value)} />,
            "job_series",
          )}
        </div>

        {field(
          "정의(Description)",
          "definition",
          <Textarea rows={3} value={definition} onChange={(e) => setDefinition(e.target.value)} />,
          "definition",
        )}
        {field(
          "목적(Mission)",
          "mission",
          <Textarea rows={2} value={mission} onChange={(e) => setMission(e.target.value)} />,
          "mission",
        )}

        <div className="space-y-1.5">
          {field(
            "주요 과업 — 한 줄에 하나, 「과업명: 활동1 / 활동2」",
            null,
            <Textarea rows={7} value={tasksText} onChange={(e) => setTasksText(e.target.value)} />,
            "tasks",
          )}
          <ItemSources items={jd.tasks.map((t) => t.task)} prefix="tasks" sourceOf={sourceOf} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            {field(
              "지식(K) — 쉼표 구분",
              null,
              <Textarea
                rows={3}
                value={knowledge}
                onChange={(e) => setKnowledge(e.target.value)}
              />,
              "knowledge",
            )}
            <ItemSources items={jd.knowledge} prefix="knowledge" sourceOf={sourceOf} />
          </div>
          <div className="space-y-1.5">
            {field(
              "기술(S) — 쉼표 구분",
              null,
              <Textarea rows={3} value={skills} onChange={(e) => setSkills(e.target.value)} />,
              "skills",
            )}
            <ItemSources items={jd.skills} prefix="skills" sourceOf={sourceOf} />
          </div>
          <div className="space-y-1.5">
            {field(
              "태도(A) — 쉼표 구분",
              null,
              <Textarea
                rows={3}
                value={attitudes}
                onChange={(e) => setAttitudes(e.target.value)}
              />,
              "attitudes",
            )}
            <ItemSources items={jd.attitudes} prefix="attitudes" sourceOf={sourceOf} />
          </div>
        </div>

        {field(
          "자격요건",
          "requirements",
          <Textarea
            rows={2}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />,
          "requirements",
        )}
      </fieldset>
    </div>
  );
}
