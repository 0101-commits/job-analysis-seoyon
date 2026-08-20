#!/usr/bin/env node
/**
 * 명부 대조 분류 자체 점검 (기획 F9).
 *
 *   node scripts/check-roster-diff.mjs
 *
 * 대조 키(계열사+사번 → 이메일 보조)와 분류 우선순위(조직이동 > 직무변경 > 기타변경)가 조용히
 * 바뀌면 반영 화면의 건수만 달라지고 아무도 모른다. 특히 퇴사 후보 판정은 잘못되면 재직자를
 * 보관 처리하는 방향으로 틀어지므로 규칙을 여기서 못 박아 둔다.
 *
 * 종료 코드: 어긋나면 1.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

// 소스가 쓰는 `@/*` 는 vite 가 풀어 주는 별칭이라 node 는 모른다.
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    const base = join(SRC, specifier.slice(2));
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
    if (!found) return next(specifier, context);
    return { url: pathToFileURL(found).href, shortCircuit: true };
  },
});

const { computeRosterDiff, rosterRecheckReason } = await import("../src/lib/roster.ts");

const A = "11111111-1111-1111-1111-111111111111"; // 계열사 A
const B = "22222222-2222-2222-2222-222222222222"; // 계열사 B

const row = (over = {}) => ({
  company_id: A,
  emp_no: "1001",
  name: "김하나",
  email: "hana@example.com",
  birth_date: "1990-01-01",
  org_text: "인사팀",
  grade: "과장",
  role_level: "책임",
  ...over,
});
const existing = (over = {}) => ({ ...row(), id: "p1", archived_at: null, ...over });

const kinds = (result) => result.items.map((i) => i.kind);

// 1. 변경 없음은 목록에 담지 않고 건수로만 센다(수백 건이 화면을 덮지 않게).
{
  const r = computeRosterDiff([row()], [existing()]);
  assert.deepEqual(r.items, []);
  assert.equal(r.summary["변경없음"], 1);
}

// 2. 분류 우선순위 — 소속과 직급이 같이 바뀌면 대표 분류는 조직이동, 바뀐 항목은 전부 남는다.
{
  const r = computeRosterDiff([row({ org_text: "경영지원팀", grade: "부장" })], [existing()]);
  assert.deepEqual(kinds(r), ["조직이동"]);
  assert.deepEqual(
    r.items[0].changes.map((c) => c.field).sort(),
    ["grade", "org_text"],
  );
}

// 3. 역할단계만 바뀌면 직무변경, 그 외 항목만 바뀌면 기타변경.
assert.deepEqual(kinds(computeRosterDiff([row({ role_level: "리더" })], [existing()])), [
  "직무변경",
]);
assert.deepEqual(kinds(computeRosterDiff([row({ grade: "부장" })], [existing()])), ["기타변경"]);

// 4. 계열사가 다르면 사번이 같아도 다른 사람 — 서연·서연이화에서 사번이 겹칠 수 있다.
{
  const r = computeRosterDiff([row({ company_id: B })], [existing({ company_id: A })]);
  assert.deepEqual(kinds(r).sort(), ["신규"]); // A 는 명부에 없는 계열사라 퇴사 후보로 잡히지 않는다
}

// 5. 사번을 다시 발급받은 사람은 이메일 보조 키로 한 사람으로 묶인다
//    (「신규 + 퇴사 후보」 두 건으로 쪼개지지 않는다).
{
  const r = computeRosterDiff([row({ emp_no: "2001" })], [existing({ emp_no: "1001" })]);
  assert.deepEqual(kinds(r), ["기타변경"]);
  assert.equal(r.items[0].participantId, "p1");
  assert.equal(r.items[0].existingEmpNo, "1001");
  assert.ok(r.items[0].changes.some((c) => c.field === "emp_no"));
}

// 6. 퇴사 후보 — 명부에 없는 기등록자. 보관된 사람은 다시 잡지 않는다.
{
  const r = computeRosterDiff(
    [row()],
    [existing(), existing({ id: "p2", emp_no: "1002", email: "duri@example.com", name: "이두리" })],
  );
  assert.deepEqual(kinds(r), ["퇴사후보"]);
  assert.equal(r.items[0].participantId, "p2");

  const withArchived = computeRosterDiff(
    [row()],
    [existing(), existing({ id: "p3", emp_no: "1003", email: "se@example.com", archived_at: "2026-08-01" })],
  );
  assert.deepEqual(withArchived.items, []);
}

// 7. 안전장치 — 올리지 않은 계열사 사람이 전원 퇴사 후보로 잡히면 안 된다.
{
  const r = computeRosterDiff(
    [row()],
    [existing(), existing({ id: "pB", company_id: B, emp_no: "9001", email: "b@example.com" })],
    [A],
  );
  assert.deepEqual(kinds(r), []); // B 계열사는 대조 범위 밖
}

// 8. 같은 명부를 다시 대조하면 같은 key 가 나온다(반영 요청이 대상을 지목하는 값).
{
  const rows = [row({ org_text: "경영지원팀" })];
  const a = computeRosterDiff(rows, [existing()]);
  const b = computeRosterDiff(rows, [existing()]);
  assert.deepEqual(
    a.items.map((i) => i.key),
    b.items.map((i) => i.key),
  );
}

// 9. 재확인 안내 문구 — 참여자가 읽는 문장이라 무엇이 바뀌었는지 들어가야 한다.
{
  const r = computeRosterDiff([row({ org_text: "경영지원팀" })], [existing()]);
  const reason = rosterRecheckReason(r.items[0]);
  assert.ok(reason.includes("인사팀") && reason.includes("경영지원팀"), reason);
}

console.log("명부 대조 규칙 점검 통과");
