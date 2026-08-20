#!/usr/bin/env node
/**
 * 과업명 대조 규칙 자체 점검 (기획 F11·F14).
 *
 *   node scripts/check-task-match.mjs
 *
 * 업무분장 대조와 직무 중복 진단은 「같은 과업인가」 판단 하나에 전부 매달려 있다. 정규화나
 * 기준값이 조용히 바뀌면 화면 숫자만 달라지고 아무도 모르므로, 규칙을 여기서 못 박아 둔다.
 *
 * 종료 코드: 어긋나면 1.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

// 소스가 쓰는 `@/*` 는 vite 가 풀어 주는 별칭이라 node 는 모른다. 확장자 없는 경로도 함께 붙인다.
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    const base = join(SRC, specifier.slice(2));
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
    if (!found) return next(specifier, context);
    return { url: pathToFileURL(found).href, shortCircuit: true };
  },
});

const {
  DUTY_SIMILAR_THRESHOLD,
  classifyDutyTasks,
  extractDutyTasks,
  normalizeTaskName,
  taskOverlap,
} = await import("../src/lib/task-match.ts");

// 정규화 — 괄호 부연·공백·조사 차이는 같은 과업으로 본다.
assert.equal(normalizeTaskName("영업 실적 관리(월간)"), normalizeTaskName("영업실적관리"));
assert.equal(normalizeTaskName("급여 지급을"), normalizeTaskName("급여지급"));
assert.notEqual(normalizeTaskName("채용 공고 관리"), normalizeTaskName("교육 과정 운영"));

// 과업명 열 고르기 — 열 이름이 회사마다 달라도 「주요 업무」 계열을 먼저 잡는다.
assert.deepEqual(
  extractDutyTasks([
    { 순번: "1", "주요 업무": "채용 계획 수립", "세부 업무": "인원 산정" },
    { 순번: "2", "주요 업무": "채용 계획 수립", "세부 업무": "공고 게시" },
    { 순번: "3", "주요 업무": "입사 지원자 관리", "세부 업무": "" },
  ]),
  ["채용 계획 수립", "입사 지원자 관리"],
);
// 알아볼 열 이름이 없으면 값이 있는 첫 열을 쓴다.
assert.deepEqual(extractDutyTasks([{ A: "", B: "교육 운영" }]), ["교육 운영"]);
assert.deepEqual(extractDutyTasks([]), []);

// 3분류 — 정확 일치 / 유사(확인 필요) / 누락 후보, 그리고 분장 미반영.
const respByNorm = new Map([
  [normalizeTaskName("채용 계획 수립"), { name: "채용계획 수립", who: "김하나(1001)" }],
  [normalizeTaskName("입사자 교육 운영"), { name: "입사자 교육 운영", who: "이두리(1002)" }],
  [normalizeTaskName("사무용품 구매"), { name: "사무용품 구매", who: "박세찬(1003)" }],
]);
const result = classifyDutyTasks(["채용 계획 수립", "입사자 교육", "노무 상담 대응"], respByNorm);
assert.deepEqual(
  result.matched.map((p) => p.dutyTask),
  ["채용 계획 수립"],
  "공백만 다른 과업은 정확 일치여야 한다",
);
assert.deepEqual(
  result.similar.map((p) => p.dutyTask),
  ["입사자 교육"],
  "표현이 비슷한 과업은 유사(확인 필요)로 남아야 한다",
);
assert.ok(result.similar[0].score >= DUTY_SIMILAR_THRESHOLD);
assert.deepEqual(result.missing, ["노무 상담 대응"], "닮은 것이 없으면 누락 후보여야 한다");
assert.deepEqual(
  result.extra.map((t) => t.name),
  ["사무용품 구매"],
  "짝을 못 찾은 응답 과업이 분장 미반영이어야 한다",
);

// 한 응답 과업이 분장의 두 줄을 함께 받을 수 있다. 그 과업은 「분장 미반영」 이 아니다.
const single = new Map([
  [normalizeTaskName("급여 지급"), { name: "급여 지급", who: "최네오(1004)" }],
]);
const twice = classifyDutyTasks(["급여 지급", "급여 지급 관리"], single);
assert.equal(twice.matched.length, 1);
assert.equal(twice.similar.length, 1);
assert.equal(twice.missing.length, 0);
assert.equal(twice.extra.length, 0);

// 과업 겹침 — 분모는 과업이 적은 쪽. 포함 관계면 100% 가 나와야 한다.
const small = new Map([
  ["a", "채용"],
  ["b", "교육"],
]);
const large = new Map([
  ["a", "채용"],
  ["b", "교육"],
  ["c", "평가"],
  ["d", "보상"],
]);
assert.equal(taskOverlap(small, large).ratio, 1);
assert.deepEqual(taskOverlap(large, small).shared.sort(), ["교육", "채용"]);
assert.equal(taskOverlap(new Map(), large).ratio, 0);
assert.equal(taskOverlap(new Map([["z", "총무"]]), large).ratio, 0);

console.log("과업 대조 규칙 점검 통과");
