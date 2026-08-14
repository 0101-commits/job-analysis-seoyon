// ⑤단계 직무 요건 입력 폼. 순수 컴포넌트 — 저장/이동은 코어(위저드)가 담당한다.
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type {
  Education,
  LanguageItem,
  LicenseItem,
  RequirementsFormProps,
  RequirementsValue,
} from "./types";

const EDUCATIONS: { value: Education; label: string }[] = [
  { value: "중졸이하", label: "중졸 이하" },
  { value: "고졸", label: "고졸" },
  { value: "전문대졸", label: "전문대졸" },
  { value: "학사", label: "학사" },
  { value: "석사급", label: "석사급" },
  { value: "박사급이상", label: "박사급 이상" },
  { value: "기준없음", label: "회사에 별도 기준 없음" },
];

/**
 * Select 의 "직접 입력" 표식. 실제 값이 아니라 UI 상태이므로 저장 직전에 빈 값으로 걸러낸다
 * (survey.data.ts saveRequirements 에서 제거).
 */
export const CUSTOM = "직접 입력";
const LANGUAGE_LEVELS = ["기초 회화", "업무 문서", "협상 가능"];
const PROFICIENCIES = [
  "6개월 미만",
  "1년 미만",
  "2년 미만",
  "3년 미만",
  "5년 미만",
  "5년 이상",
];

/** 프리셋에 없는 값이면 Select 는 "직접 입력"으로 표시하고 옆 입력칸에 실제 값을 담는다. */
function selectValue(raw: string, presets: string[]): string {
  if (raw === "") return "";
  return presets.includes(raw) ? raw : CUSTOM;
}

export function RequirementsForm({ value, onChange, disabled = false }: RequirementsFormProps) {
  const patch = (part: Partial<RequirementsValue>) => onChange({ ...value, ...part });

  const patchLicense = (index: number, part: Partial<LicenseItem>) =>
    patch({ licenses: value.licenses.map((l, i) => (i === index ? { ...l, ...part } : l)) });

  const patchLanguage = (index: number, part: Partial<LanguageItem>) =>
    patch({ languages: value.languages.map((l, i) => (i === index ? { ...l, ...part } : l)) });

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        본인의 스펙이 아니라, 이 직무를 새로 맡을 사람에게 필요한 최소 기준을 적어 주세요.
      </div>

      <section className="space-y-2">
        <Label>학력</Label>
        <RadioGroup
          value={value.education ?? ""}
          disabled={disabled}
          onValueChange={(v) => patch({ education: v as Education })}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          {EDUCATIONS.map((e) => (
            <div key={e.value} className="flex items-center gap-2">
              <RadioGroupItem value={e.value} id={`edu-${e.value}`} />
              <Label htmlFor={`edu-${e.value}`} className="font-normal">
                {e.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="major-required">전공 (필수)</Label>
          <Input
            id="major-required"
            value={value.majorsRequired}
            disabled={disabled}
            placeholder="예: 기계공학, 산업공학"
            onChange={(e) => patch({ majorsRequired: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="major-preferred">전공 (우대)</Label>
          <Input
            id="major-preferred"
            value={value.majorsPreferred}
            disabled={disabled}
            placeholder="예: 통계학, 경영학"
            onChange={(e) => patch({ majorsPreferred: e.target.value })}
          />
        </div>
      </section>

      <section className="space-y-2">
        <Label>자격증</Label>
        <ul className="space-y-2">
          {value.licenses.map((lic, i) => (
            <li key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_140px_auto]">
              <Input
                value={lic.name}
                disabled={disabled}
                placeholder="자격증명 (예: 품질경영기사)"
                aria-label={`자격증 ${i + 1} 이름`}
                onChange={(e) => patchLicense(i, { name: e.target.value })}
              />
              <Select
                value={lic.kind}
                disabled={disabled}
                onValueChange={(v) => patchLicense(i, { kind: v as LicenseItem["kind"] })}
              >
                <SelectTrigger aria-label={`자격증 ${i + 1} 필수/우대`}>
                  <SelectValue placeholder="필수/우대" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="필수">필수</SelectItem>
                  <SelectItem value="우대">우대</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={lic.grade}
                disabled={disabled}
                placeholder="등급/급수"
                aria-label={`자격증 ${i + 1} 등급`}
                onChange={(e) => patchLicense(i, { grade: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                title="자격증 삭제"
                aria-label="자격증 삭제"
                onClick={() => patch({ licenses: value.licenses.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            patch({ licenses: [...value.licenses, { name: "", kind: "필수", grade: "" }] })
          }
        >
          <Plus className="mr-1 size-4" />
          자격증 추가
        </Button>
      </section>

      <section className="space-y-2">
        <Label>어학</Label>
        <ul className="space-y-2">
          {value.languages.map((lang, i) => {
            const preset = selectValue(lang.level, LANGUAGE_LEVELS);
            return (
              <li key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)_auto]">
                <Input
                  value={lang.language}
                  disabled={disabled}
                  placeholder="언어 (예: 영어)"
                  aria-label={`어학 ${i + 1} 언어`}
                  onChange={(e) => patchLanguage(i, { language: e.target.value })}
                />
                <Select
                  value={preset}
                  disabled={disabled}
                  onValueChange={(v) => patchLanguage(i, { level: v })}
                >
                  <SelectTrigger aria-label={`어학 ${i + 1} 수준`}>
                    <SelectValue placeholder="수준" />
                  </SelectTrigger>
                  <SelectContent>
                    {[...LANGUAGE_LEVELS, CUSTOM].map((lv) => (
                      <SelectItem key={lv} value={lv}>
                        {lv}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {preset === CUSTOM ? (
                  <Input
                    value={lang.level === CUSTOM ? "" : lang.level}
                    disabled={disabled}
                    placeholder="예: TOEIC 800점 이상"
                    aria-label={`어학 ${i + 1} 직접 입력`}
                    onChange={(e) => patchLanguage(i, { level: e.target.value })}
                  />
                ) : (
                  <div />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  title="어학 삭제"
                  aria-label="어학 삭제"
                  onClick={() => patch({ languages: value.languages.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => patch({ languages: [...value.languages, { language: "", level: "" }] })}
        >
          <Plus className="mr-1 size-4" />
          어학 추가
        </Button>
      </section>

      <section className="space-y-2">
        <Label htmlFor="trainings">필요 교육</Label>
        <Textarea
          id="trainings"
          rows={3}
          value={value.trainings}
          disabled={disabled}
          placeholder="예: 사내 안전보건 기본교육, 통계적 공정관리 과정"
          onChange={(e) => patch({ trainings: e.target.value })}
        />
      </section>

      <section className="space-y-2">
        <Label>숙련까지 걸리는 기간</Label>
        <div className="grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Select
            value={selectValue(value.proficiency, PROFICIENCIES)}
            disabled={disabled}
            onValueChange={(v) => patch({ proficiency: v })}
          >
            <SelectTrigger aria-label="숙련기간">
              <SelectValue placeholder="숙련기간 선택" />
            </SelectTrigger>
            <SelectContent>
              {[...PROFICIENCIES, CUSTOM].map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectValue(value.proficiency, PROFICIENCIES) === CUSTOM ? (
            <Input
              value={value.proficiency === CUSTOM ? "" : value.proficiency}
              disabled={disabled}
              placeholder="예: 8개월"
              aria-label="숙련기간 직접 입력"
              onChange={(e) => patch({ proficiency: e.target.value })}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

export default RequirementsForm;
